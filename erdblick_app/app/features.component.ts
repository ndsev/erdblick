"use strict";

import { uint8ArrayToWasm } from "./wasm";

/**
 * JS interface of a WASM TileFeatureLayer.
 * The WASM TileFeatureLayer object is stored as a blob when not needed,
 * to keep the memory usage within reasonable limits. To use the wrapped
 * WASM TileFeatureLayer, use the peek()-function.
 */
export class FeatureTile {
    // public:
    id: number;
    tileId: number;
    numFeatures: number;
    coreLib: any;
    private parser: any;
    preventCulling: boolean;
    private tileFeatureLayerBlob: any;
    private primitiveCollection: any;
    disposed: boolean;

    /**
     * Construct a FeatureTile object.
     * @param coreLib Reference to the WASM erdblick library.
     * @param parser Singleton TileLayerStream WASM object.
     * @param tileFeatureLayerBlob Serialized TileFeatureLayer.
     * @param preventCulling Set to true to prevent the tile from being removed when it isn't visible.
     */
    constructor(coreLib: any, parser: any, tileFeatureLayerBlob: any, preventCulling: any) {
        let mapTileMetadata = uint8ArrayToWasm(coreLib, (wasmBlob: any) => {
            return parser.readTileLayerMetadata(wasmBlob);
        }, tileFeatureLayerBlob);
        this.id = mapTileMetadata.id;
        this.tileId = mapTileMetadata.tileId;
        this.numFeatures = mapTileMetadata.numFeatures;
        this.coreLib = coreLib;
        this.parser = parser;
        this.preventCulling = preventCulling;
        this.tileFeatureLayerBlob = tileFeatureLayerBlob;
        this.primitiveCollection = null;
        this.disposed = false;
    }

    /**
     * Deserialize the wrapped TileFeatureLayer, run a callback, then
     * delete the deserialized WASM representation.
     * @returns The value returned by the callback.
     */
    peek(callback: any) {
        // Deserialize the WASM tileFeatureLayer from the blob.
        return uint8ArrayToWasm(this.coreLib, (bufferToRead: any) => {
            let deserializedLayer = this.parser.readTileFeatureLayer(bufferToRead);
            // Run the callback with the deserialized layer, and
            // provide the result as the return value.
            if (callback) {
                return callback(deserializedLayer);
            }
            deserializedLayer.delete();
        }, this.tileFeatureLayerBlob);
    }

    /**
     * Mark this tile as "not available anymore".
     */
    private destroy() {
        this.disposed = true;
    }
}

/**
 * Wrapper which combines a FeatureTile and the index of
 * a feature within the tileset. Using the peek-function, it is
 * possible to access the WASM feature view in a memory-safe way.
 */
export class FeatureWrapper {
    private index: number;
    private featureTile: FeatureTile;

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
