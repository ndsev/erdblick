import {FeatureTile} from "../../mapdata/features.model";
import {
    DeckFeatureLayerVisualization,
    FeatureLayerStyle,
    HighlightMode,
    RuleFidelity,
    TileFeatureLayer
} from "../../../build/libs/core/erdblick-core";
import {SceneMode} from "../../integrations/geo";
import {ITileVisualization, IRenderSceneHandle} from "../render-view.model";
import {IconLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer} from "@deck.gl/layers";
import {PathStyleExtension} from "@deck.gl/extensions";
import {COORDINATE_SYSTEM} from "@deck.gl/core";
import {Matrix4} from "@math.gl/core";
import {DeckLayerRegistry, makeDeckLayerKey} from "./deck-layer-registry";
import {coreLib, type ErdblickCore_, uint8ArrayFromWasm} from "../../integrations/wasm";
import {
    DeckLowFiBundleBuffers,
    deckRenderWorkerPool,
    isDeckRenderWorkerPipelineEnabled
} from "./deck-render.worker.pool";
import {
    DECK_GEOMETRY_OUTPUT_ALL,
    DECK_GEOMETRY_OUTPUT_NON_POINTS_ONLY,
    DECK_GEOMETRY_OUTPUT_POINTS_ONLY,
    DeckGeometryOutputMode,
    DeckWorkerTimings
} from "./deck-render.worker.protocol";
import {MapViewLayerStyleRule, MergedPointVisualization, PointMergeService} from "../pointmerge.service";
import {collectLowFiRawBundles, type DeckLowFiRawAccessor} from "./deck-lowfi-bundle";
import {RelationLocateRequest, RelationLocateResult} from "../../mapdata/relation-locate.model";

interface StyleWithIsDeleted extends FeatureLayerStyle {
    isDeleted(): boolean;
    hasExplicitLowFidelityRules(): boolean;
    hasRelationRules(mode: HighlightMode): boolean;
}

interface DeckSceneHandle {
    deck?: unknown;
    layerRegistry?: DeckLayerRegistry;
    sceneMode?: SceneMode;
}

interface MergeCountProvider {
    count: (
        geoPos: {x: number, y: number, z: number},
        hashPos: string,
        level: number,
        mapViewLayerStyleRuleId: string
    ) => number;
}

interface DeckPickLayerMetadata {
    tileKey: string;
    featureIds?: Array<number | null>;
    featureIdsByVertex?: Array<number | null>;
}

interface DeckPathLayerMetadata extends DeckPickLayerMetadata {
    dashJustified?: boolean;
}

interface DeckBinaryAttribute<T extends ArrayLike<number>> {
    value: T;
    size: number;
}

interface DeckPathLayerData {
    length: number;
    billboard: boolean;
    coordinateOrigin: [number, number, number];
    startIndices: Uint32Array;
    featureIds: Array<number | null>;
    featureIdsByVertex: Array<number | null>;
    attributes: {
        getPath: DeckBinaryAttribute<Float32Array>;
        instanceColors: DeckBinaryAttribute<Uint8Array>;
        instanceStrokeWidths: DeckBinaryAttribute<Float32Array>;
        instanceDashArrays: DeckBinaryAttribute<Float32Array>;
    };
}

interface DeckPointLayerData {
    length: number;
    billboard: boolean;
    coordinateOrigin: [number, number, number];
    featureIds: Array<number | null>;
    attributes: {
        getPosition: DeckBinaryAttribute<Float32Array>;
        getFillColor: DeckBinaryAttribute<Uint8Array>;
        getRadius: DeckBinaryAttribute<Float32Array>;
    };
}

interface DeckSurfaceLayerData {
    length: number;
    coordinateOrigin: [number, number, number];
    startIndices: Uint32Array;
    featureIds: Array<number | null>;
    attributes: {
        getPolygon: DeckBinaryAttribute<Float32Array>;
        getFillColor: DeckBinaryAttribute<Uint8Array>;
    };
}

interface DeckPathRawBuffers {
    coordinateOrigin: Float64Array;
    positions: Float32Array;
    startIndices: Uint32Array;
    colors: Uint8Array;
    widths: Float32Array;
    featureIds: Uint32Array;
    billboards: Uint8Array;
    dashArrays?: Float32Array;
    dashOffsets?: Float32Array;
}

interface DeckPointRawBuffers {
    coordinateOrigin: Float64Array;
    positions: Float32Array;
    colors: Uint8Array;
    radii: Float32Array;
    featureIds: Uint32Array;
    billboards: Uint8Array;
}

interface DeckSurfaceRawBuffers {
    coordinateOrigin: Float64Array;
    positions: Float32Array;
    startIndices: Uint32Array;
    colors: Uint8Array;
    featureIds: Uint32Array;
}

interface DeckWasmRenderOutput {
    surfaceLayerData: DeckSurfaceLayerData[];
    pathLayerData: DeckPathLayerData[];
    pointLayerData: DeckPointLayerData[];
    arrowLayerData: DeckPathLayerData[];
    lowFiBundles: DeckLowFiBundleData[];
    mergedPointFeatures: Record<MapViewLayerStyleRule, MergedPointVisualization[]> | null;
    vertexCount: number;
    workerTimings: DeckWorkerTimings | null;
}

interface DeckLowFiBundleData {
    lod: number;
    surfaceLayerData: DeckSurfaceLayerData[];
    pathLayerData: DeckPathLayerData[];
    pointLayerData: DeckPointLayerData[];
    arrowLayerData: DeckPathLayerData[];
}

const MAX_DECK_PATH_COUNT = 1_000_000;
const MAX_DECK_SURFACE_COUNT = 1_000_000;
const MAX_DECK_VERTEX_COUNT = 20_000_000;
const MAX_DECK_POINT_COUNT = 10_000_000;
const DECK_UNSELECTABLE_FEATURE_INDEX = 0xffffffff;
const RENDER_RANK_PRIORITY_SWITCH_ONLY = 0;
const RENDER_RANK_PRIORITY_NEVER_RENDERED_WITH_DATA = 1;
const RENDER_RANK_PRIORITY_DEFAULT = 2;
const RENDER_RANK_HAS_DATA = 0;
const RENDER_RANK_MISSING_DATA = 1;
const RENDER_RANK_RENDER_ORDER_MAX = (2 ** 51) - 1;
const RENDER_RANK_ORDER_STRIDE = 2;
const RENDER_RANK_PRIORITY_STRIDE = 2 ** 52;
const DECK_ARROW_ANGLE_SIGN = -1;
const DECK_ARROW_ANGLE_OFFSET_DEG = 0;
const DECK_ARROW_ICON_SIZE = 64;
const DECK_FLAT_2D_MODEL_MATRIX = new Matrix4().scale([1, 1, 0]);
const DECK_ARROW_ICON_ATLAS =
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${DECK_ARROW_ICON_SIZE}" height="${DECK_ARROW_ICON_SIZE}" viewBox="0 0 ${DECK_ARROW_ICON_SIZE} ${DECK_ARROW_ICON_SIZE}"><polygon points="32,0 60,60 4,60" fill="white"/></svg>`
    );
const DECK_ARROW_ICON_MAPPING = {
    arrowhead: {
        x: 0,
        y: 0,
        width: DECK_ARROW_ICON_SIZE,
        height: DECK_ARROW_ICON_SIZE,
        anchorX: DECK_ARROW_ICON_SIZE / 2,
        anchorY: 0,
        mask: true
    }
};

type DeckFeatureLayerVisualizationCtor = ErdblickCore_["DeckFeatureLayerVisualization"];
type DeckRuleFidelityEnum = ErdblickCore_["RuleFidelity"];
type DeckVisualizationRawAccessor = DeckLowFiRawAccessor | "pathCoordinateOriginRaw";

function deckFeatureLayerVisualizationCtor(): DeckFeatureLayerVisualizationCtor {
    return coreLib.DeckFeatureLayerVisualization as DeckFeatureLayerVisualizationCtor;
}

function deckRuleFidelityEnum(): DeckRuleFidelityEnum {
    return coreLib.RuleFidelity as DeckRuleFidelityEnum;
}

interface DeckArrowMarker {
    id: number | null;
    position: [number, number, number];
    color: [number, number, number, number];
    sizePx: number;
    angleDeg: number;
    featureId: number | null;
}

interface DeckLayerKeys {
    surfaceLayerKey: string;
    pathLayerKey: string;
    pointLayerKey: string;
    arrowLayerKey: string;
}

interface DeckLayerRenderEntry {
    variantSuffix: string;
    orderOffset: number;
    surfaceLayerData: DeckSurfaceLayerData[];
    pathLayerData: DeckPathLayerData[];
    pointLayerData: DeckPointLayerData[];
    arrowLayerData: DeckPathLayerData[];
}

/**
 * Deck tile visualization used during migration.
 * It currently renders line geometry from DeckFeatureLayerVisualization.
 */
