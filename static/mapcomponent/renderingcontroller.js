"use strict";

import {
    Vector3,
    Vector2,
    PerspectiveCamera,
    OrthographicCamera,
    Scene,
    RGBAFormat,
    NearestFilter,
    LinearFilter,
    WebGLRenderer,
    WebGLRenderTarget,
    PointLight,
    Color,
    AmbientLight,
    Object3D, LineSegments, LineBasicMaterial, WireframeGeometry
} from "../deps/three.js";
import {MapViewerConst} from "./consts.js";
import {MapViewerCameraController} from "./cameracontroller.js";
import {MapViewerViewport, RenderTileState} from "./viewport.js";
import {HighlightPass} from "./highlight.js";
import {Globe} from "./globe.js";
import {filterMeshObjectsByName, smoothstep, throttle} from "./utils.js";


/**
 * @class
 */
export function MapViewerRenderingController(mapViewerModel, platform)
{
    let scope = this;

    /**
     * @private
     * @constant {Vector3} CLEAR_COLOR_SKY
     */
    const CLEAR_COLOR_SKY = new Vector3(0x87, 0xCE, 0xEB);

    /**
     * @public
     * @member {Globe} globeSphere - The pale blue dot
     */
    scope.globeSphere = null;

    /**
     * @private
     * @member {MapViewerViewport} viewport -
     *     Viewport controller, which keeps track of
     *     a globe snippet around the camera
     */
    let viewport = new MapViewerViewport();

// private:

    let renderer = null;
    let canvas = null;
    let canvasWidth = 800; // width of the canvas. Set by updateClientDimensions().
    let canvasHeight = 600; // height of the canvas. Set by updateClientDimensions().
    let highlightPass = null;  // The HighlightPass effect
    let mapViewerModelInitialized = false;
    let labelObjects = new Set(); // labels receive special treatment in updateLabelStates()
    let labelObjectsToRemove = new Set(); // labels that were removed through onBatchAboutToBeRemoved.
                                          // Removal will be executed in updateLabelStates called by paint().
    let renderTileSizeVisual = new Vector2(1024, 1024);
    let renderTileSizePicking = new Vector2(512, 512);

    // ------------------------------ FPS ---------------------------------

    let frameCounter = 0;
    let lastFrameCounterReset = Date.now();
    let fpsMonitorFun = null;

    let incFrameCounter = () => {
        frameCounter += 1;
        let timeDivMsec = Date.now() - lastFrameCounterReset;
        if (timeDivMsec > 1000) {
            if (fpsMonitorFun)
                fpsMonitorFun(frameCounter / timeDivMsec * 1000.);

            frameCounter = 0;
            lastFrameCounterReset = Date.now();
        }
    };

    // ------------------------------ Cameras ---------------------------------

    let cameras = {
        perspective: new PerspectiveCamera(
            MapViewerConst.cameraFov, // vertical fov
            canvasWidth / canvasHeight, // aspect ratio
            0.1 * MapViewerConst.minCameraGlobeDistance, // near plane
            2*MapViewerConst.globeRenderRadius + MapViewerConst.maxCameraGlobeDistance
        ),
        ortho: new OrthographicCamera(
            0., 360., 180., 0., 1., -1.
        )
    };

    // ------------------------------- Scenes ---------------------------------

    let scenes = {
        perspective: {
            visual: {
                main: new Scene(),
                points: new Scene()
            },
            picking: {
                main: new Scene(),
                points: new Scene()
            }
        },
        ortho: {
            visual: new Scene(),
            picking: new Scene(),
        }
    };

    // ---------------------------- Framebuffers ------------------------------

    let framebufferOptionsPicking = {
        depthBuffer: true,
        anisotropy: 0,
        format: RGBAFormat,
        minFilter: NearestFilter,
        magFilter: NearestFilter
    };
    let framebufferOptionsVisualOrtho = {
        depthBuffer: true,
        format: RGBAFormat,
        generateMipmaps: false,
        minFilter: LinearFilter,
        magFilter: LinearFilter
    };
    let framebufferOptionsVisualPerspective = {
        depthBuffer: true,
        format: RGBAFormat,
        generateMipmaps: false,
        minFilter: LinearFilter,
        magFilter: LinearFilter
    };
    let framebuffers = {
        perspective:
        {
            picking: new WebGLRenderTarget(canvasWidth, canvasHeight, framebufferOptionsPicking),
            visual: new WebGLRenderTarget(canvasWidth, canvasHeight, framebufferOptionsVisualPerspective),
        },
        tiles:
        {
            visual: [...Array(viewport.renderTileController.numRenderTiles)].map(
                () => new WebGLRenderTarget(renderTileSizeVisual.x, renderTileSizeVisual.y, framebufferOptionsVisualOrtho)),
            picking: [...Array(viewport.renderTileController.numRenderTiles)].map(
                () => new WebGLRenderTarget(renderTileSizePicking.x, renderTileSizePicking.y, framebufferOptionsPicking))
        },
    };

    // ------------------------------- Other ----------------------------------

    /// Map from RegExp to bool to track which highlight styles should be shown/hidden
    let styleFilterValues = new Map();

    /// Map to keep track of which visual id has how strong of a hover highlight
    let hoverIntensityPerId = new Map();

    /// This flag controls whether hover-highlights are enabled.
    let hoverHighlightsEnabled = false;

    /// This flag controls whether wireframes are enabled.
    let wireframesEnabled = false;
    const wireframeMaterial = new LineBasicMaterial({ color: 0xFF00FF });

    /// Init camera controller and attach light source to camera, considering that
    /// the actual camera object is the leaf in a node hierarchy managed by the camera controller
    let camController = new MapViewerCameraController(cameras.perspective, viewport, platform);
    let light = new PointLight(new Color(1,1,1), .6);
    light.position.set(1.0, 0.0, 10.0).normalize();
    cameras.perspective.add(light);
    scenes.perspective.visual.main.add(camController.azimuthRoot());
    cameras.perspective.updateMatrixWorld();

// public:

    scope.cameraController = camController;

    ///////////////////////////////////////////////////////////////////////////
    //                              INITIALIZATION                           //
    ///////////////////////////////////////////////////////////////////////////

    scope.initialize = (targetCanvas) =>
    {
        canvas = targetCanvas;

        // ---------------- Initialize renderer ----------------

        renderer = new WebGLRenderer({
            devicePixelRatio: canvas.devicePixelRatio
        });
        renderer.setSize(canvasWidth, canvasHeight);
        renderer.autoClear = false;
        renderer.debug.checkShaderErrors = true;
        canvas.appendChild(renderer.domElement);

        // ------------- Initialize HighlightPass --------------

        highlightPass = new HighlightPass(platform, framebuffers.perspective);

        // -------------- Initialize lights/globe --------------

        let light = new AmbientLight(0xffffff);
        light.name = 'Light';
        light.intensity = 0.4;
        scenes.perspective.visual.main.add(light);

        scope.globeSphere = new Globe(
            platform,
            framebuffers.tiles,
            renderer.capabilities,
            viewport);
        scope.globeSphere.meshesVisual.forEach(mesh => scenes.perspective.visual.main.add(mesh));
        scope.globeSphere.meshesPicking.forEach(mesh => scenes.perspective.picking.main.add(mesh));

        updateClientDimensions();

        mapViewerModel.setGlobe(scope.globeSphere);
        scope.resize();

        // ---------- Initialize Camera event listener ---------

        scope.cameraController.addEventListener(scope.cameraController.CAM_POS_CHANGED, (ev) =>
        {
            makeSureCameraIsOnTopOfTerrain();
            updateGlobe();

            if (!ev.zooming) {
                mapViewerModel.viewportChanged(
                    viewport,
                    ev.jumped,
                    scope.cameraController.getCameraWgs84Coords(),
                    scope.cameraController.getCameraAltitude(),
                    scope.cameraController.surfaceRoot().rotation.x,
                    scope.cameraController.surfaceRoot().rotation.z
                );
            }
        });
    };

    ///////////////////////////////////////////////////////////////////////////
    //                                 UPDATING                              //
    ///////////////////////////////////////////////////////////////////////////

    scope.resize = () =>
    {
        updateClientDimensions();
    };

    scope.addLabel = (labelText, styleName, position) => {
        let label = new Object3D();
        label.position.x = position.x;
        label.position.y = position.y;
        label.position.z = position.z;
        label.name = labelText;
        label.styleName = styleName;
        labelObjects.add(label);
        return label;
    };

    scope.removeLabel = (label) => {
        labelObjectsToRemove.add(label.id);
        labelObjects.delete(label);
    };

    function paint() {
        if (!mapViewerModelInitialized)
            return;

        transitionRenderTiles();

        // Use black (space) or blue (sky) clear color depending on camera height
        let bkColor = CLEAR_COLOR_SKY.clone().multiplyScalar(1 - smoothstep(10, 100, scope.cameraController.getCameraAltitude()));
        bkColor = bkColor.x << 16 | bkColor.y << 8 | bkColor.z;

        // Paint perspective
        renderer.setClearColor(bkColor);
        renderer.setRenderTarget(framebuffers.perspective.visual);
        renderer.clear();
        renderer.render(scenes.perspective.visual.main, cameras.perspective);
        renderer.clearDepth();
        renderer.render(scenes.perspective.visual.points, cameras.perspective);

        renderer.setRenderTarget(framebuffers.perspective.picking);
        renderer.setClearColor(0x000000, .0);
        renderer.clear();
        renderer.render(scenes.perspective.picking.main, cameras.perspective);
        renderer.clearDepth();
        renderer.render(scenes.perspective.picking.points, cameras.perspective);

        // Update hover highlights
        if (hoverHighlightsEnabled) {
            updateHoveredPixel();
        }

        // Paint scene
        renderer.setRenderTarget(null);
        renderer.clear();
        renderer.render(highlightPass.background.scene, cameras.perspective);

        // Paint hover highlights
        if (hoverHighlightsEnabled) {
            hoverIntensityPerId.forEach((intensity, id) => {
                let newHighlightGroupMask = (id & 1) ? 0x1ffff : 0;
                let newHighlightGroupId = id & newHighlightGroupMask;
                if (mapViewerModel.mapElementPriority(id))
                    intensity *= 1.5;
                if (!highlightPass.matchesSelectedHighlightId(id, newHighlightGroupId, newHighlightGroupMask)) {
                    highlightPass.setHoveredHighlightId(id, newHighlightGroupId, newHighlightGroupMask, intensity);
                    renderer.render(highlightPass.hover.scene, cameras.perspective);
                }
            });
        }

        // Paint selection highlight
        renderer.render(highlightPass.selection.scene, cameras.perspective);

        // "Paint" labels
        updateLabelStates();

        incFrameCounter();
        requestAnimationFrame(paint);
    }

    function transitionRenderTiles()
    {
        let rendertiles = viewport.renderTileController.tiles;

        /**
         * @param {MapViewerRenderTile} tile
         * @param {Scene} scene
         */
        function paintTile(tile, scene)
        {
            let subtile = tile.subtile;
            if (!subtile)
                return;

            let phiStart = subtile.angularOffset.x;
            let phiLength = subtile.angularSize.x;
            let thetaStart = subtile.angularOffset.y;
            let thetaLength = subtile.angularSize.y;

            // Normalize phiStart. It may be larger than PI, when looking at the globe backside
            let normPhiStart = phiStart;
            if (normPhiStart >= Math.PI)
                normPhiStart -= 2*Math.PI;
            if (normPhiStart < -Math.PI)
                normPhiStart += 2*Math.PI;

            cameras.ortho.right = phiLength/Math.PI * 180.;
            cameras.ortho.top = -thetaLength/Math.PI * 180.;
            cameras.ortho.position.x = normPhiStart/Math.PI * 180.;
            cameras.ortho.position.y = (-thetaStart/Math.PI + .5) * 180.;
            cameras.ortho.updateProjectionMatrix();
            cameras.ortho.updateMatrixWorld();

            renderer.clear();
            renderer.render(scene, cameras.ortho);
        }

        let wantsClear = rendertiles.filter(
            t =>
                t.state === RenderTileState.CLEARME ||
                t.state === RenderTileState.ASSIGNED);

        wantsClear.forEach(t => {
            renderer.setClearColor(0x000000, 0.);
            renderer.setRenderTarget(framebuffers.tiles.visual[t.id]);
            renderer.clear();
            renderer.setRenderTarget(framebuffers.tiles.picking[t.id]);
            renderer.clear();

            if (t.state === RenderTileState.CLEARME)
                t.unused();
            else
                t.dirty();
        });

        let wantsRender = viewport.renderTileController.tiles.filter(
            t => t.state === RenderTileState.DIRTY
        ).sort(
            (a, b) => a.subtile.penalty - b.subtile.penalty
        );

        wantsRender.slice(0, 2).forEach(t => {
            renderer.setRenderTarget(framebuffers.tiles.visual[t.id]);
            paintTile(t, scenes.ortho.visual);
            renderer.setRenderTarget(framebuffers.tiles.picking[t.id]);
            paintTile(t, scenes.ortho.picking);
            t.rendered();
        });

        return true;
    }

    function updateLabelStates() {
        let labelStateUdpateMsg = {
            type: mapViewerModel.LABEL_STATE_CHANGED,
            states: []
        };
        labelObjectsToRemove.forEach((labelId) => {
            labelStateUdpateMsg.states.push({
                labelId: labelId,
                styleId: null,
                text: null,
                position: null,
                visible: false,
                deleted: true
            });
        });
        labelObjectsToRemove.clear();
        labelObjects.forEach((labelNode) => {
            let labelState = {
                labelId: labelNode.id,
                styleId: labelNode.styleName,
                text: labelNode.name,
                position: null,
                visible: false,
                deleted: false
            };
            let labelScreenPos = new Vector3();
            labelNode.getWorldPosition(labelScreenPos);
            labelScreenPos.project(cameras.perspective);
            if (
                labelScreenPos.x > -1. && labelScreenPos.x < 1. &&
                labelScreenPos.y > -1. && labelScreenPos.y < 1. &&
                labelScreenPos.z > -1. && labelScreenPos.z < 1.
            ) {
                labelScreenPos.x += 1.;
                labelScreenPos.y += 1.;
                labelScreenPos.x *= canvasWidth*.5;
                labelScreenPos.y *= canvasHeight*.5;
                labelState.visible = true;
                labelState.position = labelScreenPos;
            }
            labelStateUdpateMsg.states.push(labelState);
        });
        mapViewerModel.dispatchEvent(labelStateUdpateMsg);
    }

    function adjustNodePositionsToTerrainHeight(node)
    {
        if (!scope.globeSphere)
            return;

        // argument is list
        if (Array.isArray(node)) {
            node.forEach((child) => {
                adjustNodePositionsToTerrainHeight(child)
            })
        }
        // argument is scene
        else if (node.type === 'Scene') {
            node.children.forEach((child) => {
                adjustNodePositionsToTerrainHeight(child)
            })
        }
        // argument is points/objects node
        else if (node.isObject3D) {
            scope.globeSphere.scaleSceneVecToTerrainHeight(node.position)
        }
    }

    function makeSureCameraIsOnTopOfTerrain()
    {
        // Make sure that surface root is positioned on top of the terrain
        scope.globeSphere.scaleSceneVecToTerrainHeight(
            scope.cameraController.surfaceRoot().position,
            scope.cameraController.azimuthRoot().rotation.y,
            scope.cameraController.azimuthRoot().rotation.x+Math.PI/2.);

        // Make sure that the camera itself is not tilted into a mountain
        scope.cameraController.azimuthRoot().updateMatrixWorld(true);
        let camPos = scope.cameraController.cameraWorldPosition();
        let origLength = camPos.length();
        scope.globeSphere.scaleSceneVecToTerrainHeight(camPos);
        let lengthDiff = camPos.length() - origLength;
        if (lengthDiff > 0) {
            console.log(origLength, camPos.length(), lengthDiff, MapViewerConst.minCameraGlobeDistance);
            scope.cameraController.surfaceRoot().position.z = origLength + lengthDiff + MapViewerConst.minCameraGlobeDistance
        }

        // Align surface position to prevent tiny jumps ->
        //  No. Small jumps are better than big jumps.
        // scope.cameraController.surfaceRoot().position.z = align(scope.cameraController.surfaceRoot().position.z, .003, true)
        // scope.cameraController.surfaceRoot().updateMatrixWorld(true)
    }

    function updateGlobe()
    {
        scope.globeSphere.update();
        scope.globeSphere.updateViewTrapezoid(
            cameras.perspective.matrixWorldInverse,
            scope.cameraController.surfaceRootWorldPosition());
    }

    function updateClientDimensions()
    {
        console.assert(canvas);
        canvasWidth = canvas.clientWidth;
        canvasHeight = canvas.clientHeight;

        let canvasWidthDevice = canvas.clientWidth * window.devicePixelRatio;
        let canvasHeightDevice = canvas.clientHeight * window.devicePixelRatio;

        renderer.setSize(canvasWidthDevice, canvasHeightDevice);
        framebuffers.perspective.picking.setSize(canvasWidthDevice, canvasHeightDevice);
        framebuffers.perspective.visual.setSize(canvasWidthDevice, canvasHeightDevice);
        scope.cameraController.updateCanvasSize(canvasWidth, canvasHeight);
    }

    function updateWireframeMaterials() {
        scenes.perspective.visual.main.children.forEach((child) => {
            child.traverse((node) => {
                if (node.material && filterMeshObjectsByName(node)) {
                    if (wireframesEnabled) {
                        node.material.visible = false;
                        node.children.forEach((child) => {
                            if (child.name === "wireframe") {
                                child.material.visible = true;
                                return;
                            }
                        })
                        const wireframeGeometry = new WireframeGeometry(node.geometry);
                        const wireframe = new LineSegments(wireframeGeometry, wireframeMaterial);
                        wireframe.name = "wireframe";
                        node.add(wireframe);
                        return wireframe;
                    } else {
                        node.material.visible = true;
                        node.children.forEach((child) => {
                            if (child.name === "wireframe") {
                                child.material.visible = false;
                                return;
                            }
                        })
                    }
                }
            })
        })
    }

    ///////////////////////////////////////////////////////////////////////////
    //                         PICKING / EXT. UTILITY                        //
    ///////////////////////////////////////////////////////////////////////////

    const unselectablePickingIdBit = 0x00800000;

    scope.clearHighlights = () => {
        highlightPass.setSelectedHighlightId(0, 0, 0);
    };

    scope.showPickingScene = (show) => {
        highlightPass.setShowPickingScene(show);
    };

    function pickId(screenX, screenY)
    {
        if (!renderer)
            return 0;

        const pickingPixelRadius = 4;
        const pickingPixelDiameter = pickingPixelRadius*2;
        let pickedPixelBuffer = new Uint8Array(
            pickingPixelDiameter * pickingPixelDiameter * 4);  // pixel buffer for the picking bitmap

        let pickingBufferX = Math.max(0,
            Math.min(
                framebuffers.perspective.picking.width-1,
                screenX/canvasWidth * framebuffers.perspective.picking.width - pickingPixelRadius));
        let pickingBufferY = Math.max(0,
            Math.min(
                framebuffers.perspective.picking.height-1,
                framebuffers.perspective.picking.height -
                screenY/canvasHeight*framebuffers.perspective.picking.height -
                pickingPixelRadius));

        renderer.readRenderTargetPixels(
            framebuffers.perspective.picking,
            pickingBufferX,
            pickingBufferY,
            pickingPixelDiameter, pickingPixelDiameter,
            pickedPixelBuffer);

        let result = 0;
        let resultManhattan = pickingPixelRadius << 1;
        let resultPriority = 0;

        for (let i = 0; i < pickedPixelBuffer.length; i += 4)
        {
            let id = (pickedPixelBuffer[i+2] << 16) | (pickedPixelBuffer[i+1] << 8) | pickedPixelBuffer[i];
            if (!id || id & unselectablePickingIdBit) continue;

            let idx = Math.abs(pickingPixelRadius - (i % pickingPixelDiameter));
            let idy = Math.abs(pickingPixelRadius - Math.floor(i / pickingPixelDiameter));
            let manhattan = idx + idy;
            let priority = mapViewerModel.mapElementPriority(id);

            let isCloser = manhattan < resultManhattan && priority === resultPriority;
            let isHigherPriority = priority > resultPriority;

            if (isCloser || isHigherPriority) {
                result = id;
                resultManhattan = manhattan;
                resultPriority = priority;
            }
        }

        return result;
    }

    scope.highlight = (id) => {
        let newHighlightGroupMask = (id & 1) ? 0x1ffff : 0;
        let newHighlightGroupId = id & newHighlightGroupMask;
        highlightPass.setSelectedHighlightId(id, newHighlightGroupId, newHighlightGroupMask);
    };

    scope.selectPixel = (screenX, screenY) => {
        let id = pickId(screenX, screenY);
        scope.highlight(id);
        return id
    };

    let currentHighlightId = null;

    scope.mousePositionChanged = throttle(250, (x, y) => {
        if (hoverHighlightsEnabled) {
            currentHighlightId = pickId(x, y);
        }
    });

    function updateHoveredPixel() {
        // -- 1) Lower all previous intensities
        let ids = [...hoverIntensityPerId.keys()];
        ids.forEach((id) => {
            if (id === currentHighlightId)
                return;
            let intensity = hoverIntensityPerId.get(id);
            intensity -= .1;
            if (intensity <= .0)
                hoverIntensityPerId.delete(id);
            else
                hoverIntensityPerId.set(id, intensity);
        });

        // -- 2) Increase currently hovered intensity
        if (currentHighlightId > 0) {
            let currentIntensity = .0;
            if (hoverIntensityPerId.has(currentHighlightId)) {
                currentIntensity = hoverIntensityPerId.get(currentHighlightId);
            }
            currentIntensity += .3;
            if (mapViewerModel.mapElementPriority(currentHighlightId)) {
                currentIntensity += .45;
            }
            hoverIntensityPerId.set(currentHighlightId, Math.min(1., currentIntensity));
        }
    }

    scope.zoomToMapElement = (visualId, onlyMove=false) => {
        let boundingBox = mapViewerModel.mapElementAngularExtents(visualId);
        if (!boundingBox) {
            console.warn(`Attempt to zoom to unknown map element with id ${visualId}`);
            return;
        }
        let center = new Vector3(); boundingBox.getCenter(center);
        let size = new Vector3(); boundingBox.getSize(size);
        scope.cameraController.moveToCoords(center.x, center.y);
        if (!onlyMove)
            scope.cameraController.setCameraAltitudeGlobeExtent(Math.max(size.x, size.y));
    };

    scope.viewport = () => viewport;

    /**
     * @param {function} fun - FPS callback function
     */
    scope.setFpsMonitorFun = (fun) => {
        fpsMonitorFun = fun;
    };

    ///////////////////////////////////////////////////////////////////////////
    //                          GENERAL DISPLAY OPTIONS                      //
    ///////////////////////////////////////////////////////////////////////////

    scope.showHoverHighlights = (show) => {
        hoverHighlightsEnabled = show;
    };

    scope.showWireframes = (show) => {
        wireframesEnabled = show;
        updateWireframeMaterials();
    };

    scope.showGlobeGrid = (show) => {
        scope.globeSphere.showGrid(show);
    };

    scope.showGlobe = (show) => {
        scope.globeSphere.showTexture(show);
    };

    scope.showShadow = (value) => {
        scope.globeSphere.showShadow(value);
    };

    scope.terrainExcentricity = (value) => {
        scope.globeSphere.terrainExcentricity(value);
    };

    scope.terrainColor = (value) => {
        scope.globeSphere.terrainColor(value);
    };

    scope.gridLevel = (value) => {
        scope.globeSphere.gridLevel(value);
    };

    scope.getGridLevel = () => {
        return scope.globeSphere.gridLevelValue;
    }

    ///////////////////////////////////////////////////////////////////////////
    //                          MAP VIEWER MODEL SLOTS                       //
    ///////////////////////////////////////////////////////////////////////////

    scope.onBatchAdded = (event) =>
    {
        scenes.ortho.visual.add(event.batch.visualRootPolys);
        scenes.ortho.visual.add(event.batch.visualRootLines);
        scenes.ortho.picking.add(event.batch.pickingRootPolys);
        scenes.ortho.picking.add(event.batch.pickingRootLines);

        scenes.perspective.visual.main.add(event.batch.visualRootObjects);
        scenes.perspective.visual.main.add(event.batch.visualRootLabels);
        scenes.perspective.visual.points.add(event.batch.visualRootPoints);
        scenes.perspective.picking.main.add(event.batch.pickingRootObjects);
        scenes.perspective.picking.points.add(event.batch.pickingRootPoints);

        adjustNodePositionsToTerrainHeight(event.batch.visualRootPoints);
        adjustNodePositionsToTerrainHeight(event.batch.visualRootObjects);
        adjustNodePositionsToTerrainHeight(event.batch.visualRootLabels);
        adjustNodePositionsToTerrainHeight(event.batch.pickingRootPoints);
        adjustNodePositionsToTerrainHeight(event.batch.pickingRootObjects);

        // Register label objects
        event.batch.visualRootLabels.children.forEach((styleNode) => {
            styleNode.children.forEach((labelNode) => {
                labelNode.styleName = styleNode.name;
                labelNode.name = decodeURIComponent(labelNode.name);
                labelObjects.add(labelNode);
                labelObjectsToRemove.delete(labelNode.id);
            })
        });

        if (event.batch.hasAreasOrLines()) {
            viewport.invalidate(event.batch.angularExtents());
        }

        if (wireframesEnabled) {
            updateWireframeMaterials();
        }
    };

    scope.onBatchAboutToBeRemoved = (event) =>
    {
        scenes.ortho.visual.remove(event.batch.visualRootPolys);
        scenes.ortho.visual.remove(event.batch.visualRootLines);
        scenes.ortho.picking.remove(event.batch.pickingRootPolys);
        scenes.ortho.picking.remove(event.batch.pickingRootLines);

        scenes.perspective.visual.main.remove(event.batch.visualRootObjects);
        scenes.perspective.visual.points.remove(event.batch.visualRootPoints);
        scenes.perspective.visual.points.remove(event.batch.visualRootLabels);
        scenes.perspective.picking.main.remove(event.batch.pickingRootObjects);
        scenes.perspective.picking.points.remove(event.batch.pickingRootPoints);

        // Remove label objects
        event.batch.visualRootLabels.children.forEach((styleNode) => {
            styleNode.children.forEach((labelNode) => {
                labelObjectsToRemove.add(labelNode.id);
                labelObjects.delete(labelNode);
            })
        });

        if (event.batch.hasAreasOrLines()) {
            viewport.invalidate(event.batch.angularExtents());
        }
    };

    // Sent out both for style filter changes and alpha-based showing/hiding
    scope.onMapElemVisibleChanged = (event) => {
        if (event.filter) {
            styleFilterValues.set(event.filter.source, event.visible);
        }
        viewport.invalidate(event.bounds);
    };

    scope.onViewportHeightmap = (event) =>
    {
        if (scope.globeSphere)
        {
            scope.globeSphere.updateTerrain(event);
            makeSureCameraIsOnTopOfTerrain();

            // Make sure that all 3d objects/icons are positioned on top of the terrain
            adjustNodePositionsToTerrainHeight(scenes.perspective.visual.main);
            adjustNodePositionsToTerrainHeight(scenes.perspective.visual.points);
            adjustNodePositionsToTerrainHeight(scenes.perspective.picking.main);
            adjustNodePositionsToTerrainHeight(scenes.perspective.picking.points);
        }
    };

    scope.onModelInitialized = (event) =>
    {
        mapViewerModelInitialized = true;
        scope.cameraController.forceUpdate();
        requestAnimationFrame(paint);
    };

    mapViewerModel.addEventListener(mapViewerModel.BATCH_ADDED,                 scope.onBatchAdded);
    mapViewerModel.addEventListener(mapViewerModel.BATCH_ABOUT_TO_BE_DISPOSED,  scope.onBatchAboutToBeRemoved);
    mapViewerModel.addEventListener(mapViewerModel.MAP_ELEM_VISIBILE_CHANGED,   scope.onMapElemVisibleChanged);
    mapViewerModel.addEventListener(mapViewerModel.VIEWPORT_HEIGHTMAP,          scope.onViewportHeightmap);
    mapViewerModel.addEventListener(mapViewerModel.INITIALIZED,                 scope.onModelInitialized);
} // MapViewerRenderingController
