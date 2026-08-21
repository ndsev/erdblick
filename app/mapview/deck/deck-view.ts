import {
    BehaviorSubject,
    combineLatest,
    distinctUntilChanged,
    skip,
    Subject,
    Subscription
} from "rxjs";
import {
    COORDINATE_SYSTEM,
    Deck as DeckGlDeck,
    type DeckProps,
    FirstPersonView as DeckFirstPersonView,
    type InteractionState,
    MapController,
    MapView as DeckMercatorView,
    type MapInteractionTargetContext,
    type PickingInfo,
    type WebMercatorViewport
} from "@deck.gl/core";
import {BitmapLayer, IconLayer, PolygonLayer, TextLayer} from "@deck.gl/layers";
import type {Device, Parameters as LumaParameters} from "@luma.gl/core";
import {WMSImageSource} from "@loaders.gl/wms";
import {Cartographic, Color, GeoMath, SceneMode} from "../../integrations/geo";
import {MapInfoService} from "../../mapdata/map-info.service";
import {MapViewStateService} from "../map-view-state.service";
import {MapTileStreamService} from "../../mapdata/map-tile-stream.service";
import {InspectionSelectionService} from "../../inspection/inspection-selection.service";
import {
    FeatureSearchService,
    type FeatureSearchOverlayLayer
} from "../../search/feature.search.service";
import {featureSearchVisibleInView} from "../../shared/feature-search-state";
import {featureSetsEqual} from "../../mapdata/feature-inspection.model";
import type {SearchResultDensityMarker, SearchResultPoint} from "../../search/search-result-density.model";
import {RightClickMenuService, TileOutlinePayload} from "../rightclickmenu.service";
import {CoordinatesService} from "../../coords/coordinates.service";
import {
    AppStateService,
    CameraViewState,
    DEFAULT_TILE_GRID_COLOR,
    DEFAULT_TILE_GRID_LEVEL,
    DEFAULT_TILE_GRID_OPACITY,
    DEFAULT_MAP_ZOOM_STEP,
    TileFeatureId,
    TileGridMode,
    VIEW_SYNC_MOVEMENT,
    VIEW_SYNC_POSITION,
    tileGridRgba
} from "../../shared/appstate.service";
import {
    AppConfigService,
    type BackgroundLayerConfig,
    type WmsBackgroundLayerConfig,
    type XyzBackgroundLayerConfig
} from "../../shared/app-config.service";
import {
    IRenderSceneHandle,
    IRenderView,
    RenderNavigationTarget,
    RenderedFeaturePickResult
} from "../render-view.model";
import {Viewport} from "../../../build/libs/core/erdblick-core";
import {DeckLayerRegistry} from "./deck-layer-registry";
import {
    createErdblickVectorLayers,
    ErdblickVectorLayer
} from "./erdblick-vector.layer";
import {GpuScene} from "./gpu-scene";
import {GpuSceneMaskController} from "./gpu-scene-mask.controller";
import {gpuIconAtlasService} from "./gpu-icon-atlas.service";
import {
    createGpuTextLayerHost,
    GpuTextLayerHost
} from "./gpu-text-layer.host";
import {
    DeckInteractionOutlineService,
    isDeckInteractionMaskLayer
} from "./deck-interaction-outline.service";
import {
    DeckSemanticZIndexService,
    isSemanticZIndexPassLayer,
    isSemanticZIndexPickingLayer
} from "./deck-semantic-z-index.service";
import {NavigationTargetOverlay} from "./deck-navigation-target";
import {planarPanViewState} from "./deck-planar-pan";
import {environment} from "../../environments/environment";
import {coreLib} from "../../integrations/wasm";
import {
    TileGridOverlayDatum,
    TILE_STATE_KIND_EMPTY,
    TILE_STATE_KIND_ERROR,
    TileGridOverlayLayer,
    TileGridStateOverlayLayer,
    tileGridOverlayData
} from "./deck-tile-grid-overlay.layer";
import {
    createSearchResultDensityLabelLayer,
    createSearchResultDensityLayer,
    layoutSearchResultDensityMarkers,
    SEARCH_RESULT_DENSITY_DEFAULT_SIZE_SCALE,
    searchResultDensityCountDomain,
    type SearchResultDensityCountDomain,
    type SearchResultDensityLayoutEntry
} from "./deck-search-result-density.layer";
import {type TileLayerProps, WMSLayer} from "../../integrations/deckgl";
import {
    autoTileGridLevel,
    coarsenedTileLevel,
    tileGridExtentForLevel,
    tileGridLatToNormY,
    tileGridLonToNormX,
    tileGridNormYToLat,
    tileGridVisibleCellCount,
    wrapColumnIntoExtent,
    type TileGridLevelExtent
} from "../tile-grid-visibility";
import {ViewLayerController} from "../view-layer.controller";
import {
    createDeckMapViewport,
    DECK_MAP_FOV_DEGREES,
    ErdblickMapView,
    isNavigationAnchorUsable,
    longitudeInNearestWorld,
    viewStateKeepingAnchor,
    viewStateKeepingNavigationAnchor,
    viewStateWithGroundCenter
} from "./navigation/web-mercator-feature-navigation";
import {clippedGeographicBounds} from "./deck-viewport-coverage";
import {ErdblickTargetNavigationAdapter} from "./navigation/erdblick-target-navigation-adapter";
import type {
    NavigationAnchor,
    NavigationSurfaceNormal,
    NavigationTargetOrigin,
    NavigationVisualTarget
} from "./navigation/feature-navigation.types";
import {
    type DeckFeaturePickLayerProps,
    markerAnchorFromPickingInfo,
    NAVIGATION_PICK_RADIUS_PIXELS,
    navigationTargetFromPickingInfo,
    pickNavigationAnchor
} from "./navigation/erdblick-navigation-anchor";
import {BatchedTileLayer} from "./batched-tile.layer";
import {
    createFirstPersonCoverageViewport,
    createFixedFirstPersonCameraState,
    FIRST_PERSON_FAR_METERS,
    FIRST_PERSON_FOCAL_DISTANCE,
    FIRST_PERSON_FOV_DEGREES,
    FIRST_PERSON_NEAR_METERS,
    type FixedFirstPersonCameraState,
    updateFixedFirstPersonLook
} from "./deck-first-person-navigation";

/** Internal camera state deck uses while the rest of the app still speaks Cesium-like camera values. */
interface DeckCameraState {
    longitude: number;
    latitude: number;
    zoom: number;
    minZoom?: number;
    maxZoom?: number;
    pitch: number;
    bearing: number;
    maxPitch: number;
    position: [number, number, number];
}

type DeckFirstPersonCameraState = FixedFirstPersonCameraState;

/** Non-persisted first-person state and its stable 360-degree tile coverage. */
interface FirstPersonSession {
    viewState: DeckFirstPersonCameraState;
    coverageViewport: Viewport;
}

type DeckView = DeckMercatorView | DeckFirstPersonView;

/** Geometry description for one tile-grid overlay level after local normalization. */
interface TileGridOverlayGeometry {
    data: TileGridOverlayDatum[];
    localMin: [number, number];
    localSize: [number, number];
    subdivisionX: number;
    subdivisionY: number;
}

/** Map/layer pair used when aggregating tile-state overlays per visible feature level. */
interface VisibleLayerRef {
    mapId: string;
    layerId: string;
}

/** One active search layer together with the visible source tiles it contributes to this view. */
interface SearchResultOverlayInput {
    searchLayer: FeatureSearchOverlayLayer;
    dotLayerKey: string;
    labelLayerKey: string;
    pinLayerKey: string;
    lowFiSourceTileKeys: Set<string>;
    highFiPinMarkers: SearchResultDensityMarker[];
    targetLevel: number;
    densitySizeScale: number;
    sourceTileKeySignature: string;
}

/** Search-result marker data plus its observed count range for one deck dot layer. */
interface SearchResultOverlayLayerData {
    markers: SearchResultDensityMarker[];
    countDomain: SearchResultDensityCountDomain;
}

/** Shared rectangle overlay datum for tile outlines and jump-area highlights. */
interface DeckRectangleOverlayDatum {
    polygon: [number, number][];
    fillColor: [number, number, number, number];
    lineColor: [number, number, number, number];
    lineWidthPixels: number;
}

/** Single location marker datum for the search/jump marker overlay. */
interface DeckLocationMarkerDatum {
    position: [number, number, number];
}

/** Single transient place-name label datum for location-search jumps. */
interface DeckLocationLabelDatum {
    position: [number, number];
    label: string;
    textColor: [number, number, number, number];
    backgroundColor: [number, number, number, number];
}

/** Minimal event shape used by deck click callbacks. */
interface DeckGestureEventLike {
    srcEvent?: {
        button?: number;
        ctrlKey?: boolean;
        pointerType?: string;
    };
}

/**
 * Minimal deck.gl map view scaffold used to wire renderer switching and camera-state sync.
 * Besides vector and overlay rendering, it now also owns config-driven raster background
 * layers so per-view background state stays close to the actual deck layer lifecycle.
 */
export abstract class DeckMapView implements IRenderView {
    private static readonly EARTH_RADIUS_METERS = 6378137;
    private static readonly WEB_MERCATOR_TILE_SIZE = 512;
    private static readonly ASSUMED_VERTICAL_FOV_RADIANS = GeoMath.toRadians(DECK_MAP_FOV_DEGREES);
    private static readonly FALLBACK_VIEWPORT_HEIGHT_PX = 1080;
    private static readonly MIN_MAP_ZOOM = 0;
    private static readonly MAX_MAP_ZOOM = 22;
    private static readonly BACKGROUND_LAYER_KEY = "background/layer";
    private static readonly TILE_GRID_LAYER_KEY = "builtin/tile-grid";
    private static readonly TILE_STATE_LAYER_KEY = "builtin/tile-state";
    private static readonly TILE_OUTLINE_LAYER_KEY = "builtin/tile-outline";
    private static readonly JUMP_AREA_LAYER_KEY = "builtin/jump-area";
    private static readonly SEARCH_RESULTS_LAYER_PREFIX = "builtin/search-results";
    private static readonly LOCATION_MARKER_LAYER_KEY = "builtin/location-marker";
    private static readonly LOCATION_LABEL_LAYER_KEY = "builtin/location-label";
    private static readonly CANVAS_RESIZE_DEBOUNCE_MS = 64;
    private static readonly CANVAS_USE_DEVICE_PIXELS = 1;
    private static readonly CANVAS_STYLE: Partial<CSSStyleDeclaration> = {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%",
        display: "block"
    };
    private static readonly LOCATION_MARKER_ICON_NAME = "marker";
    private static readonly LOCATION_MARKER_ICON_SIZE_PX = 48;
    private static readonly LOCATION_MARKER_RENDER_SIZE_PX = 32;
    private static readonly SEARCH_RESULT_PIN_RENDER_SIZE_PX = 24;
    private static readonly LOCATION_LABEL_FADE_DURATION_MS = 4200;
    private static readonly UNSELECTABLE_FEATURE_INDEX = 0xffffffff;
    private static readonly JUMP_AREA_HIGHLIGHT_DURATION_MS = 3000;
    private static readonly TILE_GRID_LINE_WIDTH_PX = 1.0;
    private static readonly TILE_GRID_MAX_VISIBLE_CELLS = 16 * 1024;
    private static readonly SEARCH_RESULT_DENSITY_SIZE_SCALE = SEARCH_RESULT_DENSITY_DEFAULT_SIZE_SCALE;
    private static readonly SEARCH_RESULT_SOURCE_TILE_HASH_OFFSET = 0x811c9dc5;
    private static readonly SEARCH_RESULT_SOURCE_TILE_HASH_PRIME = 0x01000193;
    private static readonly HOVER_ANCHOR_PICK_THROTTLE_MS = 16;
    private static readonly HOVER_DETAIL_PICK_IDLE_MS = 80;
    private static readonly HOVER_PICK_MAX_OBJECTS = 10;
    private static readonly GPU_SCENE_REDRAW_QUIET_MS = 50;
    private static readonly GPU_SCENE_REDRAW_MAX_LATENCY_MS = 1_000;
    private static readonly TILE_GRID_DATA_REFRESH_DEBOUNCE_MS = 250;
    private static readonly NAVIGATION_COMMAND_STEP_PX = 64;
    private static readonly TILE_STATE_ERROR_COLOR: [number, number, number, number] = [225, 45, 45, 105];
    private static readonly TILE_STATE_EMPTY_COLOR: [number, number, number, number] = [122, 126, 133, 64];
    private static readonly NO_DEPTH_PARAMETERS: LumaParameters = {
        depthWriteEnabled: false,
        depthCompare: "always",
        cullMode: "none"
    };

    protected readonly _viewIndex: number;
    readonly canvasId: string;
    protected deck: DeckGlDeck<DeckView> | null = null;
    protected readonly layerRegistry = new DeckLayerRegistry();
    protected readonly interactionOutlineService =
        new DeckInteractionOutlineService(this.layerRegistry);
    protected readonly semanticZIndexService =
        new DeckSemanticZIndexService(this.layerRegistry);
    private gpuScene: GpuScene | null = null;
    private gpuVectorLayers: readonly ErdblickVectorLayer[] = [];
    private readonly gpuVectorDisabledPickIndices = new Set<number>();
    private gpuTextLayerHost: GpuTextLayerHost | null = null;
    private gpuMaskController: GpuSceneMaskController | null = null;
    protected readonly subscriptions: Subscription[] = [];
    protected viewState: DeckCameraState = {
        longitude: 0,
        latitude: 0,
        zoom: 2,
        minZoom: DeckMapView.MIN_MAP_ZOOM,
        maxZoom: DeckMapView.MAX_MAP_ZOOM,
        pitch: 0,
        bearing: 0,
        maxPitch: 85,
        position: [0, 0, 0]
    };

    hoveredFeatureIds = new BehaviorSubject<TileFeatureId[]>([]);
    readonly firstPersonViewActive = new BehaviorSubject(false);
    readonly contextLost = new Subject<void>();

    private ignoreNextCamAppStateUpdate = false;
    private suppressDeckViewStateEvent = false;
    private readonly tickCallbacks = new Set<() => void>();
    private tickHandle: number | null = null;
    private deckDevice: Device | null = null;
    private navigationTargetOverlay: NavigationTargetOverlay | null = null;
    private canvasResizeTimer: ReturnType<typeof setTimeout> | null = null;
    private lastCanvasCssSize?: {width: number; height: number};
    private clippedLayoutCanvasCssSize?: {width: number; height: number};
    private layoutResizeRestoreRaf?: number;
    private backgroundLayerSignature = "";
    private tileGridEnabled = false;
    private tileGridMode: TileGridMode = "nds";
    private tileGridLevel = DEFAULT_TILE_GRID_LEVEL;
    private tileGridAutoLevel = false;
    private tileGridLineColor = tileGridRgba(DEFAULT_TILE_GRID_COLOR, DEFAULT_TILE_GRID_OPACITY);
    private tileGridLayerKeys = new Set<string>();
    private tileStateLayerKeys = new Set<string>();
    private tileGridOverlayUpdateRaf: number | null = null;
    private tileGridOverlayDataRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private searchResultsOverlayUpdateRaf: number | null = null;
    private viewportUpdateRaf: number | null = null;
    private searchResultsOverlayDataRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private lastSearchResultsSignature = "";
    private searchResultLayerKeys = new Set<string>();
    private lastLocationMarkerSignature = "";
    private jumpAreaHighlightTick: (() => void) | null = null;
    private locationLabelTick: (() => void) | null = null;
    private isHoveringFeature = false;
    private hoverNavigationPivot: NavigationAnchor | null = null;
    private hoverNavigationSurfaceNormal: NavigationSurfaceNormal | null = null;
    private hoverNavigationOrigin: NavigationTargetOrigin | null = null;
    private activeNavigationPivot: NavigationAnchor | null = null;
    private activeNavigationSurfaceNormal: NavigationSurfaceNormal | null = null;
    private activeNavigationOrigin: NavigationTargetOrigin | null = null;
    private retainedNavigationPivot: NavigationAnchor | null = null;
    private retainedNavigationSurfaceNormal: NavigationSurfaceNormal | null = null;
    private retainedNavigationOrigin: NavigationTargetOrigin | null = null;
    private readonly targetNavigationAdapter: ErdblickTargetNavigationAdapter;
    private firstPersonSession: FirstPersonSession | null = null;
    private hoverAnchorPickTimer: ReturnType<typeof setTimeout> | null = null;
    private hoverDetailPickTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingHoverAnchorPosition: {x: number; y: number} | null = null;
    private pendingHoverDetailPosition: {x: number; y: number} | null = null;
    private latestHoverPosition: {x: number; y: number} | null = null;
    private hoverDetailPickDueAtMs = 0;
    private hoverPickInFlight = false;
    private hoverPickGeneration = 0;
    private topHoverFeatureIds: TileFeatureId[] = [];
    private topHoverFeatureGeneration = -1;
    private deckCanvasPointerInside = false;
    private lastHoverAnchorPickAtMs = 0;
    private isCameraInteracting = false;
    private deckPreviousFrameCompletedAtMs = 0;
    private gpuSceneRedrawTimer: ReturnType<typeof setTimeout> | null = null;
    private gpuSceneRedrawBurstStartedAtMs = 0;
    private gpuSceneRedrawReason = "GPU scene changed";
    private gpuSceneRetiredResourcesPending = false;
    private liveCameraSyncRaf: number | null = null;
    private cameraStatePushPending = false;
    private readonly deckCanvasPointerEnter = () => {
        this.deckCanvasPointerInside = true;
    };
    private readonly deckCanvasPointerMove = (event: PointerEvent) => {
        this.onCanvasPointerMove(event);
    };
    private readonly deckCanvasPointerDown = (event: PointerEvent) => {
        this.hoverPickGeneration += 1;
        this.pendingHoverAnchorPosition = null;
        this.pendingHoverDetailPosition = null;
        this.cancelHoverPickScheduling();
        if (!this.allowPitchAndBearing || this.firstPersonSession) {
            return;
        }
        if (event.button === 2) {
            event.preventDefault();
        }
    };
    private readonly deckCanvasContextMenu = (event: MouseEvent) => {
        event.preventDefault();
    };
    private readonly deckCanvasPointerLeave = (event: PointerEvent) => {
        this.deckCanvasPointerInside = false;
        // Deck throttles expensive drill picks. A sample queued just before
        // the pointer enters an inspection panel must not run afterward and
        // erase the panel-owned validity hover.
        this.latestHoverPosition = null;
        this.pendingHoverAnchorPosition = null;
        this.pendingHoverDetailPosition = null;
        this.hoverPickGeneration += 1;
        this.cancelHoverPickScheduling();
        this.setFeatureHoverState(false);
        this.setHoverNavigationPivot(null);
        this.hoveredFeatureIds.next([]);
        const destinationOwnsInspectionHover = event.relatedTarget instanceof Element
            && event.relatedTarget.closest("inspection-container") !== null;
        if (!destinationOwnsInspectionHover) {
            this.inspectionSelection.setHoveredFeatures([]);
        }
    };
    private desktopDrillPickingEnabled = true;
    private readonly deckCursor = ({isDragging}: {isDragging: boolean}) =>
        this.isHoveringFeature ? "pointer" : (isDragging ? "grabbing" : "grab");
    /**
     * Separates visible GLTF rendering from the invisible GLTF pick-proxy pass.
     *
     * deck still draws non-pickable layers during picking unless they are filtered out explicitly,
     * so the visible GLTF layer must be excluded there or it will overwrite the cheap proxy ids.
     */
    private readonly deckLayerFilter: DeckProps<DeckView>["layerFilter"] = ({layer, isPicking}) => {
        const layerId = String(layer.id ?? "");
        if (isDeckInteractionMaskLayer(layerId)) {
            return false;
        }
        if (isSemanticZIndexPassLayer(layerId)) {
            return false;
        }
        if (isSemanticZIndexPickingLayer(layerId)) {
            return isPicking;
        }
        const layerPickable = Boolean((layer.props as {pickable?: boolean | "3d"} | undefined)?.pickable);
        const isGltfPickProxyLayer = layerId.includes("/gltf-pick-proxy");
        const isVisibleGltfLayer = layerId.includes("/gltf") && !isGltfPickProxyLayer;
        if (isPicking) {
            if (!layerPickable) {
                return false;
            }
            if (isGltfPickProxyLayer) {
                return true;
            }
            return !isVisibleGltfLayer;
        }
        return !isGltfPickProxyLayer;
    };
    private static readonly DEFAULT_DECK_SCROLL_ZOOM_SPEED = 0.01;

