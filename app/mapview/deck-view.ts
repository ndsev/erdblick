import {BehaviorSubject, distinctUntilChanged, Subscription} from "rxjs";
import {Deck as DeckGlDeck, MapView as DeckMercatorView, WebMercatorViewport} from "@deck.gl/core";
import {Cartographic, CesiumMath, SceneMode} from "../integrations/cesium";
import {MapDataService} from "../mapdata/map.service";
import {FeatureSearchService} from "../search/feature.search.service";
import {JumpTargetService} from "../search/jump.service";
import {RightClickMenuService} from "./rightclickmenu.service";
import {CoordinatesService} from "../coords/coordinates.service";
import {AppStateService, CameraViewState, TileFeatureId} from "../shared/appstate.service";
import {IRenderSceneHandle, IRenderView, ITileVisualization} from "./render-view.model";
import {Viewport} from "../../build/libs/core/erdblick-core";
import {DeckLayerRegistry} from "./deck-layer-registry";

interface DeckCameraState {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch: number;
    bearing: number;
}

/**
 * Minimal deck.gl map view scaffold used to wire renderer switching and camera-state sync.
 * Detailed deck tile rendering is introduced in later migration tasks.
 */
export abstract class DeckMapView implements IRenderView {
    private static readonly EARTH_RADIUS_METERS = 6378137;
    private static readonly WEB_MERCATOR_TILE_SIZE = 512;
    private static readonly ASSUMED_VERTICAL_FOV_RADIANS = CesiumMath.toRadians(60);
    private static readonly FALLBACK_VIEWPORT_HEIGHT_PX = 1080;

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
        featureIds: (TileFeatureId | null | string)[];
        position: {x: number; y: number};
    } | undefined> = new BehaviorSubject<{
        featureIds: (TileFeatureId | null | string)[];
        position: {x: number; y: number};
    } | undefined>(undefined);

    private ignoreNextCamAppStateUpdate = false;
    private suppressDeckViewStateEvent = false;
    private readonly tickCallbacks = new Set<() => void>();
    private tickHandle: number | null = null;

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
            onHover: (info: any) => this.onHover(info)
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
        this.tickCallbacks.clear();
        this.hoveredFeatureIds.next(undefined);
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

    pickFeature(screenPos: {x: number; y: number}): (TileFeatureId | null | string)[] {
        if (!this.deck) {
            return [];
        }
        const picked = this.deck.pickObject({
            x: screenPos.x,
            y: screenPos.y,
            radius: 4
        }) as any;
        if (!picked || picked.object === undefined || picked.object === null) {
            return [];
        }
        const id = picked.object.id ?? picked.object.featureId;
        if (id === undefined || id === null) {
            return [];
        }
        return Array.isArray(id) ? id : [id];
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
                ? Math.max(0, Math.min(60, CesiumMath.toDegrees(cameraData.orientation.pitch) + 90))
                : 0,
            bearing: this.allowPitchAndBearing
                ? this.normalizeDegrees(CesiumMath.toDegrees(cameraData.orientation.heading))
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
        const expandLon = sizeLon * 0.25;
        const expandLat = sizeLat * 0.25;

        return {
            south: south - expandLat,
            west: west - expandLon,
            width: sizeLon + expandLon * 2,
            height: sizeLat + expandLat * 2,
            camPosLon: this.viewState.longitude,
            camPosLat: this.viewState.latitude,
            orientation: CesiumMath.toRadians(this.viewState.bearing)
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
            this.mapService.tileVisualizationTopic.subscribe((tileVis: ITileVisualization) => {
                if (tileVis.viewIndex !== this._viewIndex) {
                    return;
                }
                tileVis.render(this.getSceneHandle()).then(wasRendered => {
                    if (wasRendered) {
                        this.requestRender();
                    }
                });
            })
        );

        this.subscriptions.push(
            this.mapService.tileVisualizationDestructionTopic.subscribe((tileVis: ITileVisualization) => {
                if (tileVis.viewIndex !== this._viewIndex) {
                    return;
                }
                tileVis.destroy(this.getSceneHandle());
                this.requestRender();
            })
        );
    }

    private onViewStateChange(rawViewState: any): void {
        if (this.suppressDeckViewStateEvent) {
            return;
        }
        this.stateService.focusedView = this._viewIndex;
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

    private updateViewState(nextState: DeckCameraState, setDeckProps: boolean, updateViewport: boolean): void {
        const sanitized = this.sanitizeViewState(nextState);
        this.viewState = sanitized;
        if (this.deck && setDeckProps) {
            this.suppressDeckViewStateEvent = true;
            this.deck.setProps({viewState: sanitized});
            this.suppressDeckViewStateEvent = false;
            this.requestRender();
        }
        if (updateViewport) {
            this.updateViewport();
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
                heading: CesiumMath.toRadians(this.viewState.bearing),
                pitch: CesiumMath.toRadians(this.viewState.pitch - 90),
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
        const latitudeCos = Math.max(0.01, Math.cos(CesiumMath.toRadians(latitude)));
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
        const latitudeCos = Math.max(0.01, Math.cos(CesiumMath.toRadians(latitude)));
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
