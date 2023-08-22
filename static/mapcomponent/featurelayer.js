"use strict";

/**
 * Run a WASM function which places data in a SharedUint8Array,
 * and then store this data under an object URL.
 */
function blobUriFromWasm(coreLib, fun, contentType) {
    let sharedGlbArray = new coreLib.SharedUint8Array();
    fun(sharedGlbArray);
    let objSize = sharedGlbArray.getSize();
    let bufferPtr = Number(sharedGlbArray.getPointer());
    let data = coreLib.HEAPU8.buffer.slice(bufferPtr, bufferPtr + objSize);
    const blob = new Blob([data], { type: contentType });
    const glbUrl = URL.createObjectURL(blob);
    sharedGlbArray.delete();
    return glbUrl;
}

/**
 * Bundle of a WASM TileFeatureLayer and a rendered representation
 * in the form of a Cesium 3D TileSet which references a binary GLTF tile.
 * The tileset JSON and the GLTF blob are stored as browser Blob objects
 * (see https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static).
 */
export class FeatureLayerTileSet
{
// public:
    constructor(batchName, tileFeatureLayer)
    {
        this.id = batchName;
        this.children = undefined;
        this.tileFeatureLayer = tileFeatureLayer;
        this.glbUrl = null;
        this.tileSetUrl = null;
        this.tileSet = null;
    }

    /**
     * Convert this batch's tile to GLTF and broadcast the result
     */
    render(coreLib, glbConverter, style, onResult)
    {
        this.disposeRenderResult();

        let origin = null;
        this.glbUrl = blobUriFromWasm(coreLib, sharedBuffer => {
            origin = glbConverter.render(style, this.tileFeatureLayer, sharedBuffer);
        }, "model/gltf-binary");

        this.tileSetUrl = blobUriFromWasm(coreLib, sharedBuffer => {
            glbConverter.makeTileset(this.glbUrl, origin, sharedBuffer);
        }, "application/json");

        Cesium.Cesium3DTileset.fromUrl(this.tileSetUrl, {
            featureIdLabel: "mapgetFeatureIndex"
        }).then(tileSet => {
            this.tileSet = tileSet;
            onResult(this);
        });
    }

    disposeRenderResult()
    {
        if (!this.tileSet)
            return;

        this.tileSet.destroy();
        this.tileSet = null;
        URL.revokeObjectURL(this.tileSetUrl);
        this.tileSetUrl = null;
        URL.revokeObjectURL(this.glbUrl);
        this.glbUrl = null;
    }

    dispose()
    {
        this.disposeRenderResult();
        this.tileFeatureLayer.delete();
        this.tileFeatureLayer = null;
    }
}

/**
 * Wrapper which combines a FeatureLayerTileSet and the index of
 * a feature within the tileset. Using the unwrap-function, it is
 * possible to access the WASM feature view in a memory-safe way.
 */
export class FeatureWrapper
{
    constructor(index, featureLayerTileSet) {
        this.index = index;
        this.featureLayerTileSet = featureLayerTileSet;
    }

    /**
     * Run a callback with the WASM Feature object referenced by this wrapper.
     * The feature object will be deleted after the callback is called.
     */
    peek(callback) {
        if (!this.featureLayerTileSet.tileFeatureLayer) {
            throw new RuntimeError("Unable to access feature of deleted layer.");
        }
        let feature = this.featureLayerTileSet.tileFeatureLayer.at(this.index);
        if (callback) {
            callback(feature);
        }
        feature.delete();
    }
}
