import {FeatureTile} from "../mapdata/features.model";
import {TileLoadState} from "../mapdata/tilestream";
import {coreLib, uint8ArrayFromWasm} from "../integrations/wasm";
import {
    Cartographic,
    Cesium3DTileset,
    CesiumMath,
    Cartesian3,
    Matrix4,
    Model,
    PrimitiveCollection,
    Viewer
} from "../integrations/cesium";
import {FeatureLayerStyle, HighlightMode, TileFeatureLayer} from "../../build/libs/core/erdblick-core";
import {MapViewLayerStyleRule, MergedPointVisualization, PointMergeService} from "./pointmerge.service";
import {TileBoxVisualization} from "./tilebox.visualization.model";
import {getTilesetMeshlineShader} from "./tileset-shader";

export interface LocateResolution {
    tileId: string,
    typeId: string,
    featureId: Array<string|number>
}

export interface LocateResponse {
    responses: Array<Array<LocateResolution>>
}

interface StyleWithIsDeleted extends FeatureLayerStyle {
    isDeleted(): boolean;
}

/** Bundle of a FeatureTile, a style, and a rendered Cesium visualization. */
export class TileVisualization {
    tile: FeatureTile;
    isHighDetail: boolean;
    showTileBorder: boolean = false;
    readonly viewIndex: number;

    private lowDetailVisu: TileBoxVisualization|null = null;
    private primitiveCollection: PrimitiveCollection|null = null;
    private tileset: Cesium3DTileset|null = null;
    private tilesetUrl: string|null = null;
    private glbUrl: string|null = null;
    private tilesetEventRemovers: Array<() => void> = [];
    private debugModel: Model | null = null;
    private hasHighDetailVisualization: boolean = false;
    private hasTileBorder: boolean = false;
    private renderingInProgress: boolean = false;
    private deleted: boolean = false;
    private readonly style: StyleWithIsDeleted;
    public readonly styleId: string;
    private readonly highlightMode: HighlightMode;
    private readonly featureIdSubset: string[];
    private readonly auxTileFun: (key: string)=>FeatureTile|null;
    private readonly options: Record<string, boolean|number|string>;
    private readonly pointMergeService: PointMergeService;
    private readonly use3dTiles: boolean;
    private renderQueued: boolean = false;

    /**
     * Create a tile visualization.
     * @param viewIndex Index of the MapView to which is TileVisualization is dedicated.
     * @param tile The tile to visualize.
     * @param pointMergeService Instance of the central PointMergeService, used to visualize merged point features.
     * @param auxTileFun Callback which may be called to resolve external references
     *  for relation visualization.
     * @param style The style to use for visualization.
     * @param highDetail The level of detail to use. Currently,
     *  a low-detail representation is indicated by `false`, and
     *  will result in a dot representation. A high-detail representation
     *  based on the style can be triggered using `true`.
     * @param highlightMode Controls whether the visualization will run rules that
     *  have a specific highlight mode.
     * @param featureIdSubset Subset of feature IDs for visualization. If not set,
     *  all features in the tile will be visualized.
     * @param boxGrid Sets a flag to wrap this tile visualization into a bounding box
     * @param options Option values for option variables defined by the style sheet.
     * @param use3dTiles Use the 3D Tiles backend for high-detail rendering.
     */
    constructor(viewIndex: number,
                tile: FeatureTile,
                pointMergeService: PointMergeService,
                auxTileFun: (key: string) => FeatureTile | null,
                style: FeatureLayerStyle,
                highDetail: boolean,
                highlightMode: HighlightMode = coreLib.HighlightMode.NO_HIGHLIGHT,
                featureIdSubset?: string[],
                boxGrid?: boolean,
                options?: Record<string, boolean|number|string>,
                use3dTiles: boolean = false) {
        this.tile = tile;
        this.style = style as StyleWithIsDeleted;
        this.styleId = this.style.name();
        this.isHighDetail = highDetail;
        this.renderingInProgress = false;
        this.highlightMode = highlightMode;
        this.featureIdSubset = featureIdSubset || [];
        this.deleted = false;
        this.auxTileFun = auxTileFun;
        this.showTileBorder = boxGrid === undefined ? false : boxGrid;
        this.options = options || {};
        this.pointMergeService = pointMergeService;
        this.viewIndex = viewIndex;
        this.use3dTiles = use3dTiles;
    }

