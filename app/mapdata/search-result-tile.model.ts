import {TileLayerParser} from "../../build/libs/core/erdblick-core";
import {uint8ArrayFromWasm} from "../integrations/wasm";
import type {RenderableTileLayer} from "../mapview/render-view.model";
import {FeatureTile} from "./features.model";

export interface SearchResultTileUpdate {
    refresh: number;
    nodeId: string;
    layerBlob: Uint8Array;
    resultCount: number;
}

/** Runtime data tile for one search/source-tile pair, optionally backed by a streamed TileSearchResultLayer. */
export class SearchResultTile implements RenderableTileLayer {
    private static dataSourceInfoBlobCacheByMapName: Map<string, Uint8Array> = new Map<string, Uint8Array>();

    readonly searchId: string;
    readonly sourceTileKey: string;
    readonly sourceMapId: string;
    readonly sourceLayerId: string;
    readonly sourceTileId: bigint;
    mapTileKey: string;
    nodeId: string;
    mapName: string;
    layerName: string;
    tileId: bigint;
    refresh: number;
    priority: boolean;
    requested = false;
    completed = false;
    resultCount = 0;
    layerBlob: Uint8Array;
    dataVersion = 0;
    disposed = false;
    stats: Map<string, number[]> = new Map<string, number[]>();

    private readonly parser: TileLayerParser;
    private fieldDictBlobCache: Uint8Array | null = null;
    private renderOrderRank = FeatureTile.DEFAULT_RENDER_ORDER;
    private vertexCountCache: number | null = null;

    constructor(
        parser: TileLayerParser,
        searchId: string,
        sourceTileKey: string,
        sourceMapId: string,
        sourceLayerId: string,
        sourceTileId: bigint,
        refresh: number,
        priority: boolean
    ) {
        this.parser = parser;
        this.searchId = searchId;
        this.sourceTileKey = sourceTileKey;
        this.sourceMapId = sourceMapId;
        this.sourceLayerId = sourceLayerId;
        this.sourceTileId = sourceTileId;
        this.mapTileKey = sourceTileKey;
        this.mapName = sourceMapId;
        this.layerName = sourceLayerId;
        this.tileId = sourceTileId;
        this.refresh = refresh;
        this.priority = priority;
        this.nodeId = "";
        this.layerBlob = new Uint8Array();
        this.stats.set(FeatureTile.statParseTime, []);
    }

    /** Clears cached datasource metadata after `/sources` reloads the shared parser. */
    static clearDataSourceInfoBlobCache(): void {
        SearchResultTile.dataSourceInfoBlobCacheByMapName.clear();
    }

    /** Returns whether this source tile currently has renderable search-result layer data. */
    hasResultLayer(): boolean {
        return !this.disposed && this.resultCount > 0 && this.layerBlob.length > 0;
    }

    /** Replaces the streamed result layer payload and marks dependent renderers dirty. */
    update(update: SearchResultTileUpdate): void {
        this.refresh = update.refresh;
        this.nodeId = update.nodeId || this.nodeId;
        this.layerBlob = update.layerBlob;
        this.resultCount = Math.max(0, Math.floor(update.resultCount));
        this.fieldDictBlobCache = null;
        this.dataVersion += 1;
        this.disposed = false;
        this.completed = true;
        this.requested = false;
    }

    /** Marks the source tile complete when mapget returned no result layer data for it. */
    markCompletedEmpty(refresh: number): void {
        this.refresh = refresh;
        this.resultCount = 0;
        this.nodeId = "";
        this.layerBlob = new Uint8Array();
        this.fieldDictBlobCache = null;
        this.completed = true;
        this.requested = false;
        this.disposed = false;
        this.dataVersion += 1;
    }

    /** Makes an unfinished tile eligible for another backend request. */
    markPending(): void {
        if (!this.completed) {
            this.requested = false;
        }
    }

    /** Marks this search-result tile as no longer part of the active search area. */
    dispose(): void {
        this.disposed = true;
        this.fieldDictBlobCache = null;
        this.layerBlob = new Uint8Array();
        this.resultCount = 0;
        this.dataVersion += 1;
    }

    /** Stores a caller-provided vertex count estimate from the renderer. */
    setVertexCount(count: number): void {
        this.vertexCountCache = Math.max(0, Math.floor(count));
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

    /** Returns the serialized field dictionary for this datasource node. */
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
        if (!this.mapName.length) {
            return null;
        }
        const cached = SearchResultTile.dataSourceInfoBlobCacheByMapName.get(this.mapName);
        if (cached) {
            return cached;
        }
        const encoded = uint8ArrayFromWasm((buf) => {
            this.parser.getDataSourceInfo(buf, this.mapName);
            return true;
        });
        if (!encoded) {
            return null;
        }
        SearchResultTile.dataSourceInfoBlobCacheByMapName.set(this.mapName, encoded);
        return encoded;
    }
}