export class DeckTileVisualization implements ITileVisualization {
    tile: FeatureTile;
    highFidelityStage: number;
    prefersHighFidelity: boolean;
    maxLowFiLod: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | null;
    showTileBorder: boolean = false;
    readonly viewIndex: number;
    public readonly styleId: string;

    private readonly style: StyleWithIsDeleted;
    private readonly styleSource: string;
    private readonly layerKeySuffix: string;
    private readonly pointMergeService: PointMergeService;
    private readonly highlightMode: HighlightMode;
    private readonly featureIdSubset: string[];
    private readonly options: Record<string, boolean | number | string>;
    private readonly styleHasExplicitLowFidelityRules: boolean;
    private readonly styleHasRelationRules: boolean;
    private readonly relationExternalTileLoader: (requests: RelationLocateRequest[]) => Promise<RelationLocateResult>;
    private renderQueued = false;
    private deleted = false;
    private rendered = false;
    private readonly surfaceLayerKeys = new Set<string>();
    private readonly pointLayerKeys = new Set<string>();
    private readonly pathLayerKeys = new Set<string>();
    private readonly arrowLayerKeys = new Set<string>();
    private lastSignature = "";
    private hadTileDataAtLastRender = false;
    private tileFeatureCountAtLastRender = 0;
    private tileDataVersionAtLastRender = -1;
    private latestWorkerTimings: DeckWorkerTimings | null = null;
    private latestSurfaceLayerData: DeckSurfaceLayerData[] = [];
    private latestPointLayerData: DeckPointLayerData[] = [];
    private latestArrowLayerData: DeckPathLayerData[] = [];
    private latestLowFiBundleData: DeckLowFiBundleData[] = [];
    private lowFiBundleByLod = new Map<number, DeckLowFiBundleData>();
    private activeRenderedFidelity: "low" | "high" | "any" | null = null;
    private activeRenderedLowFiLods: number[] = [];
    private latestMergedPointFeatures: Record<MapViewLayerStyleRule, MergedPointVisualization[]> | null = null;


    constructor(viewIndex: number,
                tile: FeatureTile,
                pointMergeService: PointMergeService,
                style: FeatureLayerStyle,
                styleSource: string,
                highFidelityStage: number,
                prefersHighFidelity: boolean,
                maxLowFiLod: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | null,
                highlightMode: HighlightMode = coreLib.HighlightMode.NO_HIGHLIGHT,
                featureIdSubset: string[] = [],
                layerKeySuffix: string = "",
                boxGrid?: boolean,
                options?: Record<string, boolean | number | string>,
                relationExternalTileLoader: (requests: RelationLocateRequest[]) => Promise<RelationLocateResult> =
                    async () => ({responses: [], tiles: []})) {
        this.tile = tile;
        this.pointMergeService = pointMergeService;
        this.style = style as StyleWithIsDeleted;
        this.styleSource = styleSource;
        this.styleId = this.style.name();
        this.highFidelityStage = Math.max(0, Math.floor(highFidelityStage));
        this.prefersHighFidelity = prefersHighFidelity;
        this.maxLowFiLod = maxLowFiLod;
        this.highlightMode = highlightMode;
        this.featureIdSubset = [...featureIdSubset];
        this.layerKeySuffix = layerKeySuffix;
        this.showTileBorder = boxGrid === undefined ? false : boxGrid;
        this.options = options || {};
        this.relationExternalTileLoader = relationExternalTileLoader;
        this.styleHasExplicitLowFidelityRules = this.style.hasExplicitLowFidelityRules();
        this.styleHasRelationRules = this.style.hasRelationRules(this.highlightMode);
        this.viewIndex = viewIndex;
    }

    async render(sceneHandle: IRenderSceneHandle): Promise<boolean> {
        const registry = this.resolveRegistry(sceneHandle);
        if (this.deleted || this.style.isDeleted()) {
            return false;
        }
        this.latestWorkerTimings = null;
        const startTime = performance.now();
        try {
            const fidelity = this.currentFidelity();
            if (this.tryApplyCachedLowFiSwitch(sceneHandle, registry, fidelity)) {
                return true;
            }

            this.latestSurfaceLayerData = [];
            this.latestPointLayerData = [];
            this.latestArrowLayerData = [];
            this.latestLowFiBundleData = [];
            this.latestMergedPointFeatures = null;

            let pathLayerData = await this.renderWasm(fidelity);
            let surfaceLayerData = this.latestSurfaceLayerData;
            let pointLayerData = this.latestPointLayerData;
            let arrowLayerData = this.latestArrowLayerData;
            let activeLowFiLods: number[] = [];
            let selectedLowFiBundles: DeckLowFiBundleData[] = [];
            const mergedPointFeatures = this.latestMergedPointFeatures as
                Record<MapViewLayerStyleRule, MergedPointVisualization[]> | null;

            if (this.deleted || this.style.isDeleted()) {
                return false;
            }

            if (fidelity === "low") {
                this.updateLowFiBundleCache(this.latestLowFiBundleData);
                selectedLowFiBundles = this.selectLowFiBundlesForCurrentRequest();
                if (selectedLowFiBundles.length > 0) {
                    surfaceLayerData = [];
                    pathLayerData = [];
                    pointLayerData = [];
                    arrowLayerData = [];
                    activeLowFiLods = selectedLowFiBundles.map((bundle) => bundle.lod);
                }
            }

            if (this.shouldKeepActiveLowFiFallback(
                fidelity,
                surfaceLayerData,
                pathLayerData,
                pointLayerData,
                arrowLayerData,
                mergedPointFeatures
            )) {
                this.completeRender(fidelity, activeLowFiLods);
                return true;
            }

            this.clearMergedPointVisualizations(sceneHandle);
            if (fidelity === "low" && selectedLowFiBundles.length > 0) {
                this.applyLowFiBundleDataToRegistry(sceneHandle, registry, selectedLowFiBundles);
            } else {
                this.applyLayerDataToRegistry(
                    sceneHandle,
                    registry,
                    surfaceLayerData,
                    pathLayerData,
                    pointLayerData,
                    arrowLayerData
                );
            }

            if (mergedPointFeatures) {
                for (const [mapLayerStyleRuleId, mergedPointVisualizations] of Object.entries(mergedPointFeatures)) {
                    for (const finishedCornerTile of this.pointMergeService.insert(
                        mergedPointVisualizations as MergedPointVisualization[],
                        this.tile.tileId,
                        this.tile.mapTileKey,
                        mapLayerStyleRuleId
                    )) {
                        finishedCornerTile.renderScene(sceneHandle);
                    }
                }
            }

            this.completeRender(fidelity, activeLowFiLods);
            return true;
        } finally {
            const workerTimings = this.consumeLatestWorkerTimings();
            const wallTimeMs = performance.now() - startTime;
            this.recordRenderTimeSample(wallTimeMs, workerTimings?.totalMs);
            this.recordWorkerParseTimeSample(workerTimings?.deserializeMs);
        }
    }

    private resolveLayerKeys(variantSuffix = ""): DeckLayerKeys {
        const variant = this.composeLayerVariant(variantSuffix);
        return {
            surfaceLayerKey: makeDeckLayerKey({
                tileKey: this.tile.mapTileKey,
                styleId: this.styleId,
                hoverMode: this.highlightModeLabel(),
                kind: "surface",
                variant
            }),
            pathLayerKey: makeDeckLayerKey({
                tileKey: this.tile.mapTileKey,
                styleId: this.styleId,
                hoverMode: this.highlightModeLabel(),
                kind: "path",
                variant
            }),
            pointLayerKey: makeDeckLayerKey({
                tileKey: this.tile.mapTileKey,
                styleId: this.styleId,
                hoverMode: this.highlightModeLabel(),
                kind: "point",
                variant
            }),
            arrowLayerKey: makeDeckLayerKey({
                tileKey: this.tile.mapTileKey,
                styleId: this.styleId,
                hoverMode: this.highlightModeLabel(),
                kind: "arrow",
                variant
            })
        };
    }

    private composeLayerVariant(variantSuffix: string): string | undefined {
        const parts: string[] = [];
        if (this.layerKeySuffix.length > 0) {
            parts.push(this.layerKeySuffix);
        }
        if (variantSuffix.length > 0) {
            parts.push(variantSuffix);
        }
        if (!parts.length) {
            return undefined;
        }
        return parts.join("::");
    }

    private clearMergedPointVisualizations(sceneHandle: IRenderSceneHandle): void {
        for (const affectedCornerTile of this.pointMergeService.remove(
            this.tile.tileId,
            this.tile.mapTileKey,
            this.mapViewLayerStyleId()
        )) {
            affectedCornerTile.removeScene(sceneHandle);
            if (affectedCornerTile.referencingTiles.length > 0) {
                affectedCornerTile.renderScene(sceneHandle);
            }
        }
    }

