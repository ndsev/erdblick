import {FeatureTile} from "../../mapdata/features.model";
import {FeatureLayerStyle, HighlightMode} from "../../../build/libs/core/erdblick-core";
import {ITileVisualization, IRenderSceneHandle} from "../render-view.model";
import {IconLayer, PathLayer, ScatterplotLayer} from "@deck.gl/layers";
import {PathStyleExtension} from "@deck.gl/extensions";
import {COORDINATE_SYSTEM} from "@deck.gl/core";
import {DeckLayerRegistry, makeDeckLayerKey} from "./deck-layer-registry";
import {coreLib, uint8ArrayFromWasm} from "../../integrations/wasm";
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
import {collectLowFiRawBundles} from "./deck-lowfi-bundle";

interface StyleWithIsDeleted extends FeatureLayerStyle {
    isDeleted(): boolean;
    hasExplicitLowFidelityRules(): boolean;
}

interface DeckSceneHandle {
    deck?: unknown;
    layerRegistry?: DeckLayerRegistry;
}

interface DeckBinaryAttribute<T extends ArrayLike<number>> {
    value: T;
    size: number;
}

interface DeckPathLayerData {
    length: number;
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
    coordinateOrigin: [number, number, number];
    featureIds: Array<number | null>;
    attributes: {
        getPosition: DeckBinaryAttribute<Float32Array>;
        getFillColor: DeckBinaryAttribute<Uint8Array>;
        getRadius: DeckBinaryAttribute<Float32Array>;
    };
}

interface DeckPathRawBuffers {
    coordinateOrigin: Float64Array;
    positions: Float32Array;
    startIndices: Uint32Array;
    colors: Uint8Array;
    widths: Float32Array;
    featureIds: Uint32Array;
    dashArrays?: Float32Array;
    dashOffsets?: Float32Array;
}

interface DeckPointRawBuffers {
    coordinateOrigin: Float64Array;
    positions: Float32Array;
    colors: Uint8Array;
    radii: Float32Array;
    featureIds: Uint32Array;
}

interface DeckWasmRenderOutput {
    pathLayerData: DeckPathLayerData | null;
    pointLayerData: DeckPointLayerData | null;
    arrowLayerData: DeckPathLayerData | null;
    lowFiBundles: DeckLowFiBundleData[];
    mergedPointFeatures: Record<MapViewLayerStyleRule, MergedPointVisualization[]> | null;
    vertexCount: number;
    workerTimings: DeckWorkerTimings | null;
}

interface DeckLowFiBundleData {
    lod: number;
    pathLayerData: DeckPathLayerData | null;
    pointLayerData: DeckPointLayerData | null;
    arrowLayerData: DeckPathLayerData | null;
}

const MAX_DECK_PATH_COUNT = 1_000_000;
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

interface DeckArrowMarker {
    id: number | null;
    position: [number, number, number];
    color: [number, number, number, number];
    sizePx: number;
    angleDeg: number;
    featureId: number | null;
}

interface DeckLayerKeys {
    pathLayerKey: string;
    pointLayerKey: string;
    arrowLayerKey: string;
}

