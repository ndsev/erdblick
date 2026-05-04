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
import {IconLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer} from "@deck.gl/layers";
import {PathStyleExtension} from "@deck.gl/extensions";
import {ScenegraphLayer} from "@deck.gl/mesh-layers";
import {COORDINATE_SYSTEM} from "@deck.gl/core";
import type {Device} from "@luma.gl/core";
import {Matrix4} from "@math.gl/core";
import {DeckLayerRegistry, makeDeckLayerKey} from "./deck-layer-registry";
import {coreLib, type ErdblickCore_} from "../../integrations/wasm";
import {
    deckRenderWorkerPool,
    isDeckRenderWorkerPipelineEnabled
} from "./deck-render.worker.pool";
import {
    DECK_GEOMETRY_OUTPUT_ALL,
    DECK_GEOMETRY_OUTPUT_NON_POINTS_ONLY,
    DECK_GEOMETRY_OUTPUT_POINTS_ONLY,
    DeckGltfBucketBuffers,
    DeckGltfPickProxyBucketBuffers,
    DeckGeometryBucketBuffers,
    DeckLabelDatum,
    DeckGeometryOutputMode,
    DeckLowFiBundleBuffers,
    DeckPathBucketBuffers,
    DeckPointBucketBuffers,
    DeckSurfaceBucketBuffers,
    DeckVisualizationBufferResult,
    DeckWorkerTimings
} from "./deck-render.worker.protocol";
import {MapViewLayerStyleRule, MergedPointVisualization, PointMergeService} from "../pointmerge.service";
import {RelationLocateRequest, RelationLocateResult} from "../../mapdata/relation-locate.model";
import {
    cloneProcessedGltfForScenegraph,
    DeckGltfPickProxyDatum,
    DeckGltfPickProxyLayer,
    type DeckGltfPickProxyStyleContribution,
    DeckGltfNodeLayer,
    type DeckGltfNodeStyleContribution,
    type DeckTileGltfAsset,
    retainDeckTileGltfAsset,
    releaseDeckTileGltfAsset
} from "./deck-gltf-node.layer";

/** Style wrapper for wasm styles that expose erdblick-specific lifecycle and fidelity helpers. */
interface StyleWithIsDeleted extends FeatureLayerStyle {
    isDeleted(): boolean;
    hasExplicitLowFidelityRules(): boolean;
    hasRelationRules(mode: HighlightMode): boolean;
}

/** Deck-scene subset consumed by tile visualizations when they need the registry or scene mode. */
interface DeckSceneHandle {
    deck?: unknown;
    layerRegistry?: DeckLayerRegistry;
    sceneMode?: SceneMode;
    device?: Device | null;
}

/** Callback surface used to query how many points are already merged at a location. */
interface MergeCountProvider {
    count: (
        geoPos: {x: number, y: number, z: number},
        hashPos: string,
        level: number,
        mapViewLayerStyleRuleId: string
    ) => number;
}

type DeckFeatureAddressBuffer = Uint32Array | Array<number | null>;

/** Extra picking metadata attached to deck layers emitted by this visualization. */
interface DeckPickLayerMetadata {
    tileKey: string;
    featureAddresses?: DeckFeatureAddressBuffer;
    featureAddressesByPath?: DeckFeatureAddressBuffer;
}

/** Picking metadata for path layers, including dash layout hints. */
interface DeckPathLayerMetadata extends DeckPickLayerMetadata {
    dashJustified?: boolean;
}

/** Binary attribute wrapper matching deck's binary-data layer input format. */
interface DeckBinaryAttribute<T extends ArrayLike<number>> {
    value: T;
    size: number;
}

/** Binary deck path-layer payload grouped by billboard and depth-test mode. */
interface DeckPathLayerData {
    length: number;
    billboard: boolean;
    depthTest: boolean;
    coordinateOrigin: [number, number, number];
    startIndices: Uint32Array;
    featureAddressesByPath: DeckFeatureAddressBuffer;
    attributes: {
        getPath: DeckBinaryAttribute<Float32Array>;
        instanceColors: DeckBinaryAttribute<Uint8Array>;
        instanceStrokeWidths: DeckBinaryAttribute<Float32Array>;
        instanceDashArrays?: DeckBinaryAttribute<Float32Array>;
    };
}

/** Binary deck point-layer payload grouped by billboard and depth-test mode. */
interface DeckPointLayerData {
    length: number;
    billboard: boolean;
    depthTest: boolean;
    coordinateOrigin: [number, number, number];
    featureAddresses: DeckFeatureAddressBuffer;
    attributes: {
        getPosition: DeckBinaryAttribute<Float32Array>;
        getFillColor: DeckBinaryAttribute<Uint8Array>;
        getRadius: DeckBinaryAttribute<Float32Array>;
    };
}

/** Binary deck polygon-layer payload grouped by depth-test mode. */
interface DeckSurfaceLayerData {
    length: number;
    depthTest: boolean;
    coordinateOrigin: [number, number, number];
    startIndices: Uint32Array;
    featureAddresses: DeckFeatureAddressBuffer;
    attributes: {
        getPolygon: DeckBinaryAttribute<Float32Array>;
        fillColors: DeckBinaryAttribute<Uint8Array>;
    };
}

/** GLTF-node layer payload grouped by depth-test state and resolved against one cached tile asset. */
interface DeckGltfLayerData {
    length: number;
    depthTest: boolean;
    data: Array<{
        nodeIndex: number;
        featureAddress: number;
        color: [number, number, number, number];
    }>;
    asset: DeckTileGltfAsset | null;
}

/** Simplified GLTF picking proxies grouped per feature-node for the shared pick layer. */
interface DeckGltfPickProxyLayerData {
    length: number;
    coordinateOrigin: [number, number, number];
    data: DeckGltfPickProxyDatum[];
}

/** Shared-registry payload that contributes visible GLTF node styling for one tile variant. */
interface DeckSharedGltfContribution {
    asset: DeckTileGltfAsset;
    order: number;
    priority: number;
    styleOrder: number;
    data: DeckGltfNodeStyleContribution["data"];
}

/** Shared-registry payload that contributes simplified GLTF picking geometry for one tile variant. */
interface DeckSharedGltfPickProxyContribution {
    order: number;
    coordinateOrigin: [number, number, number];
    data: DeckGltfPickProxyStyleContribution["data"];
}

export const DEBUG_RENDER_FULL_GLTF_ATTACHMENT_OPTION_ID = "$debugRenderFullGltfAttachment";
export const DEBUG_GLTF_LOGGING_OPTION_ID = "$debugGltfLogging";

/** Label-layer payload grouped by billboard and depth-test mode. */
interface DeckLabelLayerData {
    length: number;
    billboard: boolean;
    depthTest: boolean;
    coordinateOrigin: [number, number, number];
    data: DeckRenderableLabelDatum[];
}

/** Label datum normalized to deck's tuple-based position format. */
type DeckRenderableLabelDatum = Omit<DeckLabelDatum, "position"> & {
    position: [number, number, number];
};

/** Raw path buffers read back from wasm before they are regrouped for deck consumption. */
interface DeckPathRawBuffers {
    coordinateOrigin: Float64Array;
    positions: Float32Array;
    startIndices: Uint32Array;
    colors: Uint8Array;
    widths: Float32Array;
    depthTests?: Uint8Array;
    featureAddresses: Uint32Array;
    dashArrays?: Float32Array;
}

/** Raw point buffers read back from wasm before they are regrouped for deck consumption. */
interface DeckPointRawBuffers {
    coordinateOrigin: Float64Array;
    positions: Float32Array;
    colors: Uint8Array;
    radii: Float32Array;
    depthTests?: Uint8Array;
    featureAddresses: Uint32Array;
}

/** Raw surface buffers read back from wasm before they are regrouped for deck consumption. */
interface DeckSurfaceRawBuffers {
    coordinateOrigin: Float64Array;
    positions: Float32Array;
    startIndices: Uint32Array;
    colors: Uint8Array;
    depthTests?: Uint8Array;
    featureAddresses: Uint32Array;
}

/** Raw GLTF-node buffers read back from wasm before they are regrouped for deck consumption. */
interface DeckGltfRawBuffers {
    nodeIndices: Uint32Array;
    colors: Uint8Array;
    depthTests?: Uint8Array;
    featureAddresses: Uint32Array;
}

/** Complete geometry output of one wasm render pass, before deck-layer regrouping. */
interface DeckWasmRenderOutput {
    surfaceLayerData: DeckSurfaceLayerData[];
    pathLayerData: DeckPathLayerData[];
    pointLayerData: DeckPointLayerData[];
    labelLayerData: DeckLabelLayerData[];
    arrowLayerData: DeckPathLayerData[];
    gltfLayerData: DeckGltfLayerData[];
    gltfPickProxyLayerData: DeckGltfPickProxyLayerData | null;
    lowFiBundles: DeckLowFiBundleData[];
    mergedPointFeatures: Record<MapViewLayerStyleRule, MergedPointVisualization[]> | null;
    vertexCount: number;
    workerTimings: DeckWorkerTimings | null;
}

