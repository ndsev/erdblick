import {BehaviorSubject, combineLatest, distinctUntilChanged, Subscription} from "rxjs";
import {
    COORDINATE_SYSTEM,
    Deck as DeckGlDeck,
    type DeckProps,
    MapView as DeckMercatorView,
    type PickingInfo,
    WebMercatorViewport
} from "@deck.gl/core";
import {BitmapLayer, IconLayer, PolygonLayer} from "@deck.gl/layers";
import {TileLayer} from "@deck.gl/geo-layers";
import {getBounds as getWebMercatorBounds} from "@math.gl/web-mercator";
import type {Parameters as LumaParameters} from "@luma.gl/core";
import {Cartographic, Color, GeoMath, SceneMode} from "../../integrations/geo";
import {MapDataService, TileVisualizationRenderTask} from "../../mapdata/map.service";
import {FeatureSearchService} from "../../search/feature.search.service";
import {JumpTargetService} from "../../search/jump.service";
import {RightClickMenuService, TileOutlinePayload} from "../rightclickmenu.service";
import {CoordinatesService} from "../../coords/coordinates.service";
import {AppStateService, CameraViewState, TileFeatureId, TileGridMode} from "../../shared/appstate.service";
import {IRenderSceneHandle, IRenderView, ITileVisualization} from "../render-view.model";
import {Viewport} from "../../../build/libs/core/erdblick-core";
import {DeckLayerRegistry} from "./deck-layer-registry";
import {environment} from "../../environments/environment";
import {MergedPointsTile} from "../pointmerge.service";
import {coreLib} from "../../integrations/wasm";
import {
    TileGridOverlayDatum,
    TILE_STATE_KIND_EMPTY,
    TILE_STATE_KIND_ERROR,
    TileGridOverlayLayer,
    TileGridStateOverlayLayer,
    tileGridOverlayData
} from "./deck-tile-grid-overlay.layer";
import {SearchResultClusterLayer, SearchResultClusterPoint} from "./deck-search-result-cluster.layer";

interface DeckCameraState {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch: number;
    bearing: number;
    maxPitch: number;
}

interface TileGridOverlayGeometry {
    data: TileGridOverlayDatum[];
    localMin: [number, number];
    localSize: [number, number];
    subdivisionsX: number[];
    subdivisionsY: number[];
}

interface VisibleLayerRef {
    mapId: string;
    layerId: string;
}

interface DeckRectangleOverlayDatum {
    polygon: [number, number][];
    fillColor: [number, number, number, number];
    lineColor: [number, number, number, number];
    lineWidthPixels: number;
}

interface DeckLocationMarkerDatum {
    position: [number, number];
}

interface TileGridLevelExtent {
    level: number;
    rowCount: number;
    colCount: number;
    coversFullWorldX: boolean;
    minCol: number;
    maxCol: number;
    minRow: number;
    maxRow: number;
    width: number;
    height: number;
    west: number;
    east: number;
    south: number;
    north: number;
}

interface DeckPickLayerProps {
    tileKey?: string;
    featureIds?: Array<number | null>;
    featureIdsByVertex?: Array<number | null>;
}

interface DeckGestureEventLike {
    srcEvent?: {
        button?: number;
        ctrlKey?: boolean;
    };
}

/**
 * Minimal deck.gl map view scaffold used to wire renderer switching and camera-state sync.
 * Detailed deck tile rendering is introduced in later migration tasks.
 */
export abstract class DeckMapView implements IRenderView {
    private static readonly EARTH_RADIUS_METERS = 6378137;
    private static readonly WEB_MERCATOR_TILE_SIZE = 512;
    private static readonly ASSUMED_VERTICAL_FOV_RADIANS = GeoMath.toRadians(60);
    private static readonly FALLBACK_VIEWPORT_HEIGHT_PX = 1080;
    private static readonly MAX_VIEWPORT_LONGITUDE_SPAN = 360;
    private static readonly WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
    private static readonly OSM_LAYER_KEY = "osm/tile-layer";
    private static readonly OSM_TILE_URL_TEMPLATE = "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png";
    private static readonly TILE_GRID_LAYER_KEY = "builtin/tile-grid";
    private static readonly TILE_STATE_LAYER_KEY = "builtin/tile-state";
    private static readonly TILE_OUTLINE_LAYER_KEY = "builtin/tile-outline";
    private static readonly JUMP_AREA_LAYER_KEY = "builtin/jump-area";
    private static readonly SEARCH_RESULTS_LAYER_KEY = "builtin/search-results";
    private static readonly LOCATION_MARKER_LAYER_KEY = "builtin/location-marker";
    private static readonly CANVAS_RESIZE_DEBOUNCE_MS = 64;
    private static readonly LOCATION_MARKER_ICON_NAME = "marker";
    private static readonly LOCATION_MARKER_ICON_SIZE_PX = 48;
    private static readonly LOCATION_MARKER_RENDER_SIZE_PX = 32;
    private static readonly JUMP_AREA_HIGHLIGHT_DURATION_MS = 3000;
    private static readonly TILE_GRID_LINE_COLOR: [number, number, number, number] = [245, 245, 245, 100];
    private static readonly TILE_GRID_LINE_WIDTH_PX = 1.0;
    private static readonly TILE_GRID_MAX_VISIBLE_CELLS = 16 * 1024;
    private static readonly TILE_STATE_ERROR_COLOR: [number, number, number, number] = [225, 45, 45, 105];
    private static readonly TILE_STATE_EMPTY_COLOR: [number, number, number, number] = [122, 126, 133, 64];
    // Diagnostic mode: force solid red fill from shader to verify overlay visibility/lifecycle.
    private static readonly TILE_GRID_DEBUG_SOLID = false;
    private static readonly NO_DEPTH_PARAMETERS: LumaParameters = {
        depthWriteEnabled: false,
        depthCompare: "always",
        cullMode: "none"
    };

    protected readonly _viewIndex: number;
    readonly canvasId: string;
    protected deck: DeckGlDeck<DeckMercatorView> | null = null;
    protected readonly layerRegistry = new DeckLayerRegistry();
    protected readonly subscriptions: Subscription[] = [];
    protected viewState: DeckCameraState = {
        longitude: 0,
        latitude: 0,
        zoom: 2,
        pitch: 0,
        bearing: 0,
        maxPitch: 85
    };

    hoveredFeatureIds: BehaviorSubject<{
        featureIds: (TileFeatureId | null)[];
        position: {x: number; y: number};
    } | undefined> = new BehaviorSubject<{
        featureIds: (TileFeatureId | null)[];
        position: {x: number; y: number};
    } | undefined>(undefined);

