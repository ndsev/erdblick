import {COORDINATE_SYSTEM} from "@deck.gl/core";
import {PathLayer, ScatterplotLayer, SolidPolygonLayer} from "@deck.gl/layers";
import {PathStyleExtension} from "@deck.gl/extensions";
import {Matrix4} from "@math.gl/core";
import {FeatureTile} from "../../mapdata/features.model";
import {SceneMode} from "../../integrations/geo";
import {coreLib, uint8ArrayToWasm} from "../../integrations/wasm";
import {ITileVisualization, IRenderSceneHandle} from "../render-view.model";
import {DeckLayerRegistry, makeDeckLayerKey} from "./deck-layer-registry";
import {
    deckRenderWorkerPool,
    isDeckRenderWorkerPipelineEnabled
} from "./deck-render.worker.pool";
import {
    DeckGeometryBucketBuffers,
    DeckPathBucketBuffers,
    DeckPointBucketBuffers,
    DeckSurfaceBucketBuffers,
    DeckTileRenderBuffers,
    DeckVisualizationBufferResult,
    DeckWorkerTimings
} from "./deck-render.worker.protocol";
import {
    DeckTileSearchResultLayerVisualization as WasmDeckTileSearchResultLayerVisualization,
    TileLayerParser,
    TileSearchResultLayer
} from "../../../build/libs/core/erdblick-core";

interface DeckSceneHandle {
    layerRegistry?: DeckLayerRegistry;
    sceneMode?: SceneMode;
}

interface DeckBinaryAttribute<T extends ArrayLike<number>> {
    value: T;
    size: number;
}

interface DeckSearchPointLayerData {
    length: number;
    depthTest: boolean;
    coordinateOrigin: [number, number, number];
    featureAddresses: Uint32Array;
    attributes: {
        getPosition: DeckBinaryAttribute<Float32Array>;
        getFillColor: DeckBinaryAttribute<Uint8Array>;
        getRadius: DeckBinaryAttribute<Float32Array>;
    };
}

interface DeckSearchPathLayerData {
    length: number;
    depthTest: boolean;
    coordinateOrigin: [number, number, number];
    startIndices: Uint32Array;
    featureAddressesByPath: Uint32Array;
    attributes: {
        getPath: DeckBinaryAttribute<Float32Array>;
        instanceColors: DeckBinaryAttribute<Uint8Array>;
        instanceStrokeWidths: DeckBinaryAttribute<Float32Array>;
        instanceDashArrays?: DeckBinaryAttribute<Float32Array>;
    };
}

interface DeckSearchSurfaceLayerData {
    length: number;
    depthTest: boolean;
    coordinateOrigin: [number, number, number];
    startIndices: Uint32Array;
    featureAddresses: Uint32Array;
    attributes: {
        getPolygon: DeckBinaryAttribute<Float32Array>;
        fillColors: DeckBinaryAttribute<Uint8Array>;
    };
}

interface DeckSearchPickLayerMetadata {
    tileKey: string;
    searchResultFeatureIds: string[];
    featureAddresses?: Uint32Array;
    featureAddressesByPath?: Uint32Array;
}

interface DeckSearchPathLayerMetadata extends DeckSearchPickLayerMetadata {
    dashJustified?: boolean;
}

interface DeckSearchWasmRenderOutput {
    surfaceLayerData: DeckSearchSurfaceLayerData[];
    pathLayerData: DeckSearchPathLayerData[];
    pointLayerData: DeckSearchPointLayerData[];
    resultFeatureIds: string[];
    vertexCount: number;
    workerTimings: DeckWorkerTimings | null;
}

const MAX_DECK_PATH_COUNT = 1_000_000;
const MAX_DECK_SURFACE_COUNT = 1_000_000;
const MAX_DECK_VERTEX_COUNT = 20_000_000;
const MAX_DECK_POINT_COUNT = 10_000_000;
const RENDER_RANK_PRIORITY_SWITCH_ONLY = 0;
const RENDER_RANK_PRIORITY_NEVER_RENDERED_WITH_DATA = 1;
const RENDER_RANK_PRIORITY_DEFAULT = 2;
const RENDER_RANK_HAS_DATA = 0;
const RENDER_RANK_MISSING_DATA = 1;
const RENDER_RANK_RENDER_ORDER_MAX = (2 ** 51) - 1;
const RENDER_RANK_ORDER_STRIDE = 2;
const RENDER_RANK_PRIORITY_STRIDE = 2 ** 52;
const DECK_FLAT_2D_MODEL_MATRIX = new Matrix4().scale([1, 1, 0]);
const DECK_NO_DEPTH_TEST_PARAMETERS = {
    depthTest: false,
    depthMask: false
} as any;