    private applyLayerDataToRegistry(
        sceneHandle: IRenderSceneHandle,
        registry: DeckLayerRegistry,
        surfaceLayerData: DeckSurfaceLayerData[],
        pathLayerData: DeckPathLayerData[],
        pointLayerData: DeckPointLayerData[],
        arrowLayerData: DeckPathLayerData[]
    ): void {
        this.applyLayerEntriesToRegistry(sceneHandle, registry, [{
            variantSuffix: "",
            orderOffset: 0,
            surfaceLayerData,
            pathLayerData,
            pointLayerData,
            arrowLayerData
        }]);
    }

    private applyLowFiBundleDataToRegistry(
        sceneHandle: IRenderSceneHandle,
        registry: DeckLayerRegistry,
        lowFiBundles: DeckLowFiBundleData[]
    ): void {
        this.applyLayerEntriesToRegistry(sceneHandle, registry, lowFiBundles.map((bundle) => ({
            variantSuffix: `lowfi-lod-${bundle.lod}`,
            orderOffset: bundle.lod,
            surfaceLayerData: bundle.surfaceLayerData,
            pathLayerData: bundle.pathLayerData,
            pointLayerData: bundle.pointLayerData,
            arrowLayerData: bundle.arrowLayerData
        })));
    }

    private applyLayerEntriesToRegistry(
        sceneHandle: IRenderSceneHandle,
        registry: DeckLayerRegistry,
        entries: DeckLayerRenderEntry[]
    ): void {
        const desiredSurfaceLayerKeys = new Set<string>();
        const desiredPointLayerKeys = new Set<string>();
        const desiredPathLayerKeys = new Set<string>();
        const desiredArrowLayerKeys = new Set<string>();
        const modelMatrix = this.modelMatrixForScene(sceneHandle);

        for (const entry of entries) {
            for (const surfaceLayerData of entry.surfaceLayerData) {
                if (surfaceLayerData.length <= 0) {
                    continue;
                }
                const layerKeys = this.resolveLayerKeys(this.composeGeometryVariant(entry.variantSuffix, "surface"));
                const surfaceLayer = new SolidPolygonLayer<DeckSurfaceLayerData, DeckPickLayerMetadata>({
                    id: layerKeys.surfaceLayerKey,
                    data: surfaceLayerData,
                    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                    coordinateOrigin: surfaceLayerData.coordinateOrigin,
                    filled: true,
                    extruded: false,
                    wireframe: false,
                    _full3d: true,
                    modelMatrix,
                    pickable: true,
                    tileKey: this.tile.mapTileKey,
                    featureIds: surfaceLayerData.featureIds
                });
                registry.upsert(layerKeys.surfaceLayerKey, surfaceLayer, 350 + entry.orderOffset);
                desiredSurfaceLayerKeys.add(layerKeys.surfaceLayerKey);
            }

            for (const pointLayerData of entry.pointLayerData) {
                if (pointLayerData.length <= 0) {
                    continue;
                }
                const layerKeys = this.resolveLayerKeys(
                    this.composeGeometryVariant(entry.variantSuffix, "point", pointLayerData.billboard)
                );
                const pointLayer = new ScatterplotLayer<DeckPointLayerData, DeckPickLayerMetadata>({
                    id: layerKeys.pointLayerKey,
                    data: pointLayerData,
                    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                    coordinateOrigin: pointLayerData.coordinateOrigin,
                    filled: true,
                    stroked: false,
                    radiusUnits: "pixels",
                    billboard: pointLayerData.billboard,
                    modelMatrix,
                    pickable: true,
                    tileKey: this.tile.mapTileKey,
                    featureIds: pointLayerData.featureIds
                });
                registry.upsert(layerKeys.pointLayerKey, pointLayer, 425 + entry.orderOffset);
                desiredPointLayerKeys.add(layerKeys.pointLayerKey);
            }

            for (const pathLayerData of entry.pathLayerData) {
                if (pathLayerData.length <= 0) {
                    continue;
                }
                const layerKeys = this.resolveLayerKeys(
                    this.composeGeometryVariant(entry.variantSuffix, "path", pathLayerData.billboard)
                );
                const pathLayer = new PathLayer<DeckPathLayerData, DeckPathLayerMetadata>({
                    id: layerKeys.pathLayerKey,
                    data: pathLayerData,
                    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                    coordinateOrigin: pathLayerData.coordinateOrigin,
                    _pathType: "open",
                    widthUnits: "pixels",
                    billboard: pathLayerData.billboard,
                    modelMatrix,
                    capRounded: true,
                    jointRounded: true,
                    pickable: true,
                    dashJustified: true,
                    extensions: [new PathStyleExtension({dash: true})],
                    tileKey: this.tile.mapTileKey,
                    featureIds: pathLayerData.featureIds,
                    featureIdsByVertex: pathLayerData.featureIdsByVertex
                });
                registry.upsert(layerKeys.pathLayerKey, pathLayer, 400 + entry.orderOffset);
                desiredPathLayerKeys.add(layerKeys.pathLayerKey);
            }

            for (const arrowLayerData of entry.arrowLayerData) {
                if (arrowLayerData.length <= 0) {
                    continue;
                }
                const layerKeys = this.resolveLayerKeys(
                    this.composeGeometryVariant(entry.variantSuffix, "arrow", arrowLayerData.billboard)
                );
                const arrowMarkers = this.buildArrowMarkers(arrowLayerData);
                const arrowLayer = new IconLayer<DeckArrowMarker, DeckPickLayerMetadata>({
                    id: layerKeys.arrowLayerKey,
                    data: arrowMarkers,
                    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                    coordinateOrigin: arrowLayerData.coordinateOrigin,
                    iconAtlas: DECK_ARROW_ICON_ATLAS,
                    iconMapping: DECK_ARROW_ICON_MAPPING,
                    getIcon: () => "arrowhead",
                    getPosition: (marker: DeckArrowMarker) => marker.position,
                    getSize: (marker: DeckArrowMarker) => marker.sizePx,
                    sizeUnits: "pixels",
                    getAngle: (marker: DeckArrowMarker) => marker.angleDeg,
                    getColor: (marker: DeckArrowMarker) => marker.color,
                    billboard: arrowLayerData.billboard,
                    modelMatrix,
                    pickable: true,
                    tileKey: this.tile.mapTileKey,
                    alphaCutoff: 0.05,
                });
                registry.upsert(layerKeys.arrowLayerKey, arrowLayer, 450 + entry.orderOffset);
                desiredArrowLayerKeys.add(layerKeys.arrowLayerKey);
            }
        }

        this.reconcileLayerKeys(registry, this.surfaceLayerKeys, desiredSurfaceLayerKeys);
        this.reconcileLayerKeys(registry, this.pointLayerKeys, desiredPointLayerKeys);
        this.reconcileLayerKeys(registry, this.pathLayerKeys, desiredPathLayerKeys);
        this.reconcileLayerKeys(registry, this.arrowLayerKeys, desiredArrowLayerKeys);
    }

    private modelMatrixForScene(sceneHandle: IRenderSceneHandle): Matrix4 | null {
        if (sceneHandle.renderer !== "deck") {
            return null;
        }
        const deckScene = sceneHandle.scene as DeckSceneHandle | undefined;
        return deckScene?.sceneMode === SceneMode.SCENE2D ? DECK_FLAT_2D_MODEL_MATRIX : null;
    }