    get viewIndex() {
        return this._viewIndex;
    }

    /** Enables desktop-only point drill-picking without broadening touch/narrow-view taps. */
    setDesktopDrillPickingEnabled(enabled: boolean): void {
        this.desktopDrillPickingEnabled = enabled;
    }

    protected abstract readonly sceneMode: SceneMode;
    protected abstract readonly allowPitchAndBearing: boolean;
    protected readonly useOrthographicProjection: boolean = false;

    /** Creates the deck-backed view wrapper for one canvas and app-state view index. */
    constructor(id: number,
                canvasId: string,
                protected mapInfo: MapInfoService,
                protected mapViewState: MapViewStateService,
                protected tileStream: MapTileStreamService,
                protected inspectionSelection: InspectionSelectionService,
                protected featureSearchService: FeatureSearchService,
                protected menuService: RightClickMenuService,
                protected coordinatesService: CoordinatesService,
                protected stateService: AppStateService,
                protected configService: AppConfigService,
                protected layerController: ViewLayerController) {
        this._viewIndex = id;
        this.canvasId = canvasId;
        this.targetNavigationAdapter = new ErdblickTargetNavigationAdapter({
            viewId: `deck-view-${id}`,
            resolveTarget: context =>
                this.resolveControllerNavigationTarget(context),
            getRetainedTarget: () => this.retainedNavigationPivot
                ? {
                    position: this.retainedNavigationPivot,
                    ...(this.retainedNavigationSurfaceNormal
                        ? {surfaceNormal: this.retainedNavigationSurfaceNormal}
                        : {}),
                    origin: this.retainedNavigationOrigin ?? "unknown"
                }
                : null,
            getMinimumTargetDistance: target =>
                this.minimumTargetDistanceForOrigin(target.origin),
            onTargetChange: (target, active) =>
                this.onControllerNavigationTargetChange(target, active)
        });
    }

    /** Creates the normal geospatial map view using erdblick's shared projection contract. */
    private createMapDeckView(
        controller?: DeckProps<DeckView>["controller"],
        idSuffix = ""
    ): DeckMercatorView {
        return new ErdblickMapView({
            id: `deck-view-${this._viewIndex}${idSuffix}`,
            repeat: true,
            orthographic: this.useOrthographicProjection,
            controller
        });
    }

    /** Creates the fixed-location perspective view used by ephemeral first-person inspection. */
    private createFirstPersonDeckView(
        controller?: DeckProps<DeckView>["controller"],
        idSuffix = ""
    ): DeckFirstPersonView {
        return new DeckFirstPersonView({
            id: `deck-view-${this._viewIndex}${idSuffix}`,
            fovy: FIRST_PERSON_FOV_DEGREES,
            near: FIRST_PERSON_NEAR_METERS,
            far: FIRST_PERSON_FAR_METERS,
            focalDistance: FIRST_PERSON_FOCAL_DISTANCE,
            controller
        });
    }

    /** Creates the canvas, bootstraps deck, and installs all renderer-to-app subscriptions. */
    async setup(): Promise<void> {
        const container = document.getElementById(this.canvasId) as HTMLDivElement | null;
        if (!container) {
            throw new Error(`Deck container #${this.canvasId} not found.`);
        }
        container.innerHTML = "";
        const canvas = this.createDeckCanvas(container);
        canvas.addEventListener("pointerenter", this.deckCanvasPointerEnter);
        canvas.addEventListener("pointermove", this.deckCanvasPointerMove);
        // Cancel deferred hover work before Mjolnir begins classifying the gesture.
        // The controller's synchronous provider owns target acquisition.
        canvas.addEventListener("pointerdown", this.deckCanvasPointerDown, true);
        canvas.addEventListener("contextmenu", this.deckCanvasContextMenu);
        canvas.addEventListener("pointerleave", this.deckCanvasPointerLeave);
        this.navigationTargetOverlay = new NavigationTargetOverlay(container);
        canvas.addEventListener("webglcontextlost", this.deckContextLost);
        this.setCanvasDrawingBufferSize(canvas, container.clientWidth, container.clientHeight);
        this.lastCanvasCssSize = this.normalizedCanvasCssSize(container.clientWidth, container.clientHeight);
        const gl = this.createWebGl2Context(canvas, container);

        this.setViewFromState(this.stateService.cameraViewDataState.getValue(this._viewIndex));

        let resolveDeckDevice!: () => void;
        const deckDeviceReady = new Promise<void>(resolve => {
            resolveDeckDevice = resolve;
        });
        const deckProps: DeckProps<DeckView> = {
            id: `deck-${this.canvasId}`,
            gl,
            // Keep one CSS pixel per device pixel; this limits redraw pressure during live resizes.
            useDevicePixels: DeckMapView.CANVAS_USE_DEVICE_PIXELS,
            // A synchronous pointer-down readback blocks the first pan frame on dense scenes.
            pickAsync: "async",
            views: this.createMapDeckView(this.createDeckControllerOptions()),
            viewState: this.viewState,
            layers: [],
            effects: [
                this.semanticZIndexService,
                this.interactionOutlineService
            ],
            controller: false,
            pickingRadius: NAVIGATION_PICK_RADIUS_PIXELS,
            layerFilter: this.deckLayerFilter,
            onDeviceInitialized: (device) => {
                this.deckDevice = device;
                resolveDeckDevice();
            },
            onResize: ({width, height}) => {
                this.lastCanvasCssSize = this.normalizedCanvasCssSize(width, height);
                this.scheduleViewportUpdate();
                this.scheduleTileGridOverlayUpdate();
                this.scheduleSearchResultsOverlayUpdate();
                this.scheduleCanvasResize(width, height);
            },
            getCursor: this.deckCursor,
            onViewStateChange: ({viewState, interactionState}) =>
                this.onDeckViewStateChange(
                    viewState as DeckCameraState | DeckFirstPersonCameraState,
                    interactionState
                ),
            onInteractionStateChange: (interactionState) => this.onInteractionStateChange(interactionState),
            onClick: (info, event) => this.onClick(info, event),
            onAfterRender: () => {
                const completedAtMs = performance.now();
                const frameIntervalMs = this.deckPreviousFrameCompletedAtMs > 0
                    ? completedAtMs - this.deckPreviousFrameCompletedAtMs
                    : 0;
                this.deckPreviousFrameCompletedAtMs = completedAtMs;
                // Ignore a redraw after a genuinely idle view. Intervals up to
                // two seconds deliberately remain visible so a one-FPS pan is
                // reported as one FPS instead of as a tiny callback duration.
                if (frameIntervalMs > 0 && frameIntervalMs <= 2000) {
                    this.layerController.recordDeckFrameTime(frameIntervalMs);
                }
                if (this.gpuSceneRetiredResourcesPending) {
                    this.gpuSceneRetiredResourcesPending = false;
                    this.gpuScene?.releaseRetiredPresentationResources();
                }
                this.gpuMaskController?.releaseRetiredResources();
            }
        };
        this.deck = new DeckGlDeck(deckProps);
        this.layerRegistry.setDeck(this.deck);

        // Deck creates its luma device asynchronously even when an existing
        // WebGL context is supplied.  Do not publish a scene handle until the
        // device exists: attachment-backed GLTF presentation needs it to
        // parse/upload assets and an immutable handle containing `null` would
        // otherwise strand those tiles as pick proxies only.
        await deckDeviceReady;
        // This pinned Deck snapshot speculatively renders a full picking pass on every
        // pointer-down. Erdblick performs its explicit drill pick only after a click has won over
        // a drag, so keep that private bookkeeping handler off the latency-critical drag path.
        const eventManager = this.deck.getEventManager() as unknown as {
            off(eventName: string, handler: (...args: never[]) => void): void;
        } | null;
        const deckInternals = this.deck as unknown as {
            _onPointerDown: (...args: never[]) => void;
            _onPointerMove: (...args: never[]) => void;
        };
        eventManager?.off("pointerdown", deckInternals._onPointerDown);
        // Deck's native hover path starts a new asynchronous full-scene pick every frame while
        // the pointer moves. Stale results are ignored but their GPU passes and readbacks are not
        // cancelled. Erdblick owns a latest-only hover queue below, so remove Deck's duplicate path.
        eventManager?.off("pointermove", deckInternals._onPointerMove);
        eventManager?.off("pointerleave", deckInternals._onPointerMove);
        this.gpuScene = new GpuScene(
            this.deckDevice!,
            reason => this.requestGpuSceneRender(reason)
        );
        this.gpuVectorDisabledPickIndices.clear();
        this.semanticZIndexService.bindScene(
            this.gpuScene,
            this.sceneMode === SceneMode.SCENE2D,
            this.gpuVectorDisabledPickIndices
        );
        this.layerController.setDeckPresentationDiagnosticsProvider(() => ({
            layers: this.layerRegistry.size,
            scene: this.gpuScene?.snapshot() ?? {
                generation: 0,
                revision: 0,
                materialCount: 0,
                activeContributionCount: 0,
                activeOriginCount: 0,
                pickingHighWater: 0,
                pickingFragmentation: 0,
                zIndexHighWater: 0,
                zIndexUpdateMs: 0,
                labels: 0,
                stores: []
            }
        }));
        this.gpuVectorLayers = createErdblickVectorLayers(
            `builtin/gpu-vector-${this._viewIndex}`,
            this.gpuScene,
            this.sceneMode === SceneMode.SCENE2D,
            this.gpuVectorDisabledPickIndices
        );
        this.gpuTextLayerHost = createGpuTextLayerHost(
            `builtin/gpu-text-${this._viewIndex}`,
            this.gpuScene,
            this.sceneMode === SceneMode.SCENE2D
        );
        this.gpuMaskController = new GpuSceneMaskController(
            this.deckDevice!,
            this.gpuScene,
            this.interactionOutlineService,
            this.sceneMode === SceneMode.SCENE2D
        );
        this.layerRegistry.upsert(
            this.gpuVectorLayers[0].id,
            this.gpuVectorLayers[0],
            350
        );
        this.layerRegistry.upsert(
            this.gpuVectorLayers[1].id,
            this.gpuVectorLayers[1],
            400
        );
        this.layerRegistry.upsert(
            this.gpuVectorLayers[2].id,
            this.gpuVectorLayers[2],
            4_000
        );
        this.layerRegistry.upsert(
            this.gpuVectorLayers[3].id,
            this.gpuVectorLayers[3],
            4_001
        );
        this.layerRegistry.upsert(
            this.gpuTextLayerHost.id,
            this.gpuTextLayerHost,
            475
        );

        this.setupSubscriptions();
        this.cancelViewportUpdateScheduling();
        this.updateViewport();
        this.requestRender();
    }

    /** Tears down deck, overlay state, and every subscription associated with this view. */
    async destroy(): Promise<void> {
        this.flushPendingViewStatePush();
        this.layerController.setCameraInteracting(false);
        this.subscriptions.forEach(sub => sub.unsubscribe());
        this.subscriptions.length = 0;
        this.stopTickLoop();
        this.cancelViewportUpdateScheduling();
        this.cancelTileGridOverlayUpdateScheduling();
        this.cancelSearchResultsOverlayScheduling();
        this.cancelCanvasResizeScheduling();
        this.cancelLayoutResizeRestore();
        this.cancelGpuSceneRedraw();
        this.tickCallbacks.clear();
        this.setFeatureHoverState(false);
        this.hoveredFeatureIds.next([]);
        this.cancelHoverPickScheduling();
        this.hoverPickGeneration += 1;
        this.pendingHoverAnchorPosition = null;
        this.pendingHoverDetailPosition = null;
        this.latestHoverPosition = null;
        this.firstPersonSession = null;
        this.firstPersonViewActive.next(false);
        this.removeBackgroundLayer();
        this.removeTileGridLayers();
        this.layerRegistry.remove(DeckMapView.TILE_OUTLINE_LAYER_KEY);
        this.layerRegistry.remove(DeckMapView.JUMP_AREA_LAYER_KEY);
        this.removeSearchResultLayers();
        this.layerRegistry.remove(DeckMapView.LOCATION_MARKER_LAYER_KEY);
        this.layerRegistry.remove(DeckMapView.LOCATION_LABEL_LAYER_KEY);
        this.removeTileStateLayers();
        this.stopJumpAreaHighlight();
        this.stopLocationLabel();
        this.backgroundLayerSignature = "";
        this.tileGridEnabled = false;
        this.gpuMaskController?.destroy();
        this.gpuMaskController = null;
        this.semanticZIndexService.unbindScene();
        this.gpuVectorDisabledPickIndices.clear();
        for (const layer of this.gpuVectorLayers) {
            this.layerRegistry.remove(layer.id);
        }
        if (this.gpuTextLayerHost) {
            this.layerRegistry.remove(this.gpuTextLayerHost.id);
        }
        this.layerRegistry.destroy();
        // Persistent scene buffers and lookup textures belong to the same
        // device as Deck's models. Retire them while that device is alive;
        // after finalize(), WebGL context-loss teardown can no longer do so.
        this.gpuScene?.destroy();
        this.gpuScene = null;
        this.layerController.clearDeckPresentationDiagnostics();
        if (this.deckDevice) {
            // Atlas textures belong to the still-live luma device and must be
            // destroyed before Deck finalizes that device/context.
            gpuIconAtlasService.releaseDevice(this.deckDevice);
        }
        if (this.deck) {
            this.deck.getCanvas()?.removeEventListener(
                "pointerenter",
                this.deckCanvasPointerEnter
            );
            this.deck.getCanvas()?.removeEventListener(
                "pointermove",
                this.deckCanvasPointerMove
            );
            this.deck.getCanvas()?.removeEventListener(
                "pointerdown",
                this.deckCanvasPointerDown,
                true
            );
            this.deck.getCanvas()?.removeEventListener(
                "contextmenu",
                this.deckCanvasContextMenu
            );
            this.deck.getCanvas()?.removeEventListener(
                "pointerleave",
                this.deckCanvasPointerLeave
            );
            this.deck.getCanvas()?.removeEventListener(
                "webglcontextlost",
                this.deckContextLost
            );
            this.deck.finalize();
            this.deck = null;
        }
        this.gpuVectorLayers = [];
        this.gpuTextLayerHost = null;
        this.deckDevice = null;
        this.navigationTargetOverlay?.destroy();
        this.navigationTargetOverlay = null;
        this.lastCanvasCssSize = undefined;
        this.clippedLayoutCanvasCssSize = undefined;
        this.contextLost.complete();
        const container = document.getElementById(this.canvasId);
        if (container) {
            container.innerHTML = "";
        }
    }

    /** Returns whether the deck renderer is currently initialized. */
    isAvailable(): boolean {
        return this.deck !== null;
    }

    /** Marks a stable shell dirty so Deck coalesces scene changes into its next frame. */
    requestRender(reason?: string): void {
        if (!this.deck) {
            return;
        }
        const shell = this.gpuVectorLayers[0] ?? this.gpuTextLayerHost;
        if (shell) {
            shell.setNeedsRedraw();
            return;
        }
        // Initialization can request a frame before persistent shells exist.
        this.deck.redraw(reason);
    }

    /**
     * Present streamed scene mutations after a short quiet period with a hard latency bound.
     *
     * Packet admission runs independently of rendering. Waiting briefly lets many
     * uploads land before Chrome draws from the shared buffers, while the deadline
     * keeps large or continuous loads visibly progressive.
     */
    private requestGpuSceneRender(reason: string): void {
        const now = performance.now();
        if (this.gpuSceneRedrawBurstStartedAtMs === 0) {
            this.gpuSceneRedrawBurstStartedAtMs = now;
        }
        this.gpuSceneRedrawReason = reason;
        const dueAt = Math.min(
            now + DeckMapView.GPU_SCENE_REDRAW_QUIET_MS,
            this.gpuSceneRedrawBurstStartedAtMs + DeckMapView.GPU_SCENE_REDRAW_MAX_LATENCY_MS
        );
        if (this.gpuSceneRedrawTimer) {
            clearTimeout(this.gpuSceneRedrawTimer);
        }
        this.gpuSceneRedrawTimer = setTimeout(
            () => this.flushGpuSceneRender(),
            Math.max(0, dueAt - now)
        );
    }

    /** Publish one coherent scene generation after pending admissions or their latency deadline. */
    private flushGpuSceneRender(): void {
        this.gpuSceneRedrawTimer = null;
        this.gpuSceneRedrawBurstStartedAtMs = 0;
        const published = this.gpuScene?.publishPresentation() ?? false;
        if (!published) {
            return;
        }
        for (const layer of this.gpuVectorLayers) {
            layer.sceneChanged();
        }
        this.gpuTextLayerHost?.sceneChanged();
        this.gpuMaskController?.sceneChanged();
        this.semanticZIndexService.sceneChanged();
        this.gpuSceneRetiredResourcesPending = true;
        this.requestRender(this.gpuSceneRedrawReason);
    }

    /** Cancels a delayed scene redraw when the view and its GPU resources are retired. */
    private cancelGpuSceneRedraw(): void {
        if (this.gpuSceneRedrawTimer) {
            clearTimeout(this.gpuSceneRedrawTimer);
            this.gpuSceneRedrawTimer = null;
        }
        this.gpuSceneRedrawBurstStartedAtMs = 0;
    }

    /**
     * Keeps the rendered map stationary while the right dock changes the available layout width.
     *
     * A camera correction cannot preserve a pitched scene because different elevations project at
     * different depths. Instead, a shrinking dock clips the existing viewport at the right edge.
     * Closing the dock restores percentage sizing once the original viewport fits again.
     */
    prepareForLayoutResize(targetCssSize: {width: number; height: number}): void {
        if (!this.deck) {
            return;
        }
        const nextSize = this.normalizedCanvasCssSize(targetCssSize.width, targetCssSize.height);
        if (!Number.isFinite(nextSize.width) || !Number.isFinite(nextSize.height)
            || nextSize.width <= 0 || nextSize.height <= 0) {
            return;
        }

        const previousSize = this.clippedLayoutCanvasCssSize ?? this.lastCanvasCssSize;
        const startsRightEdgeClip = !this.clippedLayoutCanvasCssSize
            && previousSize
            && nextSize.width < previousSize.width
            && nextSize.height === previousSize.height;
        const keepsRightEdgeClip = this.clippedLayoutCanvasCssSize
            && nextSize.width < this.clippedLayoutCanvasCssSize.width
            && nextSize.height === this.clippedLayoutCanvasCssSize.height;
        if (startsRightEdgeClip || keepsRightEdgeClip) {
            const clippedSize = this.clippedLayoutCanvasCssSize ?? previousSize!;
            this.clippedLayoutCanvasCssSize = clippedSize;
            this.cancelLayoutResizeRestore();
            this.cancelCanvasResizeScheduling();
            const clippedStyle = this.canvasStyleAtFixedSize(clippedSize);
            this.deck.setProps({
                width: clippedSize.width,
                height: clippedSize.height,
                style: clippedStyle
            });
            Object.assign(this.deck.getCanvas()?.style ?? {}, clippedStyle);
            this.deckDevice?.getDefaultCanvasContext().setDrawingBufferSize(
                clippedSize.width,
                clippedSize.height
            );
            this.requestRender("Clip map for layout resize");
            return;
        }

        this.clippedLayoutCanvasCssSize = undefined;
        this.lastCanvasCssSize = nextSize;
        this.cancelCanvasResizeScheduling();
        const fixedStyle = this.canvasStyleAtFixedSize(nextSize);
        this.deck.setProps({
            width: nextSize.width,
            height: nextSize.height,
            style: fixedStyle
        });
        Object.assign(this.deck.getCanvas()?.style ?? {}, fixedStyle);
        this.deckDevice?.getDefaultCanvasContext().setDrawingBufferSize(
            nextSize.width,
            nextSize.height
        );
        this.cancelLayoutResizeRestore();
        this.layoutResizeRestoreRaf = window.requestAnimationFrame(() => {
            this.layoutResizeRestoreRaf = undefined;
            this.deck?.setProps({
                width: "100%",
                height: "100%",
                style: DeckMapView.CANVAS_STYLE
            });
            this.requestRender("Layout resized");
        });
        this.requestRender("Prepare layout resize");
    }