/** Queue-backed deck visualization for one streamed server-side search-result tile. */
export class DeckTileSearchVisualization implements ITileVisualization {
    readonly viewIndex: number;
    readonly styleId: string;
    readonly tile: FeatureTile;
    styleOrder: number;
    highFidelityStage: number;
    prefersHighFidelity: boolean;
    maxLowFiLod: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | null;
    showTileBorder = false;

    private searchResultLayerBlob: Uint8Array;
    private readonly parser: TileLayerParser;
    private styleSpecJson: string;
    private renderQueued = false;
    private rendered = false;
    private deleted = false;
    private lastSignature = "";
    private tileDataVersionAtLastRender = -1;
    private readonly surfaceLayerKeys = new Set<string>();
    private readonly pathLayerKeys = new Set<string>();
    private readonly pointLayerKeys = new Set<string>();

    constructor(
        viewIndex: number,
        styleId: string,
        tile: FeatureTile,
        parser: TileLayerParser,
        searchResultLayerBlob: Uint8Array,
        styleSpecJson: string,
        highFidelityStage: number,
        prefersHighFidelity: boolean,
        maxLowFiLod: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | null,
        styleOrder = 0
    ) {
        this.viewIndex = viewIndex;
        this.styleId = styleId;
        this.tile = tile;
        this.parser = parser;
        this.searchResultLayerBlob = searchResultLayerBlob;
        this.styleSpecJson = styleSpecJson;
        this.highFidelityStage = highFidelityStage;
        this.prefersHighFidelity = prefersHighFidelity;
        this.maxLowFiLod = maxLowFiLod;
        this.styleOrder = styleOrder;
    }

    updateSearchResultLayer(
        searchResultLayerBlob: Uint8Array,
        styleSpecJson: string,
        styleOrder: number
    ): void {
        this.searchResultLayerBlob = searchResultLayerBlob;
        this.styleSpecJson = styleSpecJson;
        this.styleOrder = styleOrder;
    }

    async render(sceneHandle: IRenderSceneHandle): Promise<boolean> {
        const registry = this.resolveRegistry(sceneHandle);
        if (this.deleted || !this.prefersHighFidelity) {
            this.destroy(sceneHandle);
            return false;
        }

        const output = await this.renderWasm();
        if (this.deleted) {
            return false;
        }

        const modelMatrix = this.modelMatrixForScene(sceneHandle);
        this.applyLayerDataToRegistry(registry, output, modelMatrix);
        this.rendered = true;
        this.renderQueued = false;
        this.lastSignature = this.renderSignature();
        this.tileDataVersionAtLastRender = this.tile.dataVersion;
        this.tile.setVertexCount(output.vertexCount);
        return true;
    }

    destroy(sceneHandle: IRenderSceneHandle): void {
        this.deleted = true;
        const registry = this.resolveRegistry(sceneHandle);
        for (const key of this.surfaceLayerKeys) {
            registry.remove(key);
        }
        for (const key of this.pathLayerKeys) {
            registry.remove(key);
        }
        for (const key of this.pointLayerKeys) {
            registry.remove(key);
        }
        this.surfaceLayerKeys.clear();
        this.pathLayerKeys.clear();
        this.pointLayerKeys.clear();
        this.rendered = false;
        this.tileDataVersionAtLastRender = -1;
    }

    isDirty(): boolean {
        return !this.rendered
            || this.lastSignature !== this.renderSignature()
            || this.tileDataVersionAtLastRender !== this.tile.dataVersion;
    }

    renderRank(): number {
        const priorityBucket = this.hasPendingFidelitySwitch()
            ? RENDER_RANK_PRIORITY_SWITCH_ONLY
            : ((!this.rendered && this.searchResultLayerBlob.length > 0)
                ? RENDER_RANK_PRIORITY_NEVER_RENDERED_WITH_DATA
                : RENDER_RANK_PRIORITY_DEFAULT);
        const rawRenderOrder = this.tile.renderOrder();
        const renderOrder = Number.isFinite(rawRenderOrder)
            ? Math.max(0, Math.min(Math.floor(rawRenderOrder), RENDER_RANK_RENDER_ORDER_MAX))
            : RENDER_RANK_RENDER_ORDER_MAX;
        const hasDataRank = this.searchResultLayerBlob.length > 0 ? RENDER_RANK_HAS_DATA : RENDER_RANK_MISSING_DATA;
        return priorityBucket * RENDER_RANK_PRIORITY_STRIDE
            + renderOrder * RENDER_RANK_ORDER_STRIDE
            + hasDataRank;
    }

