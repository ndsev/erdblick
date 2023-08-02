"use strict";

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

    async fetchMockData()
    {
        // TODO: Use the tile id to pick the correct 3D tile

        // Download the glb file
        const urlToGlb = "/3dtiles/545356699.glb"
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to download glb: ${response.status} ${response.statusText}`);
        }
        const glbBinaryData = await response.arrayBuffer();
        const blob = new Blob([glbBinaryData], { type: 'model/gltf-binary' });
        const glbUrl = URL.createObjectURL(blob);

        // Download the 3D TileSet descriptor (in JSON format)
        const urlToTileSet = "/3dtiles/545356699.json"
        const tsResponse = await fetch(url);
        if (!tsResponse.ok) {
            throw new Error(`Failed to download tileset: ${tsResponse.status} ${tsResponse.statusText}`);
        }
        const tileSetJson = await response.json().toString();
        // TODO: Replace the uri with the one of the blob
        // TODO: The 3D tileSet has to use the glb URL
        //root.content->uri = tileNumber + ".glb";
        const tileSetBlob = new Blob([tileSetJson], { type: 'application/json' });
        const tileSetUrl = URL.createObjectURL(tileSetBlob);

        this.glbUrl = glbUrl;
        this.tileSetUrl = tileSetUrl;
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

        Cesium.Cesium3DTileset.fromUrl(this.tileSetUrl).then(tileSet => {
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