    private effectiveStatus(): TileLoadState | undefined {
        const tileStatus = this.tile.status;
        const renderStatus = this.renderQueued ? TileLoadState.RenderingQueued : undefined;
        if (tileStatus === undefined) {
            return renderStatus;
        }
        if (renderStatus === undefined) {
            return tileStatus;
        }
        return tileStatus < renderStatus ? tileStatus : renderStatus;
    }

    updateStatus(renderQueued?: boolean) {
        if (renderQueued !== undefined) {
            this.renderQueued = renderQueued;
        }
        if (this.lowDetailVisu) {
            this.lowDetailVisu.setStatus(this, this.effectiveStatus());
        }
    }

    /**
     * Actually create the visualization.
     * @param viewer {Viewer} The viewer to add the rendered entity to.
     * @return True if anything was rendered, false otherwise.
     */
    async render(viewer: Viewer) {
        if (this.renderingInProgress || this.deleted)
            return false;

        // Remove any previous render-result, as a new one is generated.
        this.destroy(viewer);
        this.deleted = false;

        // Do not continue if the style was deleted while we were waiting.
        if (this.style.isDeleted()) {
            this.updateStatus(false);
            return false;
        }

        // Create potential high-detail visualization.
        this.renderingInProgress = true;
        let returnValue = true;
        try {
        if (this.isHighDetailAndNotEmpty()) {
            const use3dTiles = this.shouldUse3DTiles();
            returnValue = await this.tile.peekAsync(async (tileFeatureLayer: TileFeatureLayer) => {
                if (use3dTiles) {
                    const wasmVisualization = new coreLib.FeatureLayerVisualization3DTiles(
                        this.viewIndex,
                        this.tile.mapTileKey,
                        this.style,
                        this.options,
                        this.highlightMode,
                        this.featureIdSubset);

                    let startTime = performance.now();
                    try {
                        wasmVisualization.addTileFeatureLayer(tileFeatureLayer);
                        const glb = uint8ArrayFromWasm((buffer) => wasmVisualization.renderGlb(buffer));
                        if (!glb) {
                            return false;
                        }

                        this.glbUrl = URL.createObjectURL(new Blob([glb as BlobPart], {type: "model/gltf-binary"}));
                        const tilesetBytes = uint8ArrayFromWasm((buffer) => wasmVisualization.makeTileset(this.glbUrl!, buffer));
                        if (!tilesetBytes) {
                            this.clearTileset();
                            return false;
                        }

                        this.tilesetUrl = URL.createObjectURL(new Blob([tilesetBytes as BlobPart], {type: "application/json"}));
                        const tilesetUrl = this.tilesetUrl;
                        const glbBytes = glb;
                        const tilesetBytesLocal = tilesetBytes;
                        const applyTileset = async (tileset: Cesium3DTileset) => {
                            if (this.deleted || this.tilesetUrl !== tilesetUrl) {
                                if (!tileset.isDestroyed()) {
                                    tileset.destroy();
                                }
                                return;
                            }
                            this.tileset = tileset;
                            const debugNoShader = (globalThis as any).__ERDBLICK_DEBUG_3DTILES_NO_SHADER__ === true;
                            if (!debugNoShader) {
                                this.tileset.customShader = getTilesetMeshlineShader();
                                const shader = this.tileset.customShader;
                                if (shader) {
                                    const widthMode = (globalThis as any).__ERDBLICK_DEBUG_3DTILES_WIDTH_MODE__;
                                    shader.setUniform("u_widthMode", widthMode === "meters" ? 1.0 : 0.0);
                                    const widthScale = (globalThis as any).__ERDBLICK_DEBUG_3DTILES_WIDTH_SCALE__;
                                    shader.setUniform(
                                        "u_widthScale",
                                        typeof widthScale === "number" && Number.isFinite(widthScale) ? widthScale : 1.0
                                    );
                                    const showCenterline = (globalThis as any).__ERDBLICK_DEBUG_3DTILES_SHOW_CENTERLINE__ === true;
                                    shader.setUniform("u_debugShowCenterline", showCenterline ? 1.0 : 0.0);
                                }
                            }
                            const debugLift = (globalThis as any).__ERDBLICK_DEBUG_3DTILES_LIFT_METERS__;
                            if (typeof debugLift === "number" && debugLift !== 0) {
                                this.tileset.modelMatrix = Matrix4.multiplyByTranslation(
                                    this.tileset.modelMatrix,
                                    new Cartesian3(0.0, 0.0, debugLift),
                                    new Matrix4());
                            }
                            this.bindTilesetEvents(viewer);
                            if (viewer && viewer.scene) {
                                viewer.scene.primitives.add(this.tileset);
                                viewer.scene.requestRender();
                            }

                            const debugTiles = (globalThis as any).__ERDBLICK_DEBUG_3DTILES__ === true;
                            if (debugTiles) {
                                (globalThis as any).__ERDBLICK_DEBUG_VIEWER__ = viewer;
                                (globalThis as any).__ERDBLICK_DEBUG_3DTILES_TILESET__ = this.tileset;
                                console.info(`[3dtiles] glb bytes=${glbBytes.byteLength}, tileset bytes=${tilesetBytesLocal.byteLength}`);
                                console.info("[3dtiles] debug flags", {
                                    noShader: (globalThis as any).__ERDBLICK_DEBUG_3DTILES_NO_SHADER__ === true,
                                    showCenterline: (globalThis as any).__ERDBLICK_DEBUG_3DTILES_SHOW_CENTERLINE__ === true,
                                    widthMode: (globalThis as any).__ERDBLICK_DEBUG_3DTILES_WIDTH_MODE__,
                                    widthScale: (globalThis as any).__ERDBLICK_DEBUG_3DTILES_WIDTH_SCALE__
                                });
                                try {
                                    const dv = new DataView(glbBytes.buffer, glbBytes.byteOffset, glbBytes.byteLength);
                                    const magic = dv.getUint32(0, true);
                                    if (magic === 0x46546c67 && glbBytes.byteLength >= 20) { // 'glTF'
                                        const jsonLength = dv.getUint32(12, true);
                                        const jsonType = dv.getUint32(16, true);
                                        if (jsonType === 0x4e4f534a) { // 'JSON'
                                            const jsonStart = 20;
                                            const jsonText = new TextDecoder().decode(glbBytes.slice(jsonStart, jsonStart + jsonLength));
                                            const gltf = JSON.parse(jsonText);
                                            const accessors = gltf.accessors ?? [];
                                            const meshes = gltf.meshes ?? [];
                                            const buffers = gltf.buffers ?? [];
                                            let primitiveCount = 0;
                                            const attributeKeys = new Set<string>();
                                            let positionAccessorCounts: number[] = [];
                                            const positionAccessorInfo: any[] = [];
                                            for (const mesh of meshes) {
                                                for (const prim of (mesh.primitives ?? [])) {
                                                    primitiveCount++;
                                                    if (prim?.attributes) {
                                                        for (const key of Object.keys(prim.attributes)) {
                                                            attributeKeys.add(key);
                                                        }
                                                    }
                                                    const posIndex = prim?.attributes?.POSITION;
                                                    if (typeof posIndex === "number" && accessors[posIndex]) {
                                                        positionAccessorCounts.push(accessors[posIndex].count ?? 0);
                                                        positionAccessorInfo.push({
                                                            index: posIndex,
                                                            min: accessors[posIndex].min,
                                                            max: accessors[posIndex].max
                                                        });
                                                    }
                                                }
                                            }
                                            console.info("[3dtiles] glb.meshes", meshes.length, "primitives", primitiveCount);
                                            console.info("[3dtiles] glb.positionAccessorCounts", positionAccessorCounts);
                                            console.info("[3dtiles] glb.positionAccessorMinMax", positionAccessorInfo);
                                            console.info("[3dtiles] glb.primitiveAttributes", Array.from(attributeKeys.values()));
                                            console.info("[3dtiles] glb.buffers", buffers.map((b: any) => b.byteLength));

                                            // Sample a few positions and transform into cartographic to verify placement.
                                            try {
                                                const binHeaderOffset = (20 + jsonLength + 3) & ~3;
                                                const binLength = dv.getUint32(binHeaderOffset, true);
                                                const binType = dv.getUint32(binHeaderOffset + 4, true);
                                                if (binType === 0x004e4942) { // 'BIN\\0'
                                                    const binStart = binHeaderOffset + 8;
                                                    const bin = glbBytes.slice(binStart, binStart + binLength);
                                                    const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
                                                    const samplePositions: Array<{pos: number[], carto?: any}> = [];
                                                    const debugAttrStats: Record<string, any> = {};
                                                    const bufferViews = gltf.bufferViews ?? [];
                                                    const typeComponents: Record<string, number> = {
                                                        SCALAR: 1,
                                                        VEC2: 2,
                                                        VEC3: 3,
                                                        VEC4: 4
                                                    };

                                                    const readAccessorStats = (accessorIndex: number | undefined, label: string) => {
                                                        if (typeof accessorIndex !== "number") {
                                                            return;
                                                        }
                                                        const accessor = accessors[accessorIndex];
                                                        if (!accessor) {
                                                            return;
                                                        }
                                                        const components = typeComponents[accessor.type ?? ""] ?? 0;
                                                        if (components <= 0 || accessor.componentType !== 5126) {
                                                            debugAttrStats[label] = {
                                                                accessorIndex,
                                                                componentType: accessor.componentType,
                                                                type: accessor.type,
                                                                note: "unsupported component type"
                                                            };
                                                            return;
                                                        }
                                                        const bufferView = bufferViews[accessor.bufferView];
                                                        if (!bufferView) {
                                                            return;
                                                        }
                                                        const stride = bufferView.byteStride ?? (components * 4);
                                                        const baseOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
                                                        const count = accessor.count ?? 0;
                                                        const minVals = new Array(components).fill(Number.POSITIVE_INFINITY);
                                                        const maxVals = new Array(components).fill(Number.NEGATIVE_INFINITY);
                                                        const samples: number[][] = [];
                                                        for (let i = 0; i < count; i++) {
                                                            const o = baseOffset + i * stride;
                                                            const row: number[] = [];
                                                            for (let c = 0; c < components; c++) {
                                                                const v = view.getFloat32(o + c * 4, true);
                                                                row.push(v);
                                                                if (v < minVals[c]) minVals[c] = v;
                                                                if (v > maxVals[c]) maxVals[c] = v;
                                                            }
                                                            if (samples.length < 5) {
                                                                samples.push(row);
                                                            }
                                                        }
                                                        debugAttrStats[label] = {
                                                            accessorIndex,
                                                            count,
                                                            components,
                                                            min: minVals,
                                                            max: maxVals,
                                                            samples
                                                        };
                                                    };
                                                    for (const info of positionAccessorInfo.slice(0, 1)) {
                                                        const accessor = accessors[info.index];
                                                        if (!accessor || accessor.componentType !== 5126 || accessor.type !== "VEC3") {
                                                            continue;
                                                        }
                                                        const bufferView = gltf.bufferViews?.[accessor.bufferView];
                                                        if (!bufferView) {
                                                            continue;
                                                        }
                                                        const stride = bufferView.byteStride ?? 12;
                                                        const baseOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
                                                        const count = Math.min(3, accessor.count ?? 0);
                                                        for (let i = 0; i < count; i++) {
                                                            const o = baseOffset + i * stride;
                                                            const x = view.getFloat32(o, true);
                                                            const y = view.getFloat32(o + 4, true);
                                                            const z = view.getFloat32(o + 8, true);
                                                            samplePositions.push({pos: [x, y, z]});
                                                        }
                                                    }

                                                    const linePrim = meshes
                                                        .flatMap((mesh: any) => mesh.primitives ?? [])
                                                        .find((prim: any) => typeof prim?.indices === "number") ?? meshes?.[0]?.primitives?.[0];
                                                    if (linePrim?.attributes) {
                                                        readAccessorStats(linePrim.attributes.POSITION, "POSITION");
                                                        readAccessorStats(linePrim.attributes.TEXCOORD_0, "TEXCOORD_0");
                                                        readAccessorStats(linePrim.attributes.TEXCOORD_1, "TEXCOORD_1");
                                                        readAccessorStats(linePrim.attributes.TEXCOORD_2, "TEXCOORD_2");
                                                        readAccessorStats(linePrim.attributes.NORMAL, "NORMAL");
                                                        readAccessorStats(linePrim.attributes.COLOR_0, "COLOR_0");
                                                        readAccessorStats(linePrim.attributes.COLOR_1, "COLOR_1");
                                                    }

                                                    let modelMatrix = Matrix4.IDENTITY;
                                                    try {
                                                        const json2 = JSON.parse(new TextDecoder().decode(tilesetBytesLocal));
                                                        const transform = json2?.root?.transform;
                                                        if (Array.isArray(transform) && transform.length === 16) {
                                                            modelMatrix = Matrix4.fromArray(transform);
                                                        }
                                                    } catch (_) {
                                                        // ignore
                                                    }

                                                    for (const sample of samplePositions) {
                                                        const cart = Matrix4.multiplyByPoint(modelMatrix, new Cartesian3(sample.pos[0], sample.pos[1], sample.pos[2]), new Cartesian3());
                                                        const carto = Cartographic.fromCartesian(cart);
                                                        sample.carto = {
                                                            lonDeg: CesiumMath.toDegrees(carto.longitude),
                                                            latDeg: CesiumMath.toDegrees(carto.latitude),
                                                            height: carto.height
                                                        };
                                                    }
                                                    console.info("[3dtiles] glb.samplePositions", samplePositions);
                                                    if (Object.keys(debugAttrStats).length > 0) {
                                                        (globalThis as any).__ERDBLICK_DEBUG_3DTILES_ATTRS__ = debugAttrStats;
                                                        console.info("[3dtiles] glb.attributeStats", debugAttrStats);
                                                    }
                                                }
                                            } catch (err) {
                                                console.warn(`[3dtiles] glb sample failed: ${err}`);
                                            }
                                        } else {
                                            console.warn(`[3dtiles] glb json chunk type mismatch: ${jsonType}`);
                                        }
                                    } else {
                                        console.warn("[3dtiles] glb header missing or too small");
                                    }
                                } catch (err) {
                                    console.warn(`[3dtiles] glb parse failed: ${err}`);
                                }
                                try {
                                    const json = JSON.parse(new TextDecoder().decode(tilesetBytesLocal));
                                    console.info("[3dtiles] tileset.asset", json?.asset);
                                    console.info("[3dtiles] tileset.root.transform", json?.root?.transform);
                                    console.info("[3dtiles] tileset.root.boundingVolume", json?.root?.boundingVolume);
                                    console.info("[3dtiles] tileset.root.content", json?.root?.content);
                                    console.info("[3dtiles] tileset.json", json);
                                } catch (err) {
                                    console.warn(`[3dtiles] failed to parse tileset json: ${err}`);
                                }
                                try {
                                    this.tileset.debugShowBoundingVolume = true;
                                    this.tileset.debugShowContentBoundingVolume = true;
                                    this.tileset.debugColorizeTiles = true;
                                    this.tileset.debugShowGeometricError = true;
                                    // Push screen space error up so the single-tile content is requested.
                                    this.tileset.maximumScreenSpaceError = 128.0;
                                    console.info("[3dtiles] tileset.boundingSphere", this.tileset.boundingSphere);
                                    const carto = Cartographic.fromCartesian(this.tileset.boundingSphere.center);
                                    console.info("[3dtiles] tileset.centerCarto", {
                                        lonDeg: CesiumMath.toDegrees(carto.longitude),
                                        latDeg: CesiumMath.toDegrees(carto.latitude),
                                        height: carto.height
                                    });
                                    const debugFlyTo = (globalThis as any).__ERDBLICK_DEBUG_3DTILES_FLYTO__ === true;
                                    if (debugFlyTo) {
                                        console.info("[3dtiles] flyTo tileset");
                                        viewer.flyTo(this.tileset, {duration: 0.6});
                                    }

                                    const debugModel = (globalThis as any).__ERDBLICK_DEBUG_3DTILES_MODEL__ === true;
                                    if (debugModel && this.glbUrl) {
                                        let modelMatrix = Matrix4.IDENTITY;
                                        let liftMeters = 0.0;
                                        try {
                                            const json = JSON.parse(new TextDecoder().decode(tilesetBytesLocal));
                                            const transform = json?.root?.transform;
                                            if (Array.isArray(transform) && transform.length === 16) {
                                                modelMatrix = Matrix4.fromArray(transform);
                                            }
                                        } catch (_) {
                                            // fall back to identity
                                        }
                                        const debugLift = (globalThis as any).__ERDBLICK_DEBUG_3DTILES_LIFT_METERS__;
                                        if (typeof debugLift === "number" && debugLift !== 0) {
                                            liftMeters = debugLift;
                                            modelMatrix = Matrix4.multiplyByTranslation(
                                                modelMatrix,
                                                new Cartesian3(0.0, 0.0, liftMeters),
                                                new Matrix4());
                                        }
                                        try {
                                            const model = await Model.fromGltfAsync({
                                                url: this.glbUrl,
                                                modelMatrix,
                                                scene: viewer.scene,
                                                enableDebugWireframe: true,
                                                debugShowBoundingVolume: true
                                            });
                                            if (!this.deleted) {
                                                this.debugModel = model;
                                                viewer.scene.primitives.add(model);
                                                (globalThis as any).__ERDBLICK_DEBUG_3DTILES_DEBUG_MODEL__ = model;
                                                model.readyEvent.addEventListener(() => {
                                                    console.info("[3dtiles] debug model ready");
                                                    console.info("[3dtiles] debug model boundingSphere", model.boundingSphere);
                                                    try {
                                                        const carto = Cartographic.fromCartesian(model.boundingSphere.center);
                                                        console.info("[3dtiles] debug model centerCarto", {
                                                            lonDeg: CesiumMath.toDegrees(carto.longitude),
                                                            latDeg: CesiumMath.toDegrees(carto.latitude),
                                                            height: carto.height
                                                        });
                                                    } catch (_) {
                                                        // ignore
                                                    }
                                                    viewer.scene.requestRender();
                                                });
                                                model.errorEvent.addEventListener((err: any) => {
                                                    console.error("[3dtiles] debug model error", err);
                                                });
                                            } else if (!model.isDestroyed()) {
                                                model.destroy();
                                            }
                                        } catch (err) {
                                            console.error(`[3dtiles] debug model failed: ${err}`);
                                        }
                                    }
                                } catch (err) {
                                    console.warn(`[3dtiles] failed to enable tileset debug flags: ${err}`);
                                }
                            }
                        };

                        Cesium3DTileset.fromUrl(this.tilesetUrl)
                            .then((tileset) => {
                                void applyTileset(tileset).catch((err) => {
                                    console.error(`[3dtiles] failed to apply tileset: ${err}`);
                                });
                            })
                            .catch((err) => {
                                console.error(`[3dtiles] failed to load tileset: ${err}`);
                                if (this.tilesetUrl === tilesetUrl) {
                                    this.clearTileset(viewer);
                                }
                            });

                        let endTime = performance.now();

                        // Add the render time for this style sheet as a statistic to the tile.
                        let timingListKey = `Rendering/${["Basic", "Hover", "Selection"][this.highlightMode.value]}/${this.styleId}#ms`;
                        let timingList = this.tile.stats.get(timingListKey);
                        if (!timingList) {
                            timingList = [];
                            this.tile.stats.set(timingListKey, timingList);
                        }
                        timingList.push(endTime - startTime);
                        return true;
                    } catch (e) {
                        console.error(`Exception while rendering 3D tiles: ${e}`);
                        this.clearTileset();
                        return false;
                    } finally {
                        wasmVisualization.delete();
                    }
                }

                let wasmVisualization = new coreLib.FeatureLayerVisualization(
                    this.viewIndex,
                    this.tile.mapTileKey,
                    this.style,
                    this.options,
                    this.pointMergeService,
                    this.highlightMode,
                    this.featureIdSubset);

                let startTime = performance.now();
                wasmVisualization.addTileFeatureLayer(tileFeatureLayer);
                try {
                    wasmVisualization.run();
                }
                catch (e) {
                    console.error(`Exception while rendering: ${e}`);
                    return false;
                }

                // Try to resolve externally referenced auxiliary tiles.
                let extRefs = {requests: wasmVisualization.externalReferences()};
                if (extRefs.requests && extRefs.requests.length > 0) {
                    let response = await fetch("locate", {
                        body: JSON.stringify(extRefs, (_, value) =>
                            typeof value === 'bigint'
                                ? Number(value)
                                : value),
                        method: "POST"
                    }).catch((err)=>console.error(`Error during /locate call: ${err}`));
                    if (!response) {
                        return false;
                    }

                    let extRefsResolved = await response.json() as LocateResponse;
                    if (this.style.isDeleted()) {
                        // Do not continue if the style was deleted while we were waiting.
                        return false;
                    }

                    // Resolve located external tile IDs to actual tiles.
                    let seenTileIds = new Set<string>();
                    let auxTiles = new Array<FeatureTile>();
                    for (let resolutions of extRefsResolved.responses) {
                        for (let resolution of resolutions) {
                            if (!seenTileIds.has(resolution.tileId)) {
                                let tile = this.auxTileFun(resolution.tileId);
                                if (tile) {
                                    auxTiles.push(tile);
                                }
                                seenTileIds.add(resolution.tileId);
                            }
                        }
                    }

                    // Now we can actually parse the auxiliary layers,
                    // add them to the visualization, and let it process them.
                    await FeatureTile.peekMany(auxTiles, async (tileFeatureLayers: Array<TileFeatureLayer>) => {
                        for (let auxTile of tileFeatureLayers)
                            wasmVisualization.addTileFeatureLayer(auxTile);

                        try {
                            wasmVisualization.processResolvedExternalReferences(extRefsResolved.responses);
                        }
                        catch (e) {
                            console.error(`Exception while rendering: ${e}`);
                        }
                    });
                }

                if (!this.deleted) {
                    this.primitiveCollection = wasmVisualization.primitiveCollection();
                    for (const [mapLayerStyleRuleId, mergedPointVisualizations] of Object.entries(wasmVisualization.mergedPointFeatures())) {
                        for (let finishedCornerTile of this.pointMergeService.insert(mergedPointVisualizations as MergedPointVisualization[], this.tile.tileId, mapLayerStyleRuleId)) {
                            finishedCornerTile.render(viewer);
                        }
                    }
                }
                wasmVisualization.delete();
                let endTime = performance.now();

                // Add the render time for this style sheet as a statistic to the tile.
                let timingListKey = `Rendering/${["Basic", "Hover", "Selection"][this.highlightMode.value]}/${this.styleId}#ms`;
                let timingList = this.tile.stats.get(timingListKey);
                if (!timingList) {
                    timingList = [];
                    this.tile.stats.set(timingListKey, timingList);
                }
                timingList.push(endTime - startTime);
                return true;
            });
            if (this.primitiveCollection) {
                viewer.scene.primitives.add(this.primitiveCollection);
            }
            if (this.tileset) {
                viewer.scene.primitives.add(this.tileset);
            }
            this.hasHighDetailVisualization = true;
        }

        // Low-detail bounding box and load-state overlays.
        this.lowDetailVisu = TileBoxVisualization.get(
            this.viewIndex,
            this.tile,
            this.tile.numFeatures,
            viewer,
            this,
            this.effectiveStatus(),
            this.showTileBorder);
        this.hasTileBorder = this.showTileBorder;

        return returnValue;
        } finally {
            this.renderingInProgress = false;
            this.updateStatus(false);
            if (this.deleted) {
                this.destroy(viewer);
            }
        }
    }

