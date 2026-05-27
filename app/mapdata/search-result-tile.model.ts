import {TileLayerParser} from "../../build/libs/core/erdblick-core";
import {uint8ArrayFromWasm} from "../integrations/wasm";
import type {TileVisualizationTile} from "../mapview/render-view.model";
import {FeatureTile} from "./features.model";

export interface SearchResultTileUpdate {
    refresh: number;
    nodeId: string;
    layerBlob: Uint8Array;
}

/** Render-scheduler model for one streamed TileSearchResultLayer. */
export class SearchResultTile implements TileVisualizationTile {
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
        update: SearchResultTileUpdate
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
        this.refresh = update.refresh;
        this.nodeId = update.nodeId;
        this.layerBlob = update.layerBlob;
        this.stats.set(FeatureTile.statParseTime, []);
    }

    /** Clears cached datasource metadata after `/sources` reloads the shared parser. */
    static clearDataSourceInfoBlobCache(): void {
        SearchResultTile.dataSourceInfoBlobCacheByMapName.clear();
    }

    /** Replaces the streamed result layer payload and marks dependent renderers dirty. */
    update(update: SearchResultTileUpdate): void {
        this.refresh = update.refresh;
        this.nodeId = update.nodeId || this.nodeId;
        this.layerBlob = update.layerBlob;
        this.fieldDictBlobCache = null;
        this.dataVersion += 1;
        this.disposed = false;
    }

    /** Marks this search-result tile as no longer renderable. */
    dispose(): void {
        this.disposed = true;
        this.fieldDictBlobCache = null;
        this.layerBlob = new Uint8Array();
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
