import type {
    TileFeatureLayer,
    TileLayerParser
} from "../../build/libs/core/erdblick-core";
import type { TileFeatureId } from "../inspection/inspection.model";
import { coreLib, uint8ArrayToWasm } from "../integrations/wasm";
import { stripFeatureInspectionTarget } from "../utils/tile-feature-id.util";
import {
    parsePartition,
    partitionKey,
    type PartitionId
} from "./partition";
import { TileDeliveryError } from "./tile-diagnostics";
import {
    MAP_TILE_STREAM_HEADER_SIZE,
    MAP_TILE_STREAM_TYPE_INCOMING_RELATIONS,
    MAP_TILE_STREAM_TYPE_STATUS,
    MapTileStreamClientTiles
} from "./tilestream";

/** Completed incoming context; rows and associations were validated by the native feature model. */
export interface IncomingInspectionResult {
    model: any[];
    /** Canonical target snapshot validated in the same bundle as the source relations. */
    target?: InspectionFeatureTile;
    complete: boolean;
    issues: string[];
    expiresAtMs?: number;
}

/**
 * One feature-restricted `/tiles` response retained only by inspection models.
 *
 * It is neither a viewport tile nor a cache entry. The serialized model is
 * reparsed for the duration of `peek`, keeping native lifetimes explicit.
 */
export class InspectionFeatureTile {
    readonly mapTileKey: string;
    readonly stringPoolId: string;
    readonly mapName: string;
    readonly layerName: string;
    readonly partition: PartitionId;
    readonly partitionKey: string;
    readonly tileId: number | null;
    readonly legalInfo: string;
    readonly numFeatures: number;
    readonly warnings: readonly string[];
    readonly conversionTimestampMs: number | null;
    readonly ttlMs: number | null;
    readonly expiresAtMs: number | null;

    constructor(
        private readonly parser: TileLayerParser,
        readonly blob: Uint8Array
    ) {
        const metadata = uint8ArrayToWasm(
            data => parser.readTileLayerMetadata(data),
            blob
        ) as unknown as {
            id: string;
            stringPoolId: string;
            mapName: string;
            layerName: string;
            partition: unknown;
            tileId: number;
            legalInfo?: string;
            error?: string;
            warnings?: string[];
            numFeatures: number;
            conversionTimestampMs?: number;
            ttlMs?: number;
        };
        this.warnings = metadata.warnings ?? [];
        this.mapTileKey = metadata.id;
        this.stringPoolId = metadata.stringPoolId;
        this.mapName = metadata.mapName;
        this.layerName = metadata.layerName;
        this.partition = parsePartition(metadata.partition);
        this.partitionKey = partitionKey(this.partition);
        this.tileId = this.partition.kind === "tile"
            ? this.partition.id
            : null;
        this.legalInfo = metadata.legalInfo ?? "";
        this.numFeatures = Math.max(0, Math.floor(Number(metadata.numFeatures)));
        const timestamp = Number(metadata.conversionTimestampMs);
        const ttl = Number(metadata.ttlMs);
        this.conversionTimestampMs = Number.isFinite(timestamp)
            ? timestamp
            : null;
        this.ttlMs = Number.isFinite(ttl) && ttl > 0
            ? ttl
            : null;
        const expiry = this.conversionTimestampMs !== null &&
            this.ttlMs !== null
            ? this.conversionTimestampMs + this.ttlMs
            : null;
        this.expiresAtMs = expiry !== null && Number.isFinite(expiry)
            ? expiry
            : null;
        if (metadata.error) throw new TileDeliveryError(metadata.error, this.expiresAtMs);
    }

    peek<T>(callback: (layer: TileFeatureLayer) => T): T | null {
        const layer = uint8ArrayToWasm(
            data => this.parser.readTileFeatureLayer(data),
            this.blob
        );
        if (!layer) {
            return null;
        }
        try {
            return callback(layer);
        } finally {
            layer.delete();
        }
    }

    /** Ask native schema metadata whether this feature has any deferred incoming families. */
    hasIncomingRelations(featureId: string): boolean {
        return this.peek(layer => this.parser.hasIncomingRelations(layer,
            stripFeatureInspectionTarget(featureId))) ?? false;
    }