/** Cached low-fi bundle grouped by LOD after wasm output has been translated for deck. */
interface DeckLowFiBundleData {
    lod: number;
    surfaceLayerData: DeckSurfaceLayerData[];
    pathLayerData: DeckPathLayerData[];
    pointLayerData: DeckPointLayerData[];
    labelLayerData: DeckLabelLayerData[];
    arrowLayerData: DeckPathLayerData[];
    gltfLayerData: DeckGltfLayerData[];
    gltfPickProxyLayerData: DeckGltfPickProxyLayerData | null;
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
const DECK_NO_DEPTH_TEST_PARAMETERS = {
    depthTest: false,
    depthMask: false
} as any;
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
type DeckFeatureLayerVisualizationWithRenderResult = DeckFeatureLayerVisualization & {
    renderResult(): DeckVisualizationBufferResult;
};

/** Returns the wasm constructor for deck feature visualizations after the core library is initialized. */
/** Resolves the wasm visualization constructor while keeping the call sites strongly typed. */
function deckFeatureLayerVisualizationCtor(): DeckFeatureLayerVisualizationCtor {
    return coreLib.DeckFeatureLayerVisualization as DeckFeatureLayerVisualizationCtor;
}

/** Returns the wasm fidelity enum used by deck tile rendering. */
/** Returns the wasm fidelity enum object used by both worker and main-thread rendering paths. */
function deckRuleFidelityEnum(): DeckRuleFidelityEnum {
    return coreLib.RuleFidelity as DeckRuleFidelityEnum;
}

/** Icon-marker payload derived from arrow path geometry. */
interface DeckArrowMarker {
    featureAddress: number | null;
    position: [number, number, number];
    color: [number, number, number, number];
    sizePx: number;
    angleDeg: number;
}

/** Concrete registry keys for every deck layer emitted by one tile visualization variant. */
interface DeckLayerKeys {
    surfaceLayerKey: string;
    pathLayerKey: string;
    pointLayerKey: string;
    labelLayerKey: string;
    arrowLayerKey: string;
    gltfLayerKey: string;
}

/** One logical render variant applied to the registry, e.g. base geometry or a low-fi LOD bundle. */
interface DeckLayerRenderEntry {
    variantSuffix: string;
    orderOffset: number;
    surfaceLayerData: DeckSurfaceLayerData[];
    pathLayerData: DeckPathLayerData[];
    pointLayerData: DeckPointLayerData[];
    labelLayerData: DeckLabelLayerData[];
    arrowLayerData: DeckPathLayerData[];
    gltfLayerData: DeckGltfLayerData[];
    gltfPickProxyLayerData: DeckGltfPickProxyLayerData | null;
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
    public styleOrder: number;

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
    private readonly labelLayerKeys = new Set<string>();
    private readonly arrowLayerKeys = new Set<string>();
    private readonly gltfLayerKeys = new Set<string>();
    private lastSignature = "";
    private hadTileDataAtLastRender = false;
    private tileFeatureCountAtLastRender = 0;
    private tileDataVersionAtLastRender = -1;
    private latestWorkerTimings: DeckWorkerTimings | null = null;
    private latestSurfaceLayerData: DeckSurfaceLayerData[] = [];
    private latestPointLayerData: DeckPointLayerData[] = [];
    private latestLabelLayerData: DeckLabelLayerData[] = [];
    private latestArrowLayerData: DeckPathLayerData[] = [];
    private latestGltfLayerData: DeckGltfLayerData[] = [];
    private latestGltfPickProxyLayerData: DeckGltfPickProxyLayerData | null = null;
    private latestLowFiBundleData: DeckLowFiBundleData[] = [];
    private lowFiBundleByLod = new Map<number, DeckLowFiBundleData>();
    private activeRenderedFidelity: "low" | "high" | "any" | null = null;
    private activeRenderedLowFiLods: number[] = [];
    private latestMergedPointFeatures: Record<MapViewLayerStyleRule, MergedPointVisualization[]> | null = null;
    private readonly seenGltfDebugMessages = new Set<string>();
    private activeGltfAsset: DeckTileGltfAsset | null = null;
    private activeGltfAssetDevice: Device | null = null;
    private activeGltfAssetVersion = -1;
    private readonly activeSharedGltfLayerSources = new Map<string, string>();
    private readonly activeSharedGltfPickProxyLayerSources = new Map<string, string>();


