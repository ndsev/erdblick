import {coreLib, uint8ArrayFromWasm, uint8ArrayToWasm} from "../integrations/wasm";
import {TileLayerParser, TileFeatureLayer} from '../../build/libs/core/erdblick-core';
import {TileFeatureId} from "../shared/appstate.service";
import {TileLoadState} from "./tilestream";

/**
 * Normalizes feature ids for lookup against the base feature record.
 * Attribute and relation pseudo-ids resolve through their host feature.
 */
function normalizeFeatureIdForLookup(featureId: string): string {
    const attributeIndex = featureId.indexOf(":attribute#");
    if (attributeIndex > -1) {
        return featureId.slice(0, attributeIndex);
    }
    const relationIndex = featureId.indexOf(":relation#");
    if (relationIndex > -1) {
        return featureId.slice(0, relationIndex);
    }
    return featureId;
}

/**
 * JS interface of a WASM TileFeatureLayer.
 * The WASM TileFeatureLayer object is stored as a blob when not needed,
 * to keep the memory usage within reasonable limits. To use the wrapped
 * WASM TileFeatureLayer, use the peek()-function.
 */
export class FeatureTile {
    static readonly DEFAULT_RENDER_ORDER = Number.MAX_SAFE_INTEGER;
    mapTileKey: string = "undefined";
    nodeId: string = "undefined";
    mapName: string = "undefined";
    layerName: string = "undefined";
    tileId: bigint = BigInt(0);
    legalInfo: string = "";
    numFeatures: number = 0;
    error?: string;
    private parser: TileLayerParser;
    private fieldDictBlobCache: Uint8Array | null = null;
    private dataSourceInfoBlobCache: Uint8Array | null = null;
    private featureIdByAddressCache: Map<number, string> = new Map<number, string>();
    private tileFeatureLayerBlobsByStage: Map<number, Uint8Array> = new Map<number, Uint8Array>();
    private vertexCountCache: number | null = null;
    private glbAttachmentCacheVersion = -1;
    private glbAttachmentCache: {
        name: string;
        bytes: Uint8Array;
        center: [number, number, number];
    } | null | undefined = undefined;
    private stageLoadStates: Map<number, TileLoadState> = new Map<number, TileLoadState>();
    preventCulling: boolean = false;
    public tileFeatureLayerBlob: Uint8Array | null = null;
    dataVersion: number = 0;
    disposed: boolean = false;
    status: TileLoadState = TileLoadState.LoadingQueued;
    stats: Map<string, number[]> = new Map<string, number[]>();
    private renderOrderRank = FeatureTile.DEFAULT_RENDER_ORDER;

    static statTileSizePrefix = "Size/Feature-Model";
    static statParseTimePrefix = "Rendering/Feature-Model-Parsing";
    static statTileSize = "Size/Feature-Model#kb";
    static statParseTime = "Rendering/Feature-Model-Parsing#ms";

    /**
     * Construct a FeatureTile object.
     * @param parser Singleton TileLayerStream WASM object.
     * @param tileFeatureLayerBlob Serialized TileFeatureLayer.
     * @param preventCulling Set to true to prevent the tile from being removed when it isn't visible.
     * @param placeholder
     */
    constructor(
        parser: TileLayerParser,
        tileFeatureLayerBlob: Uint8Array | null,
        preventCulling: boolean,
        placeholder?: {mapTileKey: string, nodeId?: string, mapName: string, layerName: string, tileId: bigint})
    {
        this.parser = parser;
        this.preventCulling = preventCulling;
        if (tileFeatureLayerBlob) {
            this.hydrateFromBlob(tileFeatureLayerBlob)
        } else if (placeholder) {
            this.mapTileKey = placeholder.mapTileKey;
            this.nodeId = placeholder.nodeId ?? "";
            this.mapName = placeholder.mapName;
            this.layerName = placeholder.layerName;
            this.tileId = placeholder.tileId;
            this.stats.set(FeatureTile.statParseTime, []);
        } else {
            throw new Error("FeatureTile requires either tile data or placeholder metadata.");
        }
    }

