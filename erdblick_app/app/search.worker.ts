import {coreLib, initializeLibrary, uint8ArrayToWasm} from "./wasm";
import {TileFeatureLayer} from "../../build/libs/core/erdblick-core";
import {PointPrimitiveCollection} from "./cesium";

export interface SearchWorkerTask {
    tileBlob: Uint8Array;
    fieldDictStreamMessage: Uint8Array;
    query: string;
    dataSourceInfo: string;
}

export interface SearchResultForTile {
    query: string;
    numFeatures: number;
    matches: Array<[string, string, [number, number, number]]>;  // Array of (MapTileKey, FeatureId, (x, y, z))
    pointPrimitiveIndices?: Array<number>;  // Used by search service for visualization.
}

self.onmessage = async (event) => {
    // Initialize WASM if not already done.
    await initializeLibrary();

    // Parse the tile.
    let task = event.data as SearchWorkerTask;
    let parser = new coreLib.TileLayerParser();
    uint8ArrayToWasm(data=>parser.setDataSourceInfo(data), task.dataSourceInfo);
    uint8ArrayToWasm(data=>parser.readFieldDictUpdate(data), task.fieldDictStreamMessage);
    let tile: TileFeatureLayer = uint8ArrayToWasm(data=>parser.readTileFeatureLayer(data), task.tileBlob);
    let numFeatures = tile.numFeatures();

    // Get the query results from the tile.
    let search = new coreLib.FeatureLayerSearch(tile);
    let matchingFeatures = search.filter(task.query);
    search.delete();
    tile.delete();

    // Post result back to the main thread.
    let result: SearchResultForTile = {
        query: task.query,
        numFeatures: numFeatures,
        matches: matchingFeatures
    };
    self.postMessage({ id: event.data.id, result: result });
};