    /**
     * Destroy any current visualization.
     * @param viewer {Viewer} The viewer to remove the rendered entity from.
     */
    destroy(viewer: Viewer) {
        this.deleted = true;
        if (this.renderingInProgress) {
            return;
        }

        // Remove point-merge contributions that were made by this map-layer+style visualization combo.
        let removedCornerTiles = this.pointMergeService.remove(
            this.tile.tileId,
            this.mapViewLayerStyleId());
        for (let removedCornerTile of removedCornerTiles) {
            removedCornerTile.remove(viewer);
        }

        if (this.primitiveCollection) {
            viewer.scene.primitives.remove(this.primitiveCollection);
            if (!this.primitiveCollection.isDestroyed())
                this.primitiveCollection.destroy();
            this.primitiveCollection = null;
        }
        this.clearTileset(viewer);
        if (this.lowDetailVisu) {
            this.lowDetailVisu.delete(this.viewIndex, viewer, this.tile.numFeatures, this);
            this.lowDetailVisu = null;
        }
        this.hasHighDetailVisualization = false;
        this.hasTileBorder = false;
    }

    /**
     * Check if the visualization is high-detail, and the
     * underlying data is not empty.
     */
    private isHighDetailAndNotEmpty() {
        const numFeatures = this.tile.numFeatures;
        return this.isHighDetail && this.tile.hasData() && (numFeatures < 0 || numFeatures > 0);
    }