    /** Load a request-local snapshot bundle without delaying or modifying ordinary inspection. */
    async loadIncoming(featureId: string, signal: AbortSignal): Promise<IncomingInspectionResult> {
        signal.throwIfAborted();
        const canonicalId = stripFeatureInspectionTarget(featureId);
        const client = new MapTileStreamClientTiles("/filter", this.parser);
        const snapshots: InspectionFeatureTile[] = [];
        const manifests: any[] = [];
        let successful = false;
        let failure: string | undefined;
        let bytes = 0;
        const abort = () => client.destroy();
        signal.addEventListener("abort", abort, { once: true });
        client.onFeatures = blob => {
            if (successful) throw new Error("Incoming snapshot arrived after terminal status.");
            bytes += blob.byteLength;
            if (snapshots.length >= 64 || bytes > 64 * 1024 * 1024)
                throw new Error("Incoming inspection exceeds its snapshot limit.");
            snapshots.push(new InspectionFeatureTile(this.parser, blob));
        };
        client.onSubsets = () => { throw new Error("Backend does not support incoming inspection."); };
        client.onFrame = (frame, type) => {
            if (type !== MAP_TILE_STREAM_TYPE_INCOMING_RELATIONS && type !== MAP_TILE_STREAM_TYPE_STATUS) return;
            const value = JSON.parse(new TextDecoder().decode(frame.subarray(MAP_TILE_STREAM_HEADER_SIZE)));
            if (type === MAP_TILE_STREAM_TYPE_INCOMING_RELATIONS) {
                if (successful) throw new Error("Incoming manifest arrived after terminal status.");
                if (manifests.length) throw new Error("Duplicate incoming inspection manifest.");
                manifests.push(value);
            } else if (value.type === "mapget.filter.status") {
                if (value.state === "Success") successful = true;
                if (value.state === "Failed" || value.state === "Aborted")
                    failure = value.error ?? "Incoming inspection failed.";
            }
        };
        try {
            await client.request([{
                mapId: this.mapName, layerId: this.layerName, partitions: [this.partition],
                roots: [{ partition: this.partition, featureId: canonicalId }]
            }], { channels: [{ channelId: "incoming", scope: "relation", relation: { traversal: "incoming" } }] });
            signal.throwIfAborted();
            if (failure || !successful || manifests.length !== 1)
                throw new Error(failure ?? "Incomplete incoming inspection response.");
            const manifest = manifests[0];
            const view = new coreLib.IncomingInspection(JSON.stringify(manifest), this.mapTileKey, canonicalId);
            try {
                for (const snapshot of snapshots) snapshot.peek(layer => view.addSnapshot(layer));
                return {
                    model: view.inspectionModel(), target: snapshots.find(tile => tile.mapTileKey === this.mapTileKey), complete: manifest.complete,
                    issues: manifest.issues, expiresAtMs: manifest.expiresAtMs
                };
            } finally {
                view.delete();
            }
        } finally {
            signal.removeEventListener("abort", abort);
            client.destroy();
        }
    }

    contains(featureId: string): boolean {
        return this.peek(layer => {
            const feature = layer.find(stripFeatureInspectionTarget(featureId));
            try {
                return !feature.isNull();
            } finally {
                feature.delete();
            }
        }) ?? false;
    }
}

/** Memory-safe inspection handle for one feature in a restricted tile value. */
export class FeatureWrapper implements TileFeatureId {
    constructor(
        readonly featureId: string,
        readonly featureTile: InspectionFeatureTile
    ) { }

    get mapTileKey(): string {
        return this.featureTile.mapTileKey;
    }

    peek<T>(callback: (feature: any) => T): T | null {
        return this.featureTile.peek(layer => {
            const feature = layer.find(
                stripFeatureInspectionTarget(this.featureId)
            );
            if (feature.isNull()) {
                feature.delete();
                return null;
            }
            try {
                return callback(feature);
            } finally {
                feature.delete();
            }
        });
    }

    equals(other: FeatureWrapper | null): boolean {
        return !!other &&
            this.mapTileKey === other.mapTileKey &&
            this.featureId === other.featureId;
    }

    key(): TileFeatureId {
        return {
            mapTileKey: this.mapTileKey,
            featureId: this.featureId
        };
    }
}

export function featureSetsEqual(rhs: TileFeatureId[], lhs: TileFeatureId[]): boolean {
    return rhs.length === lhs.length && rhs.every(candidate =>
        lhs.some(item =>
            item.mapTileKey === candidate.mapTileKey &&
            item.featureId === candidate.featureId
        )
    );
}

export function featureSetContains(
    container: TileFeatureId[],
    maybeSubset: TileFeatureId[]
): boolean {
    return maybeSubset.length > 0 && maybeSubset.every(candidate =>
        container.some(item =>
            item.mapTileKey === candidate.mapTileKey &&
            item.featureId === candidate.featureId
        )
    );
}