    /** Returns the absolute canvas style used while a side-dock resize clips the old projection. */
    private canvasStyleAtFixedSize(size: {width: number; height: number}): Partial<CSSStyleDeclaration> {
        return {
            ...DeckMapView.CANVAS_STYLE,
            width: `${size.width}px`,
            height: `${size.height}px`
        };
    }

    /** Returns the current canvas client rect, or an empty rect if the renderer is unavailable. */
    getCanvasClientRect(): DOMRect {
        const canvas = this.deck?.getCanvas();
        if (!canvas) {
            return new DOMRect();
        }
        return canvas.getBoundingClientRect();
    }

    /** Returns the current camera bearing in degrees for the compass widget. */
    getCameraHeadingDegrees(): number {
        return this.firstPersonSession?.viewState.bearing ?? this.viewState.bearing;
    }

    /** Registers a per-frame callback and starts the RAF loop on demand. */
    onTick(cb: () => void): void {
        this.tickCallbacks.add(cb);
        if (this.tickHandle === null) {
            this.tickHandle = requestAnimationFrame(this.tick);
        }
    }

    /** Unregisters a per-frame callback and stops the RAF loop when no callbacks remain. */
    offTick(cb: () => void): void {
        this.tickCallbacks.delete(cb);
        if (this.tickCallbacks.size === 0) {
            this.stopTickLoop();
        }
    }

    /** Returns the scene mode implemented by this concrete deck view. */
    getSceneMode(): SceneMode {
        return this.sceneMode;
    }

    /** Normalizes browser-reported CSS canvas dimensions to the pixel grid deck viewports use. */
    private normalizedCanvasCssSize(cssWidth: number, cssHeight: number): {width: number; height: number} {
        return {
            width: Math.max(1, Math.floor(cssWidth)),
            height: Math.max(1, Math.floor(cssHeight))
        };
    }

    /** Creates the absolute-positioned canvas deck will render into. */
    private createDeckCanvas(container: HTMLDivElement): HTMLCanvasElement {
        const canvas = document.createElement("canvas");
        Object.assign(canvas.style, DeckMapView.CANVAS_STYLE);
        container.appendChild(canvas);
        return canvas;
    }

    /** Requests view recreation instead of attempting to replay invalid GPU resources. */
    private readonly deckContextLost = (event: Event): void => {
        event.preventDefault();
        this.contextLost.next();
    };

    /** Creates the WebGL2 context and reports useful diagnostics when Chromium rejects it. */
    private createWebGl2Context(canvas: HTMLCanvasElement, container: HTMLDivElement): WebGL2RenderingContext {
        let contextCreationStatus = "";
        const onContextCreationError: EventListener = (event) => {
            const statusMessage = "statusMessage" in event ? event.statusMessage : "";
            contextCreationStatus = typeof statusMessage === "string" && statusMessage
                ? statusMessage
                : "Browser did not provide a WebGL creation status.";
        };
        const attributes: WebGLContextAttributes = {
            alpha: true,
            antialias: this.stateService.deckAntialiasingEnabled,
            depth: true,
            stencil: false,
            preserveDrawingBuffer: false,
            powerPreference: "high-performance",
            failIfMajorPerformanceCaveat: false
        };

        canvas.addEventListener("webglcontextcreationerror", onContextCreationError);
        const gl = canvas.getContext("webgl2", attributes);
        canvas.removeEventListener("webglcontextcreationerror", onContextCreationError);
        if (gl) {
            return gl;
        }

        const diagnostics = [
            `WebGL2 context for #${this.canvasId} could not be created.`,
            `container=${container.clientWidth}x${container.clientHeight}`,
            `drawingBuffer=${canvas.width}x${canvas.height}`,
            `webgl2Global=${typeof window !== "undefined" && "WebGL2RenderingContext" in window}`,
            `status=${contextCreationStatus || "none"}`,
            `userAgent=${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}`
        ];
        canvas.remove();
        throw new Error(diagnostics.join(" "));
    }

    /** Keeps the WebGL drawing buffer in sync with the CSS size and configured device-pixel policy. */
    private setCanvasDrawingBufferSize(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): void {
        const width = Math.max(1, Math.round(cssWidth * DeckMapView.CANVAS_USE_DEVICE_PIXELS));
        const height = Math.max(1, Math.round(cssHeight * DeckMapView.CANVAS_USE_DEVICE_PIXELS));
        if (canvas.width === width && canvas.height === height) {
            return;
        }
        canvas.width = width;
        canvas.height = height;
    }

    /** Debounces drawing-buffer resizes so live DOM layout changes do not thrash WebGL state. */
    private scheduleCanvasResize(cssWidth: number, cssHeight: number): void {
        this.cancelCanvasResizeScheduling();
        this.canvasResizeTimer = setTimeout(() => {
            this.canvasResizeTimer = null;
            this.applyCanvasResize(cssWidth, cssHeight);
        }, DeckMapView.CANVAS_RESIZE_DEBOUNCE_MS);
    }

    /** Applies the pending drawing-buffer resize using the deck device when available. */
    private applyCanvasResize(cssWidth: number, cssHeight: number): void {
        const width = Math.max(1, Math.round(cssWidth * DeckMapView.CANVAS_USE_DEVICE_PIXELS));
        const height = Math.max(1, Math.round(cssHeight * DeckMapView.CANVAS_USE_DEVICE_PIXELS));
        const canvasContext = this.deckDevice?.getDefaultCanvasContext();
        if (canvasContext) {
            const [currentWidth, currentHeight] = canvasContext.getDrawingBufferSize();
            if (currentWidth === width && currentHeight === height) {
                return;
            }
            canvasContext.setDrawingBufferSize(width, height);
            this.requestRender("Canvas resized");
            return;
        }
        const canvas = this.deck?.getCanvas();
        if (!canvas) {
            return;
        }
        this.setCanvasDrawingBufferSize(canvas, cssWidth, cssHeight);
        this.requestRender("Canvas resized");
    }

    /** Cancels any pending debounced canvas resize. */
    private cancelCanvasResizeScheduling(): void {
        if (this.canvasResizeTimer !== null) {
            clearTimeout(this.canvasResizeTimer);
            this.canvasResizeTimer = null;
        }
    }

    /** Cancels any queued restoration of deck's percentage-sized canvas. */
    private cancelLayoutResizeRestore(): void {
        if (this.layoutResizeRestoreRaf !== undefined) {
            window.cancelAnimationFrame(this.layoutResizeRestoreRaf);
            this.layoutResizeRestoreRaf = undefined;
        }
    }

    /** Returns the renderer-agnostic scene handle passed to tile visualizations. */
    getSceneHandle(): IRenderSceneHandle {
        return {
            renderer: "deck",
            scene: {
                deck: this.deck,
                layerRegistry: this.layerRegistry,
                interactionOutlineService: this.interactionOutlineService,
                sceneMode: this.sceneMode,
                device: this.deckDevice,
                gpuScene: this.gpuScene,
                gpuVectorLayers: this.gpuVectorLayers,
                gpuTextLayerHost: this.gpuTextLayerHost,
                gpuMaskController: this.gpuMaskController
            }
        };
    }

    /**
     * Resolves the first eligible physical surface beneath a screen position.
     * Multiple-object picking lets non-physical labels remain above the actual anchor;
     * surfaces without application identity intentionally return an empty feature list.
     */
    pickNavigationTarget(screenPos: {x: number; y: number}): RenderNavigationTarget | undefined {
        if (!this.deck) {
            return undefined;
        }
        const layerIds = this.navigationPickLayerIds();
        const picked = pickNavigationAnchor(
            this.deck,
            [screenPos.x, screenPos.y],
            pickingInfo => this.featureIdsFromPickingInfo(pickingInfo),
            (first, second) => first.length > 0 && second.length > 0 &&
                first.some(firstId => second.some(secondId =>
                    firstId.mapTileKey === secondId.mapTileKey
                    && firstId.featureId === secondId.featureId
                )),
            this.stateService.drillPickRadius,
            layerIds.length ? layerIds : undefined
        );
        if (picked) {
            const {position, surfaceNormal, origin, value: featureIds} = picked;
            return surfaceNormal
                ? {position, surfaceNormal, origin, featureIds}
                : {position, origin, featureIds};
        }
        return undefined;
    }

    /** Resolves a finite visible point on the zero-height ground plane as the universal fallback pivot. */
    private groundNavigationTarget(
        screenPos: {x: number; y: number},
        viewport: WebMercatorViewport | null | undefined = this.createWebMercatorViewport()
    ): NavigationVisualTarget | null {
        if (!viewport) {
            return null;
        }
        const ground = viewport.unproject(
            [screenPos.x, screenPos.y],
            {targetZ: 0}
        );
        if (ground.length < 3 || !ground.every(Number.isFinite)) {
            return null;
        }
        const position: NavigationAnchor = [ground[0], ground[1], ground[2]];
        return isNavigationAnchorUsable(viewport, position, true)
            ? {position, origin: "ground"}
            : null;
    }

    /** Resolves one exact eligible physical surface for a controller acquisition. */
    private pickControllerNavigationTarget(
        context: Readonly<MapInteractionTargetContext>,
        screenPosition: [number, number]
    ): NavigationVisualTarget | null {
        const layerIds = this.navigationPickLayerIds();
        if (!this.deck || !layerIds.length) {
            return null;
        }
        const radius = Math.max(0, Math.trunc(this.stateService.drillPickRadius));
        const canvasPosition = [
            context.viewport.x + screenPosition[0],
            context.viewport.y + screenPosition[1]
        ];
        try {
            const picked = this.deck.pickObject({
                x: canvasPosition[0],
                y: canvasPosition[1],
                radius,
                layerIds,
                unproject3D: true
            });
            return picked
                ? navigationTargetFromPickingInfo({
                    ...picked,
                    x: canvasPosition[0],
                    y: canvasPosition[1],
                    viewport: context.viewport
                }, radius, true)
                : null;
        } catch (error) {
            console.error("Navigation controller picking failed.", error);
            return null;
        }
    }

    /**
     * Resolves every eligible rendered feature returned by one bounded point drill-pick.
     * Layer filtering happens before the pick so excluded representations cannot consume depth.
     */
    drillPickFeatures(
        screenPos: {x: number; y: number},
        radius: number,
        maxObjects: number
    ): RenderedFeaturePickResult {
        if (!this.deck) {
            return {featureIds: []};
        }
        const pickedObjects = this.deck.pickMultipleObjects({
            x: screenPos.x,
            y: screenPos.y,
            radius,
            depth: maxObjects,
            layerIds: this.drillPickLayerIds(),
            unproject3D: false
        });
        return {
            featureIds: this.uniqueFeatureIdsFromPickingInfos(
                pickedObjects,
                maxObjects)
        };
    }

    /** Returns the current top-level layer ids explicitly marked as ordinary feature representations. */
    private drillPickLayerIds(): string[] {
        return this.eligiblePickLayerIds("drillPickEligible");
    }

    /** Returns physical feature-representation layers that can supply navigation anchors. */
    private navigationPickLayerIds(): string[] {
        return this.eligiblePickLayerIds("navigationAnchorEligible");
    }

    /** Collects stable top-level layer ids carrying one explicit interaction capability. */
    private eligiblePickLayerIds(
        capability: "drillPickEligible" | "navigationAnchorEligible"
    ): string[] {
        if (!this.deck) {
            return [];
        }
        const result: string[] = [];
        const seen = new Set<string>();
        const visit = (entry: unknown): void => {
            if (Array.isArray(entry)) {
                entry.forEach(visit);
                return;
            }
            if (!entry || typeof entry !== "object") {
                return;
            }
            const layer = entry as {id?: unknown; props?: DeckFeaturePickLayerProps};
            if (layer.props?.[capability] !== true || typeof layer.id !== "string" || seen.has(layer.id)) {
                return;
            }
            seen.add(layer.id);
            result.push(layer.id);
        };
        visit(this.deck.props?.layers);
        return result;
    }

    /** Expands merged objects and deduplicates exact map-tile/feature identities in pick traversal order. */
    private uniqueFeatureIdsFromPickingInfos(
        pickedObjects: PickingInfo[],
        maxFeatures = Number.POSITIVE_INFINITY
    ): TileFeatureId[] {
        const featureIds: TileFeatureId[] = [];
        const seen = new Set<string>();
        for (const picked of pickedObjects) {
            for (const featureId of this.featureIdsFromPickingInfo(picked)) {
                const identity = `${featureId.mapTileKey}\u0000${featureId.featureId}`;
                if (seen.has(identity)) {
                    continue;
                }
                seen.add(identity);
                featureIds.push(featureId);
                if (featureIds.length >= maxFeatures) {
                    return featureIds;
                }
            }
        }
        return featureIds;
    }

    /** Resolves feature ids from metadata already returned by a deck picking operation. */
    private featureIdsFromPickingInfo(picked: PickingInfo): TileFeatureId[] {
        const globalPickIndex = Number(
            (picked.object as {globalPickIndex?: unknown} | undefined)
                ?.globalPickIndex ?? picked.index
        );
        if ((picked.layer instanceof ErdblickVectorLayer ||
             picked.sourceLayer instanceof ErdblickVectorLayer ||
             picked.layer instanceof GpuTextLayerHost ||
             picked.sourceLayer instanceof GpuTextLayerHost) &&
            this.gpuScene && Number.isInteger(globalPickIndex) &&
            globalPickIndex >= 0) {
            return this.gpuScene.resolvePick(globalPickIndex);
        }
        const readFeatureAddress = (buffer: ArrayLike<number | null> | undefined, index: number): number | null => {
            if (!buffer || index < 0 || index >= buffer.length) {
                return null;
            }
            const value = buffer[index];
            if (!Number.isInteger(value) || value === DeckMapView.UNSELECTABLE_FEATURE_INDEX) {
                return null;
            }
            return value;
        };

        const layerProps = picked.layer?.props as DeckFeaturePickLayerProps | undefined;
        const pickedObject = picked.object;
        const objectFeatureAddresses = pickedObject?.featureAddresses ?? pickedObject?.featureAddress;
        const objectFeatureAddressesAreBinaryBuffer = typeof objectFeatureAddresses === "object"
            && objectFeatureAddresses !== null
            && ArrayBuffer.isView(objectFeatureAddresses as ArrayBufferView);
        if (objectFeatureAddresses !== undefined && objectFeatureAddresses !== null && !objectFeatureAddressesAreBinaryBuffer) {
            if (Array.isArray(objectFeatureAddresses)) {
                return objectFeatureAddresses
                    .map(value => Number.isInteger(value)
                        ? layerProps?.subsetPickResolver?.(Number(value)) ?? []
                        : [])
                    .flat();
            }
            if (Number.isInteger(objectFeatureAddresses)) {
                const subsetResult = layerProps?.subsetPickResolver?.(
                    objectFeatureAddresses as number
                );
                if (subsetResult?.length) {
                    return subsetResult;
                }
            }
            return [];
        }

        const pickedIndex = Number(picked.index);
        if (Number.isInteger(pickedIndex) && pickedIndex >= 0) {
            const featureAddress = readFeatureAddress(layerProps?.featureAddresses, pickedIndex);
            if (featureAddress !== null) {
                const subsetResult = layerProps?.subsetPickResolver?.(featureAddress);
                if (subsetResult?.length) {
                    return subsetResult;
                }
                return [];
            }
            const featureAddressByPath = readFeatureAddress(layerProps?.featureAddressesByPath, pickedIndex);
            if (featureAddressByPath !== null) {
                const subsetResult = layerProps?.subsetPickResolver?.(featureAddressByPath);
                if (subsetResult?.length) {
                    return subsetResult;
                }
                return [];
            }
        }
        return [];
    }

    /** Unprojects a map-view screen position onto the ground plane. */
    pickCartographic(screenPos: {x: number; y: number}): { lon: number; lat: number; alt: number } | undefined {
        if (this.firstPersonSession) {
            const target = this.pickNavigationTarget(screenPos);
            return target
                ? {lon: target.position[0], lat: target.position[1], alt: target.position[2]}
                : undefined;
        }
        const viewport = this.createWebMercatorViewport();
        if (!viewport) {
            return undefined;
        }
        const [lon, lat] = viewport.unproject([screenPos.x, screenPos.y]);
        return {lon, lat, alt: 0};
    }

    /** Maps persisted app-state camera data into the controlled deck view state. */
    setViewFromState(cameraData: CameraViewState): void {
        this.applyCameraViewState(cameraData, true);
    }

    /** Applies persisted or renderer-local camera data with explicit coverage ownership. */
    private applyCameraViewState(cameraData: CameraViewState, updateViewport: boolean): void {
        if (this.firstPersonSession) {
            this.exitFirstPersonView();
        }
        const maxPitch = this.allowPitchAndBearing ? Math.max(0, this.viewState.maxPitch) : 0;
        const next: DeckCameraState = {
            longitude: cameraData.destination.lon,
            latitude: cameraData.destination.lat,
            zoom: this.altitudeToZoom(cameraData.destination.alt, cameraData.destination.lat),
            pitch: this.allowPitchAndBearing
                ? Math.max(0, Math.min(maxPitch, GeoMath.toDegrees(cameraData.orientation.pitch) + 90))
                : 0,
            bearing: this.allowPitchAndBearing
                ? this.normalizeDegrees(GeoMath.toDegrees(cameraData.orientation.heading))
                : 0,
            maxPitch,
            position: this.useOrthographicProjection
                ? [0, 0, 0]
                : [...(cameraData.position ?? [0, 0, 0])]
        };
        const groundCentered = this.groundCenteredViewState(next);
        this.updateViewState(groundCentered, true, updateViewport);
        if (!this.deck && groundCentered !== next) {
            this.pushViewStateToAppState();
        }
    }

    /** Returns the persisted camera state for this view. */
    getViewState(): CameraViewState {
        return this.stateService.cameraViewDataState.getValue(this._viewIndex);
    }

    /** Builds the native tile-selection rectangle from deck's horizon-clipped ground footprint. */
    computeViewport(): Viewport | undefined {
        if (this.firstPersonSession) {
            return this.firstPersonSession.coverageViewport;
        }
        const viewport = this.createWebMercatorViewport();
        if (!viewport) {
            return undefined;
        }
        const bounds = clippedGeographicBounds(viewport, this.viewState.longitude, 0.05);
        const nextViewport: Viewport = {
            ...bounds,
            camPosLon: this.viewState.longitude,
            camPosLat: this.viewState.latitude,
            // Keep tile-priority orientation consistent with the legacy viewport contract.
            orientation: -GeoMath.toRadians(this.viewState.bearing) + Math.PI * 0.5
        };
        const valid = Object.values(nextViewport).every(Number.isFinite);
        return valid ? nextViewport : undefined;
    }

    /** Starts a fixed-location, non-persisted first-person inspection at an exact feature point. */
    enterFirstPersonView(target: RenderNavigationTarget): void {
        if (!this.allowPitchAndBearing) {
            return;
        }
        const localTarget: NavigationAnchor = [
            this.normalizeLongitude(target.position[0]),
            target.position[1],
            target.position[2]
        ];
        const viewState = createFixedFirstPersonCameraState(localTarget, this.viewState.bearing);
        this.firstPersonSession = {
            viewState,
            coverageViewport: createFirstPersonCoverageViewport(localTarget, viewState.bearing)
        };
        this.firstPersonViewActive.next(true);
        this.clearHoverPickingState();
        this.applyActiveDeckView();
        this.cancelViewportUpdateScheduling();
        this.updateViewport();
        this.scheduleTileGridOverlayUpdate();
        this.scheduleSearchResultsOverlayUpdate();
        this.requestRender("Enter first-person view");
    }