    /**
     * Updates the tile metadata and per-stage blob cache from a serialized layer payload.
     * The highest loaded stage becomes the canonical blob for stats and placeholder metadata.
     */
    hydrateFromBlob(tileFeatureLayerBlob: Uint8Array, stageOverride?: number) {
        const mapTileMetadata = uint8ArrayToWasm((wasmBlob: any) => {
            return this.parser.readTileLayerMetadata(wasmBlob);
        }, tileFeatureLayerBlob) as {
            id: string;
            nodeId: string;
            mapName: string;
            layerName: string;
            tileId: bigint;
            stage?: number;
            legalInfo?: string;
            error?: string;
            numFeatures: number;
            scalarFields: Record<string, number>;
        };

        const parsedStage = Number.isInteger(mapTileMetadata.stage)
            ? Number(mapTileMetadata.stage)
            : 0;
        const stage = Number.isInteger(stageOverride)
            ? Math.max(0, Number(stageOverride))
            : Math.max(0, parsedStage);
        const canonicalMapTileKey = this.canonicalMapTileKeyForMetadata(mapTileMetadata);

        this.tileFeatureLayerBlobsByStage.set(stage, tileFeatureLayerBlob);
        this.tileFeatureLayerBlob = this.highestStageBlob();
        this.fieldDictBlobCache = null;
        this.dataSourceInfoBlobCache = null;
        this.featureIdByAddressCache.clear();
        this.glbAttachmentCacheVersion = -1;
        this.glbAttachmentCache = undefined;
        this.dataVersion += 1;

        if (this.mapTileKey === "undefined") {
            this.mapTileKey = canonicalMapTileKey;
        } else if (this.mapTileKey !== canonicalMapTileKey) {
            console.warn(`Hydrating tile with mismatched key. Existing=${this.mapTileKey}, Parsed=${canonicalMapTileKey}`);
        }
        this.nodeId = mapTileMetadata.nodeId as string;
        this.mapName = mapTileMetadata.mapName as string;
        this.layerName = mapTileMetadata.layerName as string;
        this.tileId = BigInt(mapTileMetadata.tileId as any);
        this.legalInfo = mapTileMetadata.legalInfo as string;
        this.error = mapTileMetadata.error ? mapTileMetadata.error as string : undefined;
        const parsedNumFeatures = Number(mapTileMetadata.numFeatures);
        if (Number.isFinite(parsedNumFeatures) && parsedNumFeatures >= 0) {
            this.numFeatures = Math.max(this.numFeatures, Math.floor(parsedNumFeatures));
        }
        this.status = this.error ? TileLoadState.Error : TileLoadState.Ok;

        const stageBlobs = this.stageBlobs();
        const totalSizeKb = stageBlobs.reduce((sum, item) => sum + item.blob.length, 0) / 1024;
        this.stats.set(FeatureTile.statTileSize, [totalSizeKb]);
        for (const stageBlob of stageBlobs) {
            this.stats.set(FeatureTile.stageTileSizeKey(stageBlob.stage), [stageBlob.blob.length / 1024]);
        }
        for (let [k, v] of Object.entries(mapTileMetadata.scalarFields)) {
            this.stats.set(k, [v as number]);
        }

        const verticesFromStats = this.vertexCountFromStats();
        if (verticesFromStats > 0) {
            this.storeVertexCount(verticesFromStats);
        }
    }

    /** Returns true once at least one stage blob is cached for this tile. */
    hasData(): boolean {
        return this.tileFeatureLayerBlobsByStage.size > 0;
    }

    /** Returns the cached stage payloads in ascending stage order for overlay attachment. */
    stageBlobs(): Array<{stage: number, blob: Uint8Array}> {
        const result: Array<{stage: number, blob: Uint8Array}> = [];
        for (const [stage, blob] of this.tileFeatureLayerBlobsByStage.entries()) {
            result.push({stage, blob});
        }
        result.sort((lhs, rhs) => lhs.stage - rhs.stage);
        return result;
    }

