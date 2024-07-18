import {coreLib, initializeLibrary, uint8ArrayToWasm} from "./wasm";
import {TileFeatureLayer} from "../../build/libs/core/erdblick-core";

export interface SearchWorkerTask {
    tileId: bigint;
    tileBlob: Uint8Array;
    fieldDictBlob: Uint8Array;
    query: string;
    dataSourceInfo: Uint8Array;
    nodeId: string;
}

export interface SearchResultPosition {
    cartesian: {x: number, y: number, z: number},
    cartographic: {x: number, y: number, z: number} | null,
    cartographicRad: {longitude: number, latitude: number, height: number}
}

export interface SearchResultForTile {
    tileId: bigint;
    query: string;
    numFeatures: number;
    matches: Array<[string, string, SearchResultPosition]>;  // Array of (MapTileKey, FeatureId, SearchResultPosition)
    billboardPrimitiveIndices?: Array<number>;  // Used by search service for visualization.
    error: null|string
}

addEventListener('message', async ({data}) => {
    // Initialize WASM if not already done.
    await initializeLibrary();
    let task = data as SearchWorkerTask;

    try {
        // Parse the tile.
        let parser = new coreLib.TileLayerParser();
        uint8ArrayToWasm(data => parser.setDataSourceInfo(data), task.dataSourceInfo);
        uint8ArrayToWasm(data => parser.addFieldDict(data), task.fieldDictBlob);
        let tile: TileFeatureLayer = uint8ArrayToWasm(data => parser.readTileFeatureLayer(data), task.tileBlob);
        const numFeatures = tile.numFeatures();
        const tileId = tile.tileId();

        // Get the query results from the tile.
        let search = new coreLib.FeatureLayerSearch(tile);
        const matchingFeatures = search.filter(task.query);
        search.delete();
        tile.delete();

        // Post result back to the main thread.
        let result: SearchResultForTile = {
            tileId: tileId,
            query: task.query,
            numFeatures: numFeatures,
            matches: matchingFeatures,
            error: null
        };
        postMessage(result);
    }
    catch (someException: any) {
        let error = someException as Error
        let result: SearchResultForTile = {
            tileId: 0n,
            query: task.query,
            numFeatures: 0,
            matches: [],
            error: `${error.name}: ${error.message}`
        };
        postMessage(result);
    }
});