    /** Restores the unchanged persisted MapView camera after ephemeral first-person inspection. */
    exitFirstPersonView(): void {
        if (!this.firstPersonSession) {
            return;
        }
        this.firstPersonSession = null;
        this.firstPersonViewActive.next(false);
        this.clearHoverPickingState();
        this.applyActiveDeckView();
        this.cancelViewportUpdateScheduling();
        this.updateViewport();
        this.updateBackgroundLayer();
        this.scheduleTileGridOverlayUpdate();
        this.scheduleSearchResultsOverlayUpdate();
        this.requestRender("Exit first-person view");
    }

    /** Returns whether this renderer is currently using its ephemeral first-person camera. */
    isFirstPersonViewActive(): boolean {
        return this.firstPersonViewActive.getValue();
    }

    /** Pans toward the top of the current view. */
    moveUp(): void {
        if (this.firstPersonSession) {
            return;
        }
        this.applyPan(0, 1);
    }

    /** Pans toward the bottom of the current view. */
    moveDown(): void {
        if (this.firstPersonSession) {
            return;
        }
        this.applyPan(0, -1);
    }

    /** Pans toward the left side of the current view. */
    moveLeft(): void {
        if (this.firstPersonSession) {
            return;
        }
        this.applyPan(-1, 0);
    }

    /** Pans toward the right side of the current view. */
    moveRight(): void {
        if (this.firstPersonSession) {
            return;
        }
        this.applyPan(1, 0);
    }

    /** Zooms in by the user-configured zoom step and persists the result to app state. */
    zoomIn(): void {
        if (this.firstPersonSession) {
            return;
        }
        this.stateService.focusedView = this._viewIndex;
        this.applyAnchoredMapViewState({
            ...this.viewState,
            zoom: this.viewState.zoom + this.stateService.mapZoomStep
        });
    }

    /** Zooms out by the user-configured zoom step and persists the result to app state. */
    zoomOut(): void {
        if (this.firstPersonSession) {
            return;
        }
        this.stateService.focusedView = this._viewIndex;
        this.applyAnchoredMapViewState({
            ...this.viewState,
            zoom: this.viewState.zoom - this.stateService.mapZoomStep
        });
    }

    /** Resets pitch and bearing while preserving the current center and zoom. */
    resetOrientation(): void {
        this.stateService.focusedView = this._viewIndex;
        if (this.firstPersonSession) {
            this.updateFirstPersonViewState({
                ...this.firstPersonSession.viewState,
                pitch: 0,
                bearing: 0
            });
            return;
        }
        this.applyAnchoredMapViewState({
            ...this.viewState,
            pitch: 0,
            bearing: 0
        });
    }

    /** Pushes the currently visible viewport rectangle back into `MapViewStateService`. */
    protected updateViewport(): void {
        const viewport = this.computeViewport();
        if (!viewport) {
            return;
        }
        this.mapViewState.setViewport(
            this._viewIndex,
            viewport,
            this.zoomToAltitude(this.viewState.zoom, 0),
            this.metersPerPixelAtZoom(
                this.viewState.zoom,
                this.viewState.latitude
            )
        );
    }

    /** Coalesces camera-driven native tile-footprint updates to one operation per frame. */
    private scheduleViewportUpdate(): void {
        if (this.viewportUpdateRaf !== null) {
            return;
        }
        this.viewportUpdateRaf = window.requestAnimationFrame(() => {
            this.viewportUpdateRaf = null;
            this.updateViewport();
        });
    }

    /** Cancels a pending camera-driven tile-footprint update. */
    private cancelViewportUpdateScheduling(): void {
        if (this.viewportUpdateRaf === null) {
            return;
        }
        window.cancelAnimationFrame(this.viewportUpdateRaf);
        this.viewportUpdateRaf = null;
    }

    /**
     * Installs every subscription that keeps the renderer synchronized with app state, search, and tile data.
     * Most subscriptions only schedule overlay work so rapid bursts collapse into one frame.
     */
    private setupSubscriptions(): void {
        this.subscriptions.push(
            this.stateService.cameraViewDataState
                .pipe(this._viewIndex, distinctUntilChanged())
                .subscribe(cameraViewData => {
                    if (this.ignoreNextCamAppStateUpdate) {
                        this.ignoreNextCamAppStateUpdate = false;
                        return;
                    }
                    this.setViewFromState(cameraViewData);
                })
        );

        this.subscriptions.push(
            this.mapViewState.liveCameraViewStateTopic.subscribe(update => {
                if (update.targetView !== this._viewIndex) {
                    return;
                }
                // Live split-view motion stays in Deck. The settled AppState update
                // owns tile coverage, persistence, URL state, and Angular UI work.
                this.applyCameraViewState(update.cameraViewData, false);
            })
        );

        this.subscriptions.push(
            this.stateService.backgroundState.pipe(this._viewIndex).subscribe(() => {
                this.updateBackgroundLayer();
            })
        );

        this.subscriptions.push(
            this.stateService.mode2dState.pipe(this._viewIndex).subscribe(() => {
                this.updateBackgroundLayer();
            })
        );

        this.subscriptions.push(
            this.configService.config$.subscribe(() => {
                this.updateBackgroundLayer();
            })
        );

        this.subscriptions.push(
            this.stateService.mapZoomStepState.pipe(distinctUntilChanged()).subscribe(() => {
                if (!this.deck || this.firstPersonSession) {
                    return;
                }
                this.deck.setProps({
                    views: this.createMapDeckView(this.createDeckControllerOptions()),
                    controller: false
                });
            })
        );

        this.subscriptions.push(
            combineLatest([
                this.stateService.markerState,
                this.stateService.markedPositionState
            ]).subscribe(() => {
                this.updateLocationMarkerOverlay();
            })
        );

        this.subscriptions.push(
            this.stateService.viewTileBordersState
                .pipe(this._viewIndex, distinctUntilChanged())
                .subscribe(enabled => {
                    this.tileGridEnabled = enabled;
                    this.scheduleTileGridOverlayUpdate();
                })
        );
        this.subscriptions.push(
            this.stateService.viewTileGridModeState
                .pipe(this._viewIndex, distinctUntilChanged())
                .subscribe(mode => {
                    this.tileGridMode = mode;
                    this.tileGridLevel = this.mapInfo.maps.getViewTileGridLevel(this._viewIndex);
                    this.scheduleTileGridOverlayUpdate();
                })
        );
        this.subscriptions.push(
            this.stateService.viewTileGridLevelState
                .pipe(this._viewIndex, distinctUntilChanged())
                .subscribe(_ => {
                    this.tileGridLevel = this.mapInfo.maps.getViewTileGridLevel(this._viewIndex);
                    this.scheduleTileGridOverlayUpdate();
                })
        );
        this.subscriptions.push(
            this.stateService.viewTileGridAutoLevelState
                .pipe(this._viewIndex, distinctUntilChanged())
                .subscribe(autoLevel => {
                    this.tileGridAutoLevel = autoLevel;
                    this.scheduleTileGridOverlayUpdate();
                })
        );
        this.subscriptions.push(
            combineLatest([
                this.stateService.viewTileGridColorState.pipe(this._viewIndex, distinctUntilChanged()),
                this.stateService.viewTileGridOpacityState.pipe(this._viewIndex, distinctUntilChanged())
            ]).subscribe(([color, opacity]) => {
                this.tileGridLineColor = tileGridRgba(color, opacity);
                this.scheduleTileGridOverlayUpdate();
            })
        );
        this.subscriptions.push(
            this.stateService.layerVisibilityState
                .pipe(this._viewIndex)
                .subscribe(() => this.scheduleTileGridOverlayUpdate())
        );
        this.subscriptions.push(
            this.stateService.layerZoomLevelState
                .pipe(this._viewIndex)
                .subscribe(() => this.scheduleTileGridOverlayUpdate())
        );
        this.subscriptions.push(
            this.mapInfo.maps$.subscribe(() => this.scheduleTileGridOverlayUpdate())
        );
        this.subscriptions.push(
            this.layerController.occupancyChanged.subscribe(() =>
                this.scheduleTileGridOverlayDataRefresh()
            )
        );
        this.subscriptions.push(
            this.featureSearchService.progress.subscribe(() => this.scheduleSearchResultsOverlayDataRefresh())
        );

        this.subscriptions.push(
            this.mapViewState.moveToWgs84PositionTopic.subscribe(value => {
                if (value.targetView !== this._viewIndex) {
                    return;
                }
                const alt = value.z ?? this.zoomToAltitude(this.viewState.zoom, value.y);
                this.stateService.setView(
                    this._viewIndex,
                    Cartographic.fromDegrees(value.x, value.y, alt),
                    this.stateService.getCameraOrientation(this._viewIndex)
                );
            })
        );

        this.subscriptions.push(
            this.mapViewState.showLocationLabelTopic.subscribe(value => {
                if (value.targetView !== this._viewIndex) {
                    return;
                }
                this.startLocationLabel(value);
            })
        );

        this.subscriptions.push(
            this.mapViewState.moveToRectangleTopic.subscribe(value => {
                if (value.targetView !== this._viewIndex) {
                    return;
                }
                this.exitFirstPersonView();
                const centerLon = (value.rectangle.west + value.rectangle.east) / 2;
                const centerLat = (value.rectangle.south + value.rectangle.north) / 2;
                const maxSpan = Math.max(
                    Math.abs(value.rectangle.east - value.rectangle.west),
                    Math.abs(value.rectangle.north - value.rectangle.south)
                );
                const zoom = Math.max(0, Math.min(22, 8 - Math.log2(Math.max(1e-6, maxSpan))));
                this.updateViewState({
                    ...this.viewState,
                    longitude: centerLon,
                    latitude: centerLat,
                    zoom
                }, true, true);
                this.startJumpAreaHighlight(value.rectangle);
            })
        );

        this.subscriptions.push(
            this.menuService.tileOutline.subscribe(payload => {
                this.updateTileOutlineLayer(payload);
            })
        );

        this.tileGridEnabled = this.stateService.viewTileBordersState.getValue(this._viewIndex);
        this.tileGridMode = this.stateService.viewTileGridModeState.getValue(this._viewIndex);
        this.tileGridLevel = this.mapInfo.maps.getViewTileGridLevel(this._viewIndex);
        this.tileGridAutoLevel = this.mapInfo.maps.getViewTileGridAutoLevel(this._viewIndex);
        this.tileGridLineColor = tileGridRgba(
            this.mapInfo.maps.getViewTileGridColor(this._viewIndex),
            this.mapInfo.maps.getViewTileGridOpacity(this._viewIndex));
        this.updateLocationMarkerOverlay();
        this.scheduleTileGridOverlayUpdate();
        this.scheduleSearchResultsOverlayUpdate();
    }

    /** Dispatches controlled camera updates to the active map or first-person state model. */
    private onDeckViewStateChange(
        rawViewState: DeckCameraState | DeckFirstPersonCameraState,
        interactionState?: InteractionState
    ): void {
        if (this.suppressDeckViewStateEvent) {
            return;
        }
        if (this.firstPersonSession) {
            this.noteCameraInteraction(interactionState);
            this.updateFirstPersonViewState(rawViewState as DeckFirstPersonCameraState);
            return;
        }
        if (this.stateService.focusedView !== this._viewIndex) {
            this.stateService.focusedView = this._viewIndex;
        }
        this.noteCameraInteraction(interactionState);
        // Deck is wired in controlled mode (`viewState` prop). User interactions only
        // take effect if we feed the updated camera state back via `setProps`.
        this.updateViewState(rawViewState as DeckCameraState, true, true);
        this.scheduleViewStatePush();
    }

    /** Tracks whether the camera is actively moving so hover picking can be suspended. */
    private onInteractionStateChange(interactionState: InteractionState): void {
        const wasCameraInteracting = this.isCameraInteracting;
        this.noteCameraInteraction(interactionState);
        this.targetNavigationAdapter.handleInteractionState(interactionState);
        if (wasCameraInteracting && !this.isCameraInteracting) {
            this.flushPendingViewStatePush();
            this.scheduleViewportUpdate();
            this.scheduleTileGridOverlayUpdate();
            this.scheduleSearchResultsOverlayUpdate();
        }
    }

    /** Displays only the live hover or actively locked feature pivot. */
    private updateNavigationPivotOverlay(): void {
        const position = this.activeNavigationPivot
            ?? this.hoverNavigationPivot;
        const surfaceNormal = this.activeNavigationPivot
            ? this.activeNavigationSurfaceNormal
            : this.hoverNavigationSurfaceNormal;
        const origin = this.activeNavigationPivot
            ? this.activeNavigationOrigin
            : this.hoverNavigationOrigin;
        if (!this.allowPitchAndBearing || this.firstPersonSession || !position) {
            this.navigationTargetOverlay?.clear();
            return;
        }
        const viewport = this.createWebMercatorViewport();
        if (!viewport) {
            this.navigationTargetOverlay?.clear();
            return;
        }
        this.navigationTargetOverlay?.update(
            {
                position,
                ...(surfaceNormal ? {surfaceNormal} : {}),
                origin: origin ?? "unknown"
            },
            viewport,
            this.activeNavigationPivot ? "active" : "hover"
        );
    }

    /** Clears all transient navigation-pivot phases and removes their shared overlay. */
    private clearNavigationPivots(): void {
        this.targetNavigationAdapter.reset(false);
        this.hoverNavigationPivot = null;
        this.hoverNavigationSurfaceNormal = null;
        this.hoverNavigationOrigin = null;
        this.activeNavigationPivot = null;
        this.activeNavigationSurfaceNormal = null;
        this.activeNavigationOrigin = null;
        this.retainedNavigationPivot = null;
        this.retainedNavigationSurfaceNormal = null;
        this.retainedNavigationOrigin = null;
        this.updateNavigationPivotOverlay();
    }

    /** Replaces the current hover candidate and refreshes the shared pivot overlay. */
    private setHoverNavigationPivot(target: NavigationVisualTarget | null): void {
        this.hoverNavigationPivot = target?.position ?? null;
        this.hoverNavigationSurfaceNormal = target?.surfaceNormal ?? null;
        this.hoverNavigationOrigin = target?.origin ?? null;
        this.updateNavigationPivotOverlay();
    }

    /** Resolves one fresh physical or forward-ground target at controller acquisition time. */
    private resolveControllerNavigationTarget(
        context: Readonly<MapInteractionTargetContext>
    ): NavigationVisualTarget | null {
        const screenPosition: [number, number] = context.screenPosition
            ? [...context.screenPosition]
            : [context.viewport.width / 2, context.viewport.height / 2];
        return this.pickControllerNavigationTarget(context, screenPosition)
            ?? this.groundNavigationTarget(
                {x: screenPosition[0], y: screenPosition[1]},
                context.viewport
            );
    }

    /** Tracks the frozen gesture pivot and retains successful targets for pointerless commands. */
    private onControllerNavigationTargetChange(
        target: NavigationVisualTarget,
        active: boolean
    ): void {
        const pivot = target.position;
        const surfaceNormal = target.surfaceNormal ?? null;
        const origin = target.origin ?? "unknown";
        this.activeNavigationPivot = active ? [...pivot] : null;
        this.activeNavigationSurfaceNormal = active ? surfaceNormal : null;
        this.activeNavigationOrigin = active ? origin : null;
        this.retainedNavigationPivot = [...pivot];
        this.retainedNavigationSurfaceNormal = surfaceNormal;
        this.retainedNavigationOrigin = origin;
        this.hoverNavigationPivot = active ? null : [...pivot];
        this.hoverNavigationSurfaceNormal = active ? null : surfaceNormal;
        this.hoverNavigationOrigin = active ? null : origin;
        this.updateNavigationPivotOverlay();
    }

    /** Suspends hover readbacks during camera motion and resumes at the latest cursor position. */
    private noteCameraInteraction(interactionState: InteractionState | undefined): void {
        if (!interactionState) {
            return;
        }
        const cameraInteracting = Boolean(
            interactionState.isDragging
            || interactionState.isPanning
            || interactionState.isRotating
            || interactionState.isZooming
            || interactionState.inTransition
            || interactionState.interactionTargetPosition
        );
        if (cameraInteracting !== this.isCameraInteracting) {
            this.isCameraInteracting = cameraInteracting;
            this.layerController.setCameraInteracting(cameraInteracting);
            this.hoverPickGeneration += 1;
            this.cancelHoverPickScheduling();
            if (cameraInteracting) {
                this.pendingHoverAnchorPosition = null;
                this.pendingHoverDetailPosition = null;
                if (this.hoverNavigationPivot) {
                    this.setHoverNavigationPivot(null);
                }
            } else if (this.latestHoverPosition) {
                this.queueHoverPicks(this.latestHoverPosition);
            }
        }
    }

    /** Cancels any pending deferred hover-pick work. */
    private cancelHoverPickScheduling(): void {
        if (this.hoverAnchorPickTimer) {
            clearTimeout(this.hoverAnchorPickTimer);
            this.hoverAnchorPickTimer = null;
        }
        if (this.hoverDetailPickTimer) {
            clearTimeout(this.hoverDetailPickTimer);
            this.hoverDetailPickTimer = null;
        }
    }

    /** Clears hover work and highlights that belong to the previously installed deck view. */
    private clearHoverPickingState(): void {
        this.hoverPickGeneration += 1;
        this.pendingHoverAnchorPosition = null;
        this.pendingHoverDetailPosition = null;
        this.latestHoverPosition = null;
        this.topHoverFeatureIds = [];
        this.topHoverFeatureGeneration = -1;
        this.cancelHoverPickScheduling();
        this.setFeatureHoverState(false);
        this.setHoverNavigationPivot(null);
        this.hoveredFeatureIds.next([]);
        this.inspectionSelection.setHoveredFeatures([]);
    }