    private composeGeometryVariant(baseVariantSuffix: string, geometryKind: string, billboard?: boolean): string {
        const parts: string[] = [];
        if (baseVariantSuffix.length > 0) {
            parts.push(baseVariantSuffix);
        }
        parts.push(
            billboard === undefined
                ? geometryKind
                : `${geometryKind}-${billboard ? "billboard" : "world"}`
        );
        return parts.join("::");
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

    private completeRender(
        fidelity: "low" | "high" | "any" | null,
        activeLowFiLods: number[]
    ): void {
        this.rendered = true;
        this.renderQueued = false;
        this.deleted = false;
        this.lastSignature = this.renderSignature(fidelity);
        this.hadTileDataAtLastRender = this.tileHasData();
        this.tileFeatureCountAtLastRender = this.tileFeatureCount();
        this.tileDataVersionAtLastRender = this.tile.dataVersion;
        this.activeRenderedFidelity = fidelity;
        this.activeRenderedLowFiLods = fidelity === "low" ? [...activeLowFiLods] : [];
    }

    private hasRenderableLayerData(
        surfaceLayerData: DeckSurfaceLayerData[],
        pathLayerData: DeckPathLayerData[],
        pointLayerData: DeckPointLayerData[],
        arrowLayerData: DeckPathLayerData[]
    ): boolean {
        return surfaceLayerData.some((data) => data.length > 0)
            || pathLayerData.some((data) => data.length > 0)
            || pointLayerData.some((data) => data.length > 0)
            || arrowLayerData.some((data) => data.length > 0);
    }

    private hasRenderableMergedPointFeatures(
        mergedPointFeatures: Record<MapViewLayerStyleRule, MergedPointVisualization[]> | null
    ): boolean {
        if (!mergedPointFeatures) {
            return false;
        }
        return Object.values(mergedPointFeatures).some(features => features.length > 0);
    }

    private shouldKeepActiveLowFiFallback(
        fidelity: "low" | "high" | "any" | null,
        surfaceLayerData: DeckSurfaceLayerData[],
        pathLayerData: DeckPathLayerData[],
        pointLayerData: DeckPointLayerData[],
        arrowLayerData: DeckPathLayerData[],
        mergedPointFeatures: Record<MapViewLayerStyleRule, MergedPointVisualization[]> | null
    ): boolean {
        if (fidelity !== "high"
            || this.activeRenderedFidelity !== "low"
            || this.activeRenderedLowFiLods.length === 0) {
            return false;
        }
        return !this.hasRenderableLayerData(surfaceLayerData, pathLayerData, pointLayerData, arrowLayerData)
            && !this.hasRenderableMergedPointFeatures(mergedPointFeatures);
    }

    private updateLowFiBundleCache(lowFiBundles: DeckLowFiBundleData[]): void {
        this.lowFiBundleByLod.clear();
        for (const lowFiBundle of lowFiBundles) {
            this.lowFiBundleByLod.set(lowFiBundle.lod, lowFiBundle);
        }
    }

    private requestedLowFiLod(): number | null {
        const requestedLod = this.resolveMaxLowFiLod("low");
        if (requestedLod < 0) {
            return null;
        }
        return Math.max(0, Math.min(7, Math.floor(requestedLod)));
    }

    private selectLowFiBundlesForCurrentRequest(): DeckLowFiBundleData[] {
        const requestedLod = this.requestedLowFiLod();
        if (requestedLod === null) {
            return [];
        }
        return [...this.lowFiBundleByLod.values()]
            .filter((bundle) => bundle.lod <= requestedLod)
            .sort((lhs, rhs) => lhs.lod - rhs.lod);
    }

    private lowFiLodSelection(): number[] {
        return this.selectLowFiBundlesForCurrentRequest().map((bundle) => bundle.lod);
    }

    private sameLowFiLodSelection(lhs: number[], rhs: number[]): boolean {
        if (lhs.length !== rhs.length) {
            return false;
        }
        for (let index = 0; index < lhs.length; index++) {
            if (lhs[index] !== rhs[index]) {
                return false;
            }
        }
        return true;
    }

    private tryApplyCachedLowFiSwitch(
        sceneHandle: IRenderSceneHandle,
        registry: DeckLayerRegistry,
        fidelity: "low" | "high" | "any" | null
    ): boolean {
        if (fidelity !== "low" || !this.rendered) {
            return false;
        }
        const selectedLowFiBundles = this.selectLowFiBundlesForCurrentRequest();
        if (selectedLowFiBundles.length === 0) {
            // No cached low-fi output is available yet for this tile. Fall back to
            // the normal render path so we do not clear the current high-fi layers
            // and temporarily make the tile disappear during a high -> low switch.
            return false;
        }
        const selectedLowFiLods = selectedLowFiBundles.map((bundle) => bundle.lod);
        if (this.activeRenderedFidelity === "low" &&
            this.sameLowFiLodSelection(this.activeRenderedLowFiLods, selectedLowFiLods)) {
            return false;
        }

        this.clearMergedPointVisualizations(sceneHandle);
        this.latestPointLayerData = [];
        this.latestArrowLayerData = [];
        this.latestMergedPointFeatures = null;
        this.latestWorkerTimings = null;
        this.applyLowFiBundleDataToRegistry(sceneHandle, registry, selectedLowFiBundles);
        this.completeRender("low", selectedLowFiLods);
        return true;
    }

    private hasPendingLowFiSwitch(): boolean {
        if (!this.rendered
            || this.currentFidelity() !== "low"
            || this.activeRenderedFidelity !== "low") {
            return false;
        }
        return !this.sameLowFiLodSelection(this.activeRenderedLowFiLods, this.lowFiLodSelection());
    }

    private hasPendingFidelitySwitch(): boolean {
        if (!this.rendered) {
            return false;
        }
        const currentFidelity = this.currentFidelity();
        if (currentFidelity === null) {
            return false;
        }
        return currentFidelity !== this.activeRenderedFidelity;
    }

    destroy(sceneHandle: IRenderSceneHandle): void {
        this.deleted = true;
        const registry = this.resolveRegistry(sceneHandle);
        for (const affectedCornerTile of this.pointMergeService.remove(
            this.tile.tileId,
            this.tile.mapTileKey,
            this.mapViewLayerStyleId()
        )) {
            affectedCornerTile.removeScene(sceneHandle);
            if (affectedCornerTile.referencingTiles.length > 0) {
                affectedCornerTile.renderScene(sceneHandle);
            }
        }
        for (const pointLayerKey of this.pointLayerKeys) {
            registry.remove(pointLayerKey);
        }
        for (const pathLayerKey of this.pathLayerKeys) {
            registry.remove(pathLayerKey);
        }
        for (const arrowLayerKey of this.arrowLayerKeys) {
            registry.remove(arrowLayerKey);
        }
        this.pointLayerKeys.clear();
        this.pathLayerKeys.clear();
        this.arrowLayerKeys.clear();
        this.latestLowFiBundleData = [];
        this.lowFiBundleByLod.clear();
        this.activeRenderedFidelity = null;
        this.activeRenderedLowFiLods = [];
        this.rendered = false;
        this.hadTileDataAtLastRender = false;
        this.tileFeatureCountAtLastRender = 0;
        this.tileDataVersionAtLastRender = -1;
    }

    isDirty(): boolean {
        return (
            !this.rendered ||
            this.lastSignature !== this.renderSignature() ||
            this.hadTileDataAtLastRender !== this.tileHasData() ||
            this.tileFeatureCountAtLastRender !== this.tileFeatureCount() ||
            this.tileDataVersionAtLastRender !== this.tile.dataVersion
        );
    }

    renderRank(): number {
        const hasData = this.tileHasData();
        const priorityBucket = (this.hasPendingLowFiSwitch() || this.hasPendingFidelitySwitch())
            ? RENDER_RANK_PRIORITY_SWITCH_ONLY
            : ((!this.rendered && hasData)
                ? RENDER_RANK_PRIORITY_NEVER_RENDERED_WITH_DATA
                : RENDER_RANK_PRIORITY_DEFAULT);
        const rawRenderOrder = this.tile.renderOrder();
        const renderOrder = Number.isFinite(rawRenderOrder)
            ? Math.max(0, Math.min(Math.floor(rawRenderOrder), RENDER_RANK_RENDER_ORDER_MAX))
            : RENDER_RANK_RENDER_ORDER_MAX;
        const hasDataRank = hasData ? RENDER_RANK_HAS_DATA : RENDER_RANK_MISSING_DATA;
        return priorityBucket * RENDER_RANK_PRIORITY_STRIDE
            + renderOrder * RENDER_RANK_ORDER_STRIDE
            + hasDataRank;
    }

    updateStatus(renderQueued?: boolean): void {
        if (renderQueued !== undefined) {
            this.renderQueued = renderQueued;
        }
    }

    setStyleOption(optionId: string, value: string | number | boolean): boolean {
        this.options[optionId] = value;
        return true;
    }

    private highlightModeLabel(): string {
        switch (this.highlightMode.value) {
            case coreLib.HighlightMode.HOVER_HIGHLIGHT.value:
                return "hover";
            case coreLib.HighlightMode.SELECTION_HIGHLIGHT.value:
                return "selection";
            default:
                return "base";
        }
    }

    private renderSignature(fidelity: "low" | "high" | "any" | null = this.currentFidelity()): string {
        return JSON.stringify({
            fidelity,
            highFidelityStage: this.highFidelityStage,
            maxLowFiLod: this.styleHasExplicitLowFidelityRules ? this.maxLowFiLod : null,
            renderQueued: this.renderQueued,
            highlightMode: this.highlightMode.value,
            featureIdSubset: this.featureIdSubset,
            styleOptions: this.options
        });
    }

    private async renderWasm(fidelity: "low" | "high" | "any" | null): Promise<DeckPathLayerData[]> {
        if (fidelity === null) {
            return [];
        }

        // Keep non-base highlighting synchronous to minimize interaction latency
        // and avoid ordering races while selection/hover state changes.
        if (this.highlightMode.value !== coreLib.HighlightMode.NO_HIGHLIGHT.value) {
            const fullMainThread = await this.renderWasmOnMainThread(fidelity, DECK_GEOMETRY_OUTPUT_ALL);
            this.setTileVertexCount(fullMainThread.vertexCount);
            this.latestWorkerTimings = fullMainThread.workerTimings;
            this.latestSurfaceLayerData = fullMainThread.surfaceLayerData;
            this.latestPointLayerData = fullMainThread.pointLayerData;
            this.latestArrowLayerData = fullMainThread.arrowLayerData;
            this.latestLowFiBundleData = fullMainThread.lowFiBundles;
            this.latestMergedPointFeatures = fullMainThread.mergedPointFeatures;
            return fullMainThread.pathLayerData;
        }

        if (!isDeckRenderWorkerPipelineEnabled()) {
            const fullMainThread = await this.renderWasmOnMainThread(fidelity, DECK_GEOMETRY_OUTPUT_ALL);
            this.setTileVertexCount(fullMainThread.vertexCount);
            this.latestWorkerTimings = fullMainThread.workerTimings;
            this.latestSurfaceLayerData = fullMainThread.surfaceLayerData;
            this.latestPointLayerData = fullMainThread.pointLayerData;
            this.latestArrowLayerData = fullMainThread.arrowLayerData;
            this.latestLowFiBundleData = fullMainThread.lowFiBundles;
            this.latestMergedPointFeatures = fullMainThread.mergedPointFeatures;
            return fullMainThread.pathLayerData;
        }

        try {
            const workerOutput = await this.renderWasmInWorker(fidelity, DECK_GEOMETRY_OUTPUT_ALL);
            this.setTileVertexCount(workerOutput.vertexCount);
            this.latestWorkerTimings = workerOutput.workerTimings;
            this.latestSurfaceLayerData = workerOutput.surfaceLayerData;
            this.latestPointLayerData = workerOutput.pointLayerData;
            this.latestArrowLayerData = workerOutput.arrowLayerData;
            this.latestLowFiBundleData = workerOutput.lowFiBundles;
            this.latestMergedPointFeatures = workerOutput.mergedPointFeatures;
            return workerOutput.pathLayerData;
        } catch (error) {
            console.error("Deck worker rendering failed; falling back to main thread rendering.", error);
            const fullMainThread = await this.renderWasmOnMainThread(fidelity, DECK_GEOMETRY_OUTPUT_ALL);
            this.setTileVertexCount(fullMainThread.vertexCount);
            this.latestWorkerTimings = fullMainThread.workerTimings;
            this.latestSurfaceLayerData = fullMainThread.surfaceLayerData;
            this.latestPointLayerData = fullMainThread.pointLayerData;
            this.latestArrowLayerData = fullMainThread.arrowLayerData;
            this.latestLowFiBundleData = fullMainThread.lowFiBundles;
            this.latestMergedPointFeatures = fullMainThread.mergedPointFeatures;
            return fullMainThread.pathLayerData;
        }
    }

    private async renderWasmInWorker(
        fidelity: "low" | "high" | "any",
        outputMode: DeckGeometryOutputMode
    ): Promise<DeckWasmRenderOutput> {
        const fieldDictBlob = this.tile.getFieldDictBlob();
        const dataSourceInfoBlob = this.tile.getDataSourceInfoBlob();
        if (!fieldDictBlob || !dataSourceInfoBlob) {
            throw new Error("Worker render requested without parser context blobs.");
        }
        const tileStageBlobs = this.tile.stageBlobs().map(entry => entry.blob);
        if (!tileStageBlobs.length && this.tile.tileFeatureLayerBlob) {
            tileStageBlobs.push(this.tile.tileFeatureLayerBlob);
        }
        if (!tileStageBlobs.length) {
            throw new Error("Worker render requested without tile data blobs.");
        }
        const pool = deckRenderWorkerPool();
        const result = await pool.renderTile({
            viewIndex: this.viewIndex,
            tileKey: this.tile.mapTileKey,
            tileStageBlobs,
            fieldDictBlob,
            dataSourceInfoBlob,
            nodeId: this.tile.nodeId,
            mapName: this.tile.mapName,
            styleSource: this.styleSource,
            styleOptions: this.copyStyleOptions(),
            highlightModeValue: this.highlightMode.value,
            fidelityValue: this.fidelityEnumValue(fidelity).value,
            highFidelityStage: this.resolvedHighFidelityStage(),
            maxLowFiLod: this.resolveMaxLowFiLod(fidelity),
            outputMode,
            featureIdSubset: [...this.featureIdSubset],
            mergeCountSnapshot: this.pointMergeService.makeMergeCountSnapshot(
                this.tile.tileId,
                this.mapViewLayerStyleId(),
                this.tile.mapTileKey
            )
        });
        return {
            surfaceLayerData: this.buildSurfaceLayerData({
                coordinateOrigin: result.coordinateOrigin,
                positions: result.surfacePositions,
                startIndices: result.surfaceStartIndices,
                colors: result.surfaceColors,
                featureIds: result.surfaceFeatureIds
            }),
            pathLayerData: this.buildPathLayerData(result),
            pointLayerData: this.buildPointLayerData({
                coordinateOrigin: result.coordinateOrigin,
                positions: result.pointPositions,
                colors: result.pointColors,
                radii: result.pointRadii,
                featureIds: result.pointFeatureIds,
                billboards: result.pointBillboards
            }),
            arrowLayerData: this.buildPathLayerData({
                coordinateOrigin: result.coordinateOrigin,
                positions: result.arrowPositions,
                startIndices: result.arrowStartIndices,
                colors: result.arrowColors,
                widths: result.arrowWidths,
                featureIds: result.arrowFeatureIds,
                billboards: result.arrowBillboards
            }),
            lowFiBundles: this.buildLowFiBundleData(result.lowFiBundles, result.coordinateOrigin),
            mergedPointFeatures:
                (result.mergedPointFeatures ?? {}) as Record<MapViewLayerStyleRule, MergedPointVisualization[]>,
            vertexCount: result.vertexCount,
            workerTimings: result.workerTimings ?? null
        };
    }

    /**
     * Cross-tile relation resolution stays on the synchronous selection path.
     * Worker renders and regular viewport paints only resolve relations inside
     * the primary tile.
     */
    private shouldAddRelationAuxiliaryTiles(): boolean {
        return this.highlightMode.value === coreLib.HighlightMode.SELECTION_HIGHLIGHT.value
            && this.styleHasRelationRules;
    }

    private createMainThreadDeckVisualization(
        fidelity: "low" | "high" | "any",
        outputMode: DeckGeometryOutputMode
    ): DeckFeatureLayerVisualization {
        const deckCtor = deckFeatureLayerVisualizationCtor();
        const mergeCountProvider: MergeCountProvider = {
            count: (geoPos, hashPos, level, mapViewLayerStyleRuleId) => this.pointMergeService.count(
                geoPos,
                hashPos,
                level,
                mapViewLayerStyleRuleId,
                this.tile.mapTileKey
            )
        };
        return new deckCtor(
            this.viewIndex,
            this.tile.mapTileKey,
            this.style,
            this.options,
            mergeCountProvider,
            this.highlightMode,
            this.fidelityEnumValue(fidelity),
            this.resolvedHighFidelityStage(),
            this.resolveMaxLowFiLod(fidelity),
            this.mapGeometryOutputModeForWasm(outputMode),
            this.featureIdSubset
        );
    }

    private async addTilesAndRunMainThreadVisualization(
        deckVisu: DeckFeatureLayerVisualization
    ): Promise<number> {
        let vertexCount = 0;
        await this.tile.peekAsync(async (tileFeatureLayer) => {
            vertexCount = Number(tileFeatureLayer.numVertices());
            deckVisu.addTileFeatureLayer(tileFeatureLayer);
            deckVisu.run();
        });
        return vertexCount;
    }

    private async resolveExternalRelations(deckVisu: DeckFeatureLayerVisualization): Promise<void> {
        if (!this.shouldAddRelationAuxiliaryTiles()) {
            return;
        }
        const requests = (deckVisu.externalRelationReferences() as RelationLocateRequest[]) ?? [];
        if (requests.length === 0) {
            return;
        }
        const locateResult = await this.relationExternalTileLoader(requests);
        await FeatureTile.peekMany(locateResult.tiles, async (tileFeatureLayers: TileFeatureLayer[]) => {
            for (const tileFeatureLayer of tileFeatureLayers) {
                deckVisu.addTileFeatureLayer(tileFeatureLayer);
            }
            deckVisu.processResolvedExternalReferences(locateResult.responses);
        });
    }

    private async renderWasmOnMainThread(
        fidelity: "low" | "high" | "any",
        outputMode: DeckGeometryOutputMode
    ): Promise<DeckWasmRenderOutput> {
        let deckVisu: DeckFeatureLayerVisualization | undefined;
        try {
            deckVisu = this.createMainThreadDeckVisualization(fidelity, outputMode);
            const vertexCount = await this.addTilesAndRunMainThreadVisualization(deckVisu);
            await this.resolveExternalRelations(deckVisu);

            const pathLayerData = this.buildPathLayerData({
                coordinateOrigin: this.readFloat64Array(deckVisu, "pathCoordinateOriginRaw"),
                positions: this.readFloat32Array(deckVisu, "pathPositionsRaw"),
                startIndices: this.readUint32Array(deckVisu, "pathStartIndicesRaw"),
                colors: this.readUint8Array(deckVisu, "pathColorsRaw"),
                widths: this.readFloat32Array(deckVisu, "pathWidthsRaw"),
                featureIds: this.readUint32Array(deckVisu, "pathFeatureIdsRaw"),
                billboards: this.readUint8Array(deckVisu, "pathBillboardsRaw"),
                dashArrays: this.readFloat32Array(deckVisu, "pathDashArrayRaw"),
                dashOffsets: this.readFloat32Array(deckVisu, "pathDashOffsetsRaw")
            });
            const surfaceLayerData = this.buildSurfaceLayerData({
                coordinateOrigin: this.readFloat64Array(deckVisu, "pathCoordinateOriginRaw"),
                positions: this.readFloat32Array(deckVisu, "surfacePositionsRaw"),
                startIndices: this.readUint32Array(deckVisu, "surfaceStartIndicesRaw"),
                colors: this.readUint8Array(deckVisu, "surfaceColorsRaw"),
                featureIds: this.readUint32Array(deckVisu, "surfaceFeatureIdsRaw")
            });
            const pointLayerData = this.buildPointLayerData({
                coordinateOrigin: this.readFloat64Array(deckVisu, "pathCoordinateOriginRaw"),
                positions: this.readFloat32Array(deckVisu, "pointPositionsRaw"),
                colors: this.readUint8Array(deckVisu, "pointColorsRaw"),
                radii: this.readFloat32Array(deckVisu, "pointRadiiRaw"),
                featureIds: this.readUint32Array(deckVisu, "pointFeatureIdsRaw"),
                billboards: this.readUint8Array(deckVisu, "pointBillboardsRaw")
            });
            const arrowLayerData = this.buildPathLayerData({
                coordinateOrigin: this.readFloat64Array(deckVisu, "pathCoordinateOriginRaw"),
                positions: this.readFloat32Array(deckVisu, "arrowPositionsRaw"),
                startIndices: this.readUint32Array(deckVisu, "arrowStartIndicesRaw"),
                colors: this.readUint8Array(deckVisu, "arrowColorsRaw"),
                widths: this.readFloat32Array(deckVisu, "arrowWidthsRaw"),
                featureIds: this.readUint32Array(deckVisu, "arrowFeatureIdsRaw"),
                billboards: this.readUint8Array(deckVisu, "arrowBillboardsRaw")
            });
            const lowFiBundles = this.readLowFiBundlesFromDeckVisualization(deckVisu);
            return {
                surfaceLayerData,
                pathLayerData,
                pointLayerData,
                arrowLayerData,
                lowFiBundles,
                mergedPointFeatures: deckVisu.mergedPointFeatures() as
                    Record<MapViewLayerStyleRule, MergedPointVisualization[]>,
                vertexCount: Math.max(0, Math.floor(vertexCount)),
                workerTimings: null
            };
        } finally {
            if (deckVisu) {
                deckVisu.delete();
            }
        }
    }

    private buildLowFiBundleData(
        rawBundles: DeckLowFiBundleBuffers[],
        coordinateOrigin: Float64Array
    ): DeckLowFiBundleData[] {
        if (!rawBundles.length) {
            return [];
        }
        const bundlesByLod = new Map<number, DeckLowFiBundleData>();
        for (const rawBundle of rawBundles) {
            const lod = Number.isFinite(rawBundle.lod)
                ? Math.max(0, Math.min(7, Math.floor(rawBundle.lod)))
                : 0;
            const pathLayerData = this.buildPathLayerData({
                coordinateOrigin,
                positions: rawBundle.positions,
                startIndices: rawBundle.startIndices,
                colors: rawBundle.colors,
                widths: rawBundle.widths,
                featureIds: rawBundle.featureIds,
                billboards: rawBundle.billboards,
                dashArrays: rawBundle.dashArrays,
                dashOffsets: rawBundle.dashOffsets
            });
            const surfaceLayerData = this.buildSurfaceLayerData({
                coordinateOrigin,
                positions: rawBundle.surfacePositions,
                startIndices: rawBundle.surfaceStartIndices,
                colors: rawBundle.surfaceColors,
                featureIds: rawBundle.surfaceFeatureIds
            });
            const pointLayerData = this.buildPointLayerData({
                coordinateOrigin,
                positions: rawBundle.pointPositions,
                colors: rawBundle.pointColors,
                radii: rawBundle.pointRadii,
                featureIds: rawBundle.pointFeatureIds,
                billboards: rawBundle.pointBillboards
            });
            const arrowLayerData = this.buildPathLayerData({
                coordinateOrigin,
                positions: rawBundle.arrowPositions,
                startIndices: rawBundle.arrowStartIndices,
                colors: rawBundle.arrowColors,
                widths: rawBundle.arrowWidths,
                featureIds: rawBundle.arrowFeatureIds,
                billboards: rawBundle.arrowBillboards
            });
            if (!surfaceLayerData.length && !pathLayerData.length && !pointLayerData.length && !arrowLayerData.length) {
                continue;
            }
            bundlesByLod.set(lod, {
                lod,
                surfaceLayerData,
                pathLayerData,
                pointLayerData,
                arrowLayerData
            });
        }
        return [...bundlesByLod.values()].sort((lhs, rhs) => lhs.lod - rhs.lod);
    }

    private readLowFiBundlesFromDeckVisualization(deckVisu: DeckFeatureLayerVisualization): DeckLowFiBundleData[] {
        const rawBundles = collectLowFiRawBundles(
            deckVisu,
            (rawAccessor) => this.readRawBytes(deckVisu, rawAccessor)
        );
        if (!rawBundles.length) {
            return [];
        }
        const coordinateOrigin = this.readFloat64Array(deckVisu, "pathCoordinateOriginRaw");
        return this.buildLowFiBundleData(
            rawBundles.map((bundle): DeckLowFiBundleBuffers => ({
                lod: bundle.lod,
                pointPositions: this.bytesToFloat32Array(bundle.pointPositions),
                pointColors: bundle.pointColors,
                pointRadii: this.bytesToFloat32Array(bundle.pointRadii),
                pointFeatureIds: this.bytesToUint32Array(bundle.pointFeatureIds),
                pointBillboards: bundle.pointBillboards,
                surfacePositions: this.bytesToFloat32Array(bundle.surfacePositions),
                surfaceStartIndices: this.bytesToUint32Array(bundle.surfaceStartIndices),
                surfaceColors: bundle.surfaceColors,
                surfaceFeatureIds: this.bytesToUint32Array(bundle.surfaceFeatureIds),
                positions: this.bytesToFloat32Array(bundle.positions),
                startIndices: this.bytesToUint32Array(bundle.startIndices),
                colors: bundle.colors,
                widths: this.bytesToFloat32Array(bundle.widths),
                featureIds: this.bytesToUint32Array(bundle.featureIds),
                billboards: bundle.billboards,
                dashArrays: this.bytesToFloat32Array(bundle.dashArrays),
                dashOffsets: this.bytesToFloat32Array(bundle.dashOffsets),
                arrowPositions: this.bytesToFloat32Array(bundle.arrowPositions),
                arrowStartIndices: this.bytesToUint32Array(bundle.arrowStartIndices),
                arrowColors: bundle.arrowColors,
                arrowWidths: this.bytesToFloat32Array(bundle.arrowWidths),
                arrowFeatureIds: this.bytesToUint32Array(bundle.arrowFeatureIds),
                arrowBillboards: bundle.arrowBillboards
            })),
            coordinateOrigin
        );
    }

    private buildPathLayerData(raw: DeckPathRawBuffers): DeckPathLayerData[] {
        if (raw.coordinateOrigin.length < 3) {
            return [];
        }
        if (raw.startIndices.length < 2) {
            return [];
        }

        const pathCount = raw.startIndices.length - 1;
        if (!pathCount || pathCount > MAX_DECK_PATH_COUNT) {
            return [];
        }

        const vertexCount = raw.startIndices[pathCount];
        if (!Number.isFinite(vertexCount) || !Number.isInteger(vertexCount) ||
            vertexCount <= 1 || vertexCount > MAX_DECK_VERTEX_COUNT) {
            return [];
        }

        if (raw.positions.length < vertexCount * 3) {
            return [];
        }
        if (raw.colors.length < pathCount * 4 || raw.widths.length < pathCount) {
            return [];
        }
        if (raw.dashArrays && raw.dashArrays.length < pathCount * 2) {
            return [];
        }
        if (raw.featureIds.length < pathCount || raw.billboards.length < pathCount) {
            return [];
        }

        const buildBucket = (billboard: boolean): DeckPathLayerData | null => {
            let bucketPathCount = 0;
            let bucketVertexCount = 0;
            for (let pathIndex = 0; pathIndex < pathCount; pathIndex++) {
                const start = raw.startIndices[pathIndex];
                const end = raw.startIndices[pathIndex + 1];
                if (end <= start || end > vertexCount) {
                    return null;
                }
                if ((raw.billboards[pathIndex] !== 0) !== billboard) {
                    continue;
                }
                bucketPathCount += 1;
                bucketVertexCount += end - start;
            }

            if (!bucketPathCount || bucketVertexCount <= 1) {
                return null;
            }

            const positions = new Float32Array(bucketVertexCount * 3);
            const startIndices = new Uint32Array(bucketPathCount + 1);
            const instanceColors = new Uint8Array(bucketVertexCount * 4);
            const instanceStrokeWidths = new Float32Array(bucketVertexCount);
            const instanceDashArrays = new Float32Array(bucketVertexCount * 2);
            const featureIds: Array<number | null> = new Array<number | null>(bucketPathCount).fill(null);
            const featureIdsByVertex: Array<number | null> = new Array<number | null>(bucketVertexCount).fill(null);

            let nextPathIndex = 0;
            let nextVertexIndex = 0;
            startIndices[0] = 0;

            for (let pathIndex = 0; pathIndex < pathCount; pathIndex++) {
                if ((raw.billboards[pathIndex] !== 0) !== billboard) {
                    continue;
                }
                const start = raw.startIndices[pathIndex];
                const end = raw.startIndices[pathIndex + 1];
                const colorOffset = pathIndex * 4;
                const width = raw.widths[pathIndex];
                const dashArrayOffset = pathIndex * 2;
                const dashA = raw.dashArrays ? (raw.dashArrays[dashArrayOffset] ?? 1) : 1;
                const dashB = raw.dashArrays ? (raw.dashArrays[dashArrayOffset + 1] ?? 0) : 0;
                const featureId = raw.featureIds[pathIndex];
                const normalizedFeatureId =
                    Number.isInteger(featureId) && featureId !== DECK_UNSELECTABLE_FEATURE_INDEX
                        ? featureId
                        : null;
                featureIds[nextPathIndex] = normalizedFeatureId;

                for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
                    const sourcePositionOffset = vertexIndex * 3;
                    const targetPositionOffset = nextVertexIndex * 3;
                    positions[targetPositionOffset] = raw.positions[sourcePositionOffset] ?? 0;
                    positions[targetPositionOffset + 1] = raw.positions[sourcePositionOffset + 1] ?? 0;
                    positions[targetPositionOffset + 2] = raw.positions[sourcePositionOffset + 2] ?? 0;

                    const colorTargetOffset = nextVertexIndex * 4;
                    instanceColors[colorTargetOffset] = raw.colors[colorOffset];
                    instanceColors[colorTargetOffset + 1] = raw.colors[colorOffset + 1];
                    instanceColors[colorTargetOffset + 2] = raw.colors[colorOffset + 2];
                    instanceColors[colorTargetOffset + 3] = raw.colors[colorOffset + 3];
                    instanceStrokeWidths[nextVertexIndex] = width;
                    const dashTargetOffset = nextVertexIndex * 2;
                    instanceDashArrays[dashTargetOffset] = dashA;
                    instanceDashArrays[dashTargetOffset + 1] = dashB;
                    featureIdsByVertex[nextVertexIndex] = normalizedFeatureId;
                    nextVertexIndex += 1;
                }

                nextPathIndex += 1;
                startIndices[nextPathIndex] = nextVertexIndex;
            }

            return {
                length: bucketPathCount,
                billboard,
                coordinateOrigin: [
                    raw.coordinateOrigin[0],
                    raw.coordinateOrigin[1],
                    raw.coordinateOrigin[2]
                ],
                startIndices,
                featureIds,
                featureIdsByVertex,
                attributes: {
                    getPath: {value: positions, size: 3},
                    instanceColors: {value: instanceColors, size: 4},
                    instanceStrokeWidths: {value: instanceStrokeWidths, size: 1},
                    instanceDashArrays: {value: instanceDashArrays, size: 2}
                }
            };
        };

        return [buildBucket(false), buildBucket(true)]
            .filter((bucket): bucket is DeckPathLayerData => bucket !== null);
    }

