import {uint8ArrayFromWasm, uint8ArrayToWasm, uint8ArrayToWasmAsync} from "../integrations/wasm";
import {TileLayerParser, TileFeatureLayer} from '../../build/libs/core/erdblick-core';
import {TileFeatureId} from "../shared/appstate.service";
import {TileLoadState} from "./tilestream";

interface WasmFeatureTileCacheEntry {
    tileBlob: Uint8Array;
    layer: TileFeatureLayer;
    pinCount: number;
    evictWhenReleased: boolean;
}

class WasmFeatureTileCache {
    private readonly entries = new Map<string, WasmFeatureTileCacheEntry>();
    private readonly maxEntries: number;

    constructor(maxEntries: number = 1000) {
        this.maxEntries = Math.max(1, maxEntries);
    }

    withLayer<T>(
        tileKey: string,
        tileBlob: Uint8Array,
        deserialize: () => TileFeatureLayer | null,
        callback: (layer: TileFeatureLayer) => T
    ): T | null {
        const cachedEntry = this.getUsableEntry(tileKey, tileBlob);
        if (cachedEntry) {
            cachedEntry.pinCount += 1;
            try {
                return callback(cachedEntry.layer);
            } finally {
                this.releaseEntry(tileKey, cachedEntry);
            }
        }

        const layer = deserialize();
        if (!layer) {
            return null;
        }

        const existing = this.entries.get(tileKey);
        if (existing && existing.pinCount > 0) {
            // Do not replace an in-use entry. Use a temporary layer without caching.
            try {
                return callback(layer);
            } finally {
                layer.delete();
            }
        }
        if (existing) {
            this.deleteEntry(tileKey, existing);
        }

        const entry: WasmFeatureTileCacheEntry = {
            tileBlob,
            layer,
            pinCount: 1,
            evictWhenReleased: false
        };
        this.entries.set(tileKey, entry);
        this.evictIfNeeded();
        try {
            return callback(layer);
        } finally {
            this.releaseEntry(tileKey, entry);
        }
    }

    async withLayerAsync<T>(
        tileKey: string,
        tileBlob: Uint8Array,
        deserialize: () => TileFeatureLayer | null,
        callback: (layer: TileFeatureLayer) => Promise<T>
    ): Promise<T | null> {
        const cachedEntry = this.getUsableEntry(tileKey, tileBlob);
        if (cachedEntry) {
            cachedEntry.pinCount += 1;
            try {
                return await callback(cachedEntry.layer);
            } finally {
                this.releaseEntry(tileKey, cachedEntry);
            }
        }

        const layer = deserialize();
        if (!layer) {
            return null;
        }

        const existing = this.entries.get(tileKey);
        if (existing && existing.pinCount > 0) {
            // Do not replace an in-use entry. Use a temporary layer without caching.
            try {
                return await callback(layer);
            } finally {
                layer.delete();
            }
        }
        if (existing) {
            this.deleteEntry(tileKey, existing);
        }

        const entry: WasmFeatureTileCacheEntry = {
            tileBlob,
            layer,
            pinCount: 1,
            evictWhenReleased: false
        };
        this.entries.set(tileKey, entry);
        this.evictIfNeeded();
        try {
            return await callback(layer);
        } finally {
            this.releaseEntry(tileKey, entry);
        }
    }

    invalidate(tileKey: string): void {
        const entry = this.entries.get(tileKey);
        if (!entry) {
            return;
        }
        if (entry.pinCount > 0) {
            entry.evictWhenReleased = true;
            return;
        }
        this.deleteEntry(tileKey, entry);
    }

    private getUsableEntry(tileKey: string, tileBlob: Uint8Array): WasmFeatureTileCacheEntry | null {
        const entry = this.entries.get(tileKey);
        if (!entry) {
            return null;
        }
        if (entry.tileBlob !== tileBlob) {
            if (entry.pinCount > 0) {
                entry.evictWhenReleased = true;
            } else {
                this.deleteEntry(tileKey, entry);
            }
            return null;
        }
        this.touchEntry(tileKey, entry);
        return entry;
    }

    private releaseEntry(tileKey: string, entry: WasmFeatureTileCacheEntry): void {
        if (entry.pinCount > 0) {
            entry.pinCount -= 1;
        }
        if (entry.pinCount > 0) {
            return;
        }
        if (entry.evictWhenReleased) {
            this.deleteEntry(tileKey, entry);
            return;
        }
        this.evictIfNeeded();
    }

    private touchEntry(tileKey: string, entry: WasmFeatureTileCacheEntry): void {
        this.entries.delete(tileKey);
        this.entries.set(tileKey, entry);
    }

    private deleteEntry(tileKey: string, entry: WasmFeatureTileCacheEntry): void {
        const current = this.entries.get(tileKey);
        if (current !== entry) {
            return;
        }
        this.entries.delete(tileKey);
        entry.layer.delete();
    }

    private evictIfNeeded(): void {
        if (this.entries.size <= this.maxEntries) {
            return;
        }
        for (const [key, entry] of this.entries) {
            if (this.entries.size <= this.maxEntries) {
                return;
            }
            if (entry.pinCount > 0) {
                continue;
            }
            this.deleteEntry(key, entry);
        }
    }
}

