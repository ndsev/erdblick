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

/// Used to create and manage the visualization of one visual batch
export class MapViewerBatch
{
// public:
    constructor(batchName, tileFeatureLayer)
    {
        this.id = batchName;
        this.children = undefined;
        this.tileFeatureLayer = tileFeatureLayer;
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
    }
}