interface DeckLayerRenderEntry {
    variantSuffix: string;
    orderOffset: number;
    pathLayerData: DeckPathLayerData | null;
    pointLayerData: DeckPointLayerData | null;
    arrowLayerData: DeckPathLayerData | null;
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
    private renderQueued = false;
    private deleted = false;
    private rendered = false;
    private readonly pointLayerKeys = new Set<string>();
    private readonly pathLayerKeys = new Set<string>();
    private readonly arrowLayerKeys = new Set<string>();
    private lastSignature = "";
    private hadTileDataAtLastRender = false;
    private tileFeatureCountAtLastRender = 0;
    private latestWorkerTimings: DeckWorkerTimings | null = null;
    private latestPointLayerData: DeckPointLayerData | null = null;
    private latestArrowLayerData: DeckPathLayerData | null = null;
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
                options?: Record<string, boolean | number | string>) {
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
        const styleWithLowFidelityIntrospection = this.style as FeatureLayerStyle & {
            hasExplicitLowFidelityRules?: () => boolean;
        };
        this.styleHasExplicitLowFidelityRules =
            typeof styleWithLowFidelityIntrospection.hasExplicitLowFidelityRules === "function"
                ? styleWithLowFidelityIntrospection.hasExplicitLowFidelityRules()
                : true;
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

            this.clearMergedPointVisualizations(sceneHandle);
            this.latestPointLayerData = null;
            this.latestArrowLayerData = null;
            this.latestLowFiBundleData = [];
            this.latestMergedPointFeatures = null;

            let pathLayerData = await this.renderWasm(fidelity);
            let pointLayerData = this.latestPointLayerData as DeckPointLayerData | null;
            let arrowLayerData = this.latestArrowLayerData as DeckPathLayerData | null;
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
                    pathLayerData = null;
                    pointLayerData = null;
                    arrowLayerData = null;
                    activeLowFiLods = selectedLowFiBundles.map((bundle) => bundle.lod);
                }
            }

            if (fidelity === "low" && selectedLowFiBundles.length > 0) {
                this.applyLowFiBundleDataToRegistry(registry, selectedLowFiBundles);
            } else {
                this.applyLayerDataToRegistry(registry, pathLayerData, pointLayerData, arrowLayerData);
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
        for (const removedCornerTile of this.pointMergeService.remove(
            this.tile.tileId,
            this.mapViewLayerStyleId()
        )) {
            removedCornerTile.removeScene(sceneHandle);
        }
    }

    private applyLayerDataToRegistry(
        registry: DeckLayerRegistry,
        pathLayerData: DeckPathLayerData | null,
        pointLayerData: DeckPointLayerData | null,
        arrowLayerData: DeckPathLayerData | null
    ): void {
        this.applyLayerEntriesToRegistry(registry, [{
            variantSuffix: "",
            orderOffset: 0,
            pathLayerData,
            pointLayerData,
            arrowLayerData
        }]);
    }

    private applyLowFiBundleDataToRegistry(
        registry: DeckLayerRegistry,
        lowFiBundles: DeckLowFiBundleData[]
    ): void {
        this.applyLayerEntriesToRegistry(registry, lowFiBundles.map((bundle) => ({
            variantSuffix: `lowfi-lod-${bundle.lod}`,
            orderOffset: bundle.lod,
            pathLayerData: bundle.pathLayerData,
            pointLayerData: bundle.pointLayerData,
            arrowLayerData: bundle.arrowLayerData
        })));
    }

    private applyLayerEntriesToRegistry(
        registry: DeckLayerRegistry,
        entries: DeckLayerRenderEntry[]
    ): void {
        const desiredPointLayerKeys = new Set<string>();
        const desiredPathLayerKeys = new Set<string>();
        const desiredArrowLayerKeys = new Set<string>();

        for (const entry of entries) {
            const layerKeys = this.resolveLayerKeys(entry.variantSuffix);
            if (entry.pointLayerData && entry.pointLayerData.length > 0) {
                const pointLayer = new ScatterplotLayer({
                    id: layerKeys.pointLayerKey,
                    data: entry.pointLayerData as any,
                    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                    coordinateOrigin: entry.pointLayerData.coordinateOrigin,
                    filled: true,
                    stroked: false,
                    radiusUnits: "pixels",
                    pickable: true,
                    tileKey: this.tile.mapTileKey,
                    featureIds: entry.pointLayerData.featureIds
                } as any);
                registry.upsert(layerKeys.pointLayerKey, pointLayer as any, 425 + entry.orderOffset);
                desiredPointLayerKeys.add(layerKeys.pointLayerKey);
            }

            if (entry.pathLayerData && entry.pathLayerData.length > 0) {
                const pathLayer = new PathLayer({
                    id: layerKeys.pathLayerKey,
                    data: entry.pathLayerData as any,
                    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                    coordinateOrigin: entry.pathLayerData.coordinateOrigin,
                    _pathType: "open",
                    widthUnits: "pixels",
                    capRounded: true,
                    jointRounded: true,
                    pickable: true,
                    dashJustified: true,
                    extensions: [new PathStyleExtension({dash: true})],
                    tileKey: this.tile.mapTileKey,
                    featureIds: entry.pathLayerData.featureIds,
                    featureIdsByVertex: entry.pathLayerData.featureIdsByVertex
                } as any);
                registry.upsert(layerKeys.pathLayerKey, pathLayer as any, 400 + entry.orderOffset);
                desiredPathLayerKeys.add(layerKeys.pathLayerKey);
            }

            if (entry.arrowLayerData && entry.arrowLayerData.length > 0) {
                const arrowMarkers = this.buildArrowMarkers(entry.arrowLayerData);
                const arrowLayer = new IconLayer({
                    id: layerKeys.arrowLayerKey,
                    data: arrowMarkers,
                    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                    coordinateOrigin: entry.arrowLayerData.coordinateOrigin,
                    iconAtlas: DECK_ARROW_ICON_ATLAS,
                    iconMapping: DECK_ARROW_ICON_MAPPING as any,
                    getIcon: () => "arrowhead",
                    getPosition: (marker: DeckArrowMarker) => marker.position,
                    getSize: (marker: DeckArrowMarker) => marker.sizePx,
                    sizeUnits: "pixels",
                    getAngle: (marker: DeckArrowMarker) => marker.angleDeg,
                    getColor: (marker: DeckArrowMarker) => marker.color,
                    billboard: false,
                    pickable: true,
                    tileKey: this.tile.mapTileKey,
                    alphaCutoff: 0.05,
                    getId: (marker: DeckArrowMarker) => marker.featureId
                } as any);
                registry.upsert(layerKeys.arrowLayerKey, arrowLayer as any, 450 + entry.orderOffset);
                desiredArrowLayerKeys.add(layerKeys.arrowLayerKey);
            }
        }

        this.reconcileLayerKeys(registry, this.pointLayerKeys, desiredPointLayerKeys);
        this.reconcileLayerKeys(registry, this.pathLayerKeys, desiredPathLayerKeys);
        this.reconcileLayerKeys(registry, this.arrowLayerKeys, desiredArrowLayerKeys);
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
        this.activeRenderedFidelity = fidelity;
        this.activeRenderedLowFiLods = fidelity === "low" ? [...activeLowFiLods] : [];
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
            return false;
        }
        const selectedLowFiLods = selectedLowFiBundles.map((bundle) => bundle.lod);
        if (this.activeRenderedFidelity === "low" &&
            this.sameLowFiLodSelection(this.activeRenderedLowFiLods, selectedLowFiLods)) {
            return false;
        }

        this.clearMergedPointVisualizations(sceneHandle);
        this.latestPointLayerData = null;
        this.latestArrowLayerData = null;
        this.latestMergedPointFeatures = null;
        this.latestWorkerTimings = null;
        this.applyLowFiBundleDataToRegistry(registry, selectedLowFiBundles);
        this.completeRender("low", selectedLowFiLods);
        return true;
    }

    private hasPendingLowFiSwitch(): boolean {
        if (!this.rendered || this.currentFidelity() !== "low") {
            return false;
        }
        const selectedLowFiLods = this.lowFiLodSelection();
        if (selectedLowFiLods.length === 0) {
            return false;
        }
        if (this.activeRenderedFidelity !== "low") {
            return true;
        }
        return !this.sameLowFiLodSelection(this.activeRenderedLowFiLods, selectedLowFiLods);
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
        for (const removedCornerTile of this.pointMergeService.remove(
            this.tile.tileId,
            this.mapViewLayerStyleId()
        )) {
            removedCornerTile.removeScene(sceneHandle);
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
    }

    isDirty(): boolean {
        return (
            !this.rendered ||
            this.lastSignature !== this.renderSignature() ||
            this.hadTileDataAtLastRender !== this.tileHasData() ||
            this.tileFeatureCountAtLastRender !== this.tileFeatureCount()
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

    private async renderWasm(fidelity: "low" | "high" | "any" | null): Promise<DeckPathLayerData | null> {
        if (fidelity === null) {
            return null;
        }

        // Keep non-base highlighting synchronous to minimize interaction latency
        // and avoid ordering races while selection/hover state changes.
        if (this.highlightMode.value !== coreLib.HighlightMode.NO_HIGHLIGHT.value) {
            const fullMainThread = await this.renderWasmOnMainThread(fidelity, DECK_GEOMETRY_OUTPUT_ALL);
            this.setTileVertexCount(fullMainThread.vertexCount);
            this.latestWorkerTimings = fullMainThread.workerTimings;
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
        const result = await pool.renderPaths({
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
                this.mapViewLayerStyleId()
            )
        });
        return {
            pathLayerData: this.buildPathLayerData(result),
            pointLayerData: this.buildPointLayerData({
                coordinateOrigin: result.coordinateOrigin,
                positions: result.pointPositions,
                colors: result.pointColors,
                radii: result.pointRadii,
                featureIds: result.pointFeatureIds
            }),
            arrowLayerData: this.buildPathLayerData({
                coordinateOrigin: result.coordinateOrigin,
                positions: result.arrowPositions,
                startIndices: result.arrowStartIndices,
                colors: result.arrowColors,
                widths: result.arrowWidths,
                featureIds: result.arrowFeatureIds
            }),
            lowFiBundles: this.buildLowFiBundleData(result.lowFiBundles, result.coordinateOrigin),
            mergedPointFeatures:
                (result.mergedPointFeatures ?? {}) as Record<MapViewLayerStyleRule, MergedPointVisualization[]>,
            vertexCount: result.vertexCount,
            workerTimings: result.workerTimings ?? null
        };
    }

    private async renderWasmOnMainThread(
        fidelity: "low" | "high" | "any",
        outputMode: DeckGeometryOutputMode
    ): Promise<DeckWasmRenderOutput> {
        let deckVisu: any;
        try {
            deckVisu = new (coreLib as any).DeckFeatureLayerVisualization(
                this.viewIndex,
                this.tile.mapTileKey,
                this.style,
                this.options,
                this.pointMergeService,
                this.highlightMode,
                this.fidelityEnumValue(fidelity),
                this.resolvedHighFidelityStage(),
                this.resolveMaxLowFiLod(fidelity),
                this.mapGeometryOutputModeForWasm(outputMode),
                this.featureIdSubset
            );
            if (typeof deckVisu.setGeometryOutputMode === "function") {
                deckVisu.setGeometryOutputMode(this.mapGeometryOutputModeForWasm(outputMode));
            }

            let vertexCount = 0;

            await this.tile.peekAsync(async (tileFeatureLayer) => {
                vertexCount = Number(tileFeatureLayer.numVertices());
                deckVisu.addTileFeatureLayer(tileFeatureLayer);
                deckVisu.run();
            });

            const pathLayerData = this.buildPathLayerData({
                coordinateOrigin: this.readFloat64Array(deckVisu, "pathCoordinateOriginRaw"),
                positions: this.readFloat32Array(deckVisu, "pathPositionsRaw"),
                startIndices: this.readUint32Array(deckVisu, "pathStartIndicesRaw"),
                colors: this.readUint8Array(deckVisu, "pathColorsRaw"),
                widths: this.readFloat32Array(deckVisu, "pathWidthsRaw"),
                featureIds: this.readUint32Array(deckVisu, "pathFeatureIdsRaw"),
                dashArrays: this.readFloat32Array(deckVisu, "pathDashArrayRaw"),
                dashOffsets: this.readFloat32Array(deckVisu, "pathDashOffsetsRaw")
            });
            const pointLayerData = this.buildPointLayerData({
                coordinateOrigin: this.readFloat64Array(deckVisu, "pathCoordinateOriginRaw"),
                positions: this.readFloat32Array(deckVisu, "pointPositionsRaw"),
                colors: this.readUint8Array(deckVisu, "pointColorsRaw"),
                radii: this.readFloat32Array(deckVisu, "pointRadiiRaw"),
                featureIds: this.readUint32Array(deckVisu, "pointFeatureIdsRaw")
            });
            const arrowLayerData = this.buildPathLayerData({
                coordinateOrigin: this.readFloat64Array(deckVisu, "pathCoordinateOriginRaw"),
                positions: this.readFloat32Array(deckVisu, "arrowPositionsRaw"),
                startIndices: this.readUint32Array(deckVisu, "arrowStartIndicesRaw"),
                colors: this.readUint8Array(deckVisu, "arrowColorsRaw"),
                widths: this.readFloat32Array(deckVisu, "arrowWidthsRaw"),
                featureIds: this.readUint32Array(deckVisu, "arrowFeatureIdsRaw")
            });
            const lowFiBundles = this.readLowFiBundlesFromDeckVisualization(deckVisu);
            return {
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
            if (deckVisu && typeof deckVisu.delete === "function") {
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
                dashArrays: rawBundle.dashArrays,
                dashOffsets: rawBundle.dashOffsets
            });
            const pointLayerData = this.buildPointLayerData({
                coordinateOrigin,
                positions: rawBundle.pointPositions,
                colors: rawBundle.pointColors,
                radii: rawBundle.pointRadii,
                featureIds: rawBundle.pointFeatureIds
            });
            const arrowLayerData = this.buildPathLayerData({
                coordinateOrigin,
                positions: rawBundle.arrowPositions,
                startIndices: rawBundle.arrowStartIndices,
                colors: rawBundle.arrowColors,
                widths: rawBundle.arrowWidths,
                featureIds: rawBundle.arrowFeatureIds
            });
            if (!pathLayerData && !pointLayerData && !arrowLayerData) {
                continue;
            }
            bundlesByLod.set(lod, {
                lod,
                pathLayerData,
                pointLayerData,
                arrowLayerData
            });
        }
        return [...bundlesByLod.values()].sort((lhs, rhs) => lhs.lod - rhs.lod);
    }

    private readLowFiBundlesFromDeckVisualization(deckVisu: any): DeckLowFiBundleData[] {
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
                positions: this.bytesToFloat32Array(bundle.positions),
                startIndices: this.bytesToUint32Array(bundle.startIndices),
                colors: bundle.colors,
                widths: this.bytesToFloat32Array(bundle.widths),
                featureIds: this.bytesToUint32Array(bundle.featureIds),
                dashArrays: this.bytesToFloat32Array(bundle.dashArrays),
                dashOffsets: this.bytesToFloat32Array(bundle.dashOffsets),
                arrowPositions: this.bytesToFloat32Array(bundle.arrowPositions),
                arrowStartIndices: this.bytesToUint32Array(bundle.arrowStartIndices),
                arrowColors: bundle.arrowColors,
                arrowWidths: this.bytesToFloat32Array(bundle.arrowWidths),
                arrowFeatureIds: this.bytesToUint32Array(bundle.arrowFeatureIds)
            })),
            coordinateOrigin
        );
    }

    private buildPathLayerData(raw: DeckPathRawBuffers): DeckPathLayerData | null {
        if (raw.coordinateOrigin.length < 3) {
            return null;
        }
        if (raw.startIndices.length < 2) {
            return null;
        }

        const pathCount = raw.startIndices.length - 1;
        if (!pathCount || pathCount > MAX_DECK_PATH_COUNT) {
            return null;
        }

        const vertexCount = raw.startIndices[pathCount];
        if (!Number.isFinite(vertexCount) || !Number.isInteger(vertexCount) ||
            vertexCount <= 1 || vertexCount > MAX_DECK_VERTEX_COUNT) {
            return null;
        }

        if (raw.positions.length < vertexCount * 3) {
            return null;
        }
        if (raw.colors.length < pathCount * 4 || raw.widths.length < pathCount) {
            return null;
        }
        if (raw.dashArrays && raw.dashArrays.length < pathCount * 2) {
            return null;
        }
        if (raw.featureIds.length < pathCount) {
            return null;
        }

        const instanceColors = new Uint8Array(vertexCount * 4);
        const instanceStrokeWidths = new Float32Array(vertexCount);
        const instanceDashArrays = new Float32Array(vertexCount * 2);
        const featureIds: Array<number | null> = new Array<number | null>(pathCount).fill(null);
        const featureIdsByVertex: Array<number | null> = new Array<number | null>(vertexCount).fill(null);

        for (let pathIndex = 0; pathIndex < pathCount; pathIndex++) {
            const start = raw.startIndices[pathIndex];
            const end = raw.startIndices[pathIndex + 1];
            if (end <= start || end > vertexCount) {
                return null;
            }
            const colorOffset = pathIndex * 4;
            const r = raw.colors[colorOffset];
            const g = raw.colors[colorOffset + 1];
            const b = raw.colors[colorOffset + 2];
            const a = raw.colors[colorOffset + 3];
            const width = raw.widths[pathIndex];
            const dashArrayOffset = pathIndex * 2;
            const dashA = raw.dashArrays ? (raw.dashArrays[dashArrayOffset] ?? 1) : 1;
            const dashB = raw.dashArrays ? (raw.dashArrays[dashArrayOffset + 1] ?? 0) : 0;
            const featureId = raw.featureIds[pathIndex];
            const normalizedFeatureId =
                Number.isInteger(featureId) && featureId !== DECK_UNSELECTABLE_FEATURE_INDEX
                    ? featureId
                    : null;
            featureIds[pathIndex] = normalizedFeatureId;

            for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
                const colorTargetOffset = vertexIndex * 4;
                instanceColors[colorTargetOffset] = r;
                instanceColors[colorTargetOffset + 1] = g;
                instanceColors[colorTargetOffset + 2] = b;
                instanceColors[colorTargetOffset + 3] = a;
                instanceStrokeWidths[vertexIndex] = width;
                const dashTargetOffset = vertexIndex * 2;
                instanceDashArrays[dashTargetOffset] = dashA;
                instanceDashArrays[dashTargetOffset + 1] = dashB;
                featureIdsByVertex[vertexIndex] = normalizedFeatureId;
            }
        }

        return {
            length: pathCount,
            coordinateOrigin: [
                raw.coordinateOrigin[0],
                raw.coordinateOrigin[1],
                raw.coordinateOrigin[2]
            ],
            startIndices: raw.startIndices,
            featureIds,
            featureIdsByVertex,
            attributes: {
                getPath: {value: raw.positions, size: 3},
                instanceColors: {value: instanceColors, size: 4},
                instanceStrokeWidths: {value: instanceStrokeWidths, size: 1},
                instanceDashArrays: {value: instanceDashArrays, size: 2}
            }
        };
    }

    private buildPointLayerData(raw: DeckPointRawBuffers): DeckPointLayerData | null {
        if (raw.coordinateOrigin.length < 3) {
            return null;
        }
        if (raw.positions.length < 3) {
            return null;
        }
        if (raw.positions.length % 3 !== 0) {
            return null;
        }

        const pointCount = raw.positions.length / 3;
        if (!pointCount || pointCount > MAX_DECK_POINT_COUNT) {
            return null;
        }
        if (raw.colors.length < pointCount * 4 || raw.radii.length < pointCount || raw.featureIds.length < pointCount) {
            return null;
        }

        const featureIds: Array<number | null> = new Array<number | null>(pointCount).fill(null);
        for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
            const featureId = raw.featureIds[pointIndex];
            featureIds[pointIndex] =
                Number.isInteger(featureId) && featureId !== DECK_UNSELECTABLE_FEATURE_INDEX
                    ? featureId
                    : null;
        }

        return {
            length: pointCount,
            coordinateOrigin: [
                raw.coordinateOrigin[0],
                raw.coordinateOrigin[1],
                raw.coordinateOrigin[2]
            ],
            featureIds,
            attributes: {
                getPosition: {value: raw.positions, size: 3},
                getFillColor: {value: raw.colors, size: 4},
                getRadius: {value: raw.radii, size: 1}
            }
        };
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

    private readFloat32Array(deckVisu: any, rawAccessor: string): Float32Array {
        const raw = this.readRawBytes(deckVisu, rawAccessor);
        return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / Float32Array.BYTES_PER_ELEMENT);
    }

    private readFloat64Array(deckVisu: any, rawAccessor: string): Float64Array {
        const raw = this.readRawBytes(deckVisu, rawAccessor);
        return new Float64Array(raw.buffer, raw.byteOffset, raw.byteLength / Float64Array.BYTES_PER_ELEMENT);
    }

    private readUint32Array(deckVisu: any, rawAccessor: string): Uint32Array {
        const raw = this.readRawBytes(deckVisu, rawAccessor);
        return new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / Uint32Array.BYTES_PER_ELEMENT);
    }

    private readUint8Array(deckVisu: any, rawAccessor: string): Uint8Array {
        return this.readRawBytes(deckVisu, rawAccessor);
    }

    private readRawBytes(deckVisu: any, rawAccessor: string): Uint8Array {
        return uint8ArrayFromWasm((shared) => {
            deckVisu[rawAccessor](shared);
            return true;
        }) as Uint8Array;
    }

    private tileHasData(): boolean {
        return this.tile.hasData();
    }

    private tileFeatureCount(): number {
        return (this.tile as any).numFeatures as number;
    }

    private resolvedHighFidelityStage(): number {
        return this.highFidelityStage;
    }

    private highestLoadedStageOrDefault(): number | null {
        const tileWithStages = this.tile as FeatureTile & { highestLoadedStage?: () => number | null };
        if (typeof tileWithStages.highestLoadedStage === "function") {
            const highestLoadedStage = tileWithStages.highestLoadedStage();
            if (highestLoadedStage === null || highestLoadedStage === undefined || !Number.isFinite(highestLoadedStage)) {
                return null;
            }
            return Math.max(0, Math.floor(highestLoadedStage));
        }
        return this.tile.hasData() ? 0 : null;
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

    private fidelityEnumValue(fidelity: "low" | "high" | "any"): any {
        if (fidelity === "high") {
            return (coreLib as any).RuleFidelity.HIGH;
        }
        if (fidelity === "low") {
            return (coreLib as any).RuleFidelity.LOW;
        }
        return (coreLib as any).RuleFidelity.ANY;
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
        const ctor = (coreLib as any).DeckFeatureLayerVisualization;
        if (!ctor) {
            return outputMode;
        }
        if (outputMode === DECK_GEOMETRY_OUTPUT_POINTS_ONLY
            && typeof ctor.GEOMETRY_OUTPUT_POINTS_ONLY === "function") {
            return ctor.GEOMETRY_OUTPUT_POINTS_ONLY();
        }
        if (outputMode === DECK_GEOMETRY_OUTPUT_NON_POINTS_ONLY
            && typeof ctor.GEOMETRY_OUTPUT_NON_POINTS_ONLY === "function") {
            return ctor.GEOMETRY_OUTPUT_NON_POINTS_ONLY();
        }
        if (typeof ctor.GEOMETRY_OUTPUT_ALL === "function") {
            return ctor.GEOMETRY_OUTPUT_ALL();
        }
        return outputMode;
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