    updateStatus(renderQueued?: boolean): void {
        if (renderQueued !== undefined) {
            this.renderQueued = renderQueued;
        }
    }

    setStyleOption(_optionId: string, _value: string | number | boolean): boolean {
        return false;
    }

    private hasPendingFidelitySwitch(): boolean {
        return this.rendered && !this.prefersHighFidelity;
    }

    private renderSignature(): string {
        return JSON.stringify({
            renderQueued: this.renderQueued,
            prefersHighFidelity: this.prefersHighFidelity,
            styleSpecJson: this.styleSpecJson,
            styleOrder: this.styleOrder
        });
    }

    private async renderWasm(): Promise<DeckSearchWasmRenderOutput> {
        if (isDeckRenderWorkerPipelineEnabled()) {
            try {
                return await this.renderWasmInWorker();
            } catch (error) {
                console.error("Deck search-result worker rendering failed; falling back to main thread.", error);
            }
        }
        return await this.renderWasmOnMainThread();
    }

    private async renderWasmInWorker(): Promise<DeckSearchWasmRenderOutput> {
        const fieldDictBlob = this.tile.getFieldDictBlob();
        const dataSourceInfoBlob = this.tile.getDataSourceInfoBlob();
        if (!fieldDictBlob || !dataSourceInfoBlob) {
            throw new Error("Search-result worker render requested without parser context blobs.");
        }
        const result = await deckRenderWorkerPool().renderSearchTile({
            viewIndex: this.viewIndex,
            tileKey: this.tile.mapTileKey,
            searchResultLayerBlob: this.searchResultLayerBlob,
            fieldDictBlob,
            dataSourceInfoBlob,
            nodeId: this.tile.nodeId,
            mapName: this.tile.mapName,
            styleSpecJson: this.styleSpecJson
        });
        return this.translateRenderResult(result);
    }

    private async renderWasmOnMainThread(): Promise<DeckSearchWasmRenderOutput> {
        let searchLayer: TileSearchResultLayer | null = null;
        let deckVisu: WasmDeckTileSearchResultLayerVisualization | null = null;
        try {
            searchLayer = uint8ArrayToWasm(
                (data) => this.parser.readTileSearchResultLayer(data),
                this.searchResultLayerBlob
            ) as TileSearchResultLayer | null;
            if (!searchLayer) {
                throw new Error("Failed to parse search-result layer.");
            }
            deckVisu = new coreLib.DeckTileSearchResultLayerVisualization(
                this.viewIndex,
                this.tile.mapTileKey,
                this.styleSpecJson
            ) as WasmDeckTileSearchResultLayerVisualization;
            deckVisu.addTileSearchResultLayer(searchLayer);
            deckVisu.run();
            const renderResult = {
                ...(deckVisu.renderResult() as DeckVisualizationBufferResult),
                vertexCount: Math.max(0, Math.floor(Number(deckVisu.vertexCount()))),
                workerTimings: undefined
            } as unknown as DeckTileRenderBuffers;
            return this.translateRenderResult(renderResult);
        } finally {
            deckVisu?.delete();
            searchLayer?.delete();
        }
    }

    private translateRenderResult(result: DeckTileRenderBuffers): DeckSearchWasmRenderOutput {
        return {
            surfaceLayerData: this.buildSurfaceLayerData(result.coordinateOrigin, result.surface),
            pathLayerData: this.buildPathLayerData(result.coordinateOrigin, result.pathWorld),
            pointLayerData: this.buildPointLayerData(result.coordinateOrigin, result.pointWorld),
            resultFeatureIds: result.resultFeatureIds ?? [],
            vertexCount: result.vertexCount,
            workerTimings: result.workerTimings ?? null
        };
    }

    private resolveLayerKey(kind: "surface" | "path" | "point", depthTest: boolean): string {
        return makeDeckLayerKey({
            tileKey: this.tile.mapTileKey,
            styleId: this.styleId,
            hoverMode: "base",
            kind,
            variant: depthTest ? "search" : "search-overlay"
        });
    }