    /** Returns the highest cached stage, or null while the tile is still a placeholder. */
    highestLoadedStage(): number | null {
        let highest: number | null = null;
        for (const stage of this.tileFeatureLayerBlobsByStage.keys()) {
            if (highest === null || stage > highest) {
                highest = stage;
            }
        }
        return highest;
    }

    /** Checks whether a specific stage payload has already been received. */
    hasStage(stage: number): boolean {
        return this.tileFeatureLayerBlobsByStage.has(stage);
    }

    /**
     * Returns the first missing stage below the advertised stage count.
     * This drives inspection/render completeness checks.
     */
    nextMissingStage(stageCount: number): number | undefined {
        const normalizedStageCount = Math.max(1, Math.floor(stageCount));
        for (let stage = 0; stage < normalizedStageCount; stage++) {
            if (!this.tileFeatureLayerBlobsByStage.has(stage)) {
                return stage;
            }
        }
        return undefined;
    }

    /** Returns true when every stage below the expected count is present. */
    isComplete(stageCount: number): boolean {
        return this.nextMissingStage(stageCount) === undefined;
    }

    /** Stores a caller-provided vertex count estimate, usually from rendering stats. */
    setVertexCount(count: number): void {
        this.storeVertexCount(count);
    }

    /** Assigns a stable render-order rank that later sorts visualizations front to back. */
    setRenderOrder(order: number): void {
        if (!Number.isFinite(order)) {
            this.renderOrderRank = FeatureTile.DEFAULT_RENDER_ORDER;
            return;
        }
        this.renderOrderRank = Math.max(0, Math.floor(order));
    }

    /** Returns the cached render-order rank used for visualization scheduling. */
    renderOrder(): number {
        return this.renderOrderRank;
    }

    /**
     * Returns the best-known vertex count for this tile.
     * The value is derived lazily from tile stats until a renderer reports a more exact count.
     */
    vertexCount(): number {
        if (this.vertexCountCache !== null) {
            return this.vertexCountCache;
        }

        const fromStats = this.vertexCountFromStats();
        if (fromStats > 0) {
            return this.storeVertexCount(fromStats);
        }
        return 0;
    }

    /** Normalizes and caches vertex counts so downstream stats stay monotonic and integral. */
    private storeVertexCount(count: number): number {
        this.vertexCountCache = Math.max(0, Math.floor(count));
        return this.vertexCountCache;
    }