    /** Records pointer coordinates immediately and queues only the newest hover sample. */
    private onCanvasPointerMove(event: PointerEvent): void {
        const position = {x: event.offsetX, y: event.offsetY};
        if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
            return;
        }
        this.latestHoverPosition = position;
        if (!environment.visualizationOnly) {
            // First-person surface coordinates require a geometry pick. That navigation mode is
            // intentionally left to its controller instead of adding a second hover readback.
            const cartographic = this.firstPersonSession
                ? undefined
                : this.pickCartographic(position);
            if (cartographic) {
                this.coordinatesService.mouseMoveCoordinates.next(
                    Cartographic.fromDegrees(cartographic.lon, cartographic.lat, cartographic.alt)
                );
            }
        }
        if (event.buttons !== 0 || this.isCameraInteracting) {
            this.pendingHoverAnchorPosition = null;
            this.pendingHoverDetailPosition = null;
            this.cancelHoverPickScheduling();
            return;
        }
        this.queueHoverPicks(position);
    }

    /** Queues a quick anchor sample and resets the deep hover query's pointer-idle deadline. */
    private queueHoverPicks(position: {x: number; y: number}): void {
        this.pendingHoverAnchorPosition = position;
        this.pendingHoverDetailPosition = position;
        this.hoverDetailPickDueAtMs = performance.now()
            + DeckMapView.HOVER_DETAIL_PICK_IDLE_MS;
        if (this.hoverDetailPickTimer) {
            clearTimeout(this.hoverDetailPickTimer);
            this.hoverDetailPickTimer = null;
        }
        this.scheduleHoverAnchorPick();
        this.scheduleHoverDetailPick();
    }

    /** Schedules the latest top-object sample at a bounded interactive rate. */
    private scheduleHoverAnchorPick(): void {
        if (this.hoverPickInFlight || this.hoverAnchorPickTimer ||
            !this.pendingHoverAnchorPosition) {
            return;
        }
        const now = performance.now();
        const nextEligibleAt = this.lastHoverAnchorPickAtMs
            + DeckMapView.HOVER_ANCHOR_PICK_THROTTLE_MS;
        const delayMs = Math.max(0, nextEligibleAt - now);
        this.hoverAnchorPickTimer = setTimeout(() => {
            this.hoverAnchorPickTimer = null;
            if (!this.deckCanvasPointerInside) {
                this.pendingHoverAnchorPosition = null;
                return;
            }
            if (this.isCameraInteracting || this.hoverPickInFlight) {
                return;
            }
            const pendingPosition = this.pendingHoverAnchorPosition;
            this.pendingHoverAnchorPosition = null;
            if (!pendingPosition) {
                return;
            }
            this.lastHoverAnchorPickAtMs = performance.now();
            void this.processHoverAnchorPick(pendingPosition);
        }, delayMs);
    }

    /** Resolves one top object without paying for a depth readback on every pointer move. */
    private async processHoverAnchorPick(position: {x: number; y: number}): Promise<void> {
        const deck = this.deck;
        if (!deck || !this.deckCanvasPointerInside) {
            return;
        }
        if (this.hoverPickInFlight) {
            this.pendingHoverAnchorPosition = position;
            return;
        }
        const generation = this.hoverPickGeneration;
        const radius = Math.max(0, Math.trunc(this.stateService.drillPickRadius));
        const navigationLayerIds = this.navigationPickLayerIds();
        this.hoverPickInFlight = true;
        try {
            const topPick = navigationLayerIds.length
                ? await deck.pickObjectAsync({
                    x: position.x,
                    y: position.y,
                    radius,
                    layerIds: navigationLayerIds,
                    unproject3D: false
                })
                : null;
            if (deck !== this.deck || generation !== this.hoverPickGeneration ||
                !this.deckCanvasPointerInside || this.isCameraInteracting ||
                !this.isHoverSampleLocal(position, radius)) {
                return;
            }
            const topFeatureIds = topPick
                ? this.featureIdsFromPickingInfo(topPick)
                : [];
            this.topHoverFeatureIds = topFeatureIds;
            this.topHoverFeatureGeneration = generation;
            // Do not make the visible highlight wait for the more expensive drill pass.
            // The settled query below replaces this with the complete feature stack.
            this.publishHoveredFeatures(topFeatureIds);
            if (!this.allowPitchAndBearing) {
                return;
            }
            this.setHoverNavigationPivot(
                (topPick
                    ? navigationTargetFromPickingInfo({
                        ...topPick,
                        x: position.x,
                        y: position.y
                    }, radius)
                    : null) ?? this.groundNavigationTarget(position)
            );
        } catch (error) {
            if (deck === this.deck && generation === this.hoverPickGeneration) {
                console.error("Hover anchor picking failed.", error);
            }
        } finally {
            this.hoverPickInFlight = false;
            this.continueHoverPickQueue();
        }
    }

    /** Schedules the deep feature stack only after the pointer has settled briefly. */
    private scheduleHoverDetailPick(): void {
        if (this.hoverPickInFlight || this.hoverDetailPickTimer ||
            !this.pendingHoverDetailPosition) {
            return;
        }
        this.hoverDetailPickTimer = setTimeout(() => {
            this.hoverDetailPickTimer = null;
            if (!this.deckCanvasPointerInside) {
                this.pendingHoverDetailPosition = null;
                return;
            }
            if (this.isCameraInteracting || this.hoverPickInFlight) {
                return;
            }
            const pendingPosition = this.pendingHoverDetailPosition;
            this.pendingHoverDetailPosition = null;
            if (pendingPosition) {
                void this.processHoverDetailPick(pendingPosition);
            }
        }, Math.max(0, this.hoverDetailPickDueAtMs - performance.now()));
    }

    /** Resolves the bounded feature stack that drives hover highlights and the HUD label. */
    private async processHoverDetailPick(position: {x: number; y: number}): Promise<void> {
        const deck = this.deck;
        if (!deck || !this.deckCanvasPointerInside) {
            return;
        }
        if (this.hoverPickInFlight) {
            this.pendingHoverDetailPosition = position;
            return;
        }
        const generation = this.hoverPickGeneration;
        const radius = Math.max(0, Math.trunc(this.stateService.drillPickRadius));
        const canvas = deck.getCanvas();
        const left = Math.max(0, position.x - radius);
        const top = Math.max(0, position.y - radius);
        const right = Math.min(canvas?.clientWidth ?? position.x + radius + 1,
            position.x + radius + 1);
        const bottom = Math.min(canvas?.clientHeight ?? position.y + radius + 1,
            position.y + radius + 1);
        const drillLayerIds = this.drillPickLayerIds();
        this.hoverPickInFlight = true;
        try {
            const picked = drillLayerIds.length && right > left && bottom > top
                ? await deck.pickObjectsAsync({
                    x: left,
                    y: top,
                    width: right - left,
                    height: bottom - top,
                    layerIds: drillLayerIds,
                    maxObjects: DeckMapView.HOVER_PICK_MAX_OBJECTS
                })
                : [];
            if (deck !== this.deck || generation !== this.hoverPickGeneration ||
                !this.deckCanvasPointerInside || this.isCameraInteracting ||
                !this.isHoverSampleLocal(position, radius)) {
                return;
            }
            const featureIds = this.uniqueFeatureIdsFromPickingInfos(
                picked,
                DeckMapView.HOVER_PICK_MAX_OBJECTS
            );
            const topFeatureIds = generation === this.topHoverFeatureGeneration
                ? this.topHoverFeatureIds
                : [];
            if (this.allowPitchAndBearing && featureIds.length) {
                for (const item of picked) {
                    const target = navigationTargetFromPickingInfo(
                        {...item, x: position.x, y: position.y},
                        radius
                    );
                    if (target) {
                        this.setHoverNavigationPivot(target);
                        break;
                    }
                }
            }
            this.publishHoveredFeatures(featureIds.length ? featureIds : topFeatureIds);
        } catch (error) {
            if (deck === this.deck && generation === this.hoverPickGeneration) {
                console.error("Hover detail picking failed.", error);
            }
        } finally {
            this.hoverPickInFlight = false;
            this.continueHoverPickQueue();
        }
    }

    /** Gives a pending anchor sample priority before resuming a settled deep query. */
    private continueHoverPickQueue(): void {
        if (this.pendingHoverAnchorPosition) {
            this.scheduleHoverAnchorPick();
        } else if (this.pendingHoverDetailPosition) {
            this.scheduleHoverDetailPick();
        }
    }

    /** Accepts an asynchronous readback while the cursor remains inside its sampled radius. */
    private isHoverSampleLocal(
        position: {x: number; y: number},
        radius: number
    ): boolean {
        const latest = this.latestHoverPosition;
        return !!latest && Math.hypot(
            latest.x - position.x,
            latest.y - position.y
        ) <= Math.max(1, radius);
    }

    /** Updates hover consumers only when the logical feature stack actually changed. */
    private publishHoveredFeatures(featureIds: TileFeatureId[]): void {
        const current = this.hoveredFeatureIds.getValue();
        const unchanged = featureSetsEqual(current, featureIds);
        this.setFeatureHoverState(featureIds.length > 0);
        if (unchanged) {
            return;
        }
        this.inspectionSelection.setHoveredFeatures(featureIds);
        this.hoveredFeatureIds.next(featureIds);
    }

    /** Tracks whether the cursor should show as a pointer over selectable geometry. */
    private setFeatureHoverState(isHoveringFeature: boolean): void {
        if (this.isHoveringFeature === isHoveringFeature) {
            return;
        }
        this.isHoveringFeature = isHoveringFeature;
        if (this.deck) {
            this.deck.setProps({getCursor: this.deckCursor});
        }
    }

    /** Handles primary-click drill inspection, marker placement, and background deselection. */
    private onClick(info: PickingInfo, event: DeckGestureEventLike): void {
        if (environment.visualizationOnly) {
            return;
        }
        const srcEvent = event?.srcEvent;
        if (srcEvent && Number.isInteger(srcEvent.button) && srcEvent.button !== 0) {
            return;
        }
        this.stateService.focusedView = this._viewIndex;
        if (!info || !Number.isFinite(info.x) || !Number.isFinite(info.y)) {
            this.stateService.unsetUnlockedSelections();
            this.menuService.tileOutline.next(null);
            return;
        }

        const screenPosition = {x: info.x, y: info.y};
        const useDesktopDrillPick = this.desktopDrillPickingEnabled
            && (!srcEvent?.pointerType || srcEvent.pointerType === "mouse");
        let pickedFeatureIds = useDesktopDrillPick
            ? this.drillPickFeatures(
                screenPosition,
                this.stateService.drillPickRadius,
                this.stateService.inspectionsLimit
            ).featureIds
            : this.featureIdsFromPickingInfo(info);
        // Deck's speculative pointer-down picker is intentionally disabled. Touch taps therefore
        // perform their bounded pick here, after the recognizer has ruled out a drag.
        if (!pickedFeatureIds.length && !useDesktopDrillPick) {
            pickedFeatureIds = this.drillPickFeatures(
                screenPosition,
                this.stateService.drillPickRadius,
                1
            ).featureIds;
        }
        // Primary click means "the top rendered feature". Multi-selection is
        // deliberately explicit through Ctrl-click or the context menu's
        // Select all action, so dense geometry cannot unexpectedly open a
        // large inspection set.
        const featureIds = pickedFeatureIds.slice(0, 1);
        const featurePosition = featureIds.length
            ? this.markerPositionForFeature(
                info,
                screenPosition,
                featureIds[0],
                this.stateService.drillPickRadius,
                this.stateService.inspectionsLimit
            )
            : null;
        const markerPosition = this.stateService.marker ? featurePosition : null;
        const cartographic = markerPosition
            ? {lon: markerPosition[0], lat: markerPosition[1], alt: markerPosition[2]}
            : this.pickCartographic(screenPosition);
        if (cartographic) {
            this.coordinatesService.mouseClickCoordinates.next(
                Cartographic.fromDegrees(cartographic.lon, cartographic.lat, cartographic.alt)
            );
        }

        if (!featureIds.length) {
            this.stateService.unsetUnlockedSelections();
            this.menuService.tileOutline.next(null);
            return;
        }

        this.inspectionSelection.inspectFeatureIds(featureIds, !!srcEvent?.ctrlKey);
    }

    /** Resolves the first drill hit's physical feature anchor for marker placement. */
    private markerPositionForFeature(
        clickInfo: PickingInfo,
        screenPosition: {x: number; y: number},
        targetFeature: TileFeatureId,
        radius: number,
        maxObjects: number
    ): NavigationAnchor | null {
        if (this.pickingInfoContainsFeature(clickInfo, targetFeature)) {
            const clickPosition = markerAnchorFromPickingInfo(clickInfo);
            if (clickPosition) {
                return clickPosition;
            }
        }
        if (!this.deck) {
            return null;
        }
        const pickedObjects = this.deck.pickMultipleObjects({
            x: screenPosition.x,
            y: screenPosition.y,
            radius,
            depth: maxObjects,
            layerIds: this.drillPickLayerIds(),
            unproject3D: true
        });
        for (const picked of pickedObjects) {
            if (!this.pickingInfoContainsFeature(picked, targetFeature)) {
                continue;
            }
            const position = markerAnchorFromPickingInfo(picked);
            if (position) {
                return position;
            }
        }
        return null;
    }

    /** Returns whether one Deck pick resolves to the exact supplied tile-feature identity. */
    private pickingInfoContainsFeature(picked: PickingInfo, target: TileFeatureId): boolean {
        return this.featureIdsFromPickingInfo(picked).some(featureId =>
            featureId.mapTileKey === target.mapTileKey
            && featureId.featureId === target.featureId
        );
    }

    /** Applies a sanitized camera state to deck and optionally refreshes viewport-dependent overlays. */
    private updateViewState(nextState: DeckCameraState, setDeckProps: boolean, updateViewport: boolean): void {
        const sanitized = this.sanitizeViewState(nextState);
        const cameraChanged =
            sanitized.longitude !== this.viewState.longitude
            || sanitized.latitude !== this.viewState.latitude
            || sanitized.zoom !== this.viewState.zoom
            || sanitized.pitch !== this.viewState.pitch
            || sanitized.bearing !== this.viewState.bearing
            || sanitized.position.some((value, index) =>
                value !== this.viewState.position[index]);
        if (cameraChanged) {
            this.hoverPickGeneration += 1;
            this.cancelHoverPickScheduling();
            this.pendingHoverAnchorPosition = null;
            this.pendingHoverDetailPosition = null;
            if (this.hoverNavigationPivot) {
                this.setHoverNavigationPivot(null);
            }
            if (this.deckCanvasPointerInside && !this.isCameraInteracting &&
                this.latestHoverPosition) {
                this.queueHoverPicks(this.latestHoverPosition);
            }
        }
        this.viewState = sanitized;
        if (cameraChanged && this.activeNavigationPivot) {
            this.updateNavigationPivotOverlay();
        }
        if (this.deck && setDeckProps) {
            const wasSuppressingViewStateEvents = this.suppressDeckViewStateEvent;
            this.suppressDeckViewStateEvent = true;
            this.deck.setProps({viewState: sanitized});
            this.suppressDeckViewStateEvent = wasSuppressingViewStateEvents;
        }
        if (updateViewport) {
            this.updateBackgroundLayer();
            this.scheduleViewportUpdate();
            this.scheduleTileGridOverlayUpdate();
            this.scheduleSearchResultsOverlayUpdate();
        }
    }

    /** Returns the controlled camera object that belongs to the currently installed deck view. */
    private activeDeckViewState(): DeckCameraState | DeckFirstPersonCameraState {
        return this.firstPersonSession?.viewState ?? this.viewState;
    }

    /** Swaps the view/controller pair on the existing Deck instance without rebuilding scene layers. */
    private applyActiveDeckView(): void {
        if (!this.deck) {
            return;
        }
        const wasSuppressingViewStateEvents = this.suppressDeckViewStateEvent;
        this.suppressDeckViewStateEvent = true;
        // deck.gl does not finalize an existing controller when the view keeps the
        // same id but changes controller class. Install the target view once without
        // a controller and under a transient id so ViewManager removes the old event
        // handlers before attaching the new controller in a second update.
        if (this.firstPersonSession) {
            this.deck.setProps({
                views: this.createFirstPersonDeckView(undefined, "-controller-detach"),
                viewState: this.firstPersonSession.viewState,
                controller: false
            });
            this.deck.setProps({
                views: this.createFirstPersonDeckView(this.createFirstPersonControllerOptions()),
                controller: false
            });
        } else {
            this.deck.setProps({
                views: this.createMapDeckView(undefined, "-controller-detach"),
                viewState: this.viewState,
                controller: false
            });
            this.deck.setProps({
                views: this.createMapDeckView(this.createDeckControllerOptions()),
                controller: false
            });
        }
        this.suppressDeckViewStateEvent = wasSuppressingViewStateEvents;
    }

    /** Accepts only look direction changes from the fixed-location first-person controller. */
    private updateFirstPersonViewState(rawViewState: DeckFirstPersonCameraState): void {
        const session = this.firstPersonSession;
        if (!session) {
            return;
        }
        session.viewState = updateFixedFirstPersonLook(session.viewState, rawViewState);
        if (this.deck) {
            const wasSuppressingViewStateEvents = this.suppressDeckViewStateEvent;
            this.suppressDeckViewStateEvent = true;
            this.deck.setProps({viewState: session.viewState});
            this.suppressDeckViewStateEvent = wasSuppressingViewStateEvents;
        }
        this.requestRender("First-person look");
    }

    /** Persists the current controlled deck view state back into `AppStateService`. */
    private pushViewStateToAppState(): void {
        const groundCentered = this.groundCenteredViewState(this.viewState);
        if (!this.isCameraInteracting && groundCentered !== this.viewState) {
            this.updateViewState(groundCentered, true, true);
        }
        const cameraViewData = this.cameraViewData(groundCentered);
        this.ignoreNextCamAppStateUpdate = true;
        this.stateService.setView(
            this._viewIndex,
            Cartographic.fromDegrees(
                cameraViewData.destination.lon,
                cameraViewData.destination.lat,
                cameraViewData.destination.alt
            ),
            cameraViewData.orientation,
            cameraViewData.position
        );
    }

    /** Keeps renderer-local camera motion hot and persists only settled state. */
    private scheduleViewStatePush(): void {
        if (!this.isCameraInteracting) {
            this.flushPendingViewStatePush(true);
            return;
        }
        this.cameraStatePushPending = true;
        if (!this.liveCameraSyncEnabled() || this.liveCameraSyncRaf !== null) {
            return;
        }
        this.liveCameraSyncRaf = window.requestAnimationFrame(() => {
            this.liveCameraSyncRaf = null;
            if (!this.isCameraInteracting || !this.liveCameraSyncEnabled()) {
                return;
            }
            const groundCentered = this.groundCenteredViewState(this.viewState);
            this.mapViewState.publishLiveCameraViewState(
                this._viewIndex,
                this.cameraViewData(groundCentered)
            );
        });
    }

    /** Publishes the newest local camera state after interaction settles. */
    private flushPendingViewStatePush(force = false): void {
        this.cancelLiveCameraSyncScheduling();
        if (!force && !this.cameraStatePushPending) {
            return;
        }
        this.cameraStatePushPending = false;
        this.pushViewStateToAppState();
    }

    /** Cancels a renderer-local camera preview that has not reached the next frame yet. */
    private cancelLiveCameraSyncScheduling(): void {
        if (this.liveCameraSyncRaf === null) {
            return;
        }
        window.cancelAnimationFrame(this.liveCameraSyncRaf);
        this.liveCameraSyncRaf = null;
    }

    /** Retains renderer-local live camera motion only when another view consumes it. */
    private liveCameraSyncEnabled(): boolean {
        return this.stateService.numViews > 1 &&
            (this.stateService.viewSync.includes(VIEW_SYNC_POSITION) ||
                this.stateService.viewSync.includes(VIEW_SYNC_MOVEMENT));
    }

    /** Converts one Deck camera pose into the renderer-neutral synchronization model. */
    private cameraViewData(state: DeckCameraState): CameraViewState {
        return {
            destination: {
                lon: state.longitude,
                lat: state.latitude,
                alt: this.zoomToAltitude(state.zoom, state.latitude)
            },
            orientation: {
                heading: GeoMath.toRadians(state.bearing),
                pitch: GeoMath.toRadians(state.pitch - 90),
                roll: 0
            },
            position: [...state.position]
        };
    }

    /** Builds the deck controller options from the current view mode and persisted zoom-speed preference. */
    private createDeckControllerOptions(): DeckProps<DeckView>["controller"] {
        const zoomStep = this.stateService.mapZoomStep;
        const scrollZoomSpeed = DeckMapView.DEFAULT_DECK_SCROLL_ZOOM_SPEED * zoomStep / DEFAULT_MAP_ZOOM_STEP;
        const keyboardZoomSpeed = Math.pow(2, zoomStep);
        if (!this.allowPitchAndBearing) {
            return {
                dragRotate: false,
                touchRotate: false,
                keyboard: false,
                scrollZoom: {speed: scrollZoomSpeed}
            };
        }
        return {
            type: MapController,
            inertia: false,
            keyboard: {zoomSpeed: keyboardZoomSpeed},
            scrollZoom: {speed: scrollZoomSpeed},
            _targetNavigation: true,
            getInteractionTarget: (context: Readonly<MapInteractionTargetContext>) =>
                this.targetNavigationAdapter.resolveInteractionTarget(context)
        };
    }

    /** Disables all position-changing input while retaining pointer/touch look rotation. */
    private createFirstPersonControllerOptions(): DeckProps<DeckView>["controller"] {
        return {
            dragMode: "rotate",
            dragRotate: true,
            dragPan: false,
            scrollZoom: false,
            doubleClickZoom: false,
            touchZoom: false,
            touchRotate: true,
            keyboard: false,
            inertia: false
        };
    }

    /** Converts a settled target-relative camera into its equivalent ground-centered state. */
    private groundCenteredViewState(state: DeckCameraState): DeckCameraState {
        const size = this.lastCanvasCssSize;
        return size
            ? viewStateWithGroundCenter(
                state,
                size.width,
                size.height,
                this.useOrthographicProjection
            )
            : state;
    }

    /** Clamps and normalizes the deck camera state before it becomes authoritative. */
    private sanitizeViewState(next: DeckCameraState): DeckCameraState {
        const longitude = Number.isFinite(next.longitude) ? next.longitude : this.viewState.longitude;
        const latitude = Number.isFinite(next.latitude) ? next.latitude : this.viewState.latitude;
        const zoom = Number.isFinite(next.zoom) ? next.zoom : this.viewState.zoom;
        const pitch = Number.isFinite(next.pitch) ? next.pitch : this.viewState.pitch;
        const bearing = Number.isFinite(next.bearing) ? next.bearing : this.viewState.bearing;
        const maxPitch = Number.isFinite(next.maxPitch) ? next.maxPitch : this.viewState.maxPitch;
        const position = next.position?.length === 3 && next.position.every(Number.isFinite)
            ? [...next.position] as [number, number, number]
            : [...this.viewState.position] as [number, number, number];
        return {
            longitude: this.normalizeLongitude(longitude),
            latitude: Math.max(-85.05113, Math.min(85.05113, latitude)),
            zoom: Math.max(DeckMapView.MIN_MAP_ZOOM, Math.min(DeckMapView.MAX_MAP_ZOOM, zoom)),
            minZoom: DeckMapView.MIN_MAP_ZOOM,
            maxZoom: DeckMapView.MAX_MAP_ZOOM,
            pitch: this.allowPitchAndBearing ? Math.max(0, Math.min(maxPitch, pitch)) : 0,
            bearing: this.allowPitchAndBearing ? this.normalizeDegrees(bearing) : 0,
            maxPitch: this.allowPitchAndBearing ? Math.max(0, maxPitch) : 0,
            position
        };
    }

    /** Creates a `WebMercatorViewport` for the current canvas and controlled deck camera state. */
    private createWebMercatorViewport(): WebMercatorViewport | undefined {
        const rect = this.getCanvasClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) {
            return undefined;
        }
        return this.createWebMercatorViewportForSize(width, height);
    }

    /** Creates a deck viewport for explicit CSS dimensions and the current controlled camera. */
    private createWebMercatorViewportForSize(width: number, height: number): WebMercatorViewport | undefined {
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            return undefined;
        }
        return createDeckMapViewport(
            this.viewState,
            width,
            height,
            this.useOrthographicProjection
        );
    }

    /** Adds, updates, or removes the configured raster background according to the current view mode and state. */
    private updateBackgroundLayer(): void {
        if (!this.deck) {
            this.removeBackgroundLayer();
            return;
        }

        const backgroundLayers = this.configService.getBackgroundLayers();
        const defaultBackgroundLayerId = this.configService.getDefaultBackgroundLayerId();
        const backgroundState = this.stateService.resolveBackgroundState(
            this._viewIndex,
            backgroundLayers,
            defaultBackgroundLayerId
        );
        const selectedLayer = backgroundLayers.find(layer => layer.id === backgroundState.layerId);
        if (!selectedLayer) {
            this.removeBackgroundLayer();
            return;
        }

        if (!this.stateService.mode2dState.getValue(this._viewIndex) && selectedLayer.type === "wms") {
            // WMS backgrounds remain a 2D-only option in erdblick. Dropping them here avoids
            // carrying an unstable layer into pitched 3D views where it cannot render correctly.
            this.removeBackgroundLayer();
            return;
        }

        const opacity = Math.max(0, Math.min(1, backgroundState.opacity / 100));
        const signature = JSON.stringify({
            layerId: selectedLayer.id,
            opacity,
            mode2d: this.stateService.mode2dState.getValue(this._viewIndex)
        });
        if (signature === this.backgroundLayerSignature) {
            // Skip deck layer churn when only unrelated state changed.
            return;
        }

        const layer = selectedLayer.type === "xyz"
            ? this.createXyzBackgroundLayer(selectedLayer, opacity)
            : this.createWmsBackgroundLayer(selectedLayer, opacity);
        this.layerRegistry.upsert(DeckMapView.BACKGROUND_LAYER_KEY, layer, -1000);
        this.backgroundLayerSignature = signature;
    }

    /** Removes the current background layer and clears the memoized render signature. */
    private removeBackgroundLayer(): void {
        this.layerRegistry.remove(DeckMapView.BACKGROUND_LAYER_KEY);
        this.backgroundLayerSignature = "";
    }

    /**
     * Builds a fetch override for authenticated background layers while preserving deck/loaders.gl
     * request options such as abort signals.
     */
    private createBackgroundFetchOverride(headers: Readonly<Record<string, string>>): typeof fetch | undefined {
        if (Object.keys(headers).length === 0) {
            return undefined;
        }

        return async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
            const mergedHeaders = new Headers(init?.headers);
            for (const [name, value] of Object.entries(headers)) {
                mergedHeaders.set(name, value);
            }

            return fetch(input, {
                ...init,
                headers: mergedHeaders
            });
        };
    }

    /** Wraps the optional background fetch override in the deck/loaders.gl `loadOptions` structure. */
    private createBackgroundLoadOptions(headers: Readonly<Record<string, string>>): {core: {fetch: typeof fetch}} | undefined {
        const fetchOverride = this.createBackgroundFetchOverride(headers);
        if (!fetchOverride) {
            return undefined;
        }

        return {
            core: {
                fetch: fetchOverride
            }
        };
    }

    /**
     * Creates the tiled XYZ background layer used for OSM and bundled imagery.
     *
     * The deck layer id includes the configured background id so switching
     * sources forces a fresh TileLayer instance and tile selection pass.
     * The layer also prefers deck's `best-available` refinement so panning
     * keeps already loaded detailed tiles visible instead of collapsing to a
     * coarse parent tile while sibling requests are still in flight. Bitmap
     * opacity is blended against the map's black background inside the shader
     * so overlapping parent/child placeholders do not briefly compound alpha.
     * When `headers` are configured, tile requests use them for authenticated
     * HTTP endpoints without changing local bundled backgrounds.
     */
    private createXyzBackgroundLayer(layerConfig: XyzBackgroundLayerConfig, opacity: number): BatchedTileLayer<string> {
        return new BatchedTileLayer<string>({
            id: `${DeckMapView.BACKGROUND_LAYER_KEY}/${layerConfig.id}`,
            data: layerConfig.urlTemplate,
            loadOptions: this.createBackgroundLoadOptions(layerConfig.headers),
            minZoom: layerConfig.minZoom,
            maxZoom: layerConfig.maxZoom,
            tileSize: layerConfig.tileSize,
            extent: layerConfig.extent,
            opacity,
            pickable: false,
            refinementStrategy: "best-available",
            updateTriggers: {
                renderSubLayers: [opacity]
            },
            renderSubLayers: (
                props: Parameters<NonNullable<TileLayerProps<string>["renderSubLayers"]>>[0]
            ) => {
                const boundingBox = props.tile?.boundingBox;
                if (!boundingBox || !props.data) {
                    return null;
                }
                return new BitmapLayer({
                    id: `${props.id}-bitmap`,
                    image: props.data,
                    bounds: [
                        boundingBox[0][0],
                        boundingBox[0][1],
                        boundingBox[1][0],
                        boundingBox[1][1]
                    ],
                    opacity,
                    transparentColor: [0, 0, 0, 255],
                    pickable: false,
                    parameters: {depthTest: false}
                });
            }
        });
    }

    /**
     * Creates the experimental WMS background layer from the config-driven service parameters.
     *
     * The source-specific layer id mirrors the XYZ path so deck does not reuse
     * stale internal state when the selected background changes. WMS metadata
     * and image requests reuse the same optional header override as XYZ tiles.
     */
    private createWmsBackgroundLayer(layerConfig: WmsBackgroundLayerConfig, opacity: number): WMSLayer {
        const imageSource = new WMSImageSource(layerConfig.url, {
            core: {
                loadOptions: this.createBackgroundLoadOptions(layerConfig.headers) ?? {}
            },
            wms: {
                wmsParameters: {
                    layers: layerConfig.layers,
                    version: layerConfig.version,
                    crs: layerConfig.crs,
                    format: layerConfig.format,
                    transparent: layerConfig.transparent
                },
                vendorParameters: layerConfig.vendorParameters
            }
        });

        return new WMSLayer({
            id: `${DeckMapView.BACKGROUND_LAYER_KEY}/${layerConfig.id}`,
            data: imageSource,
            layers: layerConfig.layers,
            serviceType: "wms",
            srs: layerConfig.crs,
            opacity,
            pickable: false,
            parameters: DeckMapView.NO_DEPTH_PARAMETERS,
            onMetadataLoadError: (error) => console.error("[DeckMapView] Failed to load WMS metadata", error),
            onImageLoadError: (_requestId, error) => console.error("[DeckMapView] Failed to load WMS image", error)
        });
    }

    /** Schedules one tile-grid overlay refresh on the next animation frame. */
    private scheduleTileGridOverlayUpdate(): void {
        if (this.tileGridOverlayUpdateRaf !== null) {
            return;
        }
        this.tileGridOverlayUpdateRaf = requestAnimationFrame(() => {
            this.tileGridOverlayUpdateRaf = null;
            this.updateTileGridOverlay();
        });
    }

    /** Recolors tile state after a tile-arrival burst without redrawing the full scene per tile. */
    private scheduleTileGridOverlayDataRefresh(): void {
        if (!this.tileGridEnabled) {
            return;
        }
        if (this.tileGridOverlayDataRefreshTimer !== null) {
            clearTimeout(this.tileGridOverlayDataRefreshTimer);
        }
        this.tileGridOverlayDataRefreshTimer = setTimeout(() => {
            this.tileGridOverlayDataRefreshTimer = null;
            this.scheduleTileGridOverlayUpdate();
        }, DeckMapView.TILE_GRID_DATA_REFRESH_DEBOUNCE_MS);
    }

    /** Cancels pending tile-grid overlay refresh work. */
    private cancelTileGridOverlayUpdateScheduling(): void {
        if (this.tileGridOverlayUpdateRaf !== null) {
            cancelAnimationFrame(this.tileGridOverlayUpdateRaf);
            this.tileGridOverlayUpdateRaf = null;
        }
        if (this.tileGridOverlayDataRefreshTimer !== null) {
            clearTimeout(this.tileGridOverlayDataRefreshTimer);
            this.tileGridOverlayDataRefreshTimer = null;
        }
    }

    /** Schedules one search-result overlay refresh on the next animation frame. */
    private scheduleSearchResultsOverlayUpdate(): void {
        if (this.searchResultsOverlayUpdateRaf !== null) {
            return;
        }
        this.searchResultsOverlayUpdateRaf = requestAnimationFrame(() => {
            this.searchResultsOverlayUpdateRaf = null;
            this.updateSearchResultsOverlay();
        });
    }

    /** Debounces search-result overlay rebuilds after search progress changes. */
    private scheduleSearchResultsOverlayDataRefresh(): void {
        if (this.searchResultsOverlayDataRefreshTimer !== null) {
            return;
        }
        this.searchResultsOverlayDataRefreshTimer = setTimeout(() => {
            this.searchResultsOverlayDataRefreshTimer = null;
            this.scheduleSearchResultsOverlayUpdate();
        }, 120);
    }

    /** Cancels pending search-result overlay refresh work. */
    private cancelSearchResultsOverlayScheduling(): void {
        if (this.searchResultsOverlayUpdateRaf !== null) {
            cancelAnimationFrame(this.searchResultsOverlayUpdateRaf);
            this.searchResultsOverlayUpdateRaf = null;
        }
        if (this.searchResultsOverlayDataRefreshTimer !== null) {
            clearTimeout(this.searchResultsOverlayDataRefreshTimer);
            this.searchResultsOverlayDataRefreshTimer = null;
        }
    }

    /** Rebuilds the search-result dot/density overlay. */
    private updateSearchResultsOverlay(): void {
        if (!this.deck) {
            this.removeSearchResultLayers();
            this.lastSearchResultsSignature = "";
            return;
        }

        const searchLayers = this.featureSearchService.getSearchResultOverlayLayers()
            .filter(searchLayer => featureSearchVisibleInView(searchLayer, this._viewIndex));
        const overlayInputs: SearchResultOverlayInput[] = searchLayers.map(searchLayer => {
            const lowFiSourceTileKeys = new Set<string>();
            const highFiPinMarkers: SearchResultDensityMarker[] = [];
            const highFidelityByLevel = new Map<number, boolean>();
            let sourceTileKeyHash = DeckMapView.SEARCH_RESULT_SOURCE_TILE_HASH_OFFSET;
            let sourceTileKeyCount = 0;
            let maxVisibleLevel = 0;
            for (const bucket of searchLayer.pointBuckets) {
                if (!this.mapViewState.showsFeatureSearchTileInView(this._viewIndex, bucket.mapId, bucket.layerId, bucket.tileId)) {
                    continue;
                }
                const bucketLevel = Number(coreLib.getTileLevel(bucket.tileId));
                sourceTileKeyHash = this.hashSearchResultSourceTileKey(sourceTileKeyHash, bucket.sourceTileKey);
                sourceTileKeyCount += 1;
                let highFidelityActive = highFidelityByLevel.get(bucketLevel);
                if (highFidelityActive === undefined) {
                    highFidelityActive = this.prefersHighFidelityForSearchResultOverlay(searchLayer, bucket.tileId);
                    highFidelityByLevel.set(bucketLevel, highFidelityActive);
                }
                if (highFidelityActive) {
                    if (searchLayer.renderStrategy.showHighFiResultDots) {
                        // Dense searches can produce more per-feature pins than V8 accepts
                        // as spread-call arguments; append one marker at a time.
                        for (const point of bucket.points) {
                            highFiPinMarkers.push(this.searchResultPointMarker(point));
                        }
                    }
                    continue;
                }
                if (!searchLayer.renderStrategy.showLowFiDots) {
                    continue;
                }
                lowFiSourceTileKeys.add(bucket.sourceTileKey);
                maxVisibleLevel = Math.max(maxVisibleLevel, bucketLevel);
            }
            const targetLevel = this.mapViewState.searchResultDensityTargetLevel(
                this._viewIndex,
                maxVisibleLevel,
                searchLayer.renderStrategy.highFidelityMaxVisibleTiles);
            return {
                searchLayer,
                dotLayerKey: this.searchResultLayerKey(searchLayer.id, "dot"),
                labelLayerKey: this.searchResultLayerKey(searchLayer.id, "label"),
                pinLayerKey: this.searchResultLayerKey(searchLayer.id, "pin"),
                lowFiSourceTileKeys,
                highFiPinMarkers,
                targetLevel,
                densitySizeScale: this.searchResultDensitySizeScale(searchLayer.renderStrategy.densitySizeMultiplier),
                sourceTileKeySignature: `${sourceTileKeyCount}:${sourceTileKeyHash.toString(16)}`
            };
        });

        const signature = overlayInputs
            .map(input => [
                input.searchLayer.id,
                input.searchLayer.pointsVersion,
                input.searchLayer.pointColor,
                input.searchLayer.styleRuleCount,
                JSON.stringify(input.searchLayer.renderStrategy),
                input.targetLevel,
                input.sourceTileKeySignature
            ].join(":"))
            .join("|");
        if (this.lastSearchResultsSignature === signature) {
            return;
        }
        this.lastSearchResultsSignature = signature;

        const densityMarkersByLayerKey = new Map<string, SearchResultOverlayLayerData>();
        const layoutEntries: SearchResultDensityLayoutEntry[] = [];
        for (const input of overlayInputs) {
            const lowFiDensityMarkers = input.lowFiSourceTileKeys.size > 0 && !input.searchLayer.densityIndex.isEmpty
                ? input.searchLayer.densityIndex.materialize({
                    sourceTileKeys: input.lowFiSourceTileKeys,
                    targetLevel: input.targetLevel
                })
                : [];
            const layerMarkers = lowFiDensityMarkers;
            const countDomain = searchResultDensityCountDomain(layerMarkers);
            for (const marker of lowFiDensityMarkers) {
                layoutEntries.push({
                    marker,
                    sortKey: `${input.searchLayer.id}\n${marker.resultKey}`,
                    countDomain,
                    sizeScale: input.densitySizeScale
                });
            }
            densityMarkersByLayerKey.set(input.dotLayerKey, {markers: layerMarkers, countDomain});
        }
        layoutSearchResultDensityMarkers(layoutEntries, DeckMapView.SEARCH_RESULT_DENSITY_SIZE_SCALE);

        const nextKeys = new Set<string>();
        for (const input of overlayInputs) {
            if ((densityMarkersByLayerKey.get(input.dotLayerKey)?.markers.length ?? 0) > 0) {
                nextKeys.add(input.dotLayerKey);
                if (input.searchLayer.renderStrategy.showBucketLabels) {
                    nextKeys.add(input.labelLayerKey);
                }
            }
            if (input.highFiPinMarkers.length > 0) {
                nextKeys.add(input.pinLayerKey);
            }
        }
        for (const layerKey of this.searchResultLayerKeys) {
            if (!nextKeys.has(layerKey)) {
                this.layerRegistry.remove(layerKey);
            }
        }
        this.searchResultLayerKeys = nextKeys;

        for (const input of overlayInputs) {
            const layerData = densityMarkersByLayerKey.get(input.dotLayerKey);
            if (layerData?.markers.length) {
                this.layerRegistry.upsert(
                    input.dotLayerKey,
                    createSearchResultDensityLayer({
                        id: input.dotLayerKey,
                        data: layerData.markers,
                        pickable: false,
                        sizeScale: input.densitySizeScale,
                        dotColor: input.searchLayer.pointColorRgba,
                        countDomain: layerData.countDomain,
                        heatGradient: input.searchLayer.renderStrategy.densityHeatGradient
                    }),
                    650);
                if (input.searchLayer.renderStrategy.showBucketLabels) {
                    this.layerRegistry.upsert(
                        input.labelLayerKey,
                        createSearchResultDensityLabelLayer({
                            id: input.labelLayerKey,
                            data: layerData.markers,
                            pickable: false
                        }),
                        651);
                }
            } else {
                this.layerRegistry.remove(input.dotLayerKey);
                this.layerRegistry.remove(input.labelLayerKey);
            }
            if (input.highFiPinMarkers.length) {
                this.layerRegistry.upsert(
                    input.pinLayerKey,
                    this.createSearchResultPinLayer(input.pinLayerKey, input.highFiPinMarkers, input.searchLayer.pointColorRgba),
                    652);
            } else {
                this.layerRegistry.remove(input.pinLayerKey);
            }
        }
    }

    /** Returns whether this search wants high-fidelity overlay state for the supplied source tile. */
    private prefersHighFidelityForSearchResultOverlay(
        searchLayer: FeatureSearchOverlayLayer,
        tileId: number
    ): boolean {
        const strategy = searchLayer.renderStrategy;
        const hasHighFidelityVisualization = strategy.showHighFiResultDots
            || (strategy.showHighFiGeometry && searchLayer.styleRuleCount > 0);
        if (!hasHighFidelityVisualization) {
            return false;
        }
        if (!strategy.showLowFiDots) {
            return true;
        }
        return this.mapViewState.prefersHighFidelityForSearchResultTile(
            this._viewIndex,
            searchLayer.id,
            tileId,
            strategy.highFidelityMaxVisibleTiles
        );
    }

    /** Applies the user-visible density marker size multiplier to the default deck icon scale. */
    private searchResultDensitySizeScale(multiplier: number): number {
        const normalizedMultiplier = Number.isFinite(multiplier)
            ? Math.max(0.5, Math.min(10, multiplier))
            : 1;
        return DeckMapView.SEARCH_RESULT_DENSITY_SIZE_SCALE * normalizedMultiplier;
    }

    /** Creates the explicit per-feature high-fidelity result-pin layer. */
    private createSearchResultPinLayer(
        layerKey: string,
        markers: SearchResultDensityMarker[],
        color: [number, number, number, number]
    ): IconLayer<SearchResultDensityMarker> {
        const iconSize = DeckMapView.LOCATION_MARKER_ICON_SIZE_PX;
        return new IconLayer<SearchResultDensityMarker>({
            id: layerKey,
            data: markers,
            coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
            iconAtlas: this.featureSearchService.markerGraphics(),
            iconMapping: {
                [DeckMapView.LOCATION_MARKER_ICON_NAME]: {
                    x: 0,
                    y: 0,
                    width: iconSize,
                    height: iconSize,
                    anchorX: iconSize / 2,
                    anchorY: iconSize,
                    mask: true
                }
            },
            getIcon: () => DeckMapView.LOCATION_MARKER_ICON_NAME,
            getPosition: marker => marker.coordinates,
            getColor: () => color,
            getSize: () => DeckMapView.SEARCH_RESULT_PIN_RENDER_SIZE_PX,
            sizeUnits: "pixels",
            billboard: true,
            pickable: false,
            alphaCutoff: 0.05,
            parameters: DeckMapView.NO_DEPTH_PARAMETERS
        });
    }

    /** Updates the FNV-1a source-key hash used to avoid sorting visible search tiles per overlay refresh. */
    private hashSearchResultSourceTileKey(hash: number, sourceTileKey: string): number {
        let nextHash = hash;
        for (let index = 0; index < sourceTileKey.length; index++) {
            nextHash ^= sourceTileKey.charCodeAt(index);
            nextHash = Math.imul(nextHash, DeckMapView.SEARCH_RESULT_SOURCE_TILE_HASH_PRIME);
        }
        return nextHash >>> 0;
    }

    /** Returns a stable deck-layer key for one feature-search session. */
    private searchResultLayerKey(searchId: string, kind: "dot" | "label" | "pin"): string {
        return `${DeckMapView.SEARCH_RESULTS_LAYER_PREFIX}/${searchId}/${kind}`;
    }

    /** Converts an individual high-fidelity search result into a positioned dot marker. */
    private searchResultPointMarker(point: SearchResultPoint): SearchResultDensityMarker {
        return {
            coordinates: point.coordinates,
            count: 1,
            mapId: point.mapId,
            layerId: point.layerId,
            tileId: point.tileId,
            featureId: point.featureId,
            resultKey: point.resultKey,
            featureKey: point.featureKey,
            featureKeys: [point.featureKey],
            resultKeys: [point.resultKey],
            showBucketLabel: false
        };
    }

    /** Removes every feature-search result layer from this deck view. */
    private removeSearchResultLayers(): void {
        for (const layerKey of this.searchResultLayerKeys) {
            this.layerRegistry.remove(layerKey);
        }
        this.searchResultLayerKeys.clear();
    }

    /**
     * Mirrors the legacy Cesium single-location pin as a dedicated deck IconLayer.
     */
    private updateLocationMarkerOverlay(): void {
        const markerEnabled = this.stateService.markerState.getValue();
        const markedPosition = this.stateService.markedPositionState.getValue();
        if (!this.deck || !markerEnabled || markedPosition.length < 2) {
            this.layerRegistry.remove(DeckMapView.LOCATION_MARKER_LAYER_KEY);
            this.lastLocationMarkerSignature = "";
            return;
        }

        const longitude = Number(markedPosition[0]);
        const latitude = Number(markedPosition[1]);
        const altitude = Number(markedPosition[2] ?? 0);
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || !Number.isFinite(altitude)) {
            this.layerRegistry.remove(DeckMapView.LOCATION_MARKER_LAYER_KEY);
            this.lastLocationMarkerSignature = "";
            return;
        }

        const iconAtlas = this.featureSearchService.markerGraphics();
        const signature = `${longitude},${latitude},${altitude},${iconAtlas}`;
        if (this.lastLocationMarkerSignature === signature) {
            return;
        }

        this.lastLocationMarkerSignature = signature;
        const iconSize = DeckMapView.LOCATION_MARKER_ICON_SIZE_PX;
        const layer = new IconLayer<DeckLocationMarkerDatum>({
            id: DeckMapView.LOCATION_MARKER_LAYER_KEY,
            data: [{position: [longitude, latitude, altitude]}],
            coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
            iconAtlas,
            iconMapping: {
                [DeckMapView.LOCATION_MARKER_ICON_NAME]: {
                    x: 0,
                    y: 0,
                    width: iconSize,
                    height: iconSize,
                    anchorX: iconSize / 2,
                    anchorY: iconSize,
                    mask: false
                }
            },
            getIcon: () => DeckMapView.LOCATION_MARKER_ICON_NAME,
            getPosition: (marker: DeckLocationMarkerDatum) => marker.position,
            getSize: () => DeckMapView.LOCATION_MARKER_RENDER_SIZE_PX,
            sizeUnits: "pixels",
            billboard: true,
            pickable: false,
            alphaCutoff: 0.05,
            parameters: DeckMapView.NO_DEPTH_PARAMETERS
        });
        this.layerRegistry.upsert(DeckMapView.LOCATION_MARKER_LAYER_KEY, layer, 700);
    }

    /** Rebuilds the independent line grid and data-derived tile-state overlays. */
    private updateTileGridOverlay(): void {
        if (!this.deck || !this.tileGridEnabled) {
            this.removeTileGridLayers();
            this.removeTileStateLayers();
            return;
        }
        const viewport = this.computeViewport();
        if (!viewport) {
            this.removeTileGridLayers();
            this.removeTileStateLayers();
            return;
        }
        const layerLevels = this.visibleMapLayerLevels();
        if (layerLevels.length) {
            this.updateTileStateOverlays(layerLevels, viewport);
        } else {
            this.removeTileStateLayers();
        }
        const effectiveGridLevel = this.tileGridAutoLevel
            ? autoTileGridLevel(
                this.zoomToAltitude(this.viewState.zoom, 0),
                this.tileGridMode
            )
            : coarsenedTileLevel(
                this.tileGridLevel,
                viewport,
                DeckMapView.TILE_GRID_MAX_VISIBLE_CELLS,
                this.tileGridMode
            );
        this.updateTileGridLayers([effectiveGridLevel], viewport);
    }

    /** Reconciles the line-only grid overlay layers for the requested levels. */
    private updateTileGridLayers(levels: number[], viewport: Viewport): void {
        const nextLayerKeys = new Set<string>();
        levels.forEach((level, index) => {
            const layerKey = `${DeckMapView.TILE_GRID_LAYER_KEY}/${level}`;
            const layer = this.createTileGridLayer(level, viewport, layerKey);
            this.layerRegistry.upsert(layerKey, layer, 490 + index);
            nextLayerKeys.add(layerKey);
        });
        for (const key of this.tileGridLayerKeys) {
            if (!nextLayerKeys.has(key)) {
                this.layerRegistry.remove(key);
            }
        }
        this.tileGridLayerKeys = nextLayerKeys;
    }

    /** Creates one shader-driven tile-grid line layer for a specific level. */
    private createTileGridLayer(level: number, viewport: Viewport, layerId: string): TileGridOverlayLayer {
        const overlayGeometry = this.tileGridOverlayGeometry(level, viewport);
        return new TileGridOverlayLayer({
            id: layerId,
            data: overlayGeometry.data,
            getPolygon: (datum: TileGridOverlayDatum) => datum.polygon,
            getFillColor: [0, 0, 0, 0],
            coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
            filled: true,
            extruded: false,
            // Keep the overlay quad in unwrapped longitude space. The shader
            // already works with unwrapped/projection-space X coordinates.
            wrapLongitude: false,
            pickable: false,
            gridMode: this.tileGridMode,
            localMin: overlayGeometry.localMin,
            localSize: overlayGeometry.localSize,
            subdivisionX: overlayGeometry.subdivisionX,
            subdivisionY: overlayGeometry.subdivisionY,
            lineColor: this.tileGridLineColor,
            lineWidthPixels: DeckMapView.TILE_GRID_LINE_WIDTH_PX,
            parameters: DeckMapView.NO_DEPTH_PARAMETERS
        });
    }

    /** Rebuilds the raster tile-state overlays that color error/empty cells behind the grid lines. */
    private updateTileStateOverlays(
        levels: number[],
        viewport: Viewport
    ): void {
        const visibleLayersByLevel = this.visibleMapLayersByLevel(levels);
        const nextLayerKeys = new Set<string>();
        const tileLimitPerView = this.tileLimitPerView();
        for (const level of levels) {
            if (tileGridVisibleCellCount(level, viewport, this.tileGridMode) >
                DeckMapView.TILE_GRID_MAX_VISIBLE_CELLS) {
                continue;
            }
            const visibleLayers = visibleLayersByLevel.get(level) ?? [];
            if (!visibleLayers.length) {
                continue;
            }
            const extent = tileGridExtentForLevel(level, viewport, this.tileGridMode);
            if (!extent) {
                continue;
            }

            const pixels = new Uint8ClampedArray(extent.width * extent.height * 4);
            const visibleTileIds = coreLib.getTileIds(viewport, level, tileLimitPerView) as number[];
            for (const tileId of visibleTileIds) {
                const stateKind = this.tileStateKindForTile(tileId, visibleLayers);
                if (stateKind === 0) {
                    continue;
                }
                const cell = this.tileGridCellForTile(tileId, extent);
                if (!cell) {
                    continue;
                }
                const pixelIndex = (cell.row * extent.width + cell.col) * 4;
                if (stateKind === TILE_STATE_KIND_ERROR) {
                    pixels[pixelIndex + 0] = DeckMapView.TILE_STATE_ERROR_COLOR[0];
                    pixels[pixelIndex + 1] = DeckMapView.TILE_STATE_ERROR_COLOR[1];
                    pixels[pixelIndex + 2] = DeckMapView.TILE_STATE_ERROR_COLOR[2];
                    pixels[pixelIndex + 3] = DeckMapView.TILE_STATE_ERROR_COLOR[3];
                } else if (stateKind === TILE_STATE_KIND_EMPTY) {
                    pixels[pixelIndex + 0] = DeckMapView.TILE_STATE_EMPTY_COLOR[0];
                    pixels[pixelIndex + 1] = DeckMapView.TILE_STATE_EMPTY_COLOR[1];
                    pixels[pixelIndex + 2] = DeckMapView.TILE_STATE_EMPTY_COLOR[2];
                    pixels[pixelIndex + 3] = DeckMapView.TILE_STATE_EMPTY_COLOR[3];
                }
            }

            const imageData = new ImageData(pixels, extent.width, extent.height);
            const layerKey = `${DeckMapView.TILE_STATE_LAYER_KEY}/${level}`;
            const overlayGeometry = this.tileStateOverlayGeometry(extent);
            const layer = new TileGridStateOverlayLayer({
                id: layerKey,
                data: overlayGeometry.data,
                getPolygon: (datum: TileGridOverlayDatum) => datum.polygon,
                getFillColor: [255, 255, 255, 255],
                coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
                filled: true,
                extruded: false,
                wrapLongitude: false,
                pickable: false,
                gridMode: this.tileGridMode,
                localMin: overlayGeometry.localMin,
                localSize: overlayGeometry.localSize,
                imageData,
                parameters: DeckMapView.NO_DEPTH_PARAMETERS
            });
            this.layerRegistry.upsert(layerKey, layer, 360);
            nextLayerKeys.add(layerKey);
        }

        for (const key of this.tileStateLayerKeys) {
            if (!nextLayerKeys.has(key)) {
                this.layerRegistry.remove(key);
            }
        }
        this.tileStateLayerKeys = nextLayerKeys;
    }

    /** Returns the effective feature levels currently visible across all enabled map layers in this view. */
    private visibleMapLayerLevels(): number[] {
        const levels = new Set<number>();
        for (const [mapId, map] of this.mapInfo.maps.maps.entries()) {
            for (const layer of map.allFeatureLayers()) {
                if (!this.mapInfo.maps.getMapLayerVisibility(this._viewIndex, mapId, layer.id)) {
                    continue;
                }
                const level = this.mapViewState.getEffectiveMapLayerLevel(this._viewIndex, mapId, layer.id);
                if (!Number.isFinite(level)) {
                    continue;
                }
                levels.add(Math.max(0, Math.floor(level)));
            }
        }
        return Array.from(levels.values()).sort((lhs, rhs) => lhs - rhs);
    }

    /** Groups visible map layers by the effective feature level they currently render at. */
    private visibleMapLayersByLevel(levels: number[]): Map<number, VisibleLayerRef[]> {
        const levelSet = new Set(levels);
        const result = new Map<number, VisibleLayerRef[]>();
        for (const level of levels) {
            result.set(level, []);
        }

        for (const [mapId, map] of this.mapInfo.maps.maps.entries()) {
            for (const layer of map.allFeatureLayers()) {
                if (!this.mapInfo.maps.getMapLayerVisibility(this._viewIndex, mapId, layer.id)) {
                    continue;
                }
                const level = this.mapViewState.getEffectiveMapLayerLevel(this._viewIndex, mapId, layer.id);
                if (!Number.isFinite(level)) {
                    continue;
                }
                const normalizedLevel = Math.max(0, Math.floor(level));
                if (!levelSet.has(normalizedLevel)) {
                    continue;
                }
                const list = result.get(normalizedLevel);
                if (!list) {
                    continue;
                }
                list.push({mapId, layerId: layer.id});
            }
        }
        return result;
    }

    /** Removes every tile-state overlay layer currently registered with deck. */
    private removeTileStateLayers(): void {
        for (const key of this.tileStateLayerKeys) {
            this.layerRegistry.remove(key);
        }
        this.tileStateLayerKeys.clear();
    }

    /** Removes every tile-grid line layer currently registered with deck. */
    private removeTileGridLayers(): void {
        for (const key of this.tileGridLayerKeys) {
            this.layerRegistry.remove(key);
        }
        this.tileGridLayerKeys.clear();
    }

    /** Classifies one tile cell as error, empty, or uncolored across every visible layer at that level. */
    private tileStateKindForTile(tileId: number, visibleLayers: VisibleLayerRef[]): number {
        switch (this.layerController.occupancyForTile(tileId, visibleLayers)) {
            case "error":
                return TILE_STATE_KIND_ERROR;
            case "empty":
                return TILE_STATE_KIND_EMPTY;
            default:
                return 0;
        }
    }

    /** Converts a tile id to its raster-cell coordinates inside the current tile-grid extent. */
    private tileGridCellForTile(tileId: number, extent: TileGridLevelExtent): {col: number; row: number} | null {
        const tileBox = coreLib.getTileBox(tileId) as unknown;
        if (!Array.isArray(tileBox) || tileBox.length < 4) {
            return null;
        }
        const west = Number(tileBox[0]);
        const north = Number(tileBox[3]);
        if (!Number.isFinite(west) || !Number.isFinite(north)) {
            return null;
        }
        const colNorm = tileGridLonToNormX(west);
        const rowNorm = tileGridLatToNormY(north, this.tileGridMode);
        const rawCol = Math.floor(colNorm * extent.colCount + 1e-9);
        const rawRow = Math.floor(rowNorm * extent.rowCount + 1e-9);
        const row = Math.max(0, Math.min(extent.rowCount - 1, rawRow));
        const col = wrapColumnIntoExtent(rawCol, extent);
        if (col < 0 || col >= extent.width) {
            return null;
        }
        const rowInExtent = row - extent.minRow;
        if (rowInExtent < 0 || rowInExtent >= extent.height) {
            return null;
        }
        return {col, row: rowInExtent};
    }

    /** Returns the per-view tile budget derived from the global load limit and split-view count. */
    private tileLimitPerView(): number {
        const viewCount = Math.max(1, this.stateService.numViews);
        return Math.max(1, Math.floor(this.stateService.tilesLoadLimit / viewCount));
    }

    /** Adds or removes the temporary tile-outline overlay created from context-menu interactions. */
    private updateTileOutlineLayer(payload: TileOutlinePayload | null): void {
        if (!payload) {
            this.layerRegistry.remove(DeckMapView.TILE_OUTLINE_LAYER_KEY);
            return;
        }

        const coordinates = payload.rectangle?.coordinates;
        if (!coordinates) {
            this.layerRegistry.remove(DeckMapView.TILE_OUTLINE_LAYER_KEY);
            return;
        }

        const data = this.rectangleOverlayData(
            GeoMath.toDegrees(coordinates.west),
            GeoMath.toDegrees(coordinates.south),
            GeoMath.toDegrees(coordinates.east),
            GeoMath.toDegrees(coordinates.north),
            this.toDeckColor(payload.rectangle["material"] as Color | undefined, [255, 105, 180, 51]),
            this.toDeckColor(payload.rectangle["outlineColor"] as Color | undefined, [255, 105, 180, 255]),
            Math.max(1, Number(payload.rectangle["outlineWidth"] ?? 3))
        );
        if (!data.length) {
            this.layerRegistry.remove(DeckMapView.TILE_OUTLINE_LAYER_KEY);
            return;
        }

        this.upsertRectangleOverlayLayer(DeckMapView.TILE_OUTLINE_LAYER_KEY, data, 520);
    }

    /** Inserts or replaces one rectangle overlay layer with depth testing disabled. */
    private upsertRectangleOverlayLayer(
        layerKey: string,
        data: DeckRectangleOverlayDatum[],
        order: number
    ): void {
        const layer = new PolygonLayer<DeckRectangleOverlayDatum>({
            id: layerKey,
            data,
            getPolygon: (datum: DeckRectangleOverlayDatum) => datum.polygon,
            getFillColor: (datum: DeckRectangleOverlayDatum) => datum.fillColor,
            getLineColor: (datum: DeckRectangleOverlayDatum) => datum.lineColor,
            getLineWidth: (datum: DeckRectangleOverlayDatum) => datum.lineWidthPixels,
            lineWidthUnits: "pixels",
            coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
            filled: true,
            stroked: true,
            extruded: false,
            wrapLongitude: false,
            pickable: false,
            parameters: DeckMapView.NO_DEPTH_PARAMETERS
        });
        this.layerRegistry.upsert(layerKey, layer, order);
    }

    /** Converts one rectangle into one or more overlay data records depending on world-wrap needs. */
    private rectangleOverlayData(
        west: number,
        south: number,
        east: number,
        north: number,
        fillColor: [number, number, number, number],
        lineColor: [number, number, number, number],
        lineWidthPixels: number
    ): DeckRectangleOverlayDatum[] {
        return this.rectangleOverlayPolygons(west, south, east, north).map(polygon => ({
            polygon,
            fillColor,
            lineColor,
            lineWidthPixels
        }));
    }

    /** Splits a wrapped rectangle into multiple polygons when it spans the full world. */
    private rectangleOverlayPolygons(
        west: number,
        south: number,
        east: number,
        north: number
    ): [number, number][][] {
        if (east - west >= 360 - 1e-6) {
            return [
                [
                    [-180, south],
                    [-180, north],
                    [0, north],
                    [0, south]
                ],
                [
                    [0, south],
                    [0, north],
                    [180, north],
                    [180, south]
                ]
            ];
        }
        return [[
            [west, south],
            [west, north],
            [east, north],
            [east, south]
        ]];
    }

    /** Starts a short-lived animated rectangle highlight for fit-to-rectangle navigation. */
    private startJumpAreaHighlight(rectangle: {west: number; south: number; east: number; north: number}): void {
        this.stopJumpAreaHighlight();

        const startTime = performance.now();
        const tick = () => {
            const elapsedMs = performance.now() - startTime;
            const progress = Math.min(1, elapsedMs / DeckMapView.JUMP_AREA_HIGHLIGHT_DURATION_MS);
            const fillAlpha = Math.max(0, (1 - progress) * 0.2);
            const lineAlpha = Math.max(0, 1 - progress);
            const data = this.rectangleOverlayData(
                rectangle.west,
                rectangle.south,
                rectangle.east,
                rectangle.north,
                this.toDeckColor(Color.AQUA.withAlpha(fillAlpha), [0, 255, 255, 51]),
                this.toDeckColor(Color.AQUA.withAlpha(lineAlpha), [0, 255, 255, 255]),
                3
            );
            this.upsertRectangleOverlayLayer(DeckMapView.JUMP_AREA_LAYER_KEY, data, 510);
            this.requestRender();

            if (progress >= 1) {
                this.stopJumpAreaHighlight();
            }
        };

        this.jumpAreaHighlightTick = tick;
        this.onTick(tick);
        tick();
    }

    /** Stops and removes the temporary jump-area highlight overlay. */
    private stopJumpAreaHighlight(): void {
        if (this.jumpAreaHighlightTick) {
            this.offTick(this.jumpAreaHighlightTick);
            this.jumpAreaHighlightTick = null;
        }
        this.layerRegistry.remove(DeckMapView.JUMP_AREA_LAYER_KEY);
    }

    /** Starts a short-lived place-name label after a location-search jump. */
    private startLocationLabel(value: {x: number; y: number; label: string}): void {
        this.stopLocationLabel();

        const longitude = Number(value.x);
        const latitude = Number(value.y);
        const label = value.label.trim().slice(0, 120);
        if (!this.deck || !Number.isFinite(longitude) || !Number.isFinite(latitude) || !label) {
            return;
        }

        const startTime = performance.now();
        const tick = () => {
            const elapsedMs = performance.now() - startTime;
            const progress = Math.min(1, elapsedMs / DeckMapView.LOCATION_LABEL_FADE_DURATION_MS);
            const alpha = Math.max(0, 1 - progress);
            const data: DeckLocationLabelDatum[] = [{
                position: [longitude, latitude],
                label,
                textColor: [255, 255, 255, Math.round(alpha * 255)],
                backgroundColor: [0, 0, 0, Math.round(alpha * 235)]
            }];
            this.layerRegistry.upsert(DeckMapView.LOCATION_LABEL_LAYER_KEY, new TextLayer<DeckLocationLabelDatum>({
                id: DeckMapView.LOCATION_LABEL_LAYER_KEY,
                data,
                coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
                getPosition: (datum: DeckLocationLabelDatum) => datum.position,
                getText: (datum: DeckLocationLabelDatum) => datum.label,
                getColor: (datum: DeckLocationLabelDatum) => datum.textColor,
                getBackgroundColor: (datum: DeckLocationLabelDatum) => datum.backgroundColor,
                getOutlineColor: () => [0, 0, 0, Math.round(alpha * 255)],
                getOutlineWidth: () => 3,
                getSize: () => 30,
                sizeUnits: "pixels",
                getTextAnchor: () => "middle",
                getAlignmentBaseline: () => "bottom",
                getPixelOffset: () => [0, -44],
                background: true,
                backgroundPadding: [14, 8],
                billboard: true,
                pickable: false,
                parameters: DeckMapView.NO_DEPTH_PARAMETERS
            } as any) as any, 720);
            this.requestRender();

            if (progress >= 1) {
                this.stopLocationLabel();
            }
        };

        this.locationLabelTick = tick;
        this.onTick(tick);
        tick();
    }

    /** Stops and removes the temporary location-search label overlay. */
    private stopLocationLabel(): void {
        if (this.locationLabelTick) {
            this.offTick(this.locationLabelTick);
            this.locationLabelTick = null;
        }
        this.layerRegistry.remove(DeckMapView.LOCATION_LABEL_LAYER_KEY);
    }

    /** Converts Cesium-style colors to deck RGBA tuples with a caller-supplied fallback. */
    private toDeckColor(
        color: Color | undefined,
        fallback: [number, number, number, number]
    ): [number, number, number, number] {
        if (!color) {
            return fallback;
        }
        return [
            Math.max(0, Math.min(255, Math.round(color.r * 255))),
            Math.max(0, Math.min(255, Math.round(color.g * 255))),
            Math.max(0, Math.min(255, Math.round(color.b * 255))),
            Math.max(0, Math.min(255, Math.round(color.a * 255)))
        ];
    }

    /** Builds the geometry description for one tile-state overlay raster. */
    private tileStateOverlayGeometry(extent: TileGridLevelExtent): TileGridOverlayGeometry {
        const {localMin, localSize} = this.tileGridLocalBounds(extent);
        return {
            data: this.buildTileGridOverlayData(
                extent.west,
                extent.east,
                extent.south,
                extent.north,
                [extent.level],
                localMin,
                localSize,
                extent.coversFullWorldX
            ),
            localMin,
            localSize,
            subdivisionX: extent.width,
            subdivisionY: extent.height
        };
    }

    /** Builds the geometry description for one tile-grid line overlay level. */
    private tileGridOverlayGeometry(level: number, viewport: Viewport): TileGridOverlayGeometry {
        if (!viewport) {
            return {
                data: tileGridOverlayData(),
                localMin: [0, 0],
                localSize: [1, 1],
                subdivisionX: 1,
                subdivisionY: 1
            };
        }
        const extent = tileGridExtentForLevel(level, viewport, this.tileGridMode);
        if (!extent) {
            return {
                data: tileGridOverlayData(),
                localMin: [0, 0],
                localSize: [1, 1],
                subdivisionX: 1,
                subdivisionY: 1
            };
        }
        const {localMin, localSize} = this.tileGridLocalBounds(extent);
        const rowsForLevel = Math.pow(2, Math.max(0, Math.min(22, level)));
        const colsForLevel = this.tileGridMode === "nds" ? rowsForLevel * 2 : rowsForLevel;
        return {
            data: this.buildTileGridOverlayData(
                extent.west,
                extent.east,
                extent.south,
                extent.north,
                [level],
                localMin,
                localSize,
                extent.coversFullWorldX
            ),
            localMin,
            localSize,
            subdivisionX: Math.max(1, Math.round(localSize[0] * colsForLevel)),
            subdivisionY: Math.max(1, Math.round(localSize[1] * rowsForLevel))
        };
    }

    /** Returns the local normalized bounds passed to the tile-grid shader modules. */
    private tileGridLocalBounds(extent: TileGridLevelExtent): {localMin: [number, number]; localSize: [number, number]} {
        return {
            localMin: [
                extent.minCol / extent.colCount,
                extent.minRow / extent.rowCount
            ],
            localSize: [
                Math.max(1e-6, (extent.maxCol - extent.minCol) / extent.colCount),
                Math.max(1e-6, (extent.maxRow - extent.minRow) / extent.rowCount)
            ]
        };
    }

    /**
     * Builds one or more overlay polygons covering the requested bounds.
     * NDS mode may split the latitude range into bands so each band gets its own correction curve.
     */
    private buildTileGridOverlayData(
        west: number,
        east: number,
        south: number,
        north: number,
        levels: number[],
        localMin: [number, number],
        localSize: [number, number],
        coversFullWorldX: boolean
    ): TileGridOverlayDatum[] {
        const polygonsForBounds = (bandSouth: number, bandNorth: number): [number, number][][] => {
            if (!coversFullWorldX) {
                return [[
                    [west, bandSouth],
                    [west, bandNorth],
                    [east, bandNorth],
                    [east, bandSouth]
                ]];
            }
            return this.tileGridFullWorldPolygons(
                -180,
                180,
                bandSouth,
                bandNorth,
                this.tileGridFullWorldSplitLongitude(levels)
            );
        };

        if (this.tileGridMode !== "nds") {
            return polygonsForBounds(south, north).map(polygon => ({
                polygon,
                ndsYCorrection: [0, 1, 0]
            }));
        }

        const bandCount = this.tileGridNdsBandCount(north, south);
        const mercatorNorth = tileGridLatToNormY(north, "xyz");
        const mercatorSouth = tileGridLatToNormY(south, "xyz");
        const data: TileGridOverlayDatum[] = [];
        for (let bandIndex = 0; bandIndex < bandCount; bandIndex++) {
            const t0 = bandIndex / bandCount;
            const t1 = (bandIndex + 1) / bandCount;
            const bandMercatorNorth = mercatorNorth + (mercatorSouth - mercatorNorth) * t0;
            const bandMercatorSouth = mercatorNorth + (mercatorSouth - mercatorNorth) * t1;
            const bandNorth = tileGridNormYToLat(bandMercatorNorth, "xyz");
            const bandSouth = tileGridNormYToLat(bandMercatorSouth, "xyz");
            const ndsYCorrection = this.tileGridNdsBandCorrection(localMin[1], localSize[1], bandNorth, bandSouth);
            for (const polygon of polygonsForBounds(bandSouth, bandNorth)) {
                data.push({polygon, ndsYCorrection});
            }
        }
        return data;
    }

    /**
     * A single 360-degree quad is unstable in deck's LNGLAT path. Split the
     * full-world overlay into two adjacent primitives and keep shader space continuous.
     */
    private tileGridFullWorldPolygons(
        west: number,
        east: number,
        south: number,
        north: number,
        splitLongitude: number
    ): [number, number][][] {
        return [
            [
                [west, south],
                [west, north],
                [splitLongitude, north],
                [splitLongitude, south]
            ],
            [
                [splitLongitude, south],
                [splitLongitude, north],
                [east, north],
                [east, south]
            ]
        ];
    }

    /**
     * Keep the full-world split seam away from all visible vertical grid lines.
     * Otherwise the seam itself can swallow one subdivision family.
     */
    private tileGridFullWorldSplitLongitude(levels: number[]): number {
        const finestLevel = levels.reduce(
            (maxLevel, level) => Math.max(maxLevel, Math.max(0, Math.min(22, Math.floor(level)))),
            0
        );
        const finestRowCount = Math.pow(2, finestLevel);
        const finestColCount = this.tileGridMode === "nds" ? finestRowCount * 2 : finestRowCount;
        const splitNormX = 0.5 + 0.5 / Math.max(2, finestColCount);
        return -180 + 360 * splitNormX;
    }

    /**
     * Computes the local Y correction that bends the linear NDS field toward Mercator.
     * The correction stays centered on the latitude midpoint to preserve precision.
     */
    private tileGridNdsBandCount(north: number, south: number): number {
        const mercatorNorth = tileGridLatToNormY(north, "xyz");
        const mercatorSouth = tileGridLatToNormY(south, "xyz");
        const mercatorSpan = Math.abs(mercatorSouth - mercatorNorth);
        if (mercatorSpan >= 0.75) {
            return 8;
        }
        if (mercatorSpan >= 0.4) {
            return 4;
        }
        if (mercatorSpan >= 0.18) {
            return 2;
        }
        return 1;
    }

    /**
     * Fits a local quadratic for one latitude band in global overlay space.
     * The rasterizer interpolates the NDS Y values linearly in Mercator space,
     * so we fit the inverse of that distortion over each band separately.
     */
    private tileGridNdsBandCorrection(
        localMinY: number,
        localSizeY: number,
        north: number,
        south: number
    ): [number, number, number] {
        if (localSizeY <= 1e-9) {
            return [0, 1, 0];
        }
        const northLocalY = this.tileGridLocalNdsY(north, localMinY, localSizeY);
        const southLocalY = this.tileGridLocalNdsY(south, localMinY, localSizeY);
        const mercatorNorthY = tileGridLatToNormY(north, "xyz");
        const mercatorSouthY = tileGridLatToNormY(south, "xyz");
        const mercatorMidY = 0.5 * (mercatorNorthY + mercatorSouthY);
        const midpointLat = tileGridNormYToLat(mercatorMidY, "xyz");
        const midpointInputY = 0.5 * (northLocalY + southLocalY);
        const midpointOutputY = this.tileGridLocalNdsY(midpointLat, localMinY, localSizeY);
        return this.tileGridQuadraticThroughPoints(
            northLocalY,
            northLocalY,
            midpointInputY,
            midpointOutputY,
            southLocalY,
            southLocalY
        );
    }

    /** Converts a latitude to shader-local NDS Y coordinates for one overlay extent. */
    private tileGridLocalNdsY(lat: number, localMinY: number, localSizeY: number): number {
        const ndsY = tileGridLatToNormY(lat, "nds");
        return (ndsY - localMinY) / Math.max(1e-6, localSizeY);
    }

    /** Fits a quadratic through three samples; used for NDS-to-Mercator correction bands. */
    private tileGridQuadraticThroughPoints(
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        x2: number,
        y2: number
    ): [number, number, number] {
        const d0 = (x0 - x1) * (x0 - x2);
        const d1 = (x1 - x0) * (x1 - x2);
        const d2 = (x2 - x0) * (x2 - x1);
        if (Math.abs(d0) < 1e-9 || Math.abs(d1) < 1e-9 || Math.abs(d2) < 1e-9) {
            return [0, 1, 0];
        }
        const l0 = y0 / d0;
        const l1 = y1 / d1;
        const l2 = y2 / d2;
        const quadratic = l0 + l1 + l2;
        const linear = -l0 * (x1 + x2) - l1 * (x0 + x2) - l2 * (x0 + x1);
        const constant = l0 * x1 * x2 + l1 * x0 * x2 + l2 * x0 * x1;
        return [constant, linear, quadratic];
    }

    /** Normalizes longitude into the conventional [-180, 180] range. */
    private normalizeLongitude(lon: number): number {
        return ((lon + 180) % 360 + 360) % 360 - 180;
    }

    /** Normalizes an angle to [0, 360). */
    private normalizeDegrees(value: number): number {
        return (value % 360 + 360) % 360;
    }

    /** Estimates deck zoom from altitude using the current latitude and an assumed vertical FOV. */
    private altitudeToZoom(altitude: number, latitude: number): number {
        const safeAltitude = Math.max(1, altitude);
        const viewportHeight = this.getViewportHeightPixels();
        const latitudeCos = Math.max(0.01, Math.cos(GeoMath.toRadians(latitude)));
        const visibleHeightMeters = 2 * safeAltitude * Math.tan(DeckMapView.ASSUMED_VERTICAL_FOV_RADIANS / 2);
        const metersPerPixel = Math.max(1e-6, visibleHeightMeters / viewportHeight);
        const worldMetersAtLatitude = latitudeCos * 2 * Math.PI * DeckMapView.EARTH_RADIUS_METERS;
        return Math.max(
            0,
            Math.min(
                22,
                Math.log2(worldMetersAtLatitude / (DeckMapView.WEB_MERCATOR_TILE_SIZE * metersPerPixel))
            )
        );
    }

    /** Estimates altitude from zoom using the current latitude and an assumed vertical FOV. */
    private zoomToAltitude(zoom: number, latitude: number = this.viewState.latitude): number {
        const viewportHeight = this.getViewportHeightPixels();
        const metersPerPixel = this.metersPerPixelAtZoom(zoom, latitude);
        const visibleHeightMeters = metersPerPixel * viewportHeight;
        const altitude =
            visibleHeightMeters / (2 * Math.tan(DeckMapView.ASSUMED_VERTICAL_FOV_RADIANS / 2));
        return Math.max(1, altitude);
    }

    /** Estimate the horizontal world-space size represented by one screen pixel. */
    private metersPerPixelAtZoom(zoom: number, latitude: number): number {
        const latitudeCos = Math.max(
            0.01,
            Math.cos(GeoMath.toRadians(latitude))
        );
        const worldMetersAtLatitude = latitudeCos * 2 * Math.PI *
            DeckMapView.EARTH_RADIUS_METERS;
        return worldMetersAtLatitude /
            (DeckMapView.WEB_MERCATOR_TILE_SIZE * Math.pow(2, zoom));
    }

    /** Returns the current viewport height in pixels, with DOM-based fallbacks during initialization. */
    private getViewportHeightPixels(): number {
        const canvasHeight = Number(this.deck?.getCanvas?.()?.clientHeight ?? 0);
        if (Number.isFinite(canvasHeight) && canvasHeight > 0) {
            return canvasHeight;
        }
        const containerHeight =
            Number((document.getElementById(this.canvasId) as HTMLDivElement | null)?.clientHeight ?? 0);
        if (Number.isFinite(containerHeight) && containerHeight > 0) {
            return containerHeight;
        }
        return DeckMapView.FALLBACK_VIEWPORT_HEIGHT_PX;
    }

    /** Resolves the center feature or center ground point for UI camera commands. */
    private commandNavigationAnchor(): {
        pivot: NavigationAnchor;
        pixel: [number, number];
        origin: NavigationTargetOrigin;
    } | null {
        const viewport = this.createWebMercatorViewport();
        if (!viewport) {
            return null;
        }
        if (this.retainedNavigationPivot) {
            const localPivot: NavigationAnchor = [
                longitudeInNearestWorld(this.retainedNavigationPivot[0], viewport.longitude),
                this.retainedNavigationPivot[1],
                this.retainedNavigationPivot[2]
            ];
            const projected = viewport.project(localPivot);
            if (isNavigationAnchorUsable(viewport, localPivot, true)) {
                return {
                    pivot: localPivot,
                    pixel: [projected[0], projected[1]],
                    origin: this.retainedNavigationOrigin ?? "unknown"
                };
            }
            this.retainedNavigationPivot = null;
            this.retainedNavigationSurfaceNormal = null;
            this.retainedNavigationOrigin = null;
        }
        const centerPixel: [number, number] = [viewport.width / 2, viewport.height / 2];
        const centerFeature = this.pickNavigationTarget({x: centerPixel[0], y: centerPixel[1]});
        if (centerFeature) {
            this.onControllerNavigationTargetChange(centerFeature, false);
            return {
                pivot: centerFeature.position,
                pixel: centerPixel,
                origin: centerFeature.origin ?? "unknown"
            };
        }
        const groundPosition = viewport.unproject(centerPixel, {targetZ: 0});
        if (groundPosition.length < 3 || !groundPosition.every(Number.isFinite)) {
            return null;
        }
        return {
            pivot: [groundPosition[0], groundPosition[1], groundPosition[2]],
            pixel: centerPixel,
            origin: "ground"
        };
    }

    /** Applies one map camera change while preserving the shared 3D anchor at a shifted pixel. */
    private applyAnchoredMapViewState(
        nextState: DeckCameraState,
        pixelOffset: [number, number] = [0, 0]
    ): void {
        const sanitizedNext = this.sanitizeViewState(nextState);
        const anchor = this.commandNavigationAnchor();
        let anchoredState = sanitizedNext;
        if (anchor) {
            const viewport = this.createWebMercatorViewport();
            if (viewport) {
                const targetPixel: [number, number] = [
                    anchor.pixel[0] + pixelOffset[0],
                    anchor.pixel[1] + pixelOffset[1]
                ];
                anchoredState = this.isFeatureNavigationOrigin(anchor.origin)
                    ? viewStateKeepingNavigationAnchor(
                        this.viewState,
                        sanitizedNext,
                        anchor.pivot,
                        targetPixel,
                        viewport.width,
                        viewport.height,
                        this.useOrthographicProjection,
                        this.stateService.featureZoomClearanceMeters
                    )
                    : viewStateKeepingAnchor(
                        sanitizedNext,
                        anchor.pivot,
                        targetPixel,
                        viewport.width,
                        viewport.height,
                        this.useOrthographicProjection
                    );
            }
        }
        this.updateViewState(anchoredState, true, true);
        this.pushViewStateToAppState();
    }

    /** Returns whether a semantic target is an actual rendered feature rather than ground. */
    private isFeatureNavigationOrigin(origin: NavigationTargetOrigin | undefined): boolean {
        return origin === "feature" || origin === "path" || origin === "gltf-proxy";
    }

    /** Samples the current feature clearance once when deck.gl acquires a target session. */
    private minimumTargetDistanceForOrigin(
        origin: NavigationTargetOrigin | undefined
    ): number | undefined {
        if (!this.isFeatureNavigationOrigin(origin)) {
            return undefined;
        }
        const clearance = this.stateService.featureZoomClearanceMeters;
        return clearance > 0 ? clearance : undefined;
    }

    /** Moves the camera parallel to the map plane in view-local screen space. */
    private applyPan(xFactor: number, yFactor: number): void {
        this.stateService.focusedView = this._viewIndex;
        const pixelOffset: [number, number] = [
            -xFactor * DeckMapView.NAVIGATION_COMMAND_STEP_PX,
            yFactor * DeckMapView.NAVIGATION_COMMAND_STEP_PX
        ];
        if (this.useOrthographicProjection) {
            this.applyAnchoredMapViewState(this.viewState, pixelOffset);
            return;
        }

        const viewport = this.createWebMercatorViewport();
        if (!viewport) {
            return;
        }
        const next = planarPanViewState(viewport, pixelOffset);
        if (!next) {
            return;
        }
        this.updateViewState({
            ...this.viewState,
            ...next,
            position: [...next.position]
        }, true, true);
        this.pushViewStateToAppState();
    }

    /** RAF tick loop used by compass updates and temporary overlay animations. */
    private tick = () => {
        for (const cb of this.tickCallbacks) {
            cb();
        }
        if (this.tickCallbacks.size === 0) {
            this.tickHandle = null;
            return;
        }
        this.tickHandle = requestAnimationFrame(this.tick);
    };

    /** Stops the shared RAF tick loop if it is currently running. */
    private stopTickLoop(): void {
        if (this.tickHandle === null) {
            return;
        }
        cancelAnimationFrame(this.tickHandle);
        this.tickHandle = null;
    }
}
