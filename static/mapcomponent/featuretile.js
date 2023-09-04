"use strict";

/**
 * Run a WASM function which places data in a SharedUint8Array,
 * and then store this data under an object URL. Will be aborted
 * and return null, if the user function returns false.
 */
function blobUriFromWasm(coreLib, fun, contentType) {
    let sharedGlbArray = new coreLib.SharedUint8Array();
    if (fun(sharedGlbArray) === false) {
        sharedGlbArray.delete();
        return null;
    }
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
export class FeatureTile
{
// public:
    constructor(tileFeatureLayer)
    {
        this.id = tileFeatureLayer.id();
        this.tileId = tileFeatureLayer.tileId();
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
        // Start timer
        let startOverall = performance.now();

        this.disposeRenderResult();

        let startGLBConversion = performance.now();
        let origin = null;
        this.glbUrl = blobUriFromWasm(coreLib, sharedBuffer => {
            origin = glbConverter.render(style, this.tileFeatureLayer, sharedBuffer);
            if (sharedBuffer.getSize() === 0)
                return false;
        }, "model/gltf-binary");
        let endGLBConversion = performance.now();
        console.log(`GLB conversion time: ${endGLBConversion - startGLBConversion}ms`);

        // The GLB URL will be null if there were no features to render.
        if (this.glbUrl === null)
            return;

        let startTilesetConversion = performance.now();
        this.tileSetUrl = blobUriFromWasm(coreLib, sharedBuffer => {
            glbConverter.makeTileset(this.glbUrl, origin, sharedBuffer);
        }, "application/json");
        let endTilesetConversion = performance.now();
        console.log(`Tileset conversion time: ${endTilesetConversion - startTilesetConversion}ms`);

        let startTilesetFromUrl = performance.now();
        Cesium.Cesium3DTileset.fromUrl(this.tileSetUrl, {
            featureIdLabel: "mapgetFeatureIndex"
        }).then(tileSet => {
            this.tileSet = tileSet;
            onResult(this);

            let endTilesetFromUrl = performance.now();
            console.log(`Cesium tileset from URL time: ${endTilesetFromUrl - startTilesetFromUrl}ms`);

            let endOverall = performance.now();
            console.log(`Overall execution time: ${endOverall - startOverall}ms`);
        });
    }

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

    dispose()
    {
        this.disposeRenderResult();
        this.tileFeatureLayer.delete();
        this.tileFeatureLayer = null;
    }
}

/**
 * Wrapper which combines a FeatureTile and the index of
 * a feature within the tileset. Using the peek-function, it is
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