    /** Sums vertex-like counters from the tile stats map while skipping timing and size metrics. */
    private vertexCountFromStats(): number {
        let vertices = 0;
        for (const [key, values] of this.stats.entries()) {
            if (!values?.length) {
                continue;
            }
            if (!/(^|\/)(vert|vertex|vertices)(\/|$|#)/i.test(key)) {
                continue;
            }
            if (/#ms$/i.test(key) || /#kb$/i.test(key)) {
                continue;
            }
            const value = values[values.length - 1];
            if (!Number.isFinite(value)) {
                continue;
            }
            vertices += Math.max(0, Math.round(value));
        }
        return vertices;
    }

    /**
     * Returns the serialized field dictionary for this datasource node.
     * The dictionary is fetched lazily because many tiles never need search/inspection helpers.
     */
    getFieldDictBlob(): Uint8Array | null {
        if (this.fieldDictBlobCache) {
            return this.fieldDictBlobCache;
        }
        if (!this.nodeId.length) {
            return null;
        }
        const encoded = uint8ArrayFromWasm((buf) => {
            this.parser.getFieldDict(buf, this.nodeId);
            return true;
        });
        if (!encoded) {
            return null;
        }
        this.fieldDictBlobCache = encoded;
        return encoded;
    }

    /** Returns cached datasource metadata for the tile's map, loading it from WASM on demand. */
    getDataSourceInfoBlob(): Uint8Array | null {
        if (this.dataSourceInfoBlobCache) {
            return this.dataSourceInfoBlobCache;
        }
        if (!this.mapName.length) {
            return null;
        }
        const encoded = uint8ArrayFromWasm((buf) => {
            this.parser.getDataSourceInfo(buf, this.mapName);
            return true;
        });
        if (!encoded) {
            return null;
        }
        this.dataSourceInfoBlobCache = encoded;
        return encoded;
    }

    /** Returns the optional tile-level GLB attachment together with the tile center anchor. */
    async getGlbAttachmentSnapshot(): Promise<{
        name: string;
        bytes: Uint8Array;
        center: [number, number, number];
    } | null> {
        if (this.glbAttachmentCacheVersion === this.dataVersion && this.glbAttachmentCache !== undefined) {
            return this.glbAttachmentCache;
        }
        const snapshot = await this.peekAsync(async (tileFeatureLayer) => {
            if (!tileFeatureLayer.hasGlbAttachment()) {
                return null;
            }
            const bytes = uint8ArrayFromWasm((buf) => tileFeatureLayer.copyGlbAttachment(buf));
            if (!bytes) {
                return null;
            }
            const center = coreLib.getTilePosition(tileFeatureLayer.tileId());
            return {
                name: tileFeatureLayer.glbAttachmentName(),
                bytes,
                center: [center.x, center.y, center.z] as [number, number, number]
            };
        });
        this.glbAttachmentCacheVersion = this.dataVersion;
        this.glbAttachmentCache = snapshot;
        return snapshot;
    }

    /**
     * Reconstructs the canonical map tile key from parser metadata.
     * This defends against placeholder keys and older payloads that omit the composed id.
     */
    private canonicalMapTileKeyForMetadata(metadata: {
        id?: string;
        mapName?: string;
        layerName?: string;
        tileId?: bigint;
    }): string {
        if (metadata.id) {
            try {
                const [mapId, layerId, tileId] = coreLib.parseMapTileKey(metadata.id);
                return coreLib.getTileFeatureLayerKey(mapId, layerId, tileId);
            } catch (_error) {
                return metadata.id;
            }
        }
        if (metadata.mapName && metadata.layerName && metadata.tileId !== undefined) {
            return coreLib.getTileFeatureLayerKey(metadata.mapName, metadata.layerName, metadata.tileId);
        }
        return this.mapTileKey;
    }

    /** Returns the highest-stage blob, which is the payload most callers want as the tile summary. */
    private highestStageBlob(): Uint8Array | null {
        const highest = this.highestLoadedStage();
        if (highest === null) {
            return null;
        }
        return this.tileFeatureLayerBlobsByStage.get(highest) || null;
    }

    /** Builds the diagnostics key that tracks serialized tile size per stage. */
    static stageTileSizeKey(stage: number): string {
        return `${FeatureTile.statTileSizePrefix}/Stage-${stage}#kb`;
    }

    /** Builds the diagnostics key that tracks parse duration per stage. */
    static stageParseTimeKey(stage: number): string {
        return `${FeatureTile.statParseTimePrefix}/Stage-${stage}#ms`;
    }

    /** Appends parse timing samples to both the overall and per-stage diagnostics buckets. */
    private recordParseTime(durationMs: number, stage: number): void {
        const parseTimes = this.stats.get(FeatureTile.statParseTime);
        if (parseTimes) {
            parseTimes.push(durationMs);
        } else {
            this.stats.set(FeatureTile.statParseTime, [durationMs]);
        }
        const stageKey = FeatureTile.stageParseTimeKey(stage);
        const stageParseTimes = this.stats.get(stageKey);
        if (stageParseTimes) {
            stageParseTimes.push(durationMs);
        } else {
            this.stats.set(stageKey, [durationMs]);
        }
    }

    /** Deserializes a single stage payload and records the parse cost for diagnostics. */
    private deserializeTileFeatureLayer(tileBlob: Uint8Array, stage: number): TileFeatureLayer | null {
        return uint8ArrayToWasm((bufferToRead: any) => {
            const startTime = performance.now();
            const deserializedLayer = this.parser.readTileFeatureLayer(bufferToRead);
            const endTime = performance.now();
            if (!deserializedLayer) {
                return null;
            }
            this.recordParseTime(endTime - startTime, stage);
            return deserializedLayer;
        }, tileBlob);
    }

    /** Attaches later stages as overlays so the base layer exposes the merged staged view. */
    private attachOverlayChain(baseLayer: TileFeatureLayer, overlays: TileFeatureLayer[]): void {
        for (const overlay of overlays) {
            baseLayer.attachOverlay(overlay);
        }
    }

    /**
     * Provide temporary access to a deserialized TileFeatureLayer.
     * @returns The value returned by the callback.
     */
    peek(callback: (layer: TileFeatureLayer) => any) {
        const stageBlobs = this.stageBlobs();
        if (!stageBlobs.length) {
            return null;
        }

        const baseLayer = this.deserializeTileFeatureLayer(stageBlobs[0].blob, stageBlobs[0].stage);
        if (!baseLayer) {
            return null;
        }
        const overlays: TileFeatureLayer[] = [];
        try {
            for (let i = 1; i < stageBlobs.length; i++) {
                const overlay = this.deserializeTileFeatureLayer(stageBlobs[i].blob, stageBlobs[i].stage);
                if (!overlay) {
                    continue;
                }
                overlays.push(overlay);
            }
            this.attachOverlayChain(baseLayer, overlays);
            return callback(baseLayer);
        } finally {
            for (const overlay of overlays) {
                overlay.delete();
            }
            baseLayer.delete();
        }
    }

    /**
     * Async version of the above function.
     */
    async peekAsync(callback: (layer: TileFeatureLayer) => Promise<any>) {
        const stageBlobs = this.stageBlobs();
        if (!stageBlobs.length) {
            return null;
        }

        const baseLayer = this.deserializeTileFeatureLayer(stageBlobs[0].blob, stageBlobs[0].stage);
        if (!baseLayer) {
            return null;
        }
        const overlays: TileFeatureLayer[] = [];
        try {
            for (let i = 1; i < stageBlobs.length; i++) {
                const overlay = this.deserializeTileFeatureLayer(stageBlobs[i].blob, stageBlobs[i].stage);
                if (!overlay) {
                    continue;
                }
                overlays.push(overlay);
            }
            this.attachOverlayChain(baseLayer, overlays);
            return await callback(baseLayer);
        } finally {
            for (const overlay of overlays) {
                overlay.delete();
            }
            baseLayer.delete();
        }
    }

    /**
     * Mark this tile as "not available anymore".
     */
    dispose() {
        this.tileFeatureLayerBlobsByStage.clear();
        this.stageLoadStates.clear();
        this.tileFeatureLayerBlob = null;
        this.vertexCountCache = null;
        this.glbAttachmentCacheVersion = -1;
        this.glbAttachmentCache = undefined;
        this.renderOrderRank = FeatureTile.DEFAULT_RENDER_ORDER;
        this.disposed = true;
    }

    /**
     * Peek into a list of multiple tiles simultaneously. Calls peek recursively,
     * according to the given tiles array.
     */
    static async peekMany(tiles: Array<FeatureTile>, cb: any, parsedTiles?: Array<TileFeatureLayer>): Promise<any> {
        // Check if callback is provided
        if (!cb) {
            return;
        }

        // Create parsedTiles list.
        if (parsedTiles === undefined) {
            parsedTiles = [];
        }

        tiles = tiles.filter(tile => tile.hasData());

        // Termination condition for recursion.
        if (tiles.length === 0) {
            // All tiles parsed, run callback.
            return await cb(parsedTiles);
        }

        // Get the next tile to process.
        const nextTile = tiles[0];

        // Remove the processed tile from the list.
        tiles = tiles.slice(1);

        // Check if nextTile is not undefined or null.
        return await nextTile.peekAsync(async parsedTile => {
            // Add parsed tile to result.
            parsedTiles!.push(parsedTile!);
            // Recurse with the remaining tiles.
            return await FeatureTile.peekMany(tiles, cb, parsedTiles);
        });
    }

    /** Returns the tile level encoded in the low 16 bits of the NDS tile id. */
    level() {
        return Number(this.tileId & BigInt(0xffff));
    }

    /** Returns true when the normalized feature id can be resolved inside this tile. */
    has(featureId: string) {
        const lookupFeatureId = normalizeFeatureIdForLookup(featureId);
        return this.peek((tileFeatureLayer: TileFeatureLayer) => {
            let feature = tileFeatureLayer.find(lookupFeatureId);
            let result = !feature.isNull();
            feature.delete();
            return result;
        });
    }

    /**
     * Resolves a feature id by numeric address and caches the string result.
     * Address-based lookups are common during rendering and inspection cross-links.
     */
    featureIdByAddress(featureAddress: number): string | null {
        if (!Number.isInteger(featureAddress) || featureAddress < 0) {
            return null;
        }
        if (featureAddress >= this.numFeatures) {
            return null;
        }
        const cached = this.featureIdByAddressCache.get(featureAddress);
        if (cached !== undefined) {
            return cached;
        }
        const featureId = this.peek((tileFeatureLayer: TileFeatureLayer) => {
            const result = tileFeatureLayer.featureIdByAddress(featureAddress);
            return (typeof result === "string" && result.length > 0) ? result : null;
        });
        if (typeof featureId === "string" && featureId.length > 0) {
            this.featureIdByAddressCache.set(featureAddress, featureId);
            return featureId;
        }
        return null;
    }
}

/**
 * Wrapper which combines a FeatureTile and feature id.
 * Using the peek-function, it is possible to access the
 * WASM feature view in a memory-safe way.
 */
export class FeatureWrapper implements TileFeatureId {
    public readonly featureId: string;
    public featureTile: FeatureTile;

