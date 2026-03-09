import {coreLib, uint8ArrayFromWasm, uint8ArrayToWasm} from "../integrations/wasm";
import {TileLayerParser, TileFeatureLayer} from '../../build/libs/core/erdblick-core';
import {TileFeatureId} from "../shared/appstate.service";
import {TileLoadState} from "./tilestream";

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
    private featureIdByIndexCache: Map<number, string> = new Map<number, string>();
    private tileFeatureLayerBlobsByStage: Map<number, Uint8Array> = new Map<number, Uint8Array>();
    private vertexCountCache: number | null = null;
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
        this.featureIdByIndexCache.clear();
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

        const parseTimesByKey = this.existingParseTimeStats();
        this.stats = new Map<string, number[]>();
        for (const [key, values] of parseTimesByKey.entries()) {
            this.stats.set(key, values);
        }
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

    hasData(): boolean {
        return this.tileFeatureLayerBlobsByStage.size > 0;
    }

    blobCount(): number {
        return this.tileFeatureLayerBlobsByStage.size;
    }

    stageBlobs(): Array<{stage: number, blob: Uint8Array}> {
        const result: Array<{stage: number, blob: Uint8Array}> = [];
        for (const [stage, blob] of this.tileFeatureLayerBlobsByStage.entries()) {
            result.push({stage, blob});
        }
        result.sort((lhs, rhs) => lhs.stage - rhs.stage);
        return result;
    }

    highestLoadedStage(): number | null {
        let highest: number | null = null;
        for (const stage of this.tileFeatureLayerBlobsByStage.keys()) {
            if (highest === null || stage > highest) {
                highest = stage;
            }
        }
        return highest;
    }

    hasStage(stage: number): boolean {
        return this.tileFeatureLayerBlobsByStage.has(stage);
    }

    nextMissingStage(stageCount: number): number | undefined {
        const normalizedStageCount = Math.max(1, Math.floor(stageCount));
        for (let stage = 0; stage < normalizedStageCount; stage++) {
            if (!this.tileFeatureLayerBlobsByStage.has(stage)) {
                return stage;
            }
        }
        return undefined;
    }

    isComplete(stageCount: number): boolean {
        return this.nextMissingStage(stageCount) === undefined;
    }

    setStageLoadState(stage: number, state: TileLoadState): void {
        this.stageLoadStates.set(Math.max(0, Math.floor(stage)), state);
    }

    stageLoadState(stage: number): TileLoadState | undefined {
        return this.stageLoadStates.get(Math.max(0, Math.floor(stage)));
    }

    setVertexCount(count: number): void {
        this.storeVertexCount(count);
    }

    setRenderOrder(order: number): void {
        if (!Number.isFinite(order)) {
            this.renderOrderRank = FeatureTile.DEFAULT_RENDER_ORDER;
            return;
        }
        this.renderOrderRank = Math.max(0, Math.floor(order));
    }

    renderOrder(): number {
        return this.renderOrderRank;
    }

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

    private storeVertexCount(count: number): number {
        this.vertexCountCache = Math.max(0, Math.floor(count));
        return this.vertexCountCache;
    }

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

    private existingParseTimeStats(): Map<string, number[]> {
        const result = new Map<string, number[]>();
        for (const [key, values] of this.stats.entries()) {
            if (key === FeatureTile.statParseTime || key.startsWith(`${FeatureTile.statParseTimePrefix}/Stage-`)) {
                result.set(key, [...values]);
            }
        }
        return result;
    }

    getFieldDictBlob(): Uint8Array | null {
        if (this.fieldDictBlobCache) {
            return this.fieldDictBlobCache;
        }
        if (!this.nodeId.length) {
            return null;
        }
        const parserWithFieldDict = this.parser as any;
        if (typeof parserWithFieldDict.getFieldDict !== "function") {
            return null;
        }
        const encoded = uint8ArrayFromWasm((buf) => {
            parserWithFieldDict.getFieldDict(buf, this.nodeId);
            return true;
        });
        if (!encoded) {
            return null;
        }
        this.fieldDictBlobCache = encoded;
        return encoded;
    }

    getDataSourceInfoBlob(): Uint8Array | null {
        if (this.dataSourceInfoBlobCache) {
            return this.dataSourceInfoBlobCache;
        }
        if (!this.mapName.length) {
            return null;
        }
        const parserWithDataSourceInfo = this.parser as any;
        if (typeof parserWithDataSourceInfo.getDataSourceInfo !== "function") {
            return null;
        }
        const encoded = uint8ArrayFromWasm((buf) => {
            parserWithDataSourceInfo.getDataSourceInfo(buf, this.mapName);
            return true;
        });
        if (!encoded) {
            return null;
        }
        this.dataSourceInfoBlobCache = encoded;
        return encoded;
    }

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

    private highestStageBlob(): Uint8Array | null {
        const highest = this.highestLoadedStage();
        if (highest === null) {
            return null;
        }
        return this.tileFeatureLayerBlobsByStage.get(highest) || null;
    }

    static stageTileSizeKey(stage: number): string {
        return `${FeatureTile.statTileSizePrefix}/Stage-${stage}#kb`;
    }

    static stageParseTimeKey(stage: number): string {
        return `${FeatureTile.statParseTimePrefix}/Stage-${stage}#ms`;
    }

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

    private attachOverlayChain(baseLayer: TileFeatureLayer, overlays: TileFeatureLayer[]): void {
        const maybeAttach = (baseLayer as any).attachOverlay;
        if (typeof maybeAttach !== "function") {
            return;
        }
        for (const overlay of overlays) {
            maybeAttach.call(baseLayer, overlay);
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

        tiles = tiles.filter(tile => tile.hasData());
        if (!tiles.length) {
            return;
        }

        // Create parsedTiles list.
        if (parsedTiles === undefined) {
            parsedTiles = [];
        }

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

    level() {
        return Number(this.tileId & BigInt(0xffff));
    }

    has(featureId: string) {
        const index = featureId.indexOf(':attribute');
        if (index > -1) {
            featureId = featureId.slice(0, index);
        }
        return this.peek((tileFeatureLayer: TileFeatureLayer) => {
            let feature = tileFeatureLayer.find(featureId);
            let result = !feature.isNull();
            feature.delete();
            return result;
        });
    }

    featureIdByIndex(featureIndex: number): string | null {
        if (!Number.isInteger(featureIndex) || featureIndex < 0) {
            return null;
        }
        if (featureIndex >= this.numFeatures) {
            return null;
        }
        const cached = this.featureIdByIndexCache.get(featureIndex);
        if (cached !== undefined) {
            return cached;
        }
        const featureId = this.peek((tileFeatureLayer: TileFeatureLayer) => {
            const layerAny = tileFeatureLayer as any;
            if (typeof layerAny.featureIdByIndex !== "function") {
                return null;
            }
            const result = layerAny.featureIdByIndex(featureIndex);
            return (typeof result === "string" && result.length > 0) ? result : null;
        });
        if (typeof featureId === "string" && featureId.length > 0) {
            this.featureIdByIndexCache.set(featureIndex, featureId);
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
    public readonly featureIndex?: number;
    public featureTile: FeatureTile;

    get mapTileKey(): string {
        return this.featureTile.mapTileKey;
    }

    /**
     * Construct a feature wrapper from a featureTile and a feature index
     * within that tile.
     * @param featureId The feature-id of the feature.
     * @param featureTile {FeatureTile} The feature tile container.
     */
    constructor(featureId: string, featureTile: FeatureTile, featureIndex?: number) {
        this.featureId = featureId;
        this.featureTile = featureTile;
        this.featureIndex = Number.isInteger(featureIndex) && featureIndex !== undefined && featureIndex >= 0
            ? featureIndex
            : undefined;
    }

    /**
     * Run a callback with the WASM Feature object referenced by this wrapper.
     * The feature object will be deleted after the callback is called.
     * @returns The value returned by the callback.
     */
    peek(callback: any) {
        return this.featureTile.peek((tileFeatureLayer: TileFeatureLayer) => {
            let feature: any = null;
            if (this.featureIndex !== undefined) {
                const featureByIndex = (tileFeatureLayer as any).featureByIndex;
                if (typeof featureByIndex === "function") {
                    feature = featureByIndex.call(tileFeatureLayer, this.featureIndex);
                }
            }
            if (!feature || feature.isNull()) {
                if (feature && feature.isNull()) {
                    feature.delete();
                }
                feature = tileFeatureLayer.find(this.featureId);
            }
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
        if (this.featureIndex !== undefined || other.featureIndex !== undefined) {
            return this.featureTile.mapTileKey == other.featureTile.mapTileKey &&
                this.featureIndex === other.featureIndex;
        }
        return this.featureTile.mapTileKey == other.featureTile.mapTileKey && this.featureId == other.featureId;
    }

    /** Returns the cross-map-layer global ID for this feature. */
    key(): TileFeatureId {
        return {
            mapTileKey: this.featureTile.mapTileKey,
            featureId: this.featureId,
            featureIndex: this.featureIndex
        };
    }
}

export function featureSetsEqual(rhs: TileFeatureId[], lhs: TileFeatureId[]) {
    return rhs.length === lhs.length && rhs.every(rf =>
        lhs.some(lf =>
            rf.mapTileKey === lf.mapTileKey && rf.featureId === lf.featureId));
}

export function featureSetContains(container: TileFeatureId[], maybeSubset: TileFeatureId[]) {
    if (!maybeSubset.length) {
        return false;
    }
    return maybeSubset.every(candidate => container.some(item =>
        item.mapTileKey === candidate.mapTileKey && item.featureId == candidate.featureId));
}
