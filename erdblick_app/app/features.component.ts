"use strict";

import {uint8ArrayToWasm, uint8ArrayToWasmAsync} from "./wasm";
import { MainModule as ErdblickCore, TileLayerParser, TileFeatureLayer } from '../../build/libs/core/erdblick-core';

/**
 * JS interface of a WASM TileFeatureLayer.
 * The WASM TileFeatureLayer object is stored as a blob when not needed,
 * to keep the memory usage within reasonable limits. To use the wrapped
 * WASM TileFeatureLayer, use the peek()-function.
 */
export class FeatureTile {
    // public:
    id: string;
    mapName: string;
    layerName: string;
    tileId: bigint;
    numFeatures: number;
    coreLib: ErdblickCore;
    private parser: TileLayerParser;
    preventCulling: boolean;
    private readonly tileFeatureLayerBlob: any;
    disposed: boolean;

    /**
     * Construct a FeatureTile object.
     * @param coreLib Reference to the WASM erdblick library.
     * @param parser Singleton TileLayerStream WASM object.
     * @param tileFeatureLayerBlob Serialized TileFeatureLayer.
     * @param preventCulling Set to true to prevent the tile from being removed when it isn't visible.
     */
    constructor(coreLib: ErdblickCore, parser: TileLayerParser, tileFeatureLayerBlob: any, preventCulling: boolean) {
        let mapTileMetadata = uint8ArrayToWasm(coreLib, (wasmBlob: any) => {
            return parser.readTileLayerMetadata(wasmBlob);
        }, tileFeatureLayerBlob);
        this.id = mapTileMetadata.id;
        this.mapName = mapTileMetadata.mapName;
        this.layerName = mapTileMetadata.layerName;
        this.tileId = mapTileMetadata.tileId;
        this.numFeatures = mapTileMetadata.numFeatures;
        this.coreLib = coreLib;
        this.parser = parser;
        this.preventCulling = preventCulling;
        this.tileFeatureLayerBlob = tileFeatureLayerBlob;
        this.disposed = false;
    }

    /**
     * Deserialize the wrapped TileFeatureLayer, run a callback, then
     * delete the deserialized WASM representation.
     * @returns The value returned by the callback.
     */
    peek(callback: (layer: TileFeatureLayer) => any) {
        // Deserialize the WASM tileFeatureLayer from the blob.
        return uint8ArrayToWasm(this.coreLib, (bufferToRead: any) => {
            let deserializedLayer = this.parser.readTileFeatureLayer(bufferToRead);
            // Run the callback with the deserialized layer, and
            // provide the result as the return value.
            let result = null;
            if (callback) {
                result = callback(deserializedLayer);
            }
            deserializedLayer.delete();
            return result;
        }, this.tileFeatureLayerBlob);
    }

    /**
     * Async version of the above function.
     */
    async peekAsync(callback: (layer: TileFeatureLayer) => Promise<any>) {
        // Deserialize the WASM tileFeatureLayer from the blob.
        return await uint8ArrayToWasmAsync(this.coreLib, async (bufferToRead: any) => {
            let deserializedLayer = this.parser.readTileFeatureLayer(bufferToRead);
            // Run the callback with the deserialized layer, and
            // provide the result as the return value.
            let result = null;
            if (callback) {
                result = await callback(deserializedLayer);
            }
            deserializedLayer.delete();
            return result;
        }, this.tileFeatureLayerBlob);
    }

    /**
     * Mark this tile as "not available anymore".
     */
    destroy() {
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
}

/**
 * Wrapper which combines a FeatureTile and the index of
 * a feature within the tileset. Using the peek-function, it is
 * possible to access the WASM feature view in a memory-safe way.
 */
export class FeatureWrapper {
    private readonly index: number;
    public featureTile: FeatureTile;

    /**
     * Construct a feature wrapper from a featureTile and a feature index
     * within that tile.
     * @param index The index of the feature within the tile.
     * @param featureTile {FeatureTile} The feature tile container.
     */
    constructor(index: number, featureTile: FeatureTile) {
        this.index = index;
        this.featureTile = featureTile;
    }

    /**
     * Run a callback with the WASM Feature object referenced by this wrapper.
     * The feature object will be deleted after the callback is called.
     * @returns The value returned by the callback.
     */
    peek(callback: any) {
        if (this.featureTile.disposed) {
            throw new Error(`Unable to access feature of deleted layer ${this.featureTile.id}!`);
        }
        return this.featureTile.peek((tileFeatureLayer: any) => {
            let feature = tileFeatureLayer.at(this.index);
            let result = null;
            if (callback) {
                result = callback(feature);
            }
            feature.delete();
            return result;
        });
    }
}
