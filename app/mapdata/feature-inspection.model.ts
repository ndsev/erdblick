import type {
    TileFeatureLayer,
    TileLayerParser
} from "../../build/libs/core/erdblick-core";
import {uint8ArrayToWasm} from "../integrations/wasm";
import type {TileFeatureId} from "../shared/appstate.service";

/** Attribute and relation pseudo-identities inspect their host feature. */
function normalizeFeatureIdForLookup(featureId: string): string {
    for (const marker of [":attribute#", ":relation#"]) {
        const index = featureId.indexOf(marker);
        if (index >= 0) {
            return featureId.slice(0, index);
        }
    }
    return featureId;
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
    readonly tileId: number;
    readonly legalInfo: string;
    readonly numFeatures: number;

    constructor(
        private readonly parser: TileLayerParser,
        readonly blob: Uint8Array
    ) {
        const metadata = uint8ArrayToWasm(
            data => parser.readTileLayerMetadata(data),
            blob
        ) as {
            id: string;
            stringPoolId: string;
            mapName: string;
            layerName: string;
            tileId: number;
            legalInfo?: string;
            numFeatures: number;
        };
        this.mapTileKey = metadata.id;
        this.stringPoolId = metadata.stringPoolId;
        this.mapName = metadata.mapName;
        this.layerName = metadata.layerName;
        this.tileId = Number(metadata.tileId);
        this.legalInfo = metadata.legalInfo ?? "";
        this.numFeatures = Math.max(0, Math.floor(Number(metadata.numFeatures)));
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

    contains(featureId: string): boolean {
        return this.peek(layer => {
            const feature = layer.find(normalizeFeatureIdForLookup(featureId));
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
    ) {}

    get mapTileKey(): string {
        return this.featureTile.mapTileKey;
    }

    peek<T>(callback: (feature: any) => T): T | null {
        return this.featureTile.peek(layer => {
            const feature = layer.find(
                normalizeFeatureIdForLookup(this.featureId)
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
