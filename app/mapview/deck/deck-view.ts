import {BehaviorSubject, combineLatest, distinctUntilChanged, Subscription} from "rxjs";
import {COORDINATE_SYSTEM, Deck as DeckGlDeck, MapView as DeckMercatorView, WebMercatorViewport} from "@deck.gl/core";
import {BitmapLayer} from "@deck.gl/layers";
import {TileLayer} from "@deck.gl/geo-layers";
import {Cartographic, GeoMath, SceneMode} from "../../integrations/geo";
import {MapDataService, TileVisualizationRenderTask} from "../../mapdata/map.service";
import {FeatureSearchService} from "../../search/feature.search.service";
import {JumpTargetService} from "../../search/jump.service";
import {RightClickMenuService} from "../rightclickmenu.service";
import {CoordinatesService} from "../../coords/coordinates.service";
import {AppStateService, CameraViewState, TileFeatureId, TileGridMode} from "../../shared/appstate.service";
import {IRenderSceneHandle, IRenderView, ITileVisualization} from "../render-view.model";
import {Viewport} from "../../../build/libs/core/erdblick-core";
import {DeckLayerRegistry} from "./deck-layer-registry";
import {environment} from "../../environments/environment";
import {MergedPointsTile} from "../pointmerge.service";
import {coreLib} from "../../integrations/wasm";
import {
    TILE_STATE_KIND_EMPTY,
    TILE_STATE_KIND_ERROR,
    TileGridOverlayLayer,
    tileGridOverlayData
} from "./deck-tile-grid-overlay.layer";
import {SearchResultClusterLayer, SearchResultClusterPoint} from "./deck-search-result-cluster.layer";

interface DeckCameraState {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch: number;
    bearing: number;
}

interface TileGridOverlayGeometry {
    polygon: [number, number][];
    localMin: [number, number];
    localSize: [number, number];
    subdivisionsX: number[];
    subdivisionsY: number[];
}

interface VisibleLayerRef {
    mapId: string;
    layerId: string;
}

interface TileGridLevelExtent {
    level: number;
    rowCount: number;
    colCount: number;
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

/**
 * Minimal deck.gl map view scaffold used to wire renderer switching and camera-state sync.
 * Detailed deck tile rendering is introduced in later migration tasks.
 */
export abstract class DeckMapView implements IRenderView {
    private static readonly EARTH_RADIUS_METERS = 6378137;
    private static readonly WEB_MERCATOR_TILE_SIZE = 512;
    private static readonly ASSUMED_VERTICAL_FOV_RADIANS = GeoMath.toRadians(60);
    private static readonly FALLBACK_VIEWPORT_HEIGHT_PX = 1080;
    private static readonly OSM_LAYER_KEY = "osm/tile-layer";
    private static readonly OSM_TILE_URL_TEMPLATE = "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png";
    private static readonly TILE_GRID_LAYER_KEY = "builtin/tile-grid";
    private static readonly TILE_STATE_LAYER_KEY = "builtin/tile-state";
    private static readonly SEARCH_RESULTS_LAYER_KEY = "builtin/search-results";
    private static readonly TILE_GRID_LINE_COLOR: [number, number, number, number] = [245, 245, 245, 240];
    private static readonly TILE_GRID_LINE_WIDTH_PX = 1.0;
    private static readonly TILE_STATE_ERROR_COLOR: [number, number, number, number] = [225, 45, 45, 105];
    private static readonly TILE_STATE_EMPTY_COLOR: [number, number, number, number] = [122, 126, 133, 64];
    // Diagnostic mode: force solid red fill from shader to verify overlay visibility/lifecycle.
    private static readonly TILE_GRID_DEBUG_SOLID = false;