    private ignoreNextCamAppStateUpdate = false;
    private suppressDeckViewStateEvent = false;
    private readonly tickCallbacks = new Set<() => void>();
    private tickHandle: number | null = null;
    private osmLayerEnabled = false;
    private osmLayerOpacity = -1;
    private tileGridEnabled = false;
    private tileGridMode: TileGridMode = "nds";
    private lastTileGridDiagnosticSignature = "";
    private tileStateLayerKeys = new Set<string>();
    private tileGridOverlayUpdateRaf: number | null = null;
    private tileGridOverlayDataRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private searchResultsOverlayUpdateRaf: number | null = null;
    private searchResultsOverlayDataRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private lastSearchResultsPointsVersion = -1;
    private lastSearchResultsIconAtlasUrl = "";
    private lastSearchResultsIconMappingUrl = "";
    private lastLocationMarkerSignature = "";
    private jumpAreaHighlightTick: (() => void) | null = null;

    get viewIndex() {
        return this._viewIndex;
    }

    protected abstract readonly sceneMode: SceneMode;
    protected abstract readonly allowPitchAndBearing: boolean;
    protected readonly useOrthographicProjection: boolean = false;

    constructor(id: number,
                canvasId: string,
                protected mapService: MapDataService,
                protected featureSearchService: FeatureSearchService,
                protected jumpService: JumpTargetService,
                protected menuService: RightClickMenuService,
                protected coordinatesService: CoordinatesService,
                protected stateService: AppStateService) {
        this._viewIndex = id;
        this.canvasId = canvasId;
    }

    async setup(): Promise<void> {
        const container = document.getElementById(this.canvasId) as HTMLDivElement | null;
        if (!container) {
            throw new Error(`Deck container #${this.canvasId} not found.`);
        }
        container.innerHTML = "";

        this.setViewFromState(this.stateService.cameraViewDataState.getValue(this._viewIndex));

        const deckProps: DeckProps<DeckMercatorView> = {
            parent: container,
            // Lowering device pixel ratio reduces redraw pressure during live resizes.
            useDevicePixels: 1,
            deviceProps: {
                createCanvasContext: {
                    resizeDebounceMs: DeckMapView.CANVAS_RESIZE_DEBOUNCE_MS
                }
            },
            views: new DeckMercatorView({
                id: `deck-view-${this._viewIndex}`,
                repeat: true,
                orthographic: this.useOrthographicProjection
            }),
            initialViewState: this.viewState,
            viewState: this.viewState,
            layers: [],
            controller: this.allowPitchAndBearing ? true : {
                dragRotate: false,
                touchRotate: false,
                keyboard: false
            },
            onViewStateChange: ({viewState}) => this.onViewStateChange(viewState as DeckCameraState),
            onHover: (info) => this.onHover(info),
            onClick: (info, event) => this.onClick(info, event)
        };
        this.deck = new DeckGlDeck(deckProps);
        this.layerRegistry.setDeck(this.deck);

        this.setupSubscriptions();
        this.updateViewport();
        this.requestRender();
    }

    async destroy(): Promise<void> {
        this.subscriptions.forEach(sub => sub.unsubscribe());
        this.subscriptions.length = 0;
        this.stopTickLoop();
        this.cancelTileGridOverlayUpdateScheduling();
        this.cancelSearchResultsOverlayScheduling();
        this.tickCallbacks.clear();
        this.hoveredFeatureIds.next(undefined);
        this.layerRegistry.remove(DeckMapView.OSM_LAYER_KEY);
        this.layerRegistry.remove(DeckMapView.TILE_GRID_LAYER_KEY);
        this.layerRegistry.remove(DeckMapView.TILE_OUTLINE_LAYER_KEY);
        this.layerRegistry.remove(DeckMapView.JUMP_AREA_LAYER_KEY);
        this.layerRegistry.remove(DeckMapView.SEARCH_RESULTS_LAYER_KEY);
        this.layerRegistry.remove(DeckMapView.LOCATION_MARKER_LAYER_KEY);
        this.removeTileStateLayers();
        this.stopJumpAreaHighlight();
        this.osmLayerEnabled = false;
        this.osmLayerOpacity = -1;
        this.tileGridEnabled = false;
        this.layerRegistry.destroy();
        this.mapService.clearAllTileVisualizations(this._viewIndex, this.getSceneHandle());

        if (this.deck) {
            this.deck.finalize();
            this.deck = null;
        }

        const container = document.getElementById(this.canvasId);
        if (container) {
            container.innerHTML = "";
        }
    }

    isAvailable(): boolean {
        return this.deck !== null;
    }

    requestRender(): void {
        if (!this.deck) {
            return;
        }
        this.deck.redraw();
    }

    getCanvasClientRect(): DOMRect {
        const canvas = this.deck?.getCanvas();
        if (!canvas) {
            return new DOMRect();
        }
        return canvas.getBoundingClientRect();
    }

    getCameraHeadingDegrees(): number {
        return this.viewState.bearing;
    }

    onTick(cb: () => void): void {
        this.tickCallbacks.add(cb);
        if (this.tickHandle === null) {
            this.tickHandle = requestAnimationFrame(this.tick);
        }
    }

    offTick(cb: () => void): void {
        this.tickCallbacks.delete(cb);
        if (this.tickCallbacks.size === 0) {
            this.stopTickLoop();
        }
    }

    getSceneMode(): SceneMode {
        return this.sceneMode;
    }

    getSceneHandle(): IRenderSceneHandle {
        return {
            renderer: "deck",
            scene: {
                deck: this.deck,
                layerRegistry: this.layerRegistry,
                sceneMode: this.sceneMode
            }
        };
    }

    pickFeature(screenPos: {x: number; y: number}): (TileFeatureId | null)[] {
        if (!this.deck) {
            return [];
        }
        const picked = this.deck.pickObject({
            x: screenPos.x,
            y: screenPos.y,
            radius: 4
        });
        if (!picked) {
            return [];
        }

        const resolveFeatureIndex = (
            tileKey: string | undefined,
            value: unknown
        ): TileFeatureId | null => {
            if (!Number.isInteger(value)) {
                return null;
            }
            if (!tileKey) {
                return null;
            }
            return this.mapService.resolveTileFeatureIdByIndex(tileKey, value as number);
        };

        const objectTileKey = (picked.layer?.props as DeckPickLayerProps | undefined)?.tileKey;
        const pickedObject = picked.object;
        const objectIdTileKeys = Array.isArray(pickedObject?.idTileKeys)
            ? pickedObject.idTileKeys as unknown[]
            : undefined;
        const objectId = pickedObject?.id ?? pickedObject?.featureId;
        if (objectId !== undefined && objectId !== null) {
            if (Array.isArray(objectId)) {
                return objectId
                    .map((value, index) => {
                        const idTileKey = typeof objectIdTileKeys?.[index] === "string"
                            ? objectIdTileKeys[index] as string
                            : objectTileKey;
                        return resolveFeatureIndex(idTileKey, value);
                    })
                    .filter((value): value is TileFeatureId => value !== null);
            }
            const resolved = resolveFeatureIndex(objectTileKey, objectId);
            return resolved ? [resolved] : [];
        }

        const pickedIndex = Number(picked.index);
        const layerProps = picked.layer?.props as DeckPickLayerProps | undefined;
        if (Number.isInteger(pickedIndex) && pickedIndex >= 0) {
            const featureIds = layerProps?.featureIds;
            if (Array.isArray(featureIds) && pickedIndex < featureIds.length) {
                const resolved = resolveFeatureIndex(layerProps?.tileKey, featureIds[pickedIndex]);
                return resolved ? [resolved] : [];
            }
            const featureIdsByVertex = layerProps?.featureIdsByVertex;
            if (Array.isArray(featureIdsByVertex) && pickedIndex < featureIdsByVertex.length) {
                const resolved = resolveFeatureIndex(layerProps?.tileKey, featureIdsByVertex[pickedIndex]);
                return resolved ? [resolved] : [];
            }
        }
        return [];
    }