    private clearTileset(viewer?: Viewer) {
        if (this.tileset) {
            if (viewer) {
                viewer.scene.primitives.remove(this.tileset);
            }
            for (const remover of this.tilesetEventRemovers) {
                try {
                    remover();
                } catch (_) {
                    // Ignore errors during cleanup.
                }
            }
            this.tilesetEventRemovers = [];
            if (!this.tileset.isDestroyed()) {
                this.tileset.destroy();
            }
            this.tileset = null;
        }
        if (this.debugModel) {
            if (viewer) {
                viewer.scene.primitives.remove(this.debugModel);
            }
            if (!this.debugModel.isDestroyed()) {
                this.debugModel.destroy();
            }
            this.debugModel = null;
        }
        if (this.tilesetUrl) {
            URL.revokeObjectURL(this.tilesetUrl);
            this.tilesetUrl = null;
        }
        if (this.glbUrl) {
            URL.revokeObjectURL(this.glbUrl);
            this.glbUrl = null;
        }
    }

    private shouldUse3DTiles(): boolean {
        return (
            this.use3dTiles &&
            this.highlightMode === coreLib.HighlightMode.NO_HIGHLIGHT &&
            this.featureIdSubset.length === 0
        );
    }

    private bindTilesetEvents(viewer: Viewer) {
        if (!this.tileset) {
            return;
        }
        const debugTiles = (globalThis as any).__ERDBLICK_DEBUG_3DTILES__ === true;
        const requestRender = () => {
            if (viewer && viewer.scene) {
                viewer.scene.requestRender();
            }
        };
        this.tilesetEventRemovers.push(
            this.tileset.loadProgress.addEventListener((pending: number, processing: number) => {
                if (pending + processing > 0) {
                    if (debugTiles) {
                        console.info(`[3dtiles] loadProgress pending=${pending} processing=${processing}`);
                    }
                    requestRender();
                }
            })
        );
        this.tilesetEventRemovers.push(
            this.tileset.allTilesLoaded.addEventListener(() => {
                if (debugTiles) {
                    console.info("[3dtiles] allTilesLoaded");
                }
                requestRender();
            })
        );
        this.tilesetEventRemovers.push(
            this.tileset.tileVisible.addEventListener((tile: any) => {
                if (debugTiles) {
                    console.info("[3dtiles] tileVisible", tile);
                }
                requestRender();
            })
        );
        this.tilesetEventRemovers.push(
            this.tileset.tileFailed.addEventListener((error: any) => {
                console.error("[3dtiles] tile failed", error);
                requestRender();
            })
        );
        this.tilesetEventRemovers.push(
            this.tileset.tileLoad.addEventListener((tile: any) => {
                if (debugTiles) {
                    console.info("[3dtiles] tileLoad", tile);
                }
                requestRender();
            })
        );
    }

    /**
     * Check if this visualization needs re-rendering, based on
     * whether the isHighDetail flag changed.
     */
    isDirty() {
        return (
            this.isHighDetailAndNotEmpty() != this.hasHighDetailVisualization ||
            this.showTileBorder != this.hasTileBorder ||
            !this.lowDetailVisu
        );
    }

    /**
     * Combination of map name, layer name, style name and highlight mode which
     * (in combination with the tile id) uniquely identifies the rendered contents
     * of this TileVisualization as expected by the surrounding MergedPointsTiles.
     */
    private mapViewLayerStyleId(): MapViewLayerStyleRule {
        return this.pointMergeService.makeMapViewLayerStyleId(this.viewIndex, this.tile.mapName, this.tile.layerName, this.styleId, this.highlightMode);
    }

    public setStyleOption(optionId: string, value: string|number|boolean) {
        this.options[optionId] = value;
    }
}
