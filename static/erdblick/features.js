"use strict";

import {uint8ArrayFromWasm, uint8ArrayToWasm} from "./wasm.js";

/**
 * Bundle of a WASM TileFeatureLayer and a rendered representation
 * in the form of a Cesium PrimitiveCollection.
 *
 * The WASM TileFatureLayer object is stored as a blob when not needed,
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
     * @param tileFeatureLayer Deserialized WASM TileFeatureLayer.
     */
    constructor(coreLib, parser, tileFeatureLayer)
    {
        this.coreLib = coreLib;
        this.parser = parser;
        this.id = tileFeatureLayer.id();
        this.tileId = tileFeatureLayer.tileId();
        this.children = undefined;
        this.tileFeatureLayerInitDeserialized = tileFeatureLayer;
        this.tileFeatureLayerSerialized = null;
        this.primitiveCollection = null;
        this.disposed = false;
    }

    /**
     * Convert this TileFeatureLayer to a Cesium TileSet which
     * contains a single tile. Returns a promise which resolves to true,
     * if there is a freshly baked Cesium3DTileset, or false,
     * if no output was generated because the tile is empty.
     * @param {*} cesiumConverter The Cesium primitive renderer that should be used.
     * @param {null} style The style that is used to make the conversion.
     */
    async render(cesiumConverter, style)
    {
        // Do not try to render if the underlying data is disposed.
        if (this.disposed)
            return false;

        // Remove any previous render-result, as a new one is generated.
        // TODO: Ensure that the View also takes note of the removed PrimitiveCollection.
        //  This will become apparent once interactive re-styling is a prime use-case.
        this.disposeRenderResult();

        this.peek(tileFeatureLayer => {
            this.primitiveCollection = cesiumConverter.render(style, tileFeatureLayer);
        });

        // The primitive collection will be null if there were no features to render.
        return this.primitiveCollection !== null && this.primitiveCollection !== undefined;
    }

    /**
     * Deserialize the wrapped TileFeatureLayer, run a callback, then
     * delete the deserialized WASM representation.
     * @returns The value returned by the callback.
     */
    peek(callback) {
        // For the first call to peek, the tileFeatureLayerInitDeserialized member
        // is still set, and the tileFeatureLayerSerialized is not yet set.
        let deserializedLayer = this.tileFeatureLayerInitDeserialized;
        if (this.tileFeatureLayerInitDeserialized) {
            this.tileFeatureLayerInitDeserialized = null;
            this.tileFeatureLayerSerialized = uint8ArrayFromWasm(this.coreLib, bufferToWrite => {
                this.parser.writeTileFeatureLayer(deserializedLayer, bufferToWrite);
            });
        }

        if (!deserializedLayer) {
            // Deserialize the WASM tileFeatureLayer from the blob.
            console.assert(this.tileFeatureLayerSerialized);
            uint8ArrayToWasm(this.coreLib, bufferToRead => {
                deserializedLayer = this.parser.readTileFeatureLayer(bufferToRead);
            }, this.tileFeatureLayerSerialized);
        }

        // Run the callback with the deserialized layer, and
        // store the result as the return value.
        let result = null;
        if (callback) {
            result = callback(deserializedLayer);
        }

        // Clean up.
        deserializedLayer.delete();
        return result;
    }

    /**
     * Remove all data associated with a previous call to this.render().
     */
    disposeRenderResult()
    {
        if (!this.primitiveCollection)
            return;
        if (!this.primitiveCollection.isDestroyed())
            this.primitiveCollection.destroy();

        this.primitiveCollection = null;
    }

    /**
     * Clean up all data associated with this FeatureTile instance.
     */
    dispose()
    {
        this.disposeRenderResult();
        if (this.tileFeatureLayerInitDeserialized) {
            this.tileFeatureLayerInitDeserialized.delete();
            this.tileFeatureLayerInitDeserialized = null;
        }
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