    protected readonly _viewIndex: number;
    readonly canvasId: string;
    protected deck: any = null;
    protected readonly layerRegistry = new DeckLayerRegistry();
    protected readonly subscriptions: Subscription[] = [];
    protected viewState: DeckCameraState = {
        longitude: 0,
        latitude: 0,
        zoom: 2,
        pitch: 0,
        bearing: 0
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
    private tileGridMode: TileGridMode = "xyz";
    private lastTileGridDiagnosticSignature = "";
    private tileStateLayerKeys = new Set<string>();
    private tileGridOverlayUpdateRaf: number | null = null;
    private tileGridOverlayDataRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private searchResultsOverlayUpdateRaf: number | null = null;
    private searchResultsOverlayDataRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private lastSearchResultsPointsVersion = -1;
    private lastSearchResultsIconAtlasUrl = "";
    private lastSearchResultsIconMappingUrl = "";

    get viewIndex() {
        return this._viewIndex;
    }

    protected abstract readonly sceneMode: SceneMode;
    protected abstract readonly allowPitchAndBearing: boolean;

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

        this.deck = new DeckGlDeck({
            parent: container,
            views: [new DeckMercatorView({id: `deck-view-${this._viewIndex}`, repeat: true})],
            initialViewState: this.viewState,
            viewState: this.viewState,
            layers: [],
            controller: this.allowPitchAndBearing ? true : {
                dragRotate: false,
                touchRotate: false,
                keyboard: false
            },
            onViewStateChange: ({viewState}: {viewState: any}) => this.onViewStateChange(viewState),
            onHover: (info: any) => this.onHover(info),
            onClick: (info: any, event: any) => this.onClick(info, event)
        } as any);
        this.layerRegistry.setDeck(this.deck as any);

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
        this.layerRegistry.remove(DeckMapView.SEARCH_RESULTS_LAYER_KEY);
        this.removeTileStateLayers();
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
                layerRegistry: this.layerRegistry
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
        }) as any;
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

        const objectTileKey = (picked.layer?.props as {tileKey?: string} | undefined)?.tileKey;
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
        const layerProps = (
            picked.layer?.props as {
                tileKey?: string;
                featureIds?: Array<number | null>;
                featureIdsByVertex?: Array<number | null>;
            } | undefined
        );
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
        const next: DeckCameraState = {
            longitude: cameraData.destination.lon,
            latitude: cameraData.destination.lat,
            zoom: this.altitudeToZoom(cameraData.destination.alt, cameraData.destination.lat),
            pitch: this.allowPitchAndBearing
                ? Math.max(0, Math.min(60, GeoMath.toDegrees(cameraData.orientation.pitch) + 90))
                : 0,
            bearing: this.allowPitchAndBearing
                ? this.normalizeDegrees(GeoMath.toDegrees(cameraData.orientation.heading))
                : 0
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

        const width = Math.max(1, viewport.width);
        const height = Math.max(1, viewport.height);
        const [westRaw, northRaw] = viewport.unproject([0, 0]);
        const [eastRaw, southRaw] = viewport.unproject([width, height]);

        const west = Math.min(westRaw, eastRaw);
        const east = Math.max(westRaw, eastRaw);
        const south = Math.min(southRaw, northRaw);
        const north = Math.max(southRaw, northRaw);
        const sizeLon = Math.abs(east - west);
        const sizeLat = Math.abs(north - south);
        const expandLon = sizeLon * 0.05;
        const expandLat = sizeLat * 0.05;

        return {
            south: south - expandLat,
            west: west - expandLon,
            width: sizeLon + expandLon * 2,
            height: sizeLat + expandLat * 2,
            camPosLon: this.viewState.longitude,
            camPosLat: this.viewState.latitude,
            // Keep tile-priority orientation consistent with the legacy viewport contract.
            orientation: -GeoMath.toRadians(this.viewState.bearing) + Math.PI * 0.5
        };
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
            combineLatest([
                this.stateService.osmEnabledState.pipe(this._viewIndex),
                this.stateService.osmOpacityState.pipe(this._viewIndex)
            ]).subscribe(([osmEnabled, osmOpacity]) => {
                this.updateOsmLayers(osmEnabled, osmOpacity / 100);
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
            })
        );