    private applyLayerDataToRegistry(
        registry: DeckLayerRegistry,
        output: DeckSearchWasmRenderOutput,
        modelMatrix: Matrix4 | null
    ): void {
        const desiredSurfaceLayerKeys = new Set<string>();
        const desiredPathLayerKeys = new Set<string>();
        const desiredPointLayerKeys = new Set<string>();

        for (const surfaceLayerData of output.surfaceLayerData) {
            const key = this.resolveLayerKey("surface", surfaceLayerData.depthTest);
            registry.upsert(
                key,
                new SolidPolygonLayer<DeckSearchSurfaceLayerData, DeckSearchPickLayerMetadata>({
                    id: key,
                    data: surfaceLayerData,
                    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                    coordinateOrigin: surfaceLayerData.coordinateOrigin,
                    filled: true,
                    extruded: false,
                    wireframe: false,
                    _normalize: false,
                    _full3d: true,
                    modelMatrix,
                    parameters: this.layerParametersForDepthTest(surfaceLayerData.depthTest),
                    pickable: true,
                    tileKey: this.tile.mapTileKey,
                    searchResultFeatureIds: output.resultFeatureIds,
                    featureAddresses: surfaceLayerData.featureAddresses
                }),
                660 + this.styleOrder
            );
            desiredSurfaceLayerKeys.add(key);
        }

        for (const pathLayerData of output.pathLayerData) {
            const key = this.resolveLayerKey("path", pathLayerData.depthTest);
            registry.upsert(
                key,
                new PathLayer<DeckSearchPathLayerData, DeckSearchPathLayerMetadata>({
                    id: key,
                    data: pathLayerData,
                    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                    coordinateOrigin: pathLayerData.coordinateOrigin,
                    _pathType: "open",
                    widthUnits: "pixels",
                    modelMatrix,
                    parameters: this.layerParametersForDepthTest(pathLayerData.depthTest),
                    capRounded: true,
                    jointRounded: true,
                    pickable: true,
                    dashJustified: true,
                    extensions: [new PathStyleExtension({dash: true})],
                    tileKey: this.tile.mapTileKey,
                    searchResultFeatureIds: output.resultFeatureIds,
                    featureAddressesByPath: pathLayerData.featureAddressesByPath
                }),
                665 + this.styleOrder
            );
            desiredPathLayerKeys.add(key);
        }

        for (const pointLayerData of output.pointLayerData) {
            const key = this.resolveLayerKey("point", pointLayerData.depthTest);
            registry.upsert(
                key,
                new ScatterplotLayer<DeckSearchPointLayerData, DeckSearchPickLayerMetadata>({
                    id: key,
                    data: pointLayerData,
                    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                    coordinateOrigin: pointLayerData.coordinateOrigin,
                    filled: true,
                    stroked: true,
                    radiusUnits: "pixels",
                    modelMatrix,
                    parameters: this.layerParametersForDepthTest(pointLayerData.depthTest),
                    getLineColor: [255, 255, 255, 220],
                    getLineWidth: 1,
                    lineWidthUnits: "pixels",
                    pickable: true,
                    tileKey: this.tile.mapTileKey,
                    searchResultFeatureIds: output.resultFeatureIds,
                    featureAddresses: pointLayerData.featureAddresses
                }),
                670 + this.styleOrder
            );
            desiredPointLayerKeys.add(key);
        }

        this.reconcileLayerKeys(registry, this.surfaceLayerKeys, desiredSurfaceLayerKeys);
        this.reconcileLayerKeys(registry, this.pathLayerKeys, desiredPathLayerKeys);
        this.reconcileLayerKeys(registry, this.pointLayerKeys, desiredPointLayerKeys);
    }

    private reconcileLayerKeys(
        registry: DeckLayerRegistry,
        activeLayerKeys: Set<string>,
        desiredLayerKeys: Set<string>
    ): void {
        for (const layerKey of activeLayerKeys) {
            if (!desiredLayerKeys.has(layerKey)) {
                registry.remove(layerKey);
            }
        }
        activeLayerKeys.clear();
        for (const layerKey of desiredLayerKeys) {
            activeLayerKeys.add(layerKey);
        }
    }

    private coordinateOriginFromRaw(raw: Float64Array): [number, number, number] | null {
        if (raw.length < 3) {
            return null;
        }
        return [raw[0], raw[1], raw[2]];
    }