    get mapTileKey(): string {
        return this.featureTile.mapTileKey;
    }

    /**
     * Construct a feature wrapper from a feature tile and feature ID.
     * @param featureId The feature-id of the feature.
     * @param featureTile {FeatureTile} The feature tile container.
     */
    constructor(featureId: string, featureTile: FeatureTile) {
        this.featureId = featureId;
        this.featureTile = featureTile;
    }

    /**
     * Run a callback with the WASM Feature object referenced by this wrapper.
     * The feature object will be deleted after the callback is called.
     * @returns The value returned by the callback.
     */
    peek(callback: any) {
        return this.featureTile.peek((tileFeatureLayer: TileFeatureLayer) => {
            const feature = tileFeatureLayer.find(normalizeFeatureIdForLookup(this.featureId));
            if (feature.isNull()) {
                feature.delete();
                return null;
            }
            let result = null;
            if (callback) {
                result = callback(feature);
            }
            feature.delete();
            return result;
        });
    }

    /** Check if this wrapper wraps the same feature as another wrapper. */
    equals(other: FeatureWrapper | null): boolean {
        if (!other) {
            return false;
        }
        return this.featureTile.mapTileKey == other.featureTile.mapTileKey && this.featureId == other.featureId;
    }

    /** Returns the cross-map-layer global ID for this feature. */
    key(): TileFeatureId {
        return {
            mapTileKey: this.featureTile.mapTileKey,
            featureId: this.featureId
        };
    }
}

/** Returns true when two unordered feature-id sets contain exactly the same elements. */
export function featureSetsEqual(rhs: TileFeatureId[], lhs: TileFeatureId[]) {
    return rhs.length === lhs.length && rhs.every(rf =>
        lhs.some(lf =>
            rf.mapTileKey === lf.mapTileKey && rf.featureId === lf.featureId));
}

/** Returns true when every requested feature id is present in the containing set. */
export function featureSetContains(container: TileFeatureId[], maybeSubset: TileFeatureId[]) {
    if (!maybeSubset.length) {
        return false;
    }
    return maybeSubset.every(candidate => container.some(item =>
        item.mapTileKey === candidate.mapTileKey && item.featureId == candidate.featureId));
}