    pickCartographic(screenPos: {x: number; y: number}): { lon: number; lat: number; alt: number } | undefined {
        const viewport = this.createWebMercatorViewport();
        if (!viewport) {
            return undefined;
        }
        const [lon, lat] = viewport.unproject([screenPos.x, screenPos.y]);
        return {lon, lat, alt: this.zoomToAltitude(this.viewState.zoom, lat)};
    }

    setViewFromState(cameraData: CameraViewState): void {
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
            maxPitch
        };
        this.updateViewState(next, true, true);
    }

    getViewState(): CameraViewState {
        return this.stateService.cameraViewDataState.getValue(this._viewIndex);
    }

    computeViewport(): Viewport | undefined {
        const viewport = this.createWebMercatorViewport();
        if (!viewport) {
            return undefined;
        }

        // Use the full ground-footprint quad instead of diagonal screen samples.
        // The diagonal approximation collapses under pitch/bearing and briefly turns the
        // tile-loading viewport into a thin strip while the camera is rotating.
        const corners = getWebMercatorBounds(
            viewport as unknown as Parameters<typeof getWebMercatorBounds>[0],
            0
        );
        if (!Array.isArray(corners) || corners.length !== 4) {
            return undefined;
        }

        const centerLon = this.viewState.longitude;
        const longitudes = corners.map(corner => this.unwrapLongitudeNear(centerLon, Number(corner[0])));
        const latitudes = corners.map(corner => Number(corner[1]));
        if (![...longitudes, ...latitudes].every(Number.isFinite)) {
            return undefined;
        }

        const west = Math.min(...longitudes);
        const east = Math.max(...longitudes);
        const south = Math.min(...latitudes);
        const north = Math.max(...latitudes);
        const sizeLon = Math.abs(east - west);
        const sizeLat = Math.abs(north - south);
        if (![west, east, south, north, sizeLon, sizeLat].every(Number.isFinite)) {
            return undefined;
        }
        if (sizeLon >= DeckMapView.MAX_VIEWPORT_LONGITUDE_SPAN) {
            const fullWorldViewport: Viewport = {
                south: -DeckMapView.WEB_MERCATOR_MAX_LATITUDE,
                west: this.viewState.longitude - DeckMapView.MAX_VIEWPORT_LONGITUDE_SPAN / 2,
                width: DeckMapView.MAX_VIEWPORT_LONGITUDE_SPAN,
                height: DeckMapView.WEB_MERCATOR_MAX_LATITUDE * 2,
                camPosLon: this.viewState.longitude,
                camPosLat: this.viewState.latitude,
                orientation: -GeoMath.toRadians(this.viewState.bearing) + Math.PI * 0.5
            };
            return Object.values(fullWorldViewport).every(Number.isFinite) ? fullWorldViewport : undefined;
        }
        const expandLon = sizeLon * 0.05;
        const expandLat = sizeLat * 0.05;
        const expandedWidth = sizeLon + expandLon * 2;
        if (expandedWidth >= DeckMapView.MAX_VIEWPORT_LONGITUDE_SPAN) {
            const fullWorldViewport: Viewport = {
                south: -DeckMapView.WEB_MERCATOR_MAX_LATITUDE,
                west: this.viewState.longitude - DeckMapView.MAX_VIEWPORT_LONGITUDE_SPAN / 2,
                width: DeckMapView.MAX_VIEWPORT_LONGITUDE_SPAN,
                height: DeckMapView.WEB_MERCATOR_MAX_LATITUDE * 2,
                camPosLon: this.viewState.longitude,
                camPosLat: this.viewState.latitude,
                orientation: -GeoMath.toRadians(this.viewState.bearing) + Math.PI * 0.5
            };
            return Object.values(fullWorldViewport).every(Number.isFinite) ? fullWorldViewport : undefined;
        }
        const clampedSouth = Math.max(-DeckMapView.WEB_MERCATOR_MAX_LATITUDE, south - expandLat);
        const clampedNorth = Math.min(DeckMapView.WEB_MERCATOR_MAX_LATITUDE, north + expandLat);

        const nextViewport: Viewport = {
            south: clampedSouth,
            west: west - expandLon,
            width: expandedWidth,
            height: Math.max(0, clampedNorth - clampedSouth),
            camPosLon: this.viewState.longitude,
            camPosLat: this.viewState.latitude,
            // Keep tile-priority orientation consistent with the legacy viewport contract.
            orientation: -GeoMath.toRadians(this.viewState.bearing) + Math.PI * 0.5
        };
        return Object.values(nextViewport).every(Number.isFinite) ? nextViewport : undefined;
    }

    moveUp(): void {
        this.applyPan(0, 1);
    }

    moveDown(): void {
        this.applyPan(0, -1);
    }

    moveLeft(): void {
        this.applyPan(-1, 0);
    }

    moveRight(): void {
        this.applyPan(1, 0);
    }

    zoomIn(): void {
        this.stateService.focusedView = this._viewIndex;
        this.updateViewState({
            ...this.viewState,
            zoom: this.viewState.zoom + 0.5
        }, true, true);
        this.pushViewStateToAppState();
    }

    zoomOut(): void {
        this.stateService.focusedView = this._viewIndex;
        this.updateViewState({
            ...this.viewState,
            zoom: this.viewState.zoom - 0.5
        }, true, true);
        this.pushViewStateToAppState();
    }

    resetOrientation(): void {
        this.stateService.focusedView = this._viewIndex;
        this.updateViewState({
            ...this.viewState,
            pitch: 0,
            bearing: 0
        }, true, true);
        this.pushViewStateToAppState();
    }

    protected updateViewport(): void {
        const viewport = this.computeViewport();
        if (!viewport) {
            return;
        }
        this.mapService.setViewport(this._viewIndex, viewport);
    }

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
            this.stateService.osmState.pipe(this._viewIndex).subscribe((osmState) => {
                this.updateOsmLayers(osmState.enabled, osmState.opacity / 100);
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
            this.mapService.maps$.subscribe(() => this.scheduleTileGridOverlayUpdate())
        );
        this.subscriptions.push(
            this.mapService.statsDialogNeedsUpdate.subscribe(() => this.scheduleTileGridOverlayDataRefresh())
        );
        this.subscriptions.push(
            this.featureSearchService.progress.subscribe(() => this.scheduleSearchResultsOverlayDataRefresh())
        );

        this.subscriptions.push(
            this.mapService.moveToWgs84PositionTopic.subscribe(value => {
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
            this.mapService.moveToRectangleTopic.subscribe(value => {
                if (value.targetView !== this._viewIndex) {
                    return;
                }
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
            this.mapService.tileVisualizationTopic.subscribe((task: TileVisualizationRenderTask) => {
                const tileVis = task.visualization;
                // The render task topic is shared across all views. Only the
                // owning view may consume and complete the task.
                if (tileVis.viewIndex !== this._viewIndex) {
                    return;
                }
                tileVis.render(this.getSceneHandle())
                    .catch(error => {
                        console.error("Tile visualization render failed.", error);
                    })
                    .finally(() => {
                        task.onDone?.();
                    });
            })
        );

        this.subscriptions.push(
            this.mapService.tileVisualizationDestructionTopic.subscribe((tileVis: ITileVisualization) => {
                if (tileVis.viewIndex !== this._viewIndex) {
                    return;
                }
                tileVis.destroy(this.getSceneHandle());
            })
        );

        this.subscriptions.push(
            this.mapService.mergedTileVisualizationDestructionTopic.subscribe((tileVis: MergedPointsTile) => {
                if (tileVis.viewIndex !== this._viewIndex) {
                    return;
                }
                tileVis.removeScene(this.getSceneHandle());
            })
        );

        this.subscriptions.push(
            this.menuService.tileOutline.subscribe(payload => {
                this.updateTileOutlineLayer(payload);
            })
        );

        this.tileGridEnabled = this.stateService.viewTileBordersState.getValue(this._viewIndex);
        this.tileGridMode = this.stateService.viewTileGridModeState.getValue(this._viewIndex);
        this.updateLocationMarkerOverlay();
        this.scheduleTileGridOverlayUpdate();
        this.scheduleSearchResultsOverlayUpdate();
    }

    private onViewStateChange(rawViewState: DeckCameraState): void {
        if (this.suppressDeckViewStateEvent) {
            return;
        }
        if (this.stateService.focusedView !== this._viewIndex) {
            this.stateService.focusedView = this._viewIndex;
        }
        // Deck is wired in controlled mode (`viewState` prop). User interactions only
        // take effect if we feed the updated camera state back via `setProps`.
        this.updateViewState(rawViewState, true, true);
        this.pushViewStateToAppState();
    }

    private onHover(info: PickingInfo): void {
        if (!info || !Number.isFinite(info.x) || !Number.isFinite(info.y)) {
            this.hoveredFeatureIds.next(undefined);
            return;
        }
        if (!environment.visualizationOnly) {
            const cartographic = this.pickCartographic({x: info.x, y: info.y});
            if (cartographic) {
                this.coordinatesService.mouseMoveCoordinates.next(
                    Cartographic.fromDegrees(cartographic.lon, cartographic.lat, cartographic.alt)
                );
            }
        }
        const featureIds = this.pickFeature({x: info.x, y: info.y});
        if (!featureIds.length) {
            this.hoveredFeatureIds.next(undefined);
            return;
        }
        this.mapService.setHoveredFeatures(featureIds).then(() => {
            this.hoveredFeatureIds.next({
                featureIds,
                position: {x: info.x, y: info.y}
            });
        });
    }

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

        const cartographic = this.pickCartographic({x: info.x, y: info.y});
        if (cartographic) {
            this.coordinatesService.mouseClickCoordinates.next(
                Cartographic.fromDegrees(cartographic.lon, cartographic.lat, cartographic.alt)
            );
        }

        const featureIds = this.pickFeature({x: info.x, y: info.y})
            .filter((id): id is TileFeatureId => !!id);
        if (!featureIds.length) {
            this.stateService.unsetUnlockedSelections();
            this.menuService.tileOutline.next(null);
            return;
        }

        const shouldPinPanel = !!srcEvent?.ctrlKey;
        this.selectFeatureIds(featureIds, shouldPinPanel);
    }

    private selectFeatureIds(featureIds: TileFeatureId[], lockSelection: boolean): void {
        if (!featureIds.length) {
            return;
        }

        if (featureIds.length === 1) {
            const panelId = this.stateService.setSelection([featureIds[0]], undefined, lockSelection);
            if (lockSelection && panelId !== undefined) {
                this.stateService.setInspectionPanelLockedState(panelId, true);
            }
            return;
        }

        // Open one panel per merged feature.
        this.stateService.unsetUnlockedSelections();
        let remainingSlots = Math.max(0, this.stateService.inspectionsLimit - this.stateService.selection.length);
        if (remainingSlots <= 0) {
            return;
        }

        for (const featureId of featureIds) {
            if (remainingSlots <= 0) {
                break;
            }
            const panelId = this.stateService.setSelection([featureId], undefined, true);
            if (panelId === undefined) {
                continue;
            }
            remainingSlots -= 1;
            if (lockSelection) {
                this.stateService.setInspectionPanelLockedState(panelId, true);
            }
        }
    }

    private updateViewState(nextState: DeckCameraState, setDeckProps: boolean, updateViewport: boolean): void {
        const sanitized = this.sanitizeViewState(nextState);
        this.viewState = sanitized;
        if (this.deck && setDeckProps) {
            this.suppressDeckViewStateEvent = true;
            this.deck.setProps({viewState: sanitized});
            this.suppressDeckViewStateEvent = false;
        }
        if (updateViewport) {
            this.updateViewport();
            const osmState = this.stateService.getOsmState(this._viewIndex);
            this.updateOsmLayers(osmState.enabled, osmState.opacity / 100);
            this.scheduleTileGridOverlayUpdate();
        }
    }

    private pushViewStateToAppState(): void {
        this.ignoreNextCamAppStateUpdate = true;
        this.stateService.setView(
            this._viewIndex,
            Cartographic.fromDegrees(
                this.viewState.longitude,
                this.viewState.latitude,
                this.zoomToAltitude(this.viewState.zoom, this.viewState.latitude)
            ),
            {
                heading: GeoMath.toRadians(this.viewState.bearing),
                pitch: GeoMath.toRadians(this.viewState.pitch - 90),
                roll: 0
            }
        );
    }

    private sanitizeViewState(next: DeckCameraState): DeckCameraState {
        const longitude = Number.isFinite(next.longitude) ? next.longitude : this.viewState.longitude;
        const latitude = Number.isFinite(next.latitude) ? next.latitude : this.viewState.latitude;
        const zoom = Number.isFinite(next.zoom) ? next.zoom : this.viewState.zoom;
        const pitch = Number.isFinite(next.pitch) ? next.pitch : this.viewState.pitch;
        const bearing = Number.isFinite(next.bearing) ? next.bearing : this.viewState.bearing;
        const maxPitch = Number.isFinite(next.maxPitch) ? next.maxPitch : this.viewState.maxPitch;
        return {
            longitude: this.normalizeLongitude(longitude),
            latitude: Math.max(-85.05113, Math.min(85.05113, latitude)),
            zoom: Math.max(0, Math.min(22, zoom)),
            pitch: this.allowPitchAndBearing ? Math.max(0, Math.min(maxPitch, pitch)) : 0,
            bearing: this.allowPitchAndBearing ? this.normalizeDegrees(bearing) : 0,
            maxPitch: this.allowPitchAndBearing ? Math.max(0, maxPitch) : 0
        };
    }

    private createWebMercatorViewport(): WebMercatorViewport | undefined {
        const rect = this.getCanvasClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            return undefined;
        }
        return new WebMercatorViewport({
            width,
            height,
            longitude: this.viewState.longitude,
            latitude: this.viewState.latitude,
            zoom: this.viewState.zoom,
            pitch: this.viewState.pitch,
            bearing: this.viewState.bearing,
            orthographic: this.useOrthographicProjection
        });
    }

    private updateOsmLayers(enabled: boolean, opacity: number): void {
        if (!this.deck || !enabled) {
            this.layerRegistry.remove(DeckMapView.OSM_LAYER_KEY);
            this.osmLayerEnabled = false;
            this.osmLayerOpacity = -1;
            return;
        }

        const clampedOpacity = Math.max(0, Math.min(1, opacity));
        if (this.osmLayerEnabled && this.osmLayerOpacity === clampedOpacity) {
            return;
        }

        const layer = new TileLayer<string>({
            id: DeckMapView.OSM_LAYER_KEY,
            data: DeckMapView.OSM_TILE_URL_TEMPLATE,
            minZoom: 0,
            maxZoom: 19,
            tileSize: 256,
            opacity: clampedOpacity,
            pickable: false,
            refinementStrategy: "no-overlap",
            updateTriggers: {
                renderSubLayers: [clampedOpacity]
            },
            renderSubLayers: (props) => {
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
                    opacity: clampedOpacity,
                    pickable: false,
                    parameters: {depthTest: false}
                });
            }
        });
        this.layerRegistry.upsert(DeckMapView.OSM_LAYER_KEY, layer, -1000);
        this.osmLayerEnabled = true;
        this.osmLayerOpacity = clampedOpacity;
    }

    private scheduleTileGridOverlayUpdate(): void {
        if (this.tileGridOverlayUpdateRaf !== null) {
            return;
        }
        this.tileGridOverlayUpdateRaf = requestAnimationFrame(() => {
            this.tileGridOverlayUpdateRaf = null;
            this.updateTileGridOverlay();
        });
    }

    private scheduleTileGridOverlayDataRefresh(): void {
        if (!this.tileGridEnabled) {
            return;
        }
        if (this.tileGridOverlayDataRefreshTimer !== null) {
            return;
        }
        this.tileGridOverlayDataRefreshTimer = setTimeout(() => {
            this.tileGridOverlayDataRefreshTimer = null;
            this.scheduleTileGridOverlayUpdate();
        }, 120);
    }

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

    private scheduleSearchResultsOverlayUpdate(): void {
        if (this.searchResultsOverlayUpdateRaf !== null) {
            return;
        }
        this.searchResultsOverlayUpdateRaf = requestAnimationFrame(() => {
            this.searchResultsOverlayUpdateRaf = null;
            this.updateSearchResultsOverlay();
        });
    }

    private scheduleSearchResultsOverlayDataRefresh(): void {
        if (this.searchResultsOverlayDataRefreshTimer !== null) {
            return;
        }
        this.searchResultsOverlayDataRefreshTimer = setTimeout(() => {
            this.searchResultsOverlayDataRefreshTimer = null;
            this.scheduleSearchResultsOverlayUpdate();
        }, 120);
    }

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

    private updateSearchResultsOverlay(): void {
        const pointsVersion = this.featureSearchService.searchResultPointsVersion;
        const iconAtlasUrl = this.featureSearchService.getSearchClusterIconAtlasUrl();
        const iconMappingUrl = this.featureSearchService.getSearchClusterIconMappingUrl();
        if (!this.deck) {
            this.layerRegistry.remove(DeckMapView.SEARCH_RESULTS_LAYER_KEY);
            this.lastSearchResultsPointsVersion = -1;
            this.lastSearchResultsIconAtlasUrl = "";
            this.lastSearchResultsIconMappingUrl = "";
            return;
        }
        if (this.lastSearchResultsPointsVersion === pointsVersion
            && this.lastSearchResultsIconAtlasUrl === iconAtlasUrl
            && this.lastSearchResultsIconMappingUrl === iconMappingUrl) {
            return;
        }
        const points = this.featureSearchService.getSearchResultPoints();
        this.lastSearchResultsPointsVersion = pointsVersion;
        this.lastSearchResultsIconAtlasUrl = iconAtlasUrl;
        this.lastSearchResultsIconMappingUrl = iconMappingUrl;
        if (!points.length) {
            this.layerRegistry.remove(DeckMapView.SEARCH_RESULTS_LAYER_KEY);
            return;
        }
        const layer = new SearchResultClusterLayer({
            id: DeckMapView.SEARCH_RESULTS_LAYER_KEY,
            data: points as SearchResultClusterPoint[],
            pickable: false,
            sizeScale: 40,
            getPosition: (point: SearchResultClusterPoint) => point.coordinates,
            iconAtlas: iconAtlasUrl,
            iconMapping: iconMappingUrl
        });
        this.layerRegistry.upsert(DeckMapView.SEARCH_RESULTS_LAYER_KEY, layer, 650);
    }

    /**
     * Mirrors the legacy Cesium single-location pin as a dedicated deck IconLayer.
     */
    private updateLocationMarkerOverlay(): void {
        const markerEnabled = this.stateService.markerState.getValue();
        const markedPosition = this.stateService.markedPositionState.getValue();
        if (!this.deck || !markerEnabled || markedPosition.length !== 2) {
            this.layerRegistry.remove(DeckMapView.LOCATION_MARKER_LAYER_KEY);
            this.lastLocationMarkerSignature = "";
            return;
        }

        const longitude = Number(markedPosition[0]);
        const latitude = Number(markedPosition[1]);
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
            this.layerRegistry.remove(DeckMapView.LOCATION_MARKER_LAYER_KEY);
            this.lastLocationMarkerSignature = "";
            return;
        }

        const iconAtlas = this.featureSearchService.markerGraphics();
        const signature = `${longitude},${latitude},${iconAtlas}`;
        if (this.lastLocationMarkerSignature === signature) {
            return;
        }

        this.lastLocationMarkerSignature = signature;
        const iconSize = DeckMapView.LOCATION_MARKER_ICON_SIZE_PX;
        const layer = new IconLayer<DeckLocationMarkerDatum>({
            id: DeckMapView.LOCATION_MARKER_LAYER_KEY,
            data: [{position: [longitude, latitude]}],
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

    private updateTileGridOverlay(): void {
        if (!this.deck || !this.tileGridEnabled) {
            this.layerRegistry.remove(DeckMapView.TILE_GRID_LAYER_KEY);
            this.removeTileStateLayers();
            this.logTileGridDiagnostic("disabled");
            return;
        }
        const levels = this.visibleMapLayerLevels();
        if (!levels.length) {
            this.layerRegistry.remove(DeckMapView.TILE_GRID_LAYER_KEY);
            this.removeTileStateLayers();
            this.logTileGridDiagnostic("no-levels");
            return;
        }
        const viewport = this.computeViewport();
        if (!viewport) {
            this.layerRegistry.remove(DeckMapView.TILE_GRID_LAYER_KEY);
            this.removeTileStateLayers();
            this.logTileGridDiagnostic("no-viewport");
            return;
        }
        const effectiveLevels = this.coarsenedTileGridLevels(levels, viewport);
        const {layerCount, coloredTileCount} = this.updateTileStateOverlays(levels, viewport);
        const layer = this.createTileGridLayer(effectiveLevels);
        this.layerRegistry.upsert(DeckMapView.TILE_GRID_LAYER_KEY, layer, 490);
        this.logTileGridDiagnostic(
            `enabled mode=${this.tileGridMode} requested=[${levels.join(",")}] effective=[${effectiveLevels.join(",")}] stateLayers=${layerCount} stateTiles=${coloredTileCount} debugSolid=${DeckMapView.TILE_GRID_DEBUG_SOLID}`
        );
    }

    private createTileGridLayer(levels: number[]): TileGridOverlayLayer {
        const overlayGeometry = DeckMapView.TILE_GRID_DEBUG_SOLID
            ? this.tileGridDebugGeometry(levels)
            : this.tileGridOverlayGeometry(levels);
        const layerId = DeckMapView.TILE_GRID_LAYER_KEY;
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
            levels,
            gridMode: this.tileGridMode,
            localMin: overlayGeometry.localMin,
            localSize: overlayGeometry.localSize,
            subdivisionsX: overlayGeometry.subdivisionsX,
            subdivisionsY: overlayGeometry.subdivisionsY,
            lineColor: DeckMapView.TILE_GRID_LINE_COLOR,
            lineWidthPixels: DeckMapView.TILE_GRID_LINE_WIDTH_PX,
            debugSolid: DeckMapView.TILE_GRID_DEBUG_SOLID,
            parameters: DeckMapView.NO_DEPTH_PARAMETERS
        });
    }

    private updateTileStateOverlays(
        levels: number[],
        viewport: Viewport
    ): {layerCount: number; coloredTileCount: number} {
        const visibleLayersByLevel = this.visibleMapLayersByLevel(levels);
        const nextLayerKeys = new Set<string>();
        const tileLimitPerView = this.tileLimitPerView();
        let coloredTileCount = 0;
        for (const level of levels) {
            if (this.tileGridVisibleCellCount(level, viewport) > DeckMapView.TILE_GRID_MAX_VISIBLE_CELLS) {
                continue;
            }
            const visibleLayers = visibleLayersByLevel.get(level) ?? [];
            if (!visibleLayers.length) {
                continue;
            }
            const extent = this.tileGridExtentForLevel(level, viewport);
            if (!extent) {
                continue;
            }

            const pixels = new Uint8ClampedArray(extent.width * extent.height * 4);
            const visibleTileIds = coreLib.getTileIds(viewport, level, tileLimitPerView) as bigint[];
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
                coloredTileCount += 1;
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
        return {layerCount: nextLayerKeys.size, coloredTileCount};
    }

    private coarsenedTileGridLevels(levels: number[], viewport: Viewport): number[] {
        const effectiveLevels = new Set<number>();
        for (const level of levels) {
            effectiveLevels.add(this.coarsenedTileGridLevel(level, viewport));
        }
        return Array.from(effectiveLevels.values()).sort((lhs, rhs) => lhs - rhs);
    }

    private coarsenedTileGridLevel(level: number, viewport: Viewport): number {
        let effectiveLevel = Math.max(0, Math.min(22, Math.floor(level)));
        while (effectiveLevel > 0 &&
            this.tileGridVisibleCellCount(effectiveLevel, viewport) > DeckMapView.TILE_GRID_MAX_VISIBLE_CELLS) {
            effectiveLevel -= 1;
        }
        return effectiveLevel;
    }

    private tileGridVisibleCellCount(level: number, viewport: Viewport): number {
        const extent = this.tileGridExtentForLevel(level, viewport);
        return extent ? extent.width * extent.height : 0;
    }

    private visibleMapLayerLevels(): number[] {
        const levels = new Set<number>();
        for (const [mapId, map] of this.mapService.maps.maps.entries()) {
            for (const layer of map.allFeatureLayers()) {
                if (!this.mapService.maps.getMapLayerVisibility(this._viewIndex, mapId, layer.id)) {
                    continue;
                }
                const level = this.mapService.getEffectiveMapLayerLevel(this._viewIndex, mapId, layer.id);
                if (!Number.isFinite(level)) {
                    continue;
                }
                levels.add(Math.max(0, Math.floor(level)));
            }
        }
        if (!levels.size) {
            levels.add(Math.max(0, Math.min(22, Math.floor(this.viewState.zoom))));
        }
        return Array.from(levels.values()).sort((lhs, rhs) => lhs - rhs);
    }

    private visibleMapLayersByLevel(levels: number[]): Map<number, VisibleLayerRef[]> {
        const levelSet = new Set(levels);
        const result = new Map<number, VisibleLayerRef[]>();
        for (const level of levels) {
            result.set(level, []);
        }

        for (const [mapId, map] of this.mapService.maps.maps.entries()) {
            for (const layer of map.allFeatureLayers()) {
                if (!this.mapService.maps.getMapLayerVisibility(this._viewIndex, mapId, layer.id)) {
                    continue;
                }
                const level = this.mapService.getEffectiveMapLayerLevel(this._viewIndex, mapId, layer.id);
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

    private removeTileStateLayers(): void {
        for (const key of this.tileStateLayerKeys) {
            this.layerRegistry.remove(key);
        }
        this.tileStateLayerKeys.clear();
    }

    private tileGridExtentForLevel(level: number, viewport: Viewport): TileGridLevelExtent | null {
        if (!Number.isFinite(level) || level < 0) {
            return null;
        }
        const safeLevel = Math.max(0, Math.min(22, Math.floor(level)));
        const viewportWest = viewport.west;
        const viewportEast = viewport.west + viewport.width;
        const viewportSouth = viewport.south;
        const viewportNorth = viewport.south + viewport.height;
        const westNorm = this.tileGridLonToNormX(viewportWest);
        const eastNorm = this.tileGridLonToNormX(viewportEast);
        const southNorm = this.tileGridLatToNormY(viewportSouth, this.tileGridMode);
        const northNorm = this.tileGridLatToNormY(viewportNorth, this.tileGridMode);
        const rowCount = Math.pow(2, safeLevel);
        const colCount = this.tileGridMode === "nds" ? rowCount * 2 : rowCount;
        const coversFullWorldX = eastNorm - westNorm >= 1 - 1e-9;
        const normMinX = coversFullWorldX ? 0 : Math.min(westNorm, eastNorm);
        const normMaxX = coversFullWorldX ? 1 : Math.max(westNorm, eastNorm);
        const normMinY = Math.min(northNorm, southNorm);
        const normMaxY = Math.max(northNorm, southNorm);
        const marginTiles = 2;
        const minCol = coversFullWorldX ? 0 : Math.floor(normMinX * colCount) - marginTiles;
        const maxCol = coversFullWorldX ? colCount : Math.ceil(normMaxX * colCount) + marginTiles;
        const minRow = Math.max(0, Math.floor(normMinY * rowCount) - marginTiles);
        const maxRow = Math.min(rowCount, Math.ceil(normMaxY * rowCount) + marginTiles);
        const width = Math.max(1, maxCol - minCol);
        const height = Math.max(1, maxRow - minRow);
        const north = this.tileGridNormYToLat(minRow / rowCount, this.tileGridMode);
        const south = this.tileGridNormYToLat(maxRow / rowCount, this.tileGridMode);
        return {
            level: safeLevel,
            rowCount,
            colCount,
            coversFullWorldX,
            minCol,
            maxCol,
            minRow,
            maxRow,
            width,
            height,
            west: this.tileGridNormXToLon(minCol / colCount),
            east: this.tileGridNormXToLon(maxCol / colCount),
            north: Math.min(north, DeckMapView.WEB_MERCATOR_MAX_LATITUDE),
            south: Math.max(south, -DeckMapView.WEB_MERCATOR_MAX_LATITUDE)
        };
    }

    private tileStateKindForTile(tileId: bigint, visibleLayers: VisibleLayerRef[]): number {
        let hasParticipant = false;
        let hasPendingParticipant = false;
        let hasEmptyParticipant = false;
        let hasNonEmptyData = false;
        for (const layer of visibleLayers) {
            const tileKey = coreLib.getTileFeatureLayerKey(layer.mapId, layer.layerId, tileId);
            const tile = this.mapService.loadedTileLayers.get(tileKey);
            if (!tile) {
                continue;
            }
            hasParticipant = true;
            if (tile.error) {
                return TILE_STATE_KIND_ERROR;
            }
            if (!tile.hasData()) {
                hasPendingParticipant = true;
                continue;
            }
            if (tile.numFeatures > 0) {
                hasNonEmptyData = true;
                continue;
            }
            hasEmptyParticipant = true;
        }
        // Aggregation rule per tile across participating layers:
        // error > non-empty > empty > unknown/loading.
        if (hasNonEmptyData) {
            return 0;
        }
        if (hasParticipant && hasEmptyParticipant && !hasPendingParticipant) {
            return TILE_STATE_KIND_EMPTY;
        }
        return 0;
    }

    private tileGridCellForTile(tileId: bigint, extent: TileGridLevelExtent): {col: number; row: number} | null {
        const tileBox = coreLib.getTileBox(tileId) as unknown;
        if (!Array.isArray(tileBox) || tileBox.length < 4) {
            return null;
        }
        const west = Number(tileBox[0]);
        const north = Number(tileBox[3]);
        if (!Number.isFinite(west) || !Number.isFinite(north)) {
            return null;
        }
        const colNorm = this.tileGridLonToNormX(west);
        const rowNorm = this.tileGridLatToNormY(north, this.tileGridMode);
        const rawCol = Math.floor(colNorm * extent.colCount + 1e-9);
        const rawRow = Math.floor(rowNorm * extent.rowCount + 1e-9);
        const row = Math.max(0, Math.min(extent.rowCount - 1, rawRow));
        const col = this.wrapColumnIntoExtent(rawCol, extent);
        if (col < 0 || col >= extent.width) {
            return null;
        }
        const rowInExtent = row - extent.minRow;
        if (rowInExtent < 0 || rowInExtent >= extent.height) {
            return null;
        }
        return {col, row: rowInExtent};
    }

    private wrapColumnIntoExtent(rawCol: number, extent: TileGridLevelExtent): number {
        const normalizedCol = ((rawCol % extent.colCount) + extent.colCount) % extent.colCount;
        const repeatsToNearExtent = Math.round((extent.minCol - normalizedCol) / extent.colCount);
        let repeatedCol = normalizedCol + repeatsToNearExtent * extent.colCount;
        while (repeatedCol < extent.minCol) {
            repeatedCol += extent.colCount;
        }
        while (repeatedCol >= extent.maxCol) {
            repeatedCol -= extent.colCount;
        }
        return repeatedCol - extent.minCol;
    }

    private tileLimitPerView(): number {
        const viewCount = Math.max(1, this.stateService.numViews);
        return Math.max(1, Math.floor(this.stateService.tilesLoadLimit / viewCount));
    }

    private tileGridDebugPolygon(): [number, number][] {
        const halfWidth = 1.5;
        const halfHeight = 1.0;
        const west = this.normalizeLongitude(this.viewState.longitude - halfWidth);
        const east = this.normalizeLongitude(this.viewState.longitude + halfWidth);
        const south = Math.max(-85.05112878, this.viewState.latitude - halfHeight);
        const north = Math.min(85.05112878, this.viewState.latitude + halfHeight);
        return [
            [west, south],
            [west, north],
            [east, north],
            [east, south]
        ];
    }

    private tileGridDebugGeometry(levels: number[]): TileGridOverlayGeometry {
        const base = this.tileGridOverlayGeometry(levels);
        return {
            ...base,
            data: [{
                polygon: this.tileGridDebugPolygon(),
                ndsYCorrection: [0, 1, 0]
            }]
        };
    }

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

    private stopJumpAreaHighlight(): void {
        if (this.jumpAreaHighlightTick) {
            this.offTick(this.jumpAreaHighlightTick);
            this.jumpAreaHighlightTick = null;
        }
        this.layerRegistry.remove(DeckMapView.JUMP_AREA_LAYER_KEY);
    }

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
            subdivisionsX: [extent.width],
            subdivisionsY: [extent.height]
        };
    }

    private tileGridOverlayGeometry(levels: number[]): TileGridOverlayGeometry {
        const viewport = this.computeViewport();
        if (!viewport) {
            return {
                data: tileGridOverlayData(),
                localMin: [0, 0],
                localSize: [1, 1],
                subdivisionsX: levels.map(() => 1),
                subdivisionsY: levels.map(() => 1)
            };
        }
        const referenceLevel = levels.length ? levels[0] : Math.max(0, Math.floor(this.viewState.zoom));
        const extent = this.tileGridExtentForLevel(referenceLevel, viewport);
        if (!extent) {
            return {
                data: tileGridOverlayData(),
                localMin: [0, 0],
                localSize: [1, 1],
                subdivisionsX: levels.map(() => 1),
                subdivisionsY: levels.map(() => 1)
            };
        }
        const {localMin, localSize} = this.tileGridLocalBounds(extent);
        const subdivisionsX = levels.map(level => {
            const rowsForLevel = Math.pow(2, Math.max(0, Math.min(22, level)));
            const colsForLevel = this.tileGridMode === "nds" ? rowsForLevel * 2 : rowsForLevel;
            return Math.max(1, Math.round(localSize[0] * colsForLevel));
        });
        const subdivisionsY = levels.map(level => {
            const rowsForLevel = Math.pow(2, Math.max(0, Math.min(22, level)));
            return Math.max(1, Math.round(localSize[1] * rowsForLevel));
        });
        return {
            data: this.buildTileGridOverlayData(
                extent.west,
                extent.east,
                extent.south,
                extent.north,
                levels,
                localMin,
                localSize,
                extent.coversFullWorldX
            ),
            localMin,
            localSize,
            subdivisionsX,
            subdivisionsY
        };
    }

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
        const mercatorNorth = this.tileGridLatToNormY(north, "xyz");
        const mercatorSouth = this.tileGridLatToNormY(south, "xyz");
        const data: TileGridOverlayDatum[] = [];
        for (let bandIndex = 0; bandIndex < bandCount; bandIndex++) {
            const t0 = bandIndex / bandCount;
            const t1 = (bandIndex + 1) / bandCount;
            const bandMercatorNorth = mercatorNorth + (mercatorSouth - mercatorNorth) * t0;
            const bandMercatorSouth = mercatorNorth + (mercatorSouth - mercatorNorth) * t1;
            const bandNorth = this.tileGridNormYToLat(bandMercatorNorth, "xyz");
            const bandSouth = this.tileGridNormYToLat(bandMercatorSouth, "xyz");
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
        const mercatorNorth = this.tileGridLatToNormY(north, "xyz");
        const mercatorSouth = this.tileGridLatToNormY(south, "xyz");
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
        const mercatorNorthY = this.tileGridLatToNormY(north, "xyz");
        const mercatorSouthY = this.tileGridLatToNormY(south, "xyz");
        const mercatorMidY = 0.5 * (mercatorNorthY + mercatorSouthY);
        const midpointLat = this.tileGridNormYToLat(mercatorMidY, "xyz");
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

    private tileGridLocalNdsY(lat: number, localMinY: number, localSizeY: number): number {
        const ndsY = this.tileGridLatToNormY(lat, "nds");
        return (ndsY - localMinY) / Math.max(1e-6, localSizeY);
    }

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

    private tileGridLonToNormX(lon: number): number {
        return (lon + 180.0) / 360.0;
    }

    private tileGridNormXToLon(normX: number): number {
        return normX * 360.0 - 180.0;
    }

    private tileGridLatToNormY(lat: number, mode: TileGridMode): number {
        if (mode === "nds") {
            const clampedLat = Math.max(-90.0, Math.min(90.0, lat));
            return (90.0 - clampedLat) / 180.0;
        }
        const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
        const sinLat = Math.sin((clampedLat * Math.PI) / 180.0);
        const mercatorY = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
        return Math.max(0, Math.min(1, mercatorY));
    }

    private tileGridNormYToLat(normY: number, mode: TileGridMode): number {
        const clampedY = Math.max(0, Math.min(1, normY));
        if (mode === "nds") {
            return 90.0 - clampedY * 180.0;
        }
        const exponent = Math.exp(Math.PI * (1 - 2 * clampedY));
        const latRad = 2 * Math.atan(exponent) - Math.PI / 2;
        return (latRad * 180.0) / Math.PI;
    }

    private logTileGridDiagnostic(message: string): void {
        const signature = `view=${this._viewIndex} ${message}`;
        if (signature === this.lastTileGridDiagnosticSignature) {
            return;
        }
        this.lastTileGridDiagnosticSignature = signature;
        console.info(`[DeckTileGrid] ${signature}`);
    }

    private normalizeLongitude(lon: number): number {
        let value = lon;
        while (value < -180) {
            value += 360;
        }
        while (value > 180) {
            value -= 360;
        }
        return value;
    }

    private unwrapLongitudeNear(referenceLon: number, lon: number): number {
        let value = lon;
        while (value - referenceLon <= -180) {
            value += 360;
        }
        while (value - referenceLon > 180) {
            value -= 360;
        }
        return value;
    }

    private normalizeDegrees(value: number): number {
        return (value % 360 + 360) % 360;
    }

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

    private zoomToAltitude(zoom: number, latitude: number = this.viewState.latitude): number {
        const viewportHeight = this.getViewportHeightPixels();
        const latitudeCos = Math.max(0.01, Math.cos(GeoMath.toRadians(latitude)));
        const worldMetersAtLatitude = latitudeCos * 2 * Math.PI * DeckMapView.EARTH_RADIUS_METERS;
        const metersPerPixel =
            worldMetersAtLatitude / (DeckMapView.WEB_MERCATOR_TILE_SIZE * Math.pow(2, zoom));
        const visibleHeightMeters = metersPerPixel * viewportHeight;
        const altitude =
            visibleHeightMeters / (2 * Math.tan(DeckMapView.ASSUMED_VERTICAL_FOV_RADIANS / 2));
        return Math.max(1, altitude);
    }

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

    private applyPan(xFactor: number, yFactor: number): void {
        this.stateService.focusedView = this._viewIndex;
        const step = 360 / Math.pow(2, this.viewState.zoom + 3);
        this.updateViewState({
            ...this.viewState,
            longitude: this.viewState.longitude + xFactor * step,
            latitude: this.viewState.latitude + yFactor * step
        }, true, true);
        this.pushViewStateToAppState();
    }

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

    private stopTickLoop(): void {
        if (this.tickHandle === null) {
            return;
        }
        cancelAnimationFrame(this.tickHandle);
        this.tickHandle = null;
    }
}
