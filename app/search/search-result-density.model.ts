import {coreLib} from "../integrations/wasm";

/**
 * Flat result point exposed to map overlays and result-tree hover interactions.
 */
export interface SearchResultPoint {
    coordinates: [number, number];
    mapId: string;
    layerId: string;
    tileId: bigint;
    mapTileKey: string;
    sourceTileKey: string;
    sourceMapId: string;
    sourceLayerId: string;
    sourceTileId: bigint;
    featureId: string;
    resultIndex: number;
    resultKey: string;
    featureKey: string;
    hoverFeatureId: string;
}

/** Result points grouped by their streamed source tile for viewport/density materialization. */
export interface SearchResultPointBucket {
    sourceTileKey: string;
    mapId: string;
    layerId: string;
    tileId: bigint;
    points: SearchResultPoint[];
}

/** Circle marker rendered by the search-result density overlay. */
export interface SearchResultDensityMarker {
    coordinates: [number, number];
    pixelOffset?: [number, number];
    count: number;
    mapId: string;
    layerId: string;
    tileId: bigint;
    featureId: string;
    resultKey: string;
    featureKey: string;
    featureKeys: string[];
    resultKeys: string[];
    showBucketLabel?: boolean;
}

/** Parameters for materializing visible source-tile contributions into density markers. */
export interface SearchResultDensityMaterializationRequest {
    sourceTileKeys: Iterable<string>;
    targetLevel: number;
}

interface SearchResultDensityNodeDelta {
    key: string;
    mapId: string;
    layerId: string;
    tileId: bigint;
    level: number;
    count: number;
    samples: SearchResultPoint[];
}

interface SearchResultDensityContribution {
    maxLevel: number;
    deltasByLevel: Map<number, Map<string, SearchResultDensityNodeDelta>>;
}

/**
 * Stores low-fidelity search results as per-source-tile density deltas.
 *
 * The index deliberately avoids a global spatial clustering rebuild. Result-tile eviction only removes the matching
 * contribution; each view materializes visible source-tile keys into already aggregated circle markers.
 */
export class SearchResultDensityIndex {
    private static readonly MAX_SAMPLE_FEATURES = 25;
    private readonly contributionsBySourceTileKey = new Map<string, SearchResultDensityContribution>();

    /** Returns whether the index currently has no source-tile contributions. */
    get isEmpty(): boolean {
        return this.contributionsBySourceTileKey.size === 0;
    }

    /** Replaces one source-tile contribution with tile-level density deltas. */
    addContribution(sourceTileKey: string, points: readonly SearchResultPoint[]): void {
        if (!points.length) {
            this.contributionsBySourceTileKey.delete(sourceTileKey);
            return;
        }

        const contribution = this.createContribution(points);
        this.contributionsBySourceTileKey.set(sourceTileKey, contribution);
    }

    /** Removes one source-tile contribution without touching unrelated result tiles. */
    removeContribution(sourceTileKey: string): boolean {
        return this.contributionsBySourceTileKey.delete(sourceTileKey);
    }

    /** Clears every indexed contribution for a full search refresh or session reset. */
    clear(): void {
        this.contributionsBySourceTileKey.clear();
    }

    /** Materializes visible source-tile contributions into tile-aggregated density markers for one deck view. */
    materialize(request: SearchResultDensityMaterializationRequest): SearchResultDensityMarker[] {
        const requestedLevel = Math.max(0, Math.floor(request.targetLevel));
        const mergedDeltas = new Map<string, SearchResultDensityNodeDelta>();
        for (const sourceTileKey of request.sourceTileKeys) {
            const contribution = this.contributionsBySourceTileKey.get(sourceTileKey);
            if (!contribution) {
                continue;
            }
            const effectiveLevel = Math.min(requestedLevel, contribution.maxLevel);
            const deltasForLevel = contribution.deltasByLevel.get(effectiveLevel);
            if (!deltasForLevel) {
                continue;
            }
            for (const delta of deltasForLevel.values()) {
                this.mergeMaterializedDelta(mergedDeltas, delta);
            }
        }

        return Array.from(mergedDeltas.values())
            .filter(delta => delta.count > 0 && delta.samples.length > 0)
            .map(delta => this.markerFromDelta(delta))
            .sort((lhs, rhs) => {
                if (lhs.tileId === rhs.tileId) {
                    return lhs.resultKey.localeCompare(rhs.resultKey);
                }
                return lhs.tileId < rhs.tileId ? -1 : 1;
            });
    }

    /** Creates one source-tile contribution by counting results once per source-tile ancestor. */
    private createContribution(points: readonly SearchResultPoint[]): SearchResultDensityContribution {
        const representative = points[0];
        const samples = points.slice(0, SearchResultDensityIndex.MAX_SAMPLE_FEATURES);
        const contribution: SearchResultDensityContribution = {
            maxLevel: 0,
            deltasByLevel: new Map<number, Map<string, SearchResultDensityNodeDelta>>()
        };
        let tileId = representative.sourceTileId;
        let level = Number(coreLib.getTileLevel(tileId));
        contribution.maxLevel = Math.max(contribution.maxLevel, level);

        while (level >= 0) {
            const deltasForLevel = new Map<string, SearchResultDensityNodeDelta>();
            const nodeKey = `${representative.sourceMapId}\n${tileId.toString()}`;
            deltasForLevel.set(nodeKey, {
                key: nodeKey,
                mapId: representative.sourceMapId,
                layerId: representative.sourceLayerId,
                tileId,
                level,
                count: points.length,
                samples
            });
            contribution.deltasByLevel.set(level, deltasForLevel);
            if (level === 0) {
                break;
            }
            tileId = this.parentTileId(tileId, level);
            level -= 1;
        }

        return contribution;
    }

    /** Merges one pre-aggregated source-tile delta into the visible-view result set. */
    private mergeMaterializedDelta(
        mergedDeltas: Map<string, SearchResultDensityNodeDelta>,
        delta: SearchResultDensityNodeDelta
    ): void {
        const existing = mergedDeltas.get(delta.key);
        if (!existing) {
            mergedDeltas.set(delta.key, {
                ...delta,
                samples: [...delta.samples]
            });
            return;
        }

        existing.count += delta.count;
        for (const sample of delta.samples) {
            if (existing.samples.length >= SearchResultDensityIndex.MAX_SAMPLE_FEATURES) {
                break;
            }
            existing.samples.push(sample);
        }
    }

    /** Converts the internal aggregate delta into the flat marker object consumed by Deck. */
    private markerFromDelta(delta: SearchResultDensityNodeDelta): SearchResultDensityMarker {
        const representative = delta.samples[0];
        const tilePosition = coreLib.getTilePosition(delta.tileId);
        return {
            coordinates: [tilePosition.x, tilePosition.y],
            count: delta.count,
            mapId: representative.mapId,
            layerId: representative.layerId,
            tileId: delta.tileId,
            featureId: representative.featureId,
            resultKey: representative.resultKey,
            featureKey: representative.featureKey,
            featureKeys: delta.samples.map(sample => sample.featureKey),
            resultKeys: delta.samples.map(sample => sample.resultKey),
            showBucketLabel: true
        };
    }

    /** Computes the parent id for a mapget tile id at a known non-root level. */
    private parentTileId(tileId: bigint, level: number): bigint {
        const x = tileId >> 32n;
        const y = (tileId >> 16n) & 0xffffn;
        const parentLevel = BigInt(level - 1);
        return ((x >> 1n) << 32n) | ((y >> 1n) << 16n) | parentLevel;
    }
}