/**
 * JS interface of a WASM TileFeatureLayer.
 * The WASM TileFeatureLayer object is stored as a blob when not needed,
 * to keep the memory usage within reasonable limits. To use the wrapped
 * WASM TileFeatureLayer, use the peek()-function.
 */
export class FeatureTile {
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
    preventCulling: boolean = false;
    public tileFeatureLayerBlob: Uint8Array | null = null;
    disposed: boolean = false;
    status: TileLoadState = TileLoadState.LoadingQueued;
    stats: Map<string, number[]> = new Map<string, number[]>();

    static statTileSize = "Size/Feature-Model#kb";
    static statParseTime = "Rendering/Feature-Model-Parsing#ms";
    private static readonly WASM_FEATURE_TILE_CACHE_LIMIT = 50;
    private static readonly wasmFeatureTileCache =
        new WasmFeatureTileCache(FeatureTile.WASM_FEATURE_TILE_CACHE_LIMIT);

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

    hydrateFromBlob(tileFeatureLayerBlob: Uint8Array) {
        FeatureTile.wasmFeatureTileCache.invalidate(this.cacheKey());
        const mapTileMetadata = uint8ArrayToWasm((wasmBlob: any) => {
            return this.parser.readTileLayerMetadata(wasmBlob);
        }, tileFeatureLayerBlob);

        this.tileFeatureLayerBlob = tileFeatureLayerBlob;
        this.fieldDictBlobCache = null;
        this.dataSourceInfoBlobCache = null;
        this.featureIdByIndexCache.clear();
        if (this.mapTileKey === "undefined") {
            this.mapTileKey = mapTileMetadata.id as string;
        } else if (this.mapTileKey !== mapTileMetadata.id) {
            console.warn(`Hydrating tile with mismatched key. Existing=${this.mapTileKey}, Parsed=${mapTileMetadata.id}`);
        }
        this.nodeId = mapTileMetadata.nodeId as string;
        this.mapName = mapTileMetadata.mapName as string;
        this.layerName = mapTileMetadata.layerName as string;
        this.tileId = mapTileMetadata.tileId;
        this.legalInfo = mapTileMetadata.legalInfo as string;
        this.error = mapTileMetadata.error ? mapTileMetadata.error as string : undefined;
        this.numFeatures = mapTileMetadata.numFeatures;
        this.status = this.error ? TileLoadState.Error : TileLoadState.Ok;

        const parseTimes = this.stats.get(FeatureTile.statParseTime) ?? [];
        this.stats = new Map<string, number[]>();
        this.stats.set(FeatureTile.statParseTime, parseTimes);
        this.stats.set(FeatureTile.statTileSize, [tileFeatureLayerBlob.length/1024]);
        for (let [k, v] of Object.entries(mapTileMetadata.scalarFields)) {
            this.stats.set(k, [v as number]);
        }
    }

    hasData(): boolean {
        return !!this.tileFeatureLayerBlob;
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

    private cacheKey(): string {
        if (this.mapTileKey !== "undefined" && this.mapTileKey.length > 0) {
            return this.mapTileKey;
        }
        return `${this.mapName}/${this.layerName}/${this.tileId.toString()}`;
    }

    private recordParseTime(durationMs: number): void {
        const parseTimes = this.stats.get(FeatureTile.statParseTime);
        if (parseTimes) {
            parseTimes.push(durationMs);
        } else {
            this.stats.set(FeatureTile.statParseTime, [durationMs]);
        }
    }

    private deserializeTileFeatureLayer(tileBlob: Uint8Array): TileFeatureLayer | null {
        return uint8ArrayToWasm((bufferToRead: any) => {
            const startTime = performance.now();
            const deserializedLayer = this.parser.readTileFeatureLayer(bufferToRead);
            const endTime = performance.now();
            if (!deserializedLayer) {
                return null;
            }
            this.recordParseTime(endTime - startTime);
            return deserializedLayer;
        }, tileBlob);
    }

    /**
     * Provide temporary access to a deserialized TileFeatureLayer.
     * Layers are cached in an LRU cache to avoid repeated deserialization.
     * @returns The value returned by the callback.
     */
    peek(callback: (layer: TileFeatureLayer) => any) {
        const tileBlob = this.tileFeatureLayerBlob;
        if (!tileBlob) {
            return null;
        }
        return FeatureTile.wasmFeatureTileCache.withLayer(
            this.cacheKey(),
            tileBlob,
            () => this.deserializeTileFeatureLayer(tileBlob),
            callback
        );
    }

    /**
     * Async version of the above function.
     */
    async peekAsync(callback: (layer: TileFeatureLayer) => Promise<any>) {
        const tileBlob = this.tileFeatureLayerBlob;
        if (!tileBlob) {
            return null;
        }
        return await FeatureTile.wasmFeatureTileCache.withLayerAsync(
            this.cacheKey(),
            tileBlob,
            () => this.deserializeTileFeatureLayer(tileBlob),
            callback
        );
    }

    /**
     * Mark this tile as "not available anymore".
     */
    dispose() {
        FeatureTile.wasmFeatureTileCache.invalidate(this.cacheKey());
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
            let feature = tileFeatureLayer.find(this.featureId);
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
