/**
 * Adapt feature-restricted tile responses to the native inspection model.
 * Inspection retains response bytes and opens native wrappers only while they
 * are needed; incoming-context requests use the ordinary tile-stream client.
 */
import type {
    TileFeatureLayer,
    TileLayerParser
} from "../../build/libs/core/erdblick-core";
import type { TileFeatureId } from "../inspection/inspection.model";
import { coreLib, uint8ArrayToWasm } from "../integrations/wasm.adapter";
import { stripFeatureInspectionTarget } from "../inspection/feature-identity.model";
import {
    parsePartition,
    partitionKey,
    type PartitionId
} from "./partition.model";
import { TileDeliveryError } from "./tile-diagnostics.model";
import { MapTileStreamClientTiles } from "./map-tile-stream.client";
import {
    MAP_TILE_STREAM_HEADER_SIZE,
    MAP_TILE_STREAM_TYPE_INCOMING_RELATIONS,
    MAP_TILE_STREAM_TYPE_STATUS
} from "./map-tile-stream.protocol";

/** Completed incoming context; rows and associations were validated by the native feature model. */
export interface IncomingInspectionResult {
    model: any[];

    /** Canonical target snapshot validated in the same bundle as the source relations. */
    target?: InspectionFeatureTile;
    complete: boolean;

    /** Completeness applies only to the exact provider partitions reported in scope. */
    status: "no-possible-family" | "complete" | "partial" | "unsupported-scope";
    scope: string[];
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

    /**
     * Read metadata while retaining the serialized response. The parser must keep
     * this tile's schemas and string dictionary installed for later peek() calls.
     * A failed tile throws TileDeliveryError carrying its expiry, when available.
     */
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

    /**
     * Open a temporary native wrapper for a synchronous callback, then delete it.
     * Do not retain the wrapper or use it after an await. A missing parsed layer
     * returns null; parser and callback exceptions propagate after cleanup.
     */
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

    /**
     * Load a request-local incoming-relation snapshot bundle without delaying or
     * modifying ordinary inspection. Transport success is required even when the
     * manifest reports partial scope. More than 64 snapshots or 64 MiB of snapshot
     * bytes rejects the whole request; cancellation destroys the client and
     * prevents publication of a late response.
     */
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

            // Validate identity and source ownership together before exposing any rows.
            const manifest = manifests[0];
            const view = new coreLib.IncomingInspection(JSON.stringify(manifest), this.mapTileKey, canonicalId);
            try {
                for (const snapshot of snapshots) snapshot.peek(layer => view.addSnapshot(layer));
                return {
                    model: view.inspectionModel(), target: snapshots.find(tile => tile.mapTileKey === this.mapTileKey), complete: manifest.complete,
                    status: manifest.status, scope: manifest.scope,
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

    /** Test the owning feature, stripping attribute/relation suffixes from its ID. */
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

/**
 * Inspection handle for one feature in a restricted tile value. Stores serialized
 * data and opens native feature wrappers only during peek().
 */
export class FeatureWrapper implements TileFeatureId {
    constructor(
        readonly featureId: string,
        readonly featureTile: InspectionFeatureTile
    ) { }

    get mapTileKey(): string {
        return this.featureTile.mapTileKey;
    }

    /**
     * Borrow a native feature only for this synchronous callback. Missing features
     * return null; the feature and tile wrappers are deleted before this call returns.
     */
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

/** Compare unique feature-key lists without regard to order; callers supply set-like lists. */
export function featureSetsEqual(rhs: TileFeatureId[], lhs: TileFeatureId[]): boolean {
    return rhs.length === lhs.length && rhs.every(candidate =>
        lhs.some(item =>
            item.mapTileKey === candidate.mapTileKey &&
            item.featureId === candidate.featureId
        )
    );
}

/**
 * Test whether every requested key is present. An empty request deliberately
 * returns false so an empty selection is not treated as an active match.
 */
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
