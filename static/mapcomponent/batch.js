"use strict";

import {GLTFLoader} from "../deps/GLTFLoader.js";
import {
    Object3D,
    Box3, Vector3, Vector4
} from "../deps/three.js";
import {wgs84FromScenePos} from "./utils.js";
import {MapViewerConst} from "./consts.js";

let gltfLoader = new GLTFLoader();

/// Used to create and manage the visualization of one visual batch
export class MapViewerBatch
{
// public:

    constructor(batchName, batchSeqNo, platform, onLoadingFinishedFn, onLoadingErrorFn)
    {
        this.visualIdIndex = undefined;
        this.id = batchName;
        this.visualRootPoints = undefined;
        this.visualRootLines = undefined;
        this.visualRootPolys = undefined;
        this.visualRootObjects = undefined;
        this.visualRootLabels = undefined;
        this.pickingRootPoints = undefined;
        this.pickingRootLines = undefined;
        this.pickingRootPolys = undefined;
        this.pickingRootObjects = undefined;

        gltfLoader.load(
            glbPickupService.batchRequestUrl(batchName, batchSeqNo),
            // Called once the gltf resource is loaded
            ( gltf ) =>
            {
                // Parse the scene as described in the NDS GLTF proposal
                let sceneExtensions = gltf.scene.userData["gltfExtensions"];
                if (sceneExtensions && sceneExtensions["NDS_geo_scene_info"])
                {
                    let ndsGeoSceneInfo = sceneExtensions["NDS_geo_scene_info"];

                    this.visualRootPoints = new Object3D();
                    this.pickingRootPoints = new Object3D();
                    this.visualRootLines = new Object3D();
                    this.pickingRootLines = new Object3D();
                    this.visualRootPolys = new Object3D();
                    this.pickingRootPolys = new Object3D();
                    this.visualRootObjects = new Object3D();
                    this.pickingRootObjects = new Object3D();
                    this.visualRootLabels = new Object3D();

                    switch (ndsGeoSceneInfo.coordinate_system) {
                        case 'wgs84':
                            // Insert the flat map elements into one of the 2D nodes - lines would be the other option.
                            this.visualRootPolys.children = gltf.scene.children;
                            break;
                        case 'euclidean':
                            // TODO: Implement forwarding of euclidean scenes
                            break;
                    }

                    this.visualIdIndex = {}
                }
                else {
                    console.assert(sceneExtensions && sceneExtensions["NDS_map_element_buffer_offsets"]);
                    this.visualIdIndex = sceneExtensions["NDS_map_element_buffer_offsets"];
                }

                gltf.scene.children.forEach((node) => {
                    switch(node.name) {
                        case "visual-points": this.visualRootPoints = node; break;
                        case "picking-points": this.pickingRootPoints = node; break;
                        case "visual-lines": this.visualRootLines = node; break;
                        case "picking-lines": this.pickingRootLines = node; break;
                        case "visual-areas": this.visualRootPolys = node; break;
                        case "picking-areas": this.pickingRootPolys = node; break;
                        case "visual-objects": this.visualRootObjects = node; break;
                        case "picking-objects": this.pickingRootObjects = node; break;
                        case "visual-labels": this.visualRootLabels = node; break;
                        default:
                            console.warn("Received node with unknown name: "+node.name)
                    }
                });

                if(!this.visualRootPoints || !this.visualRootPoints.isObject3D)
                    console.warn(`Incomplete batch: ${batchName}: visualRootPoints not set!`);
                if(!this.pickingRootPoints || !this.pickingRootPoints.isObject3D)
                    console.warn(`Incomplete batch: ${batchName}: pickingRootPoints not set!`);
                if(!this.visualRootLines || !this.visualRootLines.isObject3D)
                    console.warn(`Incomplete batch: ${batchName}: visualRootLines not set!`);
                if(!this.pickingRootLines || !this.pickingRootLines.isObject3D)
                    console.warn(`Incomplete batch: ${batchName}: pickingRootLines not set!`);
                if(!this.visualRootPolys || !this.visualRootPolys.isObject3D)
                    console.warn(`Incomplete batch: ${batchName}: visualRootPolys not set!`);
                if(!this.pickingRootPolys || !this.pickingRootPolys.isObject3D)
                    console.warn(`Incomplete batch: ${batchName}: pickingRootPolys not set!`);
                if(!this.visualRootObjects || !this.visualRootObjects.isObject3D)
                    console.warn(`Incomplete batch: ${batchName}: visualRootObjects not set!`);
                if(!this.pickingRootObjects || !this.pickingRootObjects.isObject3D)
                    console.warn(`Incomplete batch: ${batchName}: pickingRootObjects not set!`);
                if(!this.visualRootLabels || !this.visualRootLabels.isObject3D)
                    console.warn(`Incomplete batch: ${batchName}: visualRootLabels not set!`);

                // Provide render-order hints. We must render everything
                // back-to-front, so transparent objects always appear
                // sorted in the right order. This is not the case otherwise, since
                // depthWrite is disabled for transparent objects (see
                // https://github.com/mrdoob/three.js/issues/17706).
                [
                    this.visualRootLines,
                    this.visualRootPolys
                ].forEach( (root) => {
                    root.traverse((node) => {
                        if (node.geometry) {
                            const posAttrib = node.geometry.getAttribute("position");
                            if (posAttrib.count)
                                node.renderOrder = -posAttrib.getZ(0);
                        }
                    });
                });

                if(onLoadingFinishedFn)
                    onLoadingFinishedFn(this);
            },

            // called when loading is in progresses
            () => {
                // console.log( ( xhr.loaded / xhr.total * 100 ) + '% loaded' );
            },

            // called when loading has errors
            ( error ) => {
                // Don't spam errors when fetching fails because the server retracted a batch
                if(error.message && !error.message.endsWith("glTF versions >=2.0 are supported."))
                    console.warn( 'Glb load err: '+batchName+': '+error.message );
                if(onLoadingErrorFn)
                    onLoadingErrorFn()
            }
        )
    }

