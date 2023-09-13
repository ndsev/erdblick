"use strict";

import {blobUriFromWasm, uint8ArrayFromWasm, uint8ArrayToWasm} from "./wasm.js";

/**
 * Bundle of a WASM TileFeatureLayer and a rendered representation
 * in the form of a Cesium 3D TileSet which references a binary GLTF tile.
 * The tileset JSON and the GLTF blob are stored as browser Blob objects
 * (see https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static).
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
        this.glbUrl = null;
        this.tileSetUrl = null;
        this.tileSet = null;
        this.disposed = false;
    }

    /**
     * Convert this TileFeatureLayer to a Cesium TileSet which
     * contains a single tile. Returns a promise which resolves to true,
     * if there is a freshly baked Cesium3DTileset, or false,
     * if no output was generated because the tile is empty.
     * @param {*} glbConverter The WASM GLTF converter that should be used.
     * @param {null} style The style that is used to make the conversion.
     */
    async render(glbConverter, style)
    {
        // Start timer
        let startOverall = performance.now();

        // Remove any previous render-result, as a new one is generated
        // TODO: Ensure that the View also takes note of the removed Cesium3DTile.
        //  This will become apparent once interactive re-styling is a prime use-case.
        this.disposeRenderResult();

        let startGLBConversion = performance.now();
        let origin = null;
        this.peek(tileFeatureLayer => {
            this.glbUrl = blobUriFromWasm(this.coreLib, sharedBuffer => {
                origin = glbConverter.render(style, tileFeatureLayer, sharedBuffer);
                if (sharedBuffer.getSize() === 0)
                    return false;
            }, "model/gltf-binary");
        });
        let endGLBConversion = performance.now();
        console.debug(`[${this.id}] GLB conversion time: ${endGLBConversion - startGLBConversion}ms`);

        // The GLB URL will be null if there were no features to render.
        if (this.glbUrl === null)
            return false;

        let startTilesetConversion = performance.now();
        this.tileSetUrl = blobUriFromWasm(this.coreLib, sharedBuffer => {
            glbConverter.makeTileset(this.glbUrl, origin, sharedBuffer);
        }, "application/json");
        let endTilesetConversion = performance.now();
        console.debug(`[${this.id}] Tileset conversion time: ${endTilesetConversion - startTilesetConversion}ms`);

        let startTilesetFromUrl = performance.now();
        this.tileSet = await Cesium.Cesium3DTileset.fromUrl(this.tileSetUrl, {
            featureIdLabel: "mapgetFeatureIndex"
        })

        let endTilesetFromUrl = performance.now();
        console.debug(`[${this.id}] Cesium tileset from URL time: ${endTilesetFromUrl - startTilesetFromUrl}ms`);

        let endOverall = performance.now();
        console.debug(`[${this.id}] Overall execution time: ${endOverall - startOverall}ms`);

        return true;
    }

    /**
     * Deserialize the wrapped TileFeatureLayer, run a callback, then
     * delete the deserialized WASM representation.
     * @returns The value returned by the callback.
     */
    peek(callback) {
        // For the first call to peek, the tileFeatureLayer member
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
        if (!this.tileSet)
            return;
        if (!this.tileSet.isDestroyed)
            this.tileSet.destroy();

        this.tileSet = null;
        URL.revokeObjectURL(this.tileSetUrl);
        this.tileSetUrl = null;
        URL.revokeObjectURL(this.glbUrl);
        this.glbUrl = null;
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
        console.debug(`[${this.id}] Disposed.`);
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