    private buildPathLayerData(
        coordinateOriginRaw: Float64Array,
        raw: DeckPathBucketBuffers
    ): DeckSearchPathLayerData[] {
        const coordinateOrigin = this.coordinateOriginFromRaw(coordinateOriginRaw);
        if (!coordinateOrigin || raw.startIndices.length < 2) {
            return [];
        }
        const pathCount = raw.startIndices.length - 1;
        const vertexCount = raw.startIndices[pathCount];
        if (!pathCount || pathCount > MAX_DECK_PATH_COUNT || vertexCount <= 1 || vertexCount > MAX_DECK_VERTEX_COUNT) {
            return [];
        }
        if (raw.positions.length < vertexCount * 3
            || raw.colors.length < vertexCount * 4
            || raw.widths.length < vertexCount
            || raw.featureAddresses.length < pathCount
            || raw.startIndices[0] !== 0) {
            return [];
        }

        return [{
            length: pathCount,
            depthTest: false,
            coordinateOrigin,
            startIndices: raw.startIndices,
            featureAddressesByPath: raw.featureAddresses,
            attributes: {
                getPath: {value: raw.positions, size: 3},
                instanceColors: {value: raw.colors, size: 4},
                instanceStrokeWidths: {value: raw.widths, size: 1},
                ...(raw.dashArrays ? {instanceDashArrays: {value: raw.dashArrays, size: 2}} : {})
            }
        }];
    }

    private buildSurfaceLayerData(
        coordinateOriginRaw: Float64Array,
        raw: DeckSurfaceBucketBuffers
    ): DeckSearchSurfaceLayerData[] {
        const coordinateOrigin = this.coordinateOriginFromRaw(coordinateOriginRaw);
        if (!coordinateOrigin || raw.startIndices.length < 2) {
            return [];
        }
        const surfaceCount = raw.startIndices.length - 1;
        const vertexCount = raw.startIndices[surfaceCount];
        if (!surfaceCount || surfaceCount > MAX_DECK_SURFACE_COUNT || vertexCount < 3 || vertexCount > MAX_DECK_VERTEX_COUNT) {
            return [];
        }
        if (raw.positions.length < vertexCount * 3
            || raw.colors.length < vertexCount * 4
            || raw.featureAddresses.length < surfaceCount
            || raw.startIndices[0] !== 0) {
            return [];
        }

        return [{
            length: surfaceCount,
            depthTest: false,
            coordinateOrigin,
            startIndices: raw.startIndices,
            featureAddresses: raw.featureAddresses,
            attributes: {
                getPolygon: {value: raw.positions, size: 3},
                fillColors: {value: raw.colors, size: 4}
            }
        }];
    }

    private buildPointLayerData(
        coordinateOriginRaw: Float64Array,
        raw: DeckPointBucketBuffers
    ): DeckSearchPointLayerData[] {
        const coordinateOrigin = this.coordinateOriginFromRaw(coordinateOriginRaw);
        if (!coordinateOrigin || raw.positions.length < 3 || raw.positions.length % 3 !== 0) {
            return [];
        }
        const pointCount = raw.positions.length / 3;
        if (!pointCount || pointCount > MAX_DECK_POINT_COUNT) {
            return [];
        }
        if (raw.colors.length < pointCount * 4
            || raw.radii.length < pointCount
            || raw.featureAddresses.length < pointCount) {
            return [];
        }

        return [{
            length: pointCount,
            depthTest: false,
            coordinateOrigin,
            featureAddresses: raw.featureAddresses,
            attributes: {
                getPosition: {value: raw.positions, size: 3},
                getFillColor: {value: raw.colors, size: 4},
                getRadius: {value: raw.radii, size: 1}
            }
        }];
    }

    private modelMatrixForScene(sceneHandle: IRenderSceneHandle): Matrix4 | null {
        if (sceneHandle.renderer !== "deck") {
            return null;
        }
        const deckScene = sceneHandle.scene as DeckSceneHandle | undefined;
        return deckScene?.sceneMode === SceneMode.SCENE2D ? DECK_FLAT_2D_MODEL_MATRIX : null;
    }

    private layerParametersForDepthTest(depthTest: boolean) {
        return depthTest ? undefined : DECK_NO_DEPTH_TEST_PARAMETERS;
    }

    private resolveRegistry(sceneHandle: IRenderSceneHandle): DeckLayerRegistry {
        if (sceneHandle.renderer !== "deck") {
            throw new Error("DeckTileSearchVisualization can only render into a deck scene.");
        }
        const deckScene = sceneHandle.scene as DeckSceneHandle | undefined;
        if (!deckScene?.layerRegistry) {
            throw new Error("Deck scene handle does not expose a layer registry.");
        }
        return deckScene.layerRegistry;
    }
}