    private buildSurfaceLayerData(raw: DeckSurfaceRawBuffers): DeckSurfaceLayerData[] {
        if (raw.coordinateOrigin.length < 3) {
            return [];
        }
        if (raw.startIndices.length < 2) {
            return [];
        }

        const surfaceCount = raw.startIndices.length - 1;
        if (!surfaceCount || surfaceCount > MAX_DECK_SURFACE_COUNT) {
            return [];
        }

        const vertexCount = raw.startIndices[surfaceCount];
        if (!Number.isFinite(vertexCount) || !Number.isInteger(vertexCount)
            || vertexCount < 3 || vertexCount > MAX_DECK_VERTEX_COUNT) {
            return [];
        }

        if (raw.positions.length < vertexCount * 3
            || raw.colors.length < surfaceCount * 4
            || raw.featureIds.length < surfaceCount) {
            return [];
        }

        for (let surfaceIndex = 0; surfaceIndex < surfaceCount; surfaceIndex++) {
            const start = raw.startIndices[surfaceIndex];
            const end = raw.startIndices[surfaceIndex + 1];
            if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 3 || end > vertexCount) {
                return [];
            }
        }

        const featureIds: Array<number | null> = new Array<number | null>(surfaceCount).fill(null);
        for (let surfaceIndex = 0; surfaceIndex < surfaceCount; surfaceIndex++) {
            const featureId = raw.featureIds[surfaceIndex];
            featureIds[surfaceIndex] =
                Number.isInteger(featureId) && featureId !== DECK_UNSELECTABLE_FEATURE_INDEX
                    ? featureId
                    : null;
        }

