"use strict";

import {uint8ArrayToWasm} from "./wasm.js";

/**
 * JS interface of a WASM TileFeatureLayer.
 * The WASM TileFeatureLayer object is stored as a blob when not needed,
 * to keep the memory usage within reasonable limits. To use the wrapped
 * WASM TileFeatureLayer, use the peek()-function.
 */
export class FeatureTile
{
// public:

    /**
     * Construct a FeatureTile object.
     * @param coreLib Reference to the WASM erdblick library.
     * @param parser Singleton TileLayerStream WASM object.
     * @param tileFeatureLayerBlob Serialized TileFeatureLayer.
     * @param preventCulling Set to true to prevent the tile from being removed when it isn't visible.
     */
    constructor(coreLib, parser, tileFeatureLayerBlob, preventCulling)
    {
        let mapTileMetadata = uint8ArrayToWasm(coreLib, wasmBlob => {
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
    peek(callback) {
        // Deserialize the WASM tileFeatureLayer from the blob.
        return uint8ArrayToWasm(this.coreLib, bufferToRead => {
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
    destroy()
    {
        this.disposed = true;
    }
}

/**
 * Wrapper which combines a FeatureTile and the index of
 * a feature within the tileset. Using the peek-function, it is
 * possible to access the WASM feature view in a memory-safe way.
 */
export class FeatureWrapper
{
    /**
     * Construct a feature wrapper from a featureTile and a feature index
     * within that tile.
     * @param index The index of the feature within the tile.
     * @param featureTile {FeatureTile} The feature tile container.
     */
    constructor(index, featureTile) {
        this.index = index;
        this.featureTile = featureTile;
    }

    /**
     * Run a callback with the WASM Feature object referenced by this wrapper.
     * The feature object will be deleted after the callback is called.
     * @returns The value returned by the callback.
     */
    peek(callback) {
        if (this.featureTile.disposed) {
            throw new Error(`Unable to access feature of deleted layer ${this.featureTile.id}!`);
        }
        return this.featureTile.peek(tileFeatureLayer => {
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