    dispose()
    {
        [
            this.visualRootPoints,
            this.visualRootLines,
            this.visualRootPolys,
            this.visualRootObjects,
            this.visualRootLabels,
            this.pickingRootPoints,
            this.pickingRootLines,
            this.pickingRootPolys,
            this.pickingRootObjects
        ].forEach( (root) =>
        {
            if (!root)
                return;

            root.traverse(
                (node) =>
                {
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

    setElementsWithStyleVisible(styleRegex, visible)
    {
        [
            this.visualRootPoints,
            this.visualRootLines,
            this.visualRootPolys,
            this.visualRootObjects,
            this.visualRootLabels,
            this.pickingRootPoints,
            this.pickingRootLines,
            this.pickingRootPolys,
            this.pickingRootObjects,
        ].forEach( (root) =>
        {
            if (!root)
                return;

            root.children.forEach((styleNode) => {
                if(styleNode.name.match(styleRegex)) {
                    styleNode.traverse( (object) => {object.visible = visible} )
                }
            })
        })
    }

    gatherMapElement(visualId)
    {
        let visualIdString = visualId.toString();
        let offsetInfo = this.visualIdIndex[visualIdString];
        let result = {
            visualId: visualId,
            error: false,
            vertexColorMesh: null,
            pickingIdMesh: null,
            offsetInfo: offsetInfo,
            vertexColorAttrib: null,
            pickingIdAttrib: null,
            positionAttrib: null
        };

        if (offsetInfo === undefined) {
            console.warn(`Attempt to access unknown visual id ${visualId} for batch ${this.id}!`);
            result.error = true;
            return result;
        }

        // Find vertex buffer
        switch (offsetInfo.type) {
        case "point":
            result.vertexColorMesh = this.visualRootPoints.getObjectByName(offsetInfo.style);
            result.pickingIdMesh = this.pickingRootPoints.getObjectByName(offsetInfo.style);
            result.matrixWorld = result.pickingIdMesh.matrixWorld;
            break;
        case "line":
            result.vertexColorMesh = this.visualRootLines.getObjectByName(offsetInfo.style);
            result.pickingIdMesh = this.pickingRootLines.getObjectByName(offsetInfo.style);
            result.matrixWorld = result.pickingIdMesh.matrixWorld;
            break;
        case "area":
            result.vertexColorMesh = this.visualRootPolys.getObjectByName(offsetInfo.style);
            result.pickingIdMesh = this.pickingRootPolys.getObjectByName(offsetInfo.style);
            result.matrixWorld = result.pickingIdMesh.matrixWorld;
            break;
        case "3dobject":
            result.vertexColorMesh = this.visualRootObjects.getObjectByName(visualIdString).children[0];
            result.pickingIdMesh = this.pickingRootObjects.getObjectByName(visualIdString).children[0];
            result.matrixWorld = this.pickingRootObjects.getObjectByName(visualIdString).matrixWorld;
            break;
        default:
            console.warn(`Attempt to access unknown element type ${offsetInfo.type} for batch ${this.id}!`);
            result.error = true;
            return result;
        }

        result.pickingIdAttrib = result.pickingIdMesh.geometry.getAttribute("color");
        result.positionAttrib = result.pickingIdMesh.geometry.getAttribute("position");

        console.assert(result.pickingIdAttrib.isBufferAttribute);

        // Points do not have a vertex color mesh
        if (result.vertexColorMesh.isMesh && offsetInfo.type != "3dobject") {
            result.vertexColorAttrib = result.vertexColorMesh.geometry.getAttribute("color");
            console.assert(result.vertexColorAttrib.count === result.pickingIdAttrib.count);
            console.assert(result.vertexColorAttrib.isBufferAttribute);
        }

        return result;
    }

    forEachVertexOf(elem, fn)
    {
        let seenVertexCount = 0;
        for (let i = 0; i < elem.pickingIdAttrib.count; ++i)
        {
            let currentPickingId = elem.pickingIdAttrib.getX(i) | (elem.pickingIdAttrib.getY(i) << 8) | (elem.pickingIdAttrib.getZ(i) << 16);
            if (currentPickingId === elem.visualId) {
                fn(i);
                ++seenVertexCount;
            }
        }

        if (seenVertexCount === 0)
            console.warn(`Could not process element with id ${elem.visualId} from batch ${this.id}: It does not seem to have any vertices!`);
    }

    setElementVisible(visualId, visible)
    {
        let elem = this.gatherMapElement(visualId);
        console.log(elem)
        if (elem.error) return;

        this.forEachVertexOf(elem, (vertexOffset) => {
            elem.pickingIdAttrib.setW(vertexOffset, visible ? 255 : 0);
            elem.pickingIdAttrib.needsUpdate = true;
            if (elem.vertexColorAttrib) {
                // Set 0.5 opacity for validity items
                elem.vertexColorAttrib.setW(vertexOffset, visible ? 128 : 0);
                elem.vertexColorAttrib.needsUpdate = true;
            }
        });
    }

    hasAreasOrLines() {
        return this.visualRootLines.children.length > 0 || this.visualRootPolys.children.length > 0;
    }

    angularExtents() {
        let lineBounds = new Box3().setFromObject(this.visualRootLines);
        let polyBounds = new Box3().setFromObject(this.visualRootPolys);

        if (lineBounds.isEmpty())
            return polyBounds;

        if (polyBounds.isEmpty())
            return lineBounds;

        lineBounds.expandByPoint(polyBounds.min);
        lineBounds.expandByPoint(polyBounds.max);
        return lineBounds;
    }

    mapElementAngularExtents(visualId) {
        let elem = this.gatherMapElement(visualId);
        if (elem.error) return;

        // Find highest vertex offset for element
        let endOffset = 0;
        this.forEachVertexOf(elem, (vertexOffset) => {endOffset = vertexOffset + 1;});

        // Slice out the relevant vertices
        let elemVertices = elem.positionAttrib.array.slice(
            elem.offsetInfo.offset * elem.positionAttrib.itemSize,
            endOffset * elem.positionAttrib.itemSize);

        // Create the result bounding box from the vertex array
        let resultBox = new Box3();
        resultBox.setFromArray(elemVertices);
        resultBox.applyMatrix4(elem.matrixWorld);

        // If the element's coordinates are cartesian (points/3d objects),
        // convert bounding box to wgs84.
        if (elem.offsetInfo.type === "point" || elem.offsetInfo.type == "3dobject") {
            resultBox.setFromPoints([
                wgs84FromScenePos(resultBox.min, MapViewerConst.globeRenderRadius),
                wgs84FromScenePos(resultBox.max, MapViewerConst.globeRenderRadius)
            ]);
            if (elem.offsetInfo.type === "point") {
                const pointExtentDegrees = 0.0003; // ~30m at equator
                resultBox.expandByScalar(pointExtentDegrees);
            }
        }

        return resultBox;
    }

    mapElementCenterPoint(visualId) {
        let elem = this.gatherMapElement(visualId);
        if (elem.error) return;

        // Find highest vertex offset for element
        let endOffset = 0;
        this.forEachVertexOf(elem, (vertexOffset) => {endOffset = vertexOffset + 1;});

        // Slice out the relevant vertices
        let elemVertices = elem.positionAttrib.array.slice(
            elem.offsetInfo.offset * elem.positionAttrib.itemSize,
            endOffset * elem.positionAttrib.itemSize);

        let numVertices = Math.floor(elemVertices.length / 3);
        let offset = Math.floor(numVertices / 2) * 3;

        let centerVertex = new Vector4(elemVertices[offset], elemVertices[offset + 1], elemVertices[offset + 2]);
        centerVertex.applyMatrix4(elem.vertexColorMesh.matrixWorld);
        return centerVertex;
    }

    has(visualId) {
        return this.visualIdIndex[visualId.toString()] !== undefined;
    }
}