        return [{
            length: surfaceCount,
            coordinateOrigin: [
                raw.coordinateOrigin[0],
                raw.coordinateOrigin[1],
                raw.coordinateOrigin[2]
            ],
            startIndices: raw.startIndices,
            featureIds,
            attributes: {
                getPolygon: {value: raw.positions, size: 3},
                getFillColor: {value: raw.colors, size: 4}
            }
        }];
    }

    private buildPointLayerData(raw: DeckPointRawBuffers): DeckPointLayerData[] {
        if (raw.coordinateOrigin.length < 3) {
            return [];
        }
        if (raw.positions.length < 3) {
            return [];
        }
        if (raw.positions.length % 3 !== 0) {
            return [];
        }

        const pointCount = raw.positions.length / 3;
        if (!pointCount || pointCount > MAX_DECK_POINT_COUNT) {
            return [];
        }
        if (raw.colors.length < pointCount * 4
            || raw.radii.length < pointCount
            || raw.featureIds.length < pointCount
            || raw.billboards.length < pointCount) {
            return [];
        }

        const buildBucket = (billboard: boolean): DeckPointLayerData | null => {
            let bucketPointCount = 0;
            for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
                if ((raw.billboards[pointIndex] !== 0) === billboard) {
                    bucketPointCount += 1;
                }
            }
            if (!bucketPointCount) {
                return null;
            }

            const positions = new Float32Array(bucketPointCount * 3);
            const colors = new Uint8Array(bucketPointCount * 4);
            const radii = new Float32Array(bucketPointCount);
            const featureIds: Array<number | null> = new Array<number | null>(bucketPointCount).fill(null);

            let nextPointIndex = 0;
            for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
                if ((raw.billboards[pointIndex] !== 0) !== billboard) {
                    continue;
                }
                const sourcePositionOffset = pointIndex * 3;
                const targetPositionOffset = nextPointIndex * 3;
                positions[targetPositionOffset] = raw.positions[sourcePositionOffset] ?? 0;
                positions[targetPositionOffset + 1] = raw.positions[sourcePositionOffset + 1] ?? 0;
                positions[targetPositionOffset + 2] = raw.positions[sourcePositionOffset + 2] ?? 0;

                const sourceColorOffset = pointIndex * 4;
                const targetColorOffset = nextPointIndex * 4;
                colors[targetColorOffset] = raw.colors[sourceColorOffset];
                colors[targetColorOffset + 1] = raw.colors[sourceColorOffset + 1];
                colors[targetColorOffset + 2] = raw.colors[sourceColorOffset + 2];
                colors[targetColorOffset + 3] = raw.colors[sourceColorOffset + 3];

                radii[nextPointIndex] = raw.radii[pointIndex] ?? 0;
                const featureId = raw.featureIds[pointIndex];
                featureIds[nextPointIndex] =
                    Number.isInteger(featureId) && featureId !== DECK_UNSELECTABLE_FEATURE_INDEX
                        ? featureId
                        : null;
                nextPointIndex += 1;
            }

            return {
                length: bucketPointCount,
                billboard,
                coordinateOrigin: [
                    raw.coordinateOrigin[0],
                    raw.coordinateOrigin[1],
                    raw.coordinateOrigin[2]
                ],
                featureIds,
                attributes: {
                    getPosition: {value: positions, size: 3},
                    getFillColor: {value: colors, size: 4},
                    getRadius: {value: radii, size: 1}
                }
            };
        };

        return [buildBucket(false), buildBucket(true)]
            .filter((bucket): bucket is DeckPointLayerData => bucket !== null);
    }

    private buildArrowMarkers(pathData: DeckPathLayerData): DeckArrowMarker[] {
        const markers: DeckArrowMarker[] = [];
        const positions = pathData.attributes.getPath.value;
        const colors = pathData.attributes.instanceColors.value;
        const widths = pathData.attributes.instanceStrokeWidths.value;
        for (let arrowIndex = 0; arrowIndex < pathData.length; arrowIndex++) {
            const start = pathData.startIndices[arrowIndex];
            const end = pathData.startIndices[arrowIndex + 1];
            if (end - start < 3) continue;

            const leftVertex = start;
            const tipVertex = start + 1;
            const rightVertex = end - 1;

            const tipBase = tipVertex * 3;
            const leftBase = leftVertex * 3;
            const rightBase = rightVertex * 3;

            const tipX = positions[tipBase];
            const tipY = positions[tipBase + 1];
            const tipZ = positions[tipBase + 2];

            const baseCenterX = (positions[leftBase] + positions[rightBase]) * 0.5;
            const baseCenterY = (positions[leftBase + 1] + positions[rightBase + 1]) * 0.5;

            const dirX = tipX - baseCenterX;
            const dirY = tipY - baseCenterY;
            const dirLength = Math.hypot(dirX, dirY);
            if (dirLength <= 1e-6) continue;

            const colorBase = tipVertex * 4;
            const widthPx = widths[tipVertex];
            const featureId = pathData.featureIds[arrowIndex];
            const angleDeg =
                this.normalizeDegrees(
                    DECK_ARROW_ANGLE_SIGN * ((Math.atan2(dirX, dirY) * 180) / Math.PI) +
                    DECK_ARROW_ANGLE_OFFSET_DEG
                );
            const sizePx = Math.max(8, widthPx * 4);
            markers.push({
                id: featureId,
                position: [tipX, tipY, tipZ],
                color: [
                    colors[colorBase],
                    colors[colorBase + 1],
                    colors[colorBase + 2],
                    colors[colorBase + 3]
                ],
                sizePx,
                angleDeg,
                featureId
            });
        }
        return markers;
    }

    private bytesToFloat32Array(raw: Uint8Array): Float32Array {
        if (raw.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
            return new Float32Array();
        }
        return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / Float32Array.BYTES_PER_ELEMENT);
    }

    private bytesToUint32Array(raw: Uint8Array): Uint32Array {
        if (raw.byteLength % Uint32Array.BYTES_PER_ELEMENT !== 0) {
            return new Uint32Array();
        }
        return new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / Uint32Array.BYTES_PER_ELEMENT);
    }

    private readFloat32Array(deckVisu: DeckFeatureLayerVisualization, rawAccessor: DeckVisualizationRawAccessor): Float32Array {
        const raw = this.readRawBytes(deckVisu, rawAccessor);
        return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / Float32Array.BYTES_PER_ELEMENT);
    }

    private readFloat64Array(deckVisu: DeckFeatureLayerVisualization, rawAccessor: DeckVisualizationRawAccessor): Float64Array {
        const raw = this.readRawBytes(deckVisu, rawAccessor);
        return new Float64Array(raw.buffer, raw.byteOffset, raw.byteLength / Float64Array.BYTES_PER_ELEMENT);
    }

    private readUint32Array(deckVisu: DeckFeatureLayerVisualization, rawAccessor: DeckVisualizationRawAccessor): Uint32Array {
        const raw = this.readRawBytes(deckVisu, rawAccessor);
        return new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / Uint32Array.BYTES_PER_ELEMENT);
    }

    private readUint8Array(deckVisu: DeckFeatureLayerVisualization, rawAccessor: DeckVisualizationRawAccessor): Uint8Array {
        return this.readRawBytes(deckVisu, rawAccessor);
    }

    private readRawBytes(deckVisu: DeckFeatureLayerVisualization, rawAccessor: DeckVisualizationRawAccessor): Uint8Array {
        return uint8ArrayFromWasm((shared) => {
            deckVisu[rawAccessor](shared);
            return true;
        }) as Uint8Array;
    }

    private tileHasData(): boolean {
        return this.tile.hasData();
    }

    private tileFeatureCount(): number {
        return this.tile.numFeatures;
    }

    private resolvedHighFidelityStage(): number {
        return this.highFidelityStage;
    }

    private highestLoadedStageOrDefault(): number | null {
        const highestLoadedStage = this.tile.highestLoadedStage();
        if (highestLoadedStage === null || highestLoadedStage === undefined || !Number.isFinite(highestLoadedStage)) {
            return null;
        }
        return Math.max(0, Math.floor(highestLoadedStage));
    }

    private currentFidelity(): "low" | "high" | "any" | null {
        if (!this.tile.hasData() || this.tile.numFeatures <= 0) {
            return null;
        }
        const highestLoadedStage = this.highestLoadedStageOrDefault();
        if (highestLoadedStage !== null &&
            this.prefersHighFidelity &&
            highestLoadedStage >= this.resolvedHighFidelityStage()) {
            return "high";
        }
        if (!this.styleHasExplicitLowFidelityRules) {
            return "any";
        }
        return "low";
    }

    private fidelityEnumValue(fidelity: "low" | "high" | "any"): RuleFidelity {
        const fidelityEnum = deckRuleFidelityEnum();
        if (fidelity === "high") {
            return fidelityEnum.HIGH;
        }
        if (fidelity === "low") {
            return fidelityEnum.LOW;
        }
        return fidelityEnum.ANY;
    }

    private resolveMaxLowFiLod(fidelity: "low" | "high" | "any"): number {
        if (fidelity !== "low" || !this.styleHasExplicitLowFidelityRules) {
            return -1;
        }
        if (this.maxLowFiLod === null || this.maxLowFiLod === undefined) {
            return -1;
        }
        return this.maxLowFiLod;
    }

    private mapGeometryOutputModeForWasm(outputMode: DeckGeometryOutputMode): number {
        const ctor = deckFeatureLayerVisualizationCtor();
        if (outputMode === DECK_GEOMETRY_OUTPUT_POINTS_ONLY
        ) {
            return ctor.GEOMETRY_OUTPUT_POINTS_ONLY();
        }
        if (outputMode === DECK_GEOMETRY_OUTPUT_NON_POINTS_ONLY
        ) {
            return ctor.GEOMETRY_OUTPUT_NON_POINTS_ONLY();
        }
        return ctor.GEOMETRY_OUTPUT_ALL();
    }

    private setTileVertexCount(count: number): void {
        this.tile.setVertexCount(Math.max(0, Math.floor(Number(count))));
    }

    private copyStyleOptions(): Record<string, boolean | number | string> {
        return {...this.options};
    }

    private mapViewLayerStyleId(): MapViewLayerStyleRule {
        return this.pointMergeService.makeMapViewLayerStyleId(
            this.viewIndex,
            this.tile.mapName,
            this.tile.layerName,
            this.styleId,
            this.highlightMode
        );
    }

    private recordRenderTimeSample(durationMs: number, measuredDurationMs?: number): void {
        const sampleDuration = Number.isFinite(measuredDurationMs)
            ? measuredDurationMs as number
            : durationMs;
        const timingListKey = `Rendering/${this.statsHighlightModeLabel()}/${this.styleId}#ms`;
        const timingList = this.tile.stats.get(timingListKey);
        if (timingList) {
            timingList.push(sampleDuration);
            return;
        }
        this.tile.stats.set(timingListKey, [sampleDuration]);
    }

    private recordWorkerParseTimeSample(durationMs?: number): void {
        if (!Number.isFinite(durationMs)) {
            return;
        }
        const parseTimes = this.tile.stats.get(FeatureTile.statParseTime);
        if (parseTimes) {
            parseTimes.push(durationMs as number);
            return;
        }
        this.tile.stats.set(FeatureTile.statParseTime, [durationMs as number]);
    }

    private statsHighlightModeLabel(): string {
        switch (this.highlightMode.value) {
            case coreLib.HighlightMode.HOVER_HIGHLIGHT.value:
                return "Hover";
            case coreLib.HighlightMode.SELECTION_HIGHLIGHT.value:
                return "Selection";
            default:
                return "Basic";
        }
    }

    private resolveRegistry(sceneHandle: IRenderSceneHandle): DeckLayerRegistry {
        const scene = sceneHandle.scene as DeckSceneHandle;
        return scene.layerRegistry!;
    }

    private consumeLatestWorkerTimings(): DeckWorkerTimings | null {
        const timings = this.latestWorkerTimings;
        this.latestWorkerTimings = null;
        return timings;
    }

    private normalizeDegrees(value: number): number {
        const normalized = value % 360;
        return normalized < 0 ? normalized + 360 : normalized;
    }
}