        this.subscriptions.push(
            this.mapService.tileVisualizationTopic.subscribe((task: TileVisualizationRenderTask) => {
                const tileVis = task.visualization;
                if (tileVis.viewIndex !== this._viewIndex) {
                    task.onDone?.();
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

        this.tileGridEnabled = this.stateService.viewTileBordersState.getValue(this._viewIndex);
        this.tileGridMode = this.stateService.viewTileGridModeState.getValue(this._viewIndex);
        this.scheduleTileGridOverlayUpdate();
        this.scheduleSearchResultsOverlayUpdate();
    }

    private onViewStateChange(rawViewState: any): void {
        if (this.suppressDeckViewStateEvent) {
            return;
        }
        if (this.stateService.focusedView !== this._viewIndex) {
            this.stateService.focusedView = this._viewIndex;
        }
        // Deck is wired in controlled mode (`viewState` prop). User interactions only
        // take effect if we feed the updated camera state back via `setProps`.
        this.updateViewState(rawViewState as DeckCameraState, true, true);
        this.pushViewStateToAppState();
    }

    private onHover(info: any): void {
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

    private onClick(info: any, event: any): void {
        if (environment.visualizationOnly) {
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

        const shouldPinPanel = !!event?.srcEvent?.ctrlKey;
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
            this.updateOsmLayers(
                this.stateService.osmEnabledState.getValue(this._viewIndex),
                this.stateService.osmOpacityState.getValue(this._viewIndex) / 100
            );
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
        return {
            longitude: this.normalizeLongitude(longitude),
            latitude: Math.max(-85.05113, Math.min(85.05113, latitude)),
            zoom: Math.max(0, Math.min(22, zoom)),
            pitch: this.allowPitchAndBearing ? Math.max(0, Math.min(60, pitch)) : 0,
            bearing: this.allowPitchAndBearing ? this.normalizeDegrees(bearing) : 0
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
            bearing: this.viewState.bearing
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

        const layer = new TileLayer({
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
            renderSubLayers: (props: any) => {
                const boundingBox = props.tile?.boundingBox;
                if (!boundingBox || !props.data) {
                    return null;
                }
                return new BitmapLayer(props, {
                    id: `${props.id}-bitmap`,
                    data: null,
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
                } as any);
            }
        } as any);
        this.layerRegistry.upsert(DeckMapView.OSM_LAYER_KEY, layer as any, -1000);
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
        this.layerRegistry.upsert(DeckMapView.SEARCH_RESULTS_LAYER_KEY, layer as any, 650);
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
        const {layerCount, coloredTileCount} = this.updateTileStateOverlays(levels);
        const layer = this.createTileGridLayer(levels);
        this.layerRegistry.upsert(DeckMapView.TILE_GRID_LAYER_KEY, layer as any, 490);
        this.logTileGridDiagnostic(
            `enabled mode=${this.tileGridMode} levels=[${levels.join(",")}] stateLayers=${layerCount} stateTiles=${coloredTileCount} debugSolid=${DeckMapView.TILE_GRID_DEBUG_SOLID}`
        );
    }

    private createTileGridLayer(levels: number[]): TileGridOverlayLayer {
        const overlayGeometry = DeckMapView.TILE_GRID_DEBUG_SOLID
            ? this.tileGridDebugGeometry(levels)
            : this.tileGridOverlayGeometry(levels);
        const layerId = DeckMapView.TILE_GRID_LAYER_KEY;
        const overlayData = [{polygon: overlayGeometry.polygon}];
        return new TileGridOverlayLayer({
            id: layerId,
            data: overlayData,
            getPolygon: (datum: {polygon: [number, number][]}) => datum.polygon,
            getFillColor: [0, 0, 0, 0],
            coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
            filled: true,
            stroked: false,
            extruded: false,
            wrapLongitude: true,
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
            parameters: {depthTest: false, cull: false}
        } as any);
    }

    private updateTileStateOverlays(levels: number[]): {layerCount: number; coloredTileCount: number} {
        const viewport = this.computeViewport();
        if (!viewport) {
            this.removeTileStateLayers();
            return {layerCount: 0, coloredTileCount: 0};
        }

        const visibleLayersByLevel = this.visibleMapLayersByLevel(levels);
        const nextLayerKeys = new Set<string>();
        const tileLimitPerView = this.tileLimitPerView();
        let coloredTileCount = 0;
        for (const level of levels) {
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
            const layer = new BitmapLayer({
                id: layerKey,
                data: null,
                image: imageData,
                bounds: [extent.west, extent.south, extent.east, extent.north],
                coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
                wrapLongitude: false,
                opacity: 1.0,
                pickable: false,
                textureParameters: {
                    minFilter: "nearest",
                    magFilter: "nearest",
                    mipmapFilter: "nearest",
                    addressModeU: "clamp-to-edge",
                    addressModeV: "clamp-to-edge"
                },
                parameters: {depthTest: false}
            } as any);
            this.layerRegistry.upsert(layerKey, layer as any, 360);
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

    private visibleMapLayerLevels(): number[] {
        const levels = new Set<number>();
        for (const [mapId, map] of this.mapService.maps.maps.entries()) {
            for (const layer of map.allFeatureLayers()) {
                if (!this.mapService.maps.getMapLayerVisibility(this._viewIndex, mapId, layer.id)) {
                    continue;
                }
                const level = this.mapService.maps.getMapLayerLevel(this._viewIndex, mapId, layer.id);
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
                const level = this.mapService.maps.getMapLayerLevel(this._viewIndex, mapId, layer.id);
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
        const normMinX = Math.min(westNorm, eastNorm);
        const normMaxX = Math.max(westNorm, eastNorm);
        const normMinY = Math.min(northNorm, southNorm);
        const normMaxY = Math.max(northNorm, southNorm);
        const marginTiles = 2;
        const minCol = Math.floor(normMinX * colCount) - marginTiles;
        const maxCol = Math.ceil(normMaxX * colCount) + marginTiles;
        const minRow = Math.max(0, Math.floor(normMinY * rowCount) - marginTiles);
        const maxRow = Math.min(rowCount, Math.ceil(normMaxY * rowCount) + marginTiles);
        const width = Math.max(1, maxCol - minCol);
        const height = Math.max(1, maxRow - minRow);
        return {
            level: safeLevel,
            rowCount,
            colCount,
            minCol,
            maxCol,
            minRow,
            maxRow,
            width,
            height,
            west: this.tileGridNormXToLon(minCol / colCount),
            east: this.tileGridNormXToLon(maxCol / colCount),
            north: this.tileGridNormYToLat(minRow / rowCount, this.tileGridMode),
            south: this.tileGridNormYToLat(maxRow / rowCount, this.tileGridMode)
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
            polygon: this.tileGridDebugPolygon()
        };
    }

    private tileGridOverlayGeometry(levels: number[]): TileGridOverlayGeometry {
        const viewport = this.computeViewport();
        if (!viewport) {
            const polygon = tileGridOverlayData()[0].polygon;
            return {
                polygon,
                localMin: [0, 0],
                localSize: [1, 1],
                subdivisionsX: levels.map(() => 1),
                subdivisionsY: levels.map(() => 1)
            };
        }
        const referenceLevel = levels.length ? levels[0] : Math.max(0, Math.floor(this.viewState.zoom));
        const safeLevel = Math.max(0, Math.min(22, referenceLevel));

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

        const normMinX = Math.min(westNorm, eastNorm);
        const normMaxX = Math.max(westNorm, eastNorm);
        const normMinY = Math.min(northNorm, southNorm);
        const normMaxY = Math.max(northNorm, southNorm);
        const marginTiles = 2;

        const minCol = Math.floor(normMinX * colCount) - marginTiles;
        const maxCol = Math.ceil(normMaxX * colCount) + marginTiles;
        const minRow = Math.max(0, Math.floor(normMinY * rowCount) - marginTiles);
        const maxRow = Math.min(rowCount, Math.ceil(normMaxY * rowCount) + marginTiles);

        const west = this.tileGridNormXToLon(minCol / colCount);
        const east = this.tileGridNormXToLon(maxCol / colCount);
        const north = this.tileGridNormYToLat(minRow / rowCount, this.tileGridMode);
        const south = this.tileGridNormYToLat(maxRow / rowCount, this.tileGridMode);
        const alignedMinX = minCol / colCount;
        const alignedMaxX = maxCol / colCount;
        const alignedMinY = minRow / rowCount;
        const alignedMaxY = maxRow / rowCount;
        const localMin: [number, number] = [alignedMinX, alignedMinY];
        const localSize: [number, number] = [
            Math.max(1e-6, alignedMaxX - alignedMinX),
            Math.max(1e-6, alignedMaxY - alignedMinY)
        ];
        const subdivisionsX = levels.map(level => {
            const rowsForLevel = Math.pow(2, Math.max(0, Math.min(22, level)));
            const colsForLevel = this.tileGridMode === "nds" ? rowsForLevel * 2 : rowsForLevel;
            return Math.max(1, Math.round(localSize[0] * colsForLevel));
        });
        const subdivisionsY = levels.map(level => {
            const rowsForLevel = Math.pow(2, Math.max(0, Math.min(22, level)));
            return Math.max(1, Math.round(localSize[1] * rowsForLevel));
        });
        const polygon: [number, number][] = [
            [west, south],
            [west, north],
            [east, north],
            [east, south]
        ];
        return {
            polygon,
            localMin,
            localSize,
            subdivisionsX,
            subdivisionsY
        };
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
