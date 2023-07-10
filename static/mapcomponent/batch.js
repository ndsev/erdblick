"use strict";

import {GLTFLoader} from "../deps/GLTFLoader.js";

let gltfLoader = new GLTFLoader();

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
        if (this.children) {
            this.disposeChildren()
        }

        // Get the scene as GLB and visualize it.
        let sharedGlbArray = new coreLib.SharedUint8Array();
        glbConverter.render(style, this.tileFeatureLayer, sharedGlbArray);
        let objSize = sharedGlbArray.getSize();
        let bufferPtr = Number(sharedGlbArray.getPointer());
        let glbBuf = coreLib.HEAPU8.buffer.slice(bufferPtr, bufferPtr + objSize);

        gltfLoader.parse(
            glbBuf,
            "",
            // called once the gltf resource is loaded
            ( gltf ) =>
            {
                this.children = gltf.scene.children;
                onResult(this);
                sharedGlbArray.delete()
            },
            // called when loading has errors
            ( error ) => {
                // Don't spam errors when fetching fails because the server retracted a batch
                if(error.message && !error.message.endsWith("glTF versions >=2.0 are supported."))
                    console.warn( `GLB load error: ${this.id}: ${error.message}` );
                sharedGlbArray.delete()
            }
        )
    }

    disposeChildren()
    {
        this.children.forEach( (root) =>
        {
            if (!root)
                return;

            root.traverse((node) => {
                if (node.geometry)
                    node.geometry.dispose();

                if (node.material)
                {
                    if (node.material instanceof MeshFaceMaterial || node.material instanceof MultiMaterial) {
                        node.material.materials.forEach((mtrl) => {
                            if (mtrl.map) mtrl.map.dispose();
                            if (mtrl.lightMap) mtrl.lightMap.dispose();
                            if (mtrl.bumpMap) mtrl.bumpMap.dispose();
                            if (mtrl.normalMap) mtrl.normalMap.dispose();
                            if (mtrl.specularMap) mtrl.specularMap.dispose();
                            if (mtrl.envMap) mtrl.envMap.dispose();

                            mtrl.dispose();    // disposes any programs associated with the material
                        });
                    }
                    else {
                        if (node.material.map) node.material.map.dispose();
                        if (node.material.lightMap) node.material.lightMap.dispose();
                        if (node.material.bumpMap) node.material.bumpMap.dispose();
                        if (node.material.normalMap) node.material.normalMap.dispose();
                        if (node.material.specularMap) node.material.specularMap.dispose();
                        if (node.material.envMap) node.material.envMap.dispose();

                        node.material.dispose();   // disposes any programs associated with the material
                    }
                }
            });
        });
    }

    dispose()
    {
        this.disposeChildren()
        this.tileFeatureLayer.delete()
    }
}