    /** Captures every render input needed to keep one tile/style visualization alive across rerenders. */
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
                styleOrder: number = 0,
                relationExternalTileLoader: (requests: RelationLocateRequest[]) => Promise<RelationLocateResult> =
                    async () => ({responses: [], tiles: []})) {
        this.tile = tile;
        this.pointMergeService = pointMergeService;
        this.style = style as StyleWithIsDeleted;
        this.styleSource = styleSource;
        this.styleId = this.style.name();
        this.styleOrder = styleOrder;
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

    /**
     * Renders the tile into deck layers or merged-point scene state.
     * Low-fi bundle switches may short-circuit to cached data instead of rerunning wasm.
     */
    async render(sceneHandle: IRenderSceneHandle): Promise<boolean> {
        const registry = this.resolveRegistry(sceneHandle);
        if (this.deleted || this.style.isDeleted()) {
            return false;
        }
        this.latestWorkerTimings = null;
        const startTime = performance.now();
        try {
            const fidelity = this.currentFidelity();
            if (await this.tryApplyCachedLowFiSwitch(sceneHandle, registry, fidelity)) {
                return true;
            }

            this.latestSurfaceLayerData = [];
            this.latestPointLayerData = [];
            this.latestLabelLayerData = [];
            this.latestArrowLayerData = [];
            this.latestGltfLayerData = [];
            this.latestGltfPickProxyLayerData = null;
            this.latestLowFiBundleData = [];
            this.latestMergedPointFeatures = null;

            let pathLayerData = await this.renderWasm(fidelity);
            let surfaceLayerData = this.latestSurfaceLayerData;
            let pointLayerData = this.latestPointLayerData;
            let labelLayerData = this.latestLabelLayerData;
            let arrowLayerData = this.latestArrowLayerData;
            let gltfLayerData = this.latestGltfLayerData;
            let gltfPickProxyLayerData = this.latestGltfPickProxyLayerData;
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
                    labelLayerData = [];
                    arrowLayerData = [];
                    gltfLayerData = [];
                    gltfPickProxyLayerData = null;
                    activeLowFiLods = selectedLowFiBundles.map((bundle) => bundle.lod);
                }
            }

            if (this.shouldKeepActiveLowFiFallback(
                fidelity,
                surfaceLayerData,
                pathLayerData,
                pointLayerData,
                labelLayerData,
                arrowLayerData,
                gltfLayerData,
                mergedPointFeatures
            )) {
                this.completeRender(fidelity, activeLowFiLods);
                return true;
            }

            const layerEntries = fidelity === "low" && selectedLowFiBundles.length > 0
                ? this.buildLowFiLayerEntries(selectedLowFiBundles)
                : this.buildDefaultLayerEntries(
                    surfaceLayerData,
                    pathLayerData,
                    pointLayerData,
                    labelLayerData,
                    arrowLayerData,
                    gltfLayerData,
                    gltfPickProxyLayerData
                );
            await this.attachGltfAssetsToEntries(sceneHandle, layerEntries);
            this.logGltfRenderSummary(fidelity, layerEntries);

            this.clearMergedPointVisualizations(sceneHandle);
            this.applyLayerEntriesToRegistry(sceneHandle, registry, layerEntries);

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

    /** Resolves the registry keys used by the different geometry layers emitted for this visualization. */
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
            labelLayerKey: makeDeckLayerKey({
                tileKey: this.tile.mapTileKey,
                styleId: this.styleId,
                hoverMode: this.highlightModeLabel(),
                kind: "label",
                variant
            }),
            arrowLayerKey: makeDeckLayerKey({
                tileKey: this.tile.mapTileKey,
                styleId: this.styleId,
                hoverMode: this.highlightModeLabel(),
                kind: "arrow",
                variant
            }),
            gltfLayerKey: makeDeckLayerKey({
                tileKey: this.tile.mapTileKey,
                styleId: this.styleId,
                hoverMode: this.highlightModeLabel(),
                kind: "gltf",
                variant
            })
        };
    }

    /** Composes an optional variant suffix used to distinguish low-fi bundles and highlight variants. */
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

    /** GLTF layers are shared per tile/variant, independent of the contributing stylesheet. */
    /** Returns the shared registry key for the visible GLTF layer of this tile/variant. */
    private sharedGltfLayerKey(variantSuffix: string): string {
        const variant = variantSuffix.length > 0 ? `/${variantSuffix}` : "";
        return `${this.tile.mapTileKey}/gltf${variant}`;
    }

    /** GLTF picking proxies are shared per tile/variant alongside the visible GLTF layer. */
    /** Returns the shared registry key for the invisible GLTF picking proxy of this tile/variant. */
    private sharedGltfPickProxyLayerKey(variantSuffix: string): string {
        const variant = variantSuffix.length > 0 ? `/${variantSuffix}` : "";
        return `${this.tile.mapTileKey}/gltf-pick-proxy${variant}`;
    }

    /** One visualization contributes exactly one GLTF style stack entry per shared tile/variant layer. */
    /** Distinguishes this visualization's visible GLTF contribution inside the shared layer stack. */
    private sharedGltfContributionSourceId(variantSuffix: string): string {
        const suffix = this.layerKeySuffix.length > 0 ? this.layerKeySuffix : "-";
        const variant = variantSuffix.length > 0 ? variantSuffix : "-";
        return `${this.styleId}/${this.highlightModeLabel()}/${suffix}/${variant}`;
    }

    /** One visualization contributes at most one GLTF picking-proxy entry per shared tile/variant layer. */
    /** Distinguishes this visualization's picking-proxy contribution inside the shared layer stack. */
    private sharedGltfPickProxyContributionSourceId(variantSuffix: string): string {
        const suffix = this.layerKeySuffix.length > 0 ? this.layerKeySuffix : "-";
        const variant = variantSuffix.length > 0 ? variantSuffix : "-";
        return `${this.styleId}/pick/${suffix}/${variant}`;
    }

    /** Shared GLTF style precedence: base < stylesheet override < hover < selection. */
    /**
     * Encodes the shared-layer precedence for GLTF styling.
     *
     * Base styling stays below temporary highlight overlays so hover/selection can tint the same
     * node set without destroying the textured pass underneath.
     */
    private gltfContributionPriority(): number {
        switch (this.highlightMode.value) {
            case coreLib.HighlightMode.SELECTION_HIGHLIGHT.value:
                return 3;
            case coreLib.HighlightMode.HOVER_HIGHLIGHT.value:
                return 2;
            default:
                return this.layerKeySuffix.length > 0 ? 1 : 0;
        }
    }

    /** Removes this tile's contributions from merged-point corner tiles and re-renders surviving corners. */
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

    /** Builds the default render entry used when the visualization emits one direct geometry set. */
    private buildDefaultLayerEntries(
        surfaceLayerData: DeckSurfaceLayerData[],
        pathLayerData: DeckPathLayerData[],
        pointLayerData: DeckPointLayerData[],
        labelLayerData: DeckLabelLayerData[],
        arrowLayerData: DeckPathLayerData[],
        gltfLayerData: DeckGltfLayerData[],
        gltfPickProxyLayerData: DeckGltfPickProxyLayerData | null
    ): DeckLayerRenderEntry[] {
        return [{
            variantSuffix: "",
            orderOffset: 0,
            surfaceLayerData,
            pathLayerData,
            pointLayerData,
            labelLayerData,
            arrowLayerData,
            gltfLayerData,
            gltfPickProxyLayerData
        }];
    }

    /** Builds the render entries used when low-fi cached bundles replace the default geometry. */
    private buildLowFiLayerEntries(lowFiBundles: DeckLowFiBundleData[]): DeckLayerRenderEntry[] {
        return lowFiBundles.map((bundle) => ({
            variantSuffix: `lowfi-lod-${bundle.lod}`,
            orderOffset: bundle.lod,
            surfaceLayerData: bundle.surfaceLayerData,
            pathLayerData: bundle.pathLayerData,
            pointLayerData: bundle.pointLayerData,
            labelLayerData: bundle.labelLayerData,
            arrowLayerData: bundle.arrowLayerData,
            gltfLayerData: bundle.gltfLayerData,
            gltfPickProxyLayerData: bundle.gltfPickProxyLayerData
        }));
    }

    /** Applies one geometry result directly to the deck registry as the default variant. */
    private applyLayerDataToRegistry(
        sceneHandle: IRenderSceneHandle,
        registry: DeckLayerRegistry,
        surfaceLayerData: DeckSurfaceLayerData[],
        pathLayerData: DeckPathLayerData[],
        pointLayerData: DeckPointLayerData[],
        labelLayerData: DeckLabelLayerData[],
        arrowLayerData: DeckPathLayerData[],
        gltfLayerData: DeckGltfLayerData[],
        gltfPickProxyLayerData: DeckGltfPickProxyLayerData | null
    ): void {
        this.applyLayerEntriesToRegistry(
            sceneHandle,
            registry,
            this.buildDefaultLayerEntries(
                surfaceLayerData,
                pathLayerData,
                pointLayerData,
                labelLayerData,
                arrowLayerData,
                gltfLayerData,
                gltfPickProxyLayerData
            )
        );
    }

    /** Applies one or more cached low-fi bundles to the deck registry as separate variants. */
    private applyLowFiBundleDataToRegistry(
        sceneHandle: IRenderSceneHandle,
        registry: DeckLayerRegistry,
        lowFiBundles: DeckLowFiBundleData[]
    ): void {
        this.applyLayerEntriesToRegistry(sceneHandle, registry, this.buildLowFiLayerEntries(lowFiBundles));
    }

    /** Returns the deck device used for tile-local GLTF asset caching, or `null` outside deck rendering. */
    private resolveDeckDevice(sceneHandle: IRenderSceneHandle): Device | null {
        if (sceneHandle.renderer !== "deck") {
            return null;
        }
        const deckScene = sceneHandle.scene as DeckSceneHandle | undefined;
        return deckScene?.device ?? null;
    }

    /** Releases the currently retained GLTF asset reference, if any. */
    private releaseActiveGltfAsset(): void {
        if (!this.activeGltfAssetDevice || this.activeGltfAssetVersion < 0) {
            this.activeGltfAsset = null;
            this.activeGltfAssetDevice = null;
            this.activeGltfAssetVersion = -1;
            return;
        }
        releaseDeckTileGltfAsset(this.tile, this.activeGltfAssetDevice);
        this.activeGltfAsset = null;
        this.activeGltfAssetDevice = null;
        this.activeGltfAssetVersion = -1;
    }

    /** Retains the current tile's parsed GLTF asset for the active deck device and tile data version. */
    private async ensureActiveGltfAsset(sceneHandle: IRenderSceneHandle): Promise<DeckTileGltfAsset | null> {
        const device = this.resolveDeckDevice(sceneHandle);
        if (!device) {
            this.releaseActiveGltfAsset();
            return null;
        }
        if (this.activeGltfAssetDevice === device && this.activeGltfAssetVersion === this.tile.dataVersion) {
            return this.activeGltfAsset;
        }
        this.releaseActiveGltfAsset();
        this.activeGltfAsset = await retainDeckTileGltfAsset(this.tile, device);
        this.activeGltfAssetDevice = device;
        this.activeGltfAssetVersion = this.tile.dataVersion;
        return this.activeGltfAsset;
    }

    /** Assigns one cached GLTF asset to every GLTF layer entry that will be applied this frame. */
    private async attachGltfAssetsToEntries(
        sceneHandle: IRenderSceneHandle,
        entries: DeckLayerRenderEntry[]
    ): Promise<void> {
        const gltfLayerData = entries.flatMap((entry) => entry.gltfLayerData);
        const needsAssetForDebug = this.shouldRenderFullGltfAttachmentDebug();
        if (!needsAssetForDebug && !gltfLayerData.some((entry) => entry.length > 0)) {
            this.releaseActiveGltfAsset();
            return;
        }
        const asset = await this.ensureActiveGltfAsset(sceneHandle);
        for (const gltfEntry of gltfLayerData) {
            gltfEntry.asset = asset;
        }
        if (asset) {
            this.logGltfDebug("Retained tile GLTF asset", {
                attachmentName: asset.attachmentName,
                byteLength: asset.byteLength,
                sceneCount: asset.sceneCount,
                modelNodeCount: asset.modelNodeCount,
                nodeRootCount: asset.nodeRootCount,
                tilePosition: asset.tilePosition
            });
        } else {
            this.logGltfDebug("No GLTF attachment is available for this tile.");
        }
    }

    /**
     * Materializes the concrete deck layers for the supplied render entries and reconciles stale keys.
     * Layer ordering is intentionally grouped by geometry family and variant offset.
     */
    private applyLayerEntriesToRegistry(
        sceneHandle: IRenderSceneHandle,
        registry: DeckLayerRegistry,
        entries: DeckLayerRenderEntry[]
    ): void {
        const layerOrderBias = this.highlightMode.value === coreLib.HighlightMode.NO_HIGHLIGHT.value ? 0 : 1000;
        const desiredSurfaceLayerKeys = new Set<string>();
        const desiredPointLayerKeys = new Set<string>();
        const desiredPathLayerKeys = new Set<string>();
        const desiredLabelLayerKeys = new Set<string>();
        const desiredArrowLayerKeys = new Set<string>();
        const desiredGltfLayerKeys = new Set<string>();
        const desiredSharedGltfLayerSources = new Map<string, string>();
        const desiredSharedGltfPickProxyLayerSources = new Map<string, string>();
        const modelMatrix = this.modelMatrixForScene(sceneHandle);
        const debugRenderFullAsset = this.shouldRenderFullGltfAttachmentDebug();
        const debugAsset = this.activeGltfAsset;

        if (debugRenderFullAsset && debugAsset) {
            const layerKeys = this.resolveLayerKeys(this.composeGeometryVariant("", "gltf-debug-full"));
            const gltfLayer = new ScenegraphLayer({
                id: layerKeys.gltfLayerKey,
                data: [{position: debugAsset.tilePosition, color: [255, 255, 255, 255]}],
                scenegraph: cloneProcessedGltfForScenegraph(debugAsset.processedGltf),
                coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
                modelMatrix,
                parameters: {
                    ...this.layerParametersForDepthTest(true),
                    cullMode: "none"
                },
                pickable: false,
                _lighting: "flat",
                getPosition: (datum: {position: [number, number, number]}) => datum.position,
                getColor: (datum: {color: [number, number, number, number]}) => datum.color
            });
            registry.upsert(layerKeys.gltfLayerKey, gltfLayer, 375 + layerOrderBias);
            desiredGltfLayerKeys.add(layerKeys.gltfLayerKey);
            this.logGltfDebug("Rendering full GLTF attachment in debug bypass mode.", {
                attachmentName: debugAsset.attachmentName,
                sceneCount: debugAsset.sceneCount,
                modelNodeCount: debugAsset.modelNodeCount,
                tilePosition: debugAsset.tilePosition
            });
        }

        for (const entry of entries) {
            for (const surfaceLayerData of entry.surfaceLayerData) {
                if (surfaceLayerData.length <= 0) {
                    continue;
                }
                const layerKeys = this.resolveLayerKeys(
                    this.composeGeometryVariant(entry.variantSuffix, "surface", undefined, surfaceLayerData.depthTest)
                );
                const surfaceLayer = new SolidPolygonLayer<DeckSurfaceLayerData, DeckPickLayerMetadata>({
                    id: layerKeys.surfaceLayerKey,
                    data: surfaceLayerData,
                    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                    coordinateOrigin: surfaceLayerData.coordinateOrigin,
                    filled: true,
                    extruded: false,
                    wireframe: false,
                    // Our binary surface buffers carry per-vertex attributes already aligned to the raw vertices.
                    // Deck's polygon normalization may add closing vertices, which desynchronizes those buffers.
                    _normalize: false,
                    _full3d: true,
                    modelMatrix,
                    parameters: this.layerParametersForDepthTest(surfaceLayerData.depthTest),
                    pickable: true,
                    tileKey: this.tile.mapTileKey,
                    featureAddresses: surfaceLayerData.featureAddresses
                });
                registry.upsert(layerKeys.surfaceLayerKey, surfaceLayer, 350 + entry.orderOffset + layerOrderBias);
                desiredSurfaceLayerKeys.add(layerKeys.surfaceLayerKey);
            }

            for (const pointLayerData of entry.pointLayerData) {
                if (pointLayerData.length <= 0) {
                    continue;
                }
                const layerKeys = this.resolveLayerKeys(
                    this.composeGeometryVariant(
                        entry.variantSuffix,
                        "point",
                        pointLayerData.billboard,
                        pointLayerData.depthTest
                    )
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
                    parameters: this.layerParametersForDepthTest(pointLayerData.depthTest),
                    pickable: true,
                    tileKey: this.tile.mapTileKey,
                    featureAddresses: pointLayerData.featureAddresses
                });
                registry.upsert(layerKeys.pointLayerKey, pointLayer, 425 + entry.orderOffset + layerOrderBias);
                desiredPointLayerKeys.add(layerKeys.pointLayerKey);
            }

            for (const labelLayerData of entry.labelLayerData) {
                if (labelLayerData.length <= 0) {
                    continue;
                }
                const layerKeys = this.resolveLayerKeys(
                    this.composeGeometryVariant(
                        entry.variantSuffix,
                        "label",
                        labelLayerData.billboard,
                        labelLayerData.depthTest
                    )
                );
                const labelLayer = new TextLayer({
                    id: layerKeys.labelLayerKey,
                    data: labelLayerData.data,
                    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                    coordinateOrigin: labelLayerData.coordinateOrigin,
                    getPosition: (d: DeckRenderableLabelDatum) => d.position,
                    getText: (d: DeckRenderableLabelDatum) => d.text,
                    getColor: (d: DeckRenderableLabelDatum) => d.fillColor,
                    getOutlineColor: (d: DeckRenderableLabelDatum) => d.outlineColor,
                    getOutlineWidth: (d: DeckRenderableLabelDatum) => d.outlineWidth,
                    getSize: (d: DeckRenderableLabelDatum) => 14 * d.scale,
                    sizeUnits: "pixels",
                    getPixelOffset: (d: DeckRenderableLabelDatum) => d.pixelOffset ?? [0, 0],
                    billboard: labelLayerData.billboard,
                    modelMatrix,
                    parameters: this.layerParametersForDepthTest(labelLayerData.depthTest),
                    pickable: true,
                    tileKey: this.tile.mapTileKey
                } as any) as any;
                registry.upsert(layerKeys.labelLayerKey, labelLayer, 475 + entry.orderOffset + layerOrderBias);
                desiredLabelLayerKeys.add(layerKeys.labelLayerKey);
            }

            for (const pathLayerData of entry.pathLayerData) {
                if (pathLayerData.length <= 0) {
                    continue;
                }
                const layerKeys = this.resolveLayerKeys(
                    this.composeGeometryVariant(
                        entry.variantSuffix,
                        "path",
                        pathLayerData.billboard,
                        pathLayerData.depthTest
                    )
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
                    parameters: this.layerParametersForDepthTest(pathLayerData.depthTest),
                    capRounded: true,
                    jointRounded: true,
                    pickable: true,
                    dashJustified: true,
                    extensions: [new PathStyleExtension({dash: true})],
                    tileKey: this.tile.mapTileKey,
                    featureAddressesByPath: pathLayerData.featureAddressesByPath
                });
                registry.upsert(layerKeys.pathLayerKey, pathLayer, 400 + entry.orderOffset + layerOrderBias);
                desiredPathLayerKeys.add(layerKeys.pathLayerKey);
            }

            for (const arrowLayerData of entry.arrowLayerData) {
                if (arrowLayerData.length <= 0) {
                    continue;
                }
                const layerKeys = this.resolveLayerKeys(
                    this.composeGeometryVariant(
                        entry.variantSuffix,
                        "arrow",
                        arrowLayerData.billboard,
                        arrowLayerData.depthTest
                    )
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
                    parameters: this.layerParametersForDepthTest(arrowLayerData.depthTest),
                    pickable: true,
                    tileKey: this.tile.mapTileKey,
                    alphaCutoff: 0.05,
                });
                registry.upsert(layerKeys.arrowLayerKey, arrowLayer, 450 + entry.orderOffset + layerOrderBias);
                desiredArrowLayerKeys.add(layerKeys.arrowLayerKey);
            }

            if (debugRenderFullAsset) {
                continue;
            }

            const sharedGltfContribution = this.buildSharedGltfContribution(entry);
            if (sharedGltfContribution) {
                const sharedGltfLayerKey = this.sharedGltfLayerKey(entry.variantSuffix);
                const sharedGltfSourceId = this.sharedGltfContributionSourceId(entry.variantSuffix);
                registry.upsertShared(
                    sharedGltfLayerKey,
                    sharedGltfSourceId,
                    sharedGltfContribution,
                    (_key, rawContributions) => this.buildSharedGltfLayer(
                        sharedGltfLayerKey,
                        rawContributions,
                        modelMatrix
                    )
                );
                desiredSharedGltfLayerSources.set(sharedGltfLayerKey, sharedGltfSourceId);
            }

            const sharedGltfPickProxyContribution = this.buildSharedGltfPickProxyContribution(entry);
            if (sharedGltfPickProxyContribution) {
                const sharedGltfPickProxyLayerKey = this.sharedGltfPickProxyLayerKey(entry.variantSuffix);
                const sharedGltfPickProxySourceId = this.sharedGltfPickProxyContributionSourceId(entry.variantSuffix);
                registry.upsertShared(
                    sharedGltfPickProxyLayerKey,
                    sharedGltfPickProxySourceId,
                    sharedGltfPickProxyContribution,
                    (_key, rawContributions) => this.buildSharedGltfPickProxyLayer(
                        sharedGltfPickProxyLayerKey,
                        rawContributions
                    )
                );
                desiredSharedGltfPickProxyLayerSources.set(
                    sharedGltfPickProxyLayerKey,
                    sharedGltfPickProxySourceId
                );
            }
        }

        this.reconcileLayerKeys(registry, this.surfaceLayerKeys, desiredSurfaceLayerKeys);
        this.reconcileLayerKeys(registry, this.pointLayerKeys, desiredPointLayerKeys);
        this.reconcileLayerKeys(registry, this.pathLayerKeys, desiredPathLayerKeys);
        this.reconcileLayerKeys(registry, this.labelLayerKeys, desiredLabelLayerKeys);
        this.reconcileLayerKeys(registry, this.arrowLayerKeys, desiredArrowLayerKeys);
        this.reconcileLayerKeys(registry, this.gltfLayerKeys, desiredGltfLayerKeys);
        this.reconcileSharedLayerSources(registry, this.activeSharedGltfLayerSources, desiredSharedGltfLayerSources);
        this.reconcileSharedLayerSources(
            registry,
            this.activeSharedGltfPickProxyLayerSources,
            desiredSharedGltfPickProxyLayerSources
        );
    }

    /** Returns the 2D flattening matrix when the target scene is orthographic deck 2D. */
    private modelMatrixForScene(sceneHandle: IRenderSceneHandle): Matrix4 | null {
        if (sceneHandle.renderer !== "deck") {
            return null;
        }
        const deckScene = sceneHandle.scene as DeckSceneHandle | undefined;
        return deckScene?.sceneMode === SceneMode.SCENE2D ? DECK_FLAT_2D_MODEL_MATRIX : null;
    }

    /** Builds the geometry-specific variant suffix used in deck layer keys. */
    private composeGeometryVariant(
        baseVariantSuffix: string,
        geometryKind: string,
        billboard?: boolean,
        depthTest: boolean = true
    ): string {
        const parts: string[] = [];
        if (baseVariantSuffix.length > 0) {
            parts.push(baseVariantSuffix);
        }
        parts.push(
            billboard === undefined
                ? geometryKind
                : `${geometryKind}-${billboard ? "billboard" : "world"}`
        );
        if (!depthTest) {
            parts.push("overlay");
        }
        return parts.join("::");
    }

    /** Returns whether the viewer-wide GLTF debug toggle should bypass filtered node rendering for base tiles. */
    private shouldRenderFullGltfAttachmentDebug(): boolean {
        return this.highlightMode.value === coreLib.HighlightMode.NO_HIGHLIGHT.value
            && this.options[DEBUG_RENDER_FULL_GLTF_ATTACHMENT_OPTION_ID] === true;
    }

    /** Returns whether verbose GLTF diagnostics are enabled for this visualization. */
    private shouldLogGltfDebug(): boolean {
        return this.options[DEBUG_GLTF_LOGGING_OPTION_ID] === true;
    }

    /** Emits one deduplicated GLTF diagnostics message into the console-backed diagnostics log. */
    private logGltfDebug(message: string, data?: Record<string, unknown>): void {
        if (!this.shouldLogGltfDebug()) {
            return;
        }
        const payload = {
            view: this.viewIndex,
            tileKey: this.tile.mapTileKey,
            styleId: this.styleId,
            highlightMode: this.highlightModeLabel(),
            ...data
        };
        const signature = `${message}:${JSON.stringify(payload)}`;
        if (this.seenGltfDebugMessages.has(signature)) {
            return;
        }
        this.seenGltfDebugMessages.add(signature);
        console.info(`[GLTF] ${message}`, payload);
    }

    /** Logs a compact summary of the GLTF render data emitted by wasm for this tile/style render pass. */
    private logGltfRenderSummary(
        fidelity: "low" | "high" | "any" | null,
        entries: DeckLayerRenderEntry[]
    ): void {
        if (!this.shouldLogGltfDebug()) {
            return;
        }
        const gltfEntries = entries.flatMap((entry) => entry.gltfLayerData);
        const totalRenderedNodes = gltfEntries.reduce((sum, entry) => sum + entry.length, 0);
        const uniqueNodeCount = new Set(
            gltfEntries.flatMap((entry) => entry.data.map((datum) => datum.nodeIndex))
        ).size;
        const featureCount = new Set(
            gltfEntries.flatMap((entry) => entry.data.map((datum) => datum.featureAddress))
        ).size;
        this.logGltfDebug("Wasm GLTF render output summary", {
            fidelity,
            highFidelityStage: this.highFidelityStage,
            maxLowFiLod: this.maxLowFiLod,
            debugFullAttachment: this.shouldRenderFullGltfAttachmentDebug(),
            emittedLayerCount: gltfEntries.length,
            renderedNodeCount: totalRenderedNodes,
            uniqueNodeCount,
            featureCount
        });
        if (totalRenderedNodes === 0) {
            this.logGltfDebug("Wasm emitted no GLTF node references for this render pass.");
        }
    }

    /** Chooses deck layer parameters that either honor or bypass depth testing. */
    private layerParametersForDepthTest(depthTest: boolean) {
        return depthTest ? undefined : DECK_NO_DEPTH_TEST_PARAMETERS;
    }

    /** Converts one visualization render entry into a shared GLTF style contribution for the tile-level layer. */
    private buildSharedGltfContribution(entry: DeckLayerRenderEntry): DeckSharedGltfContribution | null {
        const asset = entry.gltfLayerData.find((data) => data.asset)?.asset;
        if (!asset) {
            return null;
        }

        const flatTint = this.highlightMode.value !== coreLib.HighlightMode.NO_HIGHLIGHT.value;
        const renderPriority = this.gltfContributionPriority();
        const data = entry.gltfLayerData.flatMap((gltfLayerData) => {
            this.logGltfDebug("Preparing shared GLTF contribution.", {
                variantSuffix: entry.variantSuffix,
                depthTest: gltfLayerData.depthTest,
                renderedNodeCount: gltfLayerData.length,
                uniqueNodeCount: new Set(gltfLayerData.data.map((datum) => datum.nodeIndex)).size,
                assetNodeRootCount: asset.nodeRootCount,
                sourceStyleId: this.styleId,
                highlightMode: this.highlightModeLabel()
            });
            return gltfLayerData.data.map((datum) => ({
                nodeIndex: datum.nodeIndex,
                featureAddress: datum.featureAddress,
                color: datum.color,
                // Highlight overlays must stay on top of the base pass even when the source style
                // requested depth testing for the original textured geometry.
                depthTest: flatTint ? false : gltfLayerData.depthTest,
                flatTint,
                renderPriority
            }));
        });
        if (!data.length) {
            return null;
        }

        return {
            asset,
            order: 375 + entry.orderOffset,
            priority: renderPriority,
            styleOrder: this.styleOrder,
            data
        };
    }

    /** Converts one visualization render entry into a shared GLTF picking-proxy contribution. */
    private buildSharedGltfPickProxyContribution(entry: DeckLayerRenderEntry): DeckSharedGltfPickProxyContribution | null {
        if (this.highlightMode.value !== coreLib.HighlightMode.NO_HIGHLIGHT.value) {
            // Only the non-highlight pass contributes picking geometry; otherwise hover overlays
            // would pick themselves and reintroduce the flicker we just removed.
            return null;
        }
        const gltfPickProxyLayerData = entry.gltfPickProxyLayerData;
        if (!gltfPickProxyLayerData || gltfPickProxyLayerData.length <= 0) {
            return null;
        }
        return {
            order: 374 + entry.orderOffset,
            coordinateOrigin: gltfPickProxyLayerData.coordinateOrigin,
            data: gltfPickProxyLayerData.data
        };
    }

    /**
     * Reconstructs the single shared visible GLTF layer from all active per-style contributions.
     *
     * The shared layer key intentionally excludes the originating style id so multiple styles can
     * cooperate on the same node set instead of instantiating duplicate scenegraph geometry.
     */
    private buildSharedGltfLayer(
        layerKey: string,
        rawContributions: ReadonlyMap<string, unknown>,
        modelMatrix: Matrix4 | null
    ): {layer: DeckGltfNodeLayer | null; order: number} {
        const contributions = [...rawContributions.entries()]
            .map(([sourceId, contribution]) => ({
                sourceId,
                contribution: contribution as DeckSharedGltfContribution
            }));
        if (!contributions.length) {
            return {layer: null, order: 0};
        }
        const asset = contributions[0].contribution.asset;
        const maxPriority = contributions.reduce(
            (max, {contribution}) => Math.max(max, contribution.priority),
            0
        );
        const order = contributions.reduce(
            (max, {contribution}) => Math.max(max, contribution.order),
            0
        ) + (maxPriority >= 2 ? 1000 : 0);
        return {
            order,
            layer: new DeckGltfNodeLayer({
                id: layerKey,
                contributions: contributions.map(({sourceId, contribution}) => ({
                    sourceId,
                    priority: contribution.priority,
                    styleOrder: contribution.styleOrder,
                    data: contribution.data
                })),
                asset,
                pickable: false,
                modelMatrix
            })
        };
    }

    /** Reconstructs the shared invisible GLTF pick-proxy layer from all active contributors. */
    private buildSharedGltfPickProxyLayer(
        layerKey: string,
        rawContributions: ReadonlyMap<string, unknown>
    ): {layer: DeckGltfPickProxyLayer | null; order: number} {
        const contributions = [...rawContributions.entries()]
            .map(([sourceId, contribution]) => ({
                sourceId,
                contribution: contribution as DeckSharedGltfPickProxyContribution
            }));
        if (!contributions.length) {
            return {layer: null, order: 0};
        }
        const coordinateOrigin = contributions[0].contribution.coordinateOrigin;
        const order = contributions.reduce(
            (max, {contribution}) => Math.max(max, contribution.order),
            0
        );
        return {
            order,
            layer: new DeckGltfPickProxyLayer({
                id: layerKey,
                contributions: contributions.map(({sourceId, contribution}) => ({
                    sourceId,
                    data: contribution.data
                })),
                coordinateOrigin,
                pickable: true,
                tileKey: this.tile.mapTileKey
            })
        };
    }

    /** Removes stale registry keys and replaces the active-key set with the desired keys. */
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

    /** Removes stale shared-layer contributors while preserving shared layers that still have live sources. */
    private reconcileSharedLayerSources(
        registry: DeckLayerRegistry,
        activeLayerSources: Map<string, string>,
        desiredLayerSources: Map<string, string>
    ): void {
        for (const [layerKey, sourceId] of activeLayerSources) {
            if (!desiredLayerSources.has(layerKey)) {
                registry.removeShared(layerKey, sourceId);
            }
        }
        activeLayerSources.clear();
        for (const [layerKey, sourceId] of desiredLayerSources) {
            activeLayerSources.set(layerKey, sourceId);
        }
    }

    /** Removes all shared-layer contributors tracked in one source map and clears it afterwards. */
    private clearSharedLayerSources(
        registry: DeckLayerRegistry,
        activeLayerSources: Map<string, string>
    ): void {
        for (const [layerKey, sourceId] of activeLayerSources) {
            registry.removeShared(layerKey, sourceId);
        }
        activeLayerSources.clear();
    }

    /** Commits the post-render bookkeeping that drives dirtiness and low-fi-switch detection. */
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

    /** Returns true when at least one surface/path/point/label/arrow layer contains geometry. */
    private hasRenderableLayerData(
        surfaceLayerData: DeckSurfaceLayerData[],
        pathLayerData: DeckPathLayerData[],
        pointLayerData: DeckPointLayerData[],
        labelLayerData: DeckLabelLayerData[],
        arrowLayerData: DeckPathLayerData[],
        gltfLayerData: DeckGltfLayerData[]
    ): boolean {
        return surfaceLayerData.some((data) => data.length > 0)
            || pathLayerData.some((data) => data.length > 0)
            || pointLayerData.some((data) => data.length > 0)
            || labelLayerData.some((data) => data.length > 0)
            || arrowLayerData.some((data) => data.length > 0)
            || gltfLayerData.some((data) => data.length > 0);
    }

    /** Returns true when merged-point output contains any features. */
    private hasRenderableMergedPointFeatures(
        mergedPointFeatures: Record<MapViewLayerStyleRule, MergedPointVisualization[]> | null
    ): boolean {
        if (!mergedPointFeatures) {
            return false;
        }
        return Object.values(mergedPointFeatures).some(features => features.length > 0);
    }

    /** Keeps the currently visible low-fi output alive until high-fi data becomes renderable again. */
    private shouldKeepActiveLowFiFallback(
        fidelity: "low" | "high" | "any" | null,
        surfaceLayerData: DeckSurfaceLayerData[],
        pathLayerData: DeckPathLayerData[],
        pointLayerData: DeckPointLayerData[],
        labelLayerData: DeckLabelLayerData[],
        arrowLayerData: DeckPathLayerData[],
        gltfLayerData: DeckGltfLayerData[],
        mergedPointFeatures: Record<MapViewLayerStyleRule, MergedPointVisualization[]> | null
    ): boolean {
        if (fidelity !== "high"
            || this.activeRenderedFidelity !== "low"
            || this.activeRenderedLowFiLods.length === 0) {
            return false;
        }
        return !this.hasRenderableLayerData(
            surfaceLayerData,
            pathLayerData,
            pointLayerData,
            labelLayerData,
            arrowLayerData,
            gltfLayerData
        )
            && !this.hasRenderableMergedPointFeatures(mergedPointFeatures);
    }

    /** Replaces the cached low-fi bundle map with the latest worker or main-thread output. */
    private updateLowFiBundleCache(lowFiBundles: DeckLowFiBundleData[]): void {
        this.lowFiBundleByLod.clear();
        for (const lowFiBundle of lowFiBundles) {
            this.lowFiBundleByLod.set(lowFiBundle.lod, lowFiBundle);
        }
    }

    /** Returns the requested low-fi LOD after clamping to the supported 0-7 range. */
    private requestedLowFiLod(): number | null {
        const requestedLod = this.resolveMaxLowFiLod("low");
        if (requestedLod < 0) {
            return null;
        }
        return Math.max(0, Math.min(7, Math.floor(requestedLod)));
    }

    /** Selects the cached low-fi bundles that satisfy the current requested low-fi LOD. */
    private selectLowFiBundlesForCurrentRequest(): DeckLowFiBundleData[] {
        const requestedLod = this.requestedLowFiLod();
        if (requestedLod === null) {
            return [];
        }
        return [...this.lowFiBundleByLod.values()]
            .filter((bundle) => bundle.lod <= requestedLod)
            .sort((lhs, rhs) => lhs.lod - rhs.lod);
    }

    /** Returns just the LOD numbers of the currently selected low-fi bundles. */
    private lowFiLodSelection(): number[] {
        return this.selectLowFiBundlesForCurrentRequest().map((bundle) => bundle.lod);
    }

    /** Returns true when two low-fi bundle selections describe the same set of active LODs. */
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

    /** Fast-path that swaps cached low-fi bundles into the registry without rerunning wasm. */
    private async tryApplyCachedLowFiSwitch(
        sceneHandle: IRenderSceneHandle,
        registry: DeckLayerRegistry,
        fidelity: "low" | "high" | "any" | null
    ): Promise<boolean> {
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
        this.latestGltfLayerData = [];
        this.latestGltfPickProxyLayerData = null;
        this.latestMergedPointFeatures = null;
        this.latestWorkerTimings = null;
        const layerEntries = this.buildLowFiLayerEntries(selectedLowFiBundles);
        await this.attachGltfAssetsToEntries(sceneHandle, layerEntries);
        this.applyLayerEntriesToRegistry(sceneHandle, registry, layerEntries);
        this.completeRender("low", selectedLowFiLods);
        return true;
    }

    /** Returns true when the requested low-fi LOD changed relative to what is currently rendered. */
    private hasPendingLowFiSwitch(): boolean {
        if (!this.rendered
            || this.currentFidelity() !== "low"
            || this.activeRenderedFidelity !== "low") {
            return false;
        }
        return !this.sameLowFiLodSelection(this.activeRenderedLowFiLods, this.lowFiLodSelection());
    }

    /** Returns true when the currently requested fidelity differs from the last rendered fidelity. */
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

    /** Removes all deck layers and merged-point state owned by this visualization. */
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
        for (const surfaceLayerKey of this.surfaceLayerKeys) {
            registry.remove(surfaceLayerKey);
        }
        for (const pointLayerKey of this.pointLayerKeys) {
            registry.remove(pointLayerKey);
        }
        for (const pathLayerKey of this.pathLayerKeys) {
            registry.remove(pathLayerKey);
        }
        for (const labelLayerKey of this.labelLayerKeys) {
            registry.remove(labelLayerKey);
        }
        for (const arrowLayerKey of this.arrowLayerKeys) {
            registry.remove(arrowLayerKey);
        }
        for (const gltfLayerKey of this.gltfLayerKeys) {
            registry.remove(gltfLayerKey);
        }
        this.clearSharedLayerSources(registry, this.activeSharedGltfLayerSources);
        this.clearSharedLayerSources(registry, this.activeSharedGltfPickProxyLayerSources);
        this.surfaceLayerKeys.clear();
        this.pointLayerKeys.clear();
        this.pathLayerKeys.clear();
        this.labelLayerKeys.clear();
        this.arrowLayerKeys.clear();
        this.gltfLayerKeys.clear();
        this.latestLabelLayerData = [];
        this.latestGltfLayerData = [];
        this.latestGltfPickProxyLayerData = null;
        this.latestLowFiBundleData = [];
        this.lowFiBundleByLod.clear();
        this.activeRenderedFidelity = null;
        this.activeRenderedLowFiLods = [];
        this.rendered = false;
        this.hadTileDataAtLastRender = false;
        this.tileFeatureCountAtLastRender = 0;
        this.tileDataVersionAtLastRender = -1;
        this.releaseActiveGltfAsset();
    }

    /** Returns whether any relevant tile/style/fidelity input changed since the last successful render. */
    isDirty(): boolean {
        return (
            !this.rendered ||
            this.lastSignature !== this.renderSignature() ||
            this.hadTileDataAtLastRender !== this.tileHasData() ||
            this.tileFeatureCountAtLastRender !== this.tileFeatureCount() ||
            this.tileDataVersionAtLastRender !== this.tile.dataVersion
        );
    }

    /** Returns the queue sort rank used by `VisualizationQueue`. */
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

    /** Updates whether this visualization is currently queued for rendering. */
    updateStatus(renderQueued?: boolean): void {
        if (renderQueued !== undefined) {
            this.renderQueued = renderQueued;
        }
    }

    /** Applies a style option change locally; deck renderers currently treat every option update as dirty. */
    setStyleOption(optionId: string, value: string | number | boolean): boolean {
        if (this.options[optionId] === value) {
            return false;
        }
        this.options[optionId] = value;
        return true;
    }

    /** Returns a compact highlight-mode label used in deck layer keys. */
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

    /** Builds the signature that determines whether a rerender is required. */
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

    /** Copies one wasm render pass into the instance fields consumed by later deck-layer assembly. */
    private applyWasmRenderOutput(output: DeckWasmRenderOutput): DeckPathLayerData[] {
        this.setTileVertexCount(output.vertexCount);
        this.latestWorkerTimings = output.workerTimings;
        this.latestSurfaceLayerData = output.surfaceLayerData;
        this.latestPointLayerData = output.pointLayerData;
        this.latestLabelLayerData = output.labelLayerData;
        this.latestArrowLayerData = output.arrowLayerData;
        this.latestGltfLayerData = output.gltfLayerData;
        this.latestGltfPickProxyLayerData = output.gltfPickProxyLayerData;
        this.latestLowFiBundleData = output.lowFiBundles;
        this.latestMergedPointFeatures = output.mergedPointFeatures;
        return output.pathLayerData;
    }

    /**
     * Executes the wasm render path, preferring worker rendering for base geometry.
     * Hover/selection highlights stay on the main thread to minimize interaction latency and races.
     */
    private async renderWasm(fidelity: "low" | "high" | "any" | null): Promise<DeckPathLayerData[]> {
        if (fidelity === null) {
            return [];
        }

        // Keep non-base highlighting synchronous to minimize interaction latency
        // and avoid ordering races while selection/hover state changes.
        if (this.highlightMode.value !== coreLib.HighlightMode.NO_HIGHLIGHT.value) {
            const fullMainThread = await this.renderWasmOnMainThread(fidelity, DECK_GEOMETRY_OUTPUT_ALL);
            return this.applyWasmRenderOutput(fullMainThread);
        }

        if (!isDeckRenderWorkerPipelineEnabled()) {
            const fullMainThread = await this.renderWasmOnMainThread(fidelity, DECK_GEOMETRY_OUTPUT_ALL);
            return this.applyWasmRenderOutput(fullMainThread);
        }

        try {
            const workerOutput = await this.renderWasmInWorker(fidelity, DECK_GEOMETRY_OUTPUT_ALL);
            return this.applyWasmRenderOutput(workerOutput);
        } catch (error) {
            console.error("Deck worker rendering failed; falling back to main thread rendering.", error);
            const fullMainThread = await this.renderWasmOnMainThread(fidelity, DECK_GEOMETRY_OUTPUT_ALL);
            return this.applyWasmRenderOutput(fullMainThread);
        }
    }

    /** Marshals the current tile/style state to the render-worker pool and translates the result back. */
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
        const geometryLayerData = this.buildGeometryLayerData(result.coordinateOrigin, result);
        return {
            ...geometryLayerData,
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

    /** Adds the primary tile to a wasm visualization and runs it on the main thread. */
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

    /** Resolves cross-tile relation targets and feeds the located auxiliary tiles into the visualization. */
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

    /** Executes the full wasm render path on the main thread and translates the result into deck layer data. */
    private async renderWasmOnMainThread(
        fidelity: "low" | "high" | "any",
        outputMode: DeckGeometryOutputMode
    ): Promise<DeckWasmRenderOutput> {
        let deckVisu: DeckFeatureLayerVisualization | undefined;
        try {
            deckVisu = this.createMainThreadDeckVisualization(fidelity, outputMode);
            const vertexCount = await this.addTilesAndRunMainThreadVisualization(deckVisu);
            await this.resolveExternalRelations(deckVisu);
            const renderResult = this.readRenderResultFromDeckVisualization(deckVisu);
            const geometryLayerData = this.buildGeometryLayerData(
                renderResult.coordinateOrigin,
                renderResult
            );
            return {
                ...geometryLayerData,
                lowFiBundles: this.buildLowFiBundleData(renderResult.lowFiBundles, renderResult.coordinateOrigin),
                mergedPointFeatures: renderResult.mergedPointFeatures as
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

    /** Converts low-fi bundle buffers from wasm output into deck-friendly grouped layer data. */
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
            const geometryLayerData = this.buildGeometryLayerData(coordinateOrigin, rawBundle);
            const {
                surfaceLayerData,
                pathLayerData,
                pointLayerData,
                labelLayerData,
                arrowLayerData,
                gltfLayerData,
                gltfPickProxyLayerData
            } = geometryLayerData;
            if (!surfaceLayerData.length && !pathLayerData.length && !pointLayerData.length
                && !labelLayerData.length && !arrowLayerData.length && !gltfLayerData.length) {
                continue;
            }
            bundlesByLod.set(lod, {
                lod,
                surfaceLayerData,
                pathLayerData,
                pointLayerData,
                labelLayerData,
                arrowLayerData,
                gltfLayerData,
                gltfPickProxyLayerData
            });
        }
        return [...bundlesByLod.values()].sort((lhs, rhs) => lhs.lod - rhs.lod);
    }

    /** Converts raw wasm geometry buckets into the grouped deck layer-data structures used by this class. */
    private buildGeometryLayerData(
        coordinateOrigin: Float64Array,
        geometry: DeckGeometryBucketBuffers
    ): Pick<
        DeckWasmRenderOutput,
        | "surfaceLayerData"
        | "pathLayerData"
        | "pointLayerData"
        | "labelLayerData"
        | "arrowLayerData"
        | "gltfLayerData"
        | "gltfPickProxyLayerData"
    > {
        return {
            surfaceLayerData: this.buildSurfaceLayerData({
                coordinateOrigin,
                ...geometry.surface
            }),
            pathLayerData: this.buildCombinedPathLayerData(
                coordinateOrigin,
                geometry.pathWorld,
                geometry.pathBillboard
            ),
            pointLayerData: this.buildCombinedPointLayerData(
                coordinateOrigin,
                geometry.pointWorld,
                geometry.pointBillboard
            ),
            labelLayerData: this.buildCombinedLabelLayerData(
                coordinateOrigin,
                geometry.labelWorld,
                geometry.labelBillboard
            ),
            arrowLayerData: this.buildCombinedPathLayerData(
                coordinateOrigin,
                geometry.arrowWorld,
                geometry.arrowBillboard
            ),
            gltfLayerData: this.buildGltfLayerData(geometry.gltfNodes),
            gltfPickProxyLayerData: this.buildGltfPickProxyLayerData(coordinateOrigin, geometry.gltfPickProxies)
        };
    }

    /** Regroups raw GLTF-node buffers by depth-test state into tile-local scenegraph layer payloads. */
    private buildGltfLayerData(raw: DeckGltfBucketBuffers): DeckGltfLayerData[] {
        if (!raw.nodeIndices.length) {
            return [];
        }
        const itemCount = raw.nodeIndices.length;
        if (raw.colors.length < itemCount * 4 || raw.featureAddresses.length < itemCount) {
            return [];
        }
        if (raw.depthTests && raw.depthTests.length < itemCount) {
            return [];
        }

        const groups = new Map<boolean, DeckGltfLayerData["data"]>();
        for (let itemIndex = 0; itemIndex < itemCount; itemIndex++) {
            const depthTest = !raw.depthTests || raw.depthTests[itemIndex] !== 0;
            const group = groups.get(depthTest) ?? [];
            const colorOffset = itemIndex * 4;
            group.push({
                nodeIndex: raw.nodeIndices[itemIndex],
                featureAddress: raw.featureAddresses[itemIndex],
                color: [
                    raw.colors[colorOffset],
                    raw.colors[colorOffset + 1],
                    raw.colors[colorOffset + 2],
                    raw.colors[colorOffset + 3]
                ]
            });
            groups.set(depthTest, group);
        }

        return [true, false].flatMap((depthTest) => {
            const data = groups.get(depthTest);
            if (!data || data.length <= 0) {
                return [];
            }
            return [{
                length: data.length,
                depthTest,
                data,
                asset: null
            }];
        });
    }

    /** Converts raw GLTF picking-proxy triangle buffers into per-feature-node proxy records. */
    private buildGltfPickProxyLayerData(
        coordinateOriginRaw: Float64Array,
        raw: DeckGltfPickProxyBucketBuffers
    ): DeckGltfPickProxyLayerData | null {
        const coordinateOrigin = this.coordinateOriginFromRaw(coordinateOriginRaw);
        if (!coordinateOrigin || raw.startIndices.length < 2) {
            return null;
        }

        const proxyCount = raw.startIndices.length - 1;
        const vertexCount = raw.startIndices[proxyCount];
        if (!Number.isFinite(vertexCount) || !Number.isInteger(vertexCount)
            || vertexCount < 3 || vertexCount > MAX_DECK_VERTEX_COUNT) {
            return null;
        }
        if (raw.positions.length < vertexCount * 3
            || raw.featureAddresses.length < proxyCount
            || raw.nodeIndices.length < proxyCount
            || raw.startIndices[0] !== 0) {
            return null;
        }

        const data: DeckGltfPickProxyDatum[] = [];
        for (let proxyIndex = 0; proxyIndex < proxyCount; proxyIndex++) {
            const start = raw.startIndices[proxyIndex];
            const end = raw.startIndices[proxyIndex + 1];
            if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 3 || end > vertexCount) {
                return null;
            }
            const featureAddress = raw.featureAddresses[proxyIndex];
            if (!Number.isInteger(featureAddress) || featureAddress === DECK_UNSELECTABLE_FEATURE_INDEX) {
                continue;
            }
            data.push({
                nodeIndex: raw.nodeIndices[proxyIndex],
                featureAddress,
                positions: raw.positions.subarray(start * 3, end * 3)
            });
        }

        if (!data.length) {
            return null;
        }

        return {
            length: data.length,
            coordinateOrigin,
            data
        };
    }

    /** Reads the binary render result from the wasm visualization wrapper. */
    private readRenderResultFromDeckVisualization(deckVisu: DeckFeatureLayerVisualization): DeckVisualizationBufferResult {
        return (deckVisu as DeckFeatureLayerVisualizationWithRenderResult).renderResult();
    }

    /** Builds path-layer data for both world-space and billboard path buckets. */
    private buildCombinedPathLayerData(
        coordinateOrigin: Float64Array,
        worldRaw: Omit<DeckPathRawBuffers, "coordinateOrigin">,
        billboardRaw: Omit<DeckPathRawBuffers, "coordinateOrigin">
    ): DeckPathLayerData[] {
        return [
            ...this.buildPathLayerData({coordinateOrigin, ...worldRaw}, false),
            ...this.buildPathLayerData({coordinateOrigin, ...billboardRaw}, true)
        ];
    }

    /** Builds point-layer data for both world-space and billboard point buckets. */
    private buildCombinedPointLayerData(
        coordinateOrigin: Float64Array,
        worldRaw: Omit<DeckPointRawBuffers, "coordinateOrigin">,
        billboardRaw: Omit<DeckPointRawBuffers, "coordinateOrigin">
    ): DeckPointLayerData[] {
        return [
            ...this.buildPointLayerData({coordinateOrigin, ...worldRaw}, false),
            ...this.buildPointLayerData({coordinateOrigin, ...billboardRaw}, true)
        ];
    }

    /** Builds label-layer data for both world-space and billboard label buckets. */
    private buildCombinedLabelLayerData(
        coordinateOrigin: Float64Array,
        worldRaw: DeckLabelDatum[],
        billboardRaw: DeckLabelDatum[]
    ): DeckLabelLayerData[] {
        return [
            ...this.buildLabelLayerData(coordinateOrigin, worldRaw, false),
            ...this.buildLabelLayerData(coordinateOrigin, billboardRaw, true)
        ];
    }

    /** Extracts the meter-offset coordinate origin tuple from raw wasm output. */
    private coordinateOriginFromRaw(raw: Float64Array): [number, number, number] | null {
        if (raw.length < 3) {
            return null;
        }
        return [raw[0], raw[1], raw[2]];
    }

    /** Regroups raw path buffers by depth-test state into deck binary path-layer payloads. */
    private buildPathLayerData(raw: DeckPathRawBuffers, billboard: boolean): DeckPathLayerData[] {
        const coordinateOrigin = this.coordinateOriginFromRaw(raw.coordinateOrigin);
        if (!coordinateOrigin) {
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
        if (raw.colors.length < vertexCount * 4 || raw.widths.length < vertexCount || raw.featureAddresses.length < pathCount) {
            return [];
        }
        if (raw.depthTests && raw.depthTests.length < pathCount) {
            return [];
        }
        if (raw.dashArrays && raw.dashArrays.length < vertexCount * 2) {
            return [];
        }
        if (raw.startIndices[0] !== 0) {
            return [];
        }
        for (let pathIndex = 0; pathIndex < pathCount; pathIndex++) {
            const start = raw.startIndices[pathIndex];
            const end = raw.startIndices[pathIndex + 1];
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > vertexCount) {
                return [];
            }
        }

        const groups = new Map<boolean, {
            positions: number[];
            startIndices: number[];
            colors: number[];
            widths: number[];
            depthTests: number[];
            featureAddresses: number[];
            dashArrays?: number[];
        }>();
        const dashArraysPresent = !!raw.dashArrays && raw.dashArrays.length >= vertexCount * 2;

        for (let pathIndex = 0; pathIndex < pathCount; pathIndex++) {
            const depthTest = !raw.depthTests || raw.depthTests[pathIndex] !== 0;
            let group = groups.get(depthTest);
            if (!group) {
                group = {
                    positions: [],
                    startIndices: [0],
                    colors: [],
                    widths: [],
                    depthTests: [],
                    featureAddresses: [],
                    dashArrays: dashArraysPresent ? [] : undefined
                };
                groups.set(depthTest, group);
            }

            const startVertex = raw.startIndices[pathIndex];
            const endVertex = raw.startIndices[pathIndex + 1];
            for (let vertexIndex = startVertex; vertexIndex < endVertex; vertexIndex++) {
                const pathOffset = vertexIndex * 3;
                group.positions.push(
                    raw.positions[pathOffset],
                    raw.positions[pathOffset + 1],
                    raw.positions[pathOffset + 2]
                );
                const colorOffset = vertexIndex * 4;
                group.colors.push(
                    raw.colors[colorOffset],
                    raw.colors[colorOffset + 1],
                    raw.colors[colorOffset + 2],
                    raw.colors[colorOffset + 3]
                );
                group.widths.push(raw.widths[vertexIndex]);
                if (group.dashArrays && raw.dashArrays) {
                    const dashOffset = vertexIndex * 2;
                    group.dashArrays.push(raw.dashArrays[dashOffset], raw.dashArrays[dashOffset + 1]);
                }
            }
            group.depthTests.push(depthTest ? 1 : 0);
            group.featureAddresses.push(raw.featureAddresses[pathIndex]);
            group.startIndices.push(group.positions.length / 3);
        }

        return [true, false].flatMap((depthTest) => {
            const group = groups.get(depthTest);
            if (!group || group.featureAddresses.length <= 0) {
                return [];
            }
            const attributes: DeckPathLayerData["attributes"] = {
                getPath: {value: new Float32Array(group.positions), size: 3},
                instanceColors: {value: new Uint8Array(group.colors), size: 4},
                instanceStrokeWidths: {value: new Float32Array(group.widths), size: 1}
            };
            if (group.dashArrays && group.dashArrays.length > 0) {
                attributes.instanceDashArrays = {value: new Float32Array(group.dashArrays), size: 2};
            }
            return [{
                length: group.featureAddresses.length,
                billboard,
                depthTest,
                coordinateOrigin,
                startIndices: new Uint32Array(group.startIndices),
                featureAddressesByPath: new Uint32Array(group.featureAddresses),
                attributes
            }];
        });
    }

    /** Regroups raw surface buffers by depth-test state into deck polygon-layer payloads. */
    private buildSurfaceLayerData(raw: DeckSurfaceRawBuffers): DeckSurfaceLayerData[] {
        const coordinateOrigin = this.coordinateOriginFromRaw(raw.coordinateOrigin);
        if (!coordinateOrigin) {
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
            || raw.colors.length < vertexCount * 4
            || raw.featureAddresses.length < surfaceCount) {
            return [];
        }
        if (raw.depthTests && raw.depthTests.length < surfaceCount) {
            return [];
        }
        if (raw.startIndices[0] !== 0) {
            return [];
        }

        for (let surfaceIndex = 0; surfaceIndex < surfaceCount; surfaceIndex++) {
            const start = raw.startIndices[surfaceIndex];
            const end = raw.startIndices[surfaceIndex + 1];
            if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 3 || end > vertexCount) {
                return [];
            }
        }

        const groups = new Map<boolean, {
            positions: number[];
            startIndices: number[];
            colors: number[];
            depthTests: number[];
            featureAddresses: number[];
        }>();

        for (let surfaceIndex = 0; surfaceIndex < surfaceCount; surfaceIndex++) {
            const depthTest = !raw.depthTests || raw.depthTests[surfaceIndex] !== 0;
            let group = groups.get(depthTest);
            if (!group) {
                group = {
                    positions: [],
                    startIndices: [0],
                    colors: [],
                    depthTests: [],
                    featureAddresses: []
                };
                groups.set(depthTest, group);
            }

            const startVertex = raw.startIndices[surfaceIndex];
            const endVertex = raw.startIndices[surfaceIndex + 1];
            for (let vertexIndex = startVertex; vertexIndex < endVertex; vertexIndex++) {
                const positionOffset = vertexIndex * 3;
                group.positions.push(
                    raw.positions[positionOffset],
                    raw.positions[positionOffset + 1],
                    raw.positions[positionOffset + 2]
                );
                const colorOffset = vertexIndex * 4;
                group.colors.push(
                    raw.colors[colorOffset],
                    raw.colors[colorOffset + 1],
                    raw.colors[colorOffset + 2],
                    raw.colors[colorOffset + 3]
                );
            }
            group.depthTests.push(depthTest ? 1 : 0);
            group.featureAddresses.push(raw.featureAddresses[surfaceIndex]);
            group.startIndices.push(group.positions.length / 3);
        }

        return [true, false].flatMap((depthTest) => {
            const group = groups.get(depthTest);
            if (!group || group.featureAddresses.length <= 0) {
                return [];
            }
            return [{
                length: group.featureAddresses.length,
                depthTest,
                coordinateOrigin,
                startIndices: new Uint32Array(group.startIndices),
                featureAddresses: new Uint32Array(group.featureAddresses),
                attributes: {
                    getPolygon: {value: new Float32Array(group.positions), size: 3},
                    fillColors: {value: new Uint8Array(group.colors), size: 4}
                }
            }];
        });
    }

    /** Regroups raw point buffers by depth-test state into deck scatterplot-layer payloads. */
    private buildPointLayerData(raw: DeckPointRawBuffers, billboard: boolean): DeckPointLayerData[] {
        const coordinateOrigin = this.coordinateOriginFromRaw(raw.coordinateOrigin);
        if (!coordinateOrigin) {
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
            || raw.featureAddresses.length < pointCount) {
            return [];
        }
        if (raw.depthTests && raw.depthTests.length < pointCount) {
            return [];
        }

        const groups = new Map<boolean, {
            positions: number[];
            colors: number[];
            radii: number[];
            featureAddresses: number[];
        }>();
        for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
            const depthTest = !raw.depthTests || raw.depthTests[pointIndex] !== 0;
            let group = groups.get(depthTest);
            if (!group) {
                group = {positions: [], colors: [], radii: [], featureAddresses: []};
                groups.set(depthTest, group);
            }
            const positionOffset = pointIndex * 3;
            group.positions.push(
                raw.positions[positionOffset],
                raw.positions[positionOffset + 1],
                raw.positions[positionOffset + 2]
            );
            const colorOffset = pointIndex * 4;
            group.colors.push(
                raw.colors[colorOffset],
                raw.colors[colorOffset + 1],
                raw.colors[colorOffset + 2],
                raw.colors[colorOffset + 3]
            );
            group.radii.push(raw.radii[pointIndex]);
            group.featureAddresses.push(raw.featureAddresses[pointIndex]);
        }

        return [true, false].flatMap((depthTest) => {
            const group = groups.get(depthTest);
            if (!group || group.featureAddresses.length <= 0) {
                return [];
            }
            return [{
                length: group.featureAddresses.length,
                billboard,
                depthTest,
                coordinateOrigin,
                featureAddresses: new Uint32Array(group.featureAddresses),
                attributes: {
                    getPosition: {value: new Float32Array(group.positions), size: 3},
                    getFillColor: {value: new Uint8Array(group.colors), size: 4},
                    getRadius: {value: new Float32Array(group.radii), size: 1}
                }
            }];
        });
    }

    /** Regroups label data by depth-test state and normalizes positions to deck tuples. */
    private buildLabelLayerData(
        coordinateOriginRaw: Float64Array,
        data: DeckLabelDatum[],
        billboard: boolean
    ): DeckLabelLayerData[] {
        const coordinateOrigin = this.coordinateOriginFromRaw(coordinateOriginRaw);
        if (!coordinateOrigin || data.length <= 0) {
            return [];
        }
        const groups = new Map<boolean, DeckRenderableLabelDatum[]>();
        for (const entry of data) {
            const depthTest = entry.depthTest !== false;
            const group = groups.get(depthTest) ?? [];
            group.push({
                ...entry,
                depthTest,
                position: [entry.position.x, entry.position.y, entry.position.z]
            });
            groups.set(depthTest, group);
        }
        return [true, false].flatMap((depthTest) => {
            const normalizedData = groups.get(depthTest);
            if (!normalizedData || normalizedData.length <= 0) {
                return [];
            }
            return [{
                length: normalizedData.length,
                billboard,
                depthTest,
                coordinateOrigin,
                data: normalizedData
            }];
        });
    }

    /** Derives arrowhead icon markers from the first and last vertices of rendered arrow paths. */
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
            const rawFeatureAddress = pathData.featureAddressesByPath[arrowIndex];
            const featureAddress =
                Number.isInteger(rawFeatureAddress) && rawFeatureAddress !== DECK_UNSELECTABLE_FEATURE_INDEX
                    ? rawFeatureAddress
                    : null;
            const angleDeg =
                this.normalizeDegrees(
                    DECK_ARROW_ANGLE_SIGN * ((Math.atan2(dirX, dirY) * 180) / Math.PI) +
                    DECK_ARROW_ANGLE_OFFSET_DEG
                );
            const sizePx = Math.max(8, widthPx * 4);
            markers.push({
                featureAddress,
                position: [tipX, tipY, tipZ],
                color: [
                    colors[colorBase],
                    colors[colorBase + 1],
                    colors[colorBase + 2],
                    colors[colorBase + 3]
                ],
                sizePx,
                angleDeg
            });
        }
        return markers;
    }

    /** Returns whether the backing tile currently has any stage payloads loaded. */
    private tileHasData(): boolean {
        return this.tile.hasData();
    }

    /** Returns the tile's current feature count snapshot. */
    private tileFeatureCount(): number {
        return this.tile.numFeatures;
    }

    /** Returns the configured high-fidelity stage for this visualization. */
    private resolvedHighFidelityStage(): number {
        return this.highFidelityStage;
    }

    /** Returns the tile's highest loaded stage, normalized to a non-negative integer when present. */
    private highestLoadedStageOrDefault(): number | null {
        const highestLoadedStage = this.tile.highestLoadedStage();
        if (highestLoadedStage === null || highestLoadedStage === undefined || !Number.isFinite(highestLoadedStage)) {
            return null;
        }
        return Math.max(0, Math.floor(highestLoadedStage));
    }

    /** Chooses the fidelity that should currently be rendered from tile state and view policy. */
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
        return "low";
    }

    /** Maps the local fidelity label to the wasm `RuleFidelity` enum. */
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

    /** Returns the low-fi LOD limit to pass to wasm, or `-1` when low-fi limits are inactive. */
    private resolveMaxLowFiLod(fidelity: "low" | "high" | "any"): number {
        if (fidelity !== "low" || !this.styleHasExplicitLowFidelityRules) {
            return -1;
        }
        if (this.maxLowFiLod === null || this.maxLowFiLod === undefined) {
            return -1;
        }
        return this.maxLowFiLod;
    }

    /** Maps the worker/main-thread output mode to the wasm geometry-output constant. */
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

    /** Pushes the rendered vertex count back into the owning tile's diagnostics state. */
    private setTileVertexCount(count: number): void {
        this.tile.setVertexCount(Math.max(0, Math.floor(Number(count))));
    }

    /** Returns a shallow copy of the current style options for worker-safe transport. */
    private copyStyleOptions(): Record<string, boolean | number | string> {
        return {...this.options};
    }

    /** Builds the merged-point service key shared by all layers of this visualization. */
    private mapViewLayerStyleId(): MapViewLayerStyleRule {
        return this.pointMergeService.makeMapViewLayerStyleId(
            this.viewIndex,
            this.tile.mapName,
            this.tile.layerName,
            this.styleId,
            this.highlightMode
        );
    }

    /** Records one render duration sample under the style/highlight-specific diagnostics key. */
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

    /** Records worker-side deserialize time into the tile's parse-time diagnostics bucket. */
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

    /** Returns the diagnostics label used for the current highlight mode. */
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

    /** Extracts the deck layer registry from the renderer-specific scene handle. */
    private resolveRegistry(sceneHandle: IRenderSceneHandle): DeckLayerRegistry {
        const scene = sceneHandle.scene as DeckSceneHandle;
        return scene.layerRegistry!;
    }

    /** Returns and clears the latest worker timings after a render finished. */
    private consumeLatestWorkerTimings(): DeckWorkerTimings | null {
        const timings = this.latestWorkerTimings;
        this.latestWorkerTimings = null;
        return timings;
    }

    /** Normalizes an angle to [0, 360). */
    private normalizeDegrees(value: number): number {
        const normalized = value % 360;
        return normalized < 0 ? normalized + 360 : normalized;
    }
}
