import {Injectable, OnDestroy} from "@angular/core";
import {NavigationEnd, Params, Router} from "@angular/router";
import {ReplaySubject, skip, Subscription} from "rxjs";
import {filter} from "rxjs/operators";
import {Camera, Cartesian3, Cartographic, CesiumMath} from "../integrations/cesium";
import {SelectedSourceData} from "../inspection/inspection.service";
import {AppModeService} from "./app-mode.service";
import {MapInfoItem} from "../mapdata/map.service";
import {AppState, AppStateOptions} from "./app-state";
import {z} from "zod";

export const MAX_NUM_TILES_TO_LOAD = 2048;
export const MAX_NUM_TILES_TO_VISUALIZE = 512;

export interface TileFeatureId {
    featureId: string,
    mapTileKey: string,
}

export interface StyleParameters {
    visible: boolean,
    options: Record<string, boolean|number>
}

export interface StyleURLParameters {
    v: boolean,
    o: Record<string, boolean|number>
}

export interface CameraViewState {
    destination: { lon: number, lat: number, alt: number };
    orientation: { heading: number, pitch: number, roll: number };
}

export type PanelSizeState = [] | [number, number];

const Boolish = z.union([
    z.boolean(),
    z.string()
        .transform(value => value.trim().toLowerCase())
        .refine(value => ['true', 'false', '1', '0'].includes(value))
        .transform(value => value === 'true' || value === '1'),
    z.number().refine(value => value === 0 || value === 1).transform(value => value === 1),
]);

const Numberish = z.preprocess(input => {
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (trimmed === '') {
            return input;
        }
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return input;
}, z.number());

const SearchSchema = z.union([
    z.tuple([]),
    z.tuple([z.coerce.number(), z.string()]),
]);

const CoordinatesSchema = z.union([
    z.tuple([]),
    z.tuple([z.coerce.number(), z.coerce.number()]),
]);

const TileFeatureIdSchema = z.object({
    featureId: z.string(),
    mapTileKey: z.string(),
});

const CameraPayloadSchema = z.object({
    lon: z.coerce.number().optional(),
    lat: z.coerce.number().optional(),
    alt: z.coerce.number().optional(),
    h: z.coerce.number().optional(),
    p: z.coerce.number().optional(),
    r: z.coerce.number().optional()
});
type CameraPayload = z.infer<typeof CameraPayloadSchema>;

const ViewRectangleSchema = z.union([
    z.null(),
    z.tuple([z.coerce.number(), z.coerce.number(), z.coerce.number(), z.coerce.number()]),
]);

const LayersSchema = z.array(z.tuple([z.string(), z.coerce.number(), Boolish, Boolish]));

const StylesSchema = z.record(z.string(), z.object({
    v: Boolish,
    o: z.record(z.string(), z.union([Boolish, Numberish])),
}));

const SelectedSourceDataPayloadSchema = z.object({
    mapId: z.string(),
    tileId: z.coerce.number(),
    layerId: z.string(),
    address: z.string().optional(),
    featureIds: z.string().optional(),
});
type SelectedSourceDataPayload = z.infer<typeof SelectedSourceDataPayloadSchema>;
const SelectedSourceDataSchema = z.union([z.null(), SelectedSourceDataPayloadSchema]);

const PanelStateSchema = z.union([
    z.tuple([]),
    z.tuple([z.coerce.number(), z.coerce.number()]),
]);

const SearchHistorySchema = z.union([
    z.null(),
    z.tuple([z.coerce.number(), z.string()]),
]);

function isSourceOrMetaData(mapLayerNameOrLayerId: string): boolean {
    return mapLayerNameOrLayerId.includes('/SourceData-') ||
        mapLayerNameOrLayerId.includes('/Metadata-');
}

@Injectable({providedIn: 'root'})
export class AppStateService implements OnDestroy {

    private readonly statePool = new Map<string, AppState<unknown>>();
    private readonly readySubject = new ReplaySubject<void>(1);
    public readonly ready$ = this.readySubject.asObservable();

    private readonly stateSubscriptions: Subscription[] = [];

    private _replaceUrl = true;

    private isHydrating = false;
    private isReady = false;
    private pendingUrlSync = false;
    private pendingStorageSync = false;
    private flushHandle: Promise<void> | null = null;

    // Base UI metrics
    baseFontSize: number = 16;
    inspectionContainerWidth: number = 40;
    inspectionContainerHeight: number = (window.innerHeight - 10.5 * this.baseFontSize);

    private baseCameraMoveM = 100.0;
    private baseCameraZoomM = 100.0;
    private scalingFactor = 1;

    readonly searchState = this.createState<[number, string] | []>({
        name: 'search',
        defaultValue: [],
        schema: SearchSchema,
        urlParamName: 's',
        urlIncludeInVisualizationOnly: false,
    });

    readonly markerState = this.createState<boolean>({
        name: 'marker',
        defaultValue: false,
        schema: Boolish,
        urlParamName: 'm',
        urlIncludeInVisualizationOnly: false,
    });

    readonly markedPositionState = this.createState<number[]>({
        name: 'markedPosition',
        defaultValue: [],
        schema: CoordinatesSchema,
        urlParamName: 'mp',
        urlIncludeInVisualizationOnly: false,
    });

    readonly selectedFeaturesState = this.createState<TileFeatureId[]>({
        name: 'selected',
        defaultValue: [],
        schema: z.array(TileFeatureIdSchema),
        urlParamName: 'sel',
        urlIncludeInVisualizationOnly: false,
    });

    readonly cameraViewData = this.createState<CameraViewState>({
        name: 'cameraView',
        defaultValue: {
            destination: {lon: 22.837473, lat: 38.490817, alt: 16000000},
            orientation: {heading: 6.0, pitch: -1.55, roll: 0.25},
        },
        schema: CameraPayloadSchema,
        preprocess: (value: any) => ({
            lon: value.destination.lon,
            lat: value.destination.lat,
            alt: value.destination.alt,
            h: value.orientation.heading,
            p: value.orientation.pitch,
            r: value.orientation.roll,
        }),
        postprocess: (payload: any, currentValue: CameraViewState) => ({
            destination: {
                lon: payload.lon ?? currentValue.destination.lon,
                lat: payload.lat ?? currentValue.destination.lat,
                alt: payload.alt ?? currentValue.destination.alt,
            },
            orientation: {
                heading: payload.h ?? currentValue.orientation.heading,
                pitch: payload.p ?? currentValue.orientation.pitch,
                roll: payload.r ?? currentValue.orientation.roll,
            },
        }),
        urlFormEncode: true,
    });

    readonly viewRectangleState = this.createState<[number, number, number, number] | null>({
        name: 'viewRectangle',
        defaultValue: null,
        schema: ViewRectangleSchema,
        urlParamName: 'vr',
        urlIncludeInVisualizationOnly: false,
    });

    readonly mode2dState = this.createState<boolean>({
        name: 'mode2d',
        defaultValue: false,
        schema: Boolish,
        urlParamName: 'm2d',
        urlIncludeInVisualizationOnly: false,
    });

    readonly osmEnabledState = this.createState<boolean>({
        name: 'osm',
        defaultValue: true,
        schema: Boolish,
        urlParamName: 'osm',
    });

    readonly osmOpacityState = this.createState<number>({
        name: 'osmOpacity',
        defaultValue: 30,
        schema: z.coerce.number().min(0).max(100).refine(value => Number.isInteger(value)),
        urlParamName: 'osmOp',
    });

    readonly layersState = this.createState<Array<[string, number, boolean, boolean]>>({
        name: 'layers',
        defaultValue: [],
        schema: LayersSchema,
        urlParamName: 'l',
    });

    readonly stylesState = this.createState<Record<string, StyleURLParameters>>({
        name: 'styles',
        defaultValue: {},
        schema: StylesSchema,
        urlParamName: 'sty',
    });

    readonly tilesLoadLimitState = this.createState<number>({
        name: 'tilesLoadLimit',
        defaultValue: MAX_NUM_TILES_TO_LOAD,
        schema: z.coerce.number().nonnegative(),
        urlParamName: 'tll',
    });

    readonly tilesVisualizeLimitState = this.createState<number>({
        name: 'tilesVisualizeLimit',
        defaultValue: MAX_NUM_TILES_TO_VISUALIZE,
        schema: z.coerce.number().nonnegative(),
        urlParamName: 'tvl',
    });

    readonly selectedSourceDataState = this.createState<SelectedSourceData | null>({
        name: 'selectedSourceData',
        defaultValue: null,
        schema: SelectedSourceDataSchema,
        urlParamName: 'ssd',
        urlIncludeInVisualizationOnly: false,
    });

    readonly enabledCoordsTileIdsState = this.createState<string[]>({
        name: 'enabledCoordsTileIds',
        defaultValue: ["WGS84"],
        schema: z.array(z.string()),
    });

    readonly panelState = this.createState<PanelSizeState>({
        name: 'panel',
        defaultValue: [] as PanelSizeState,
        schema: PanelStateSchema,
    });

    readonly legalInfoDialogVisibleState = this.createState<boolean>({
        name: 'legalInfoDialogVisible',
        defaultValue: false,
        schema: Boolish,
    });

    readonly lastSearchHistoryEntry = this.createState<[number, string] | null>({
        name: 'lastSearchHistoryEntry',
        defaultValue: null,
        schema: SearchHistorySchema,
    });

    constructor(private readonly router: Router) {
        this.baseFontSize = parseFloat(window.getComputedStyle(document.documentElement).fontSize);
        this.inspectionContainerWidth = 40 * this.baseFontSize;
        this.inspectionContainerHeight = window.innerHeight - 10.5 * this.baseFontSize;

        this.setupStateSubscriptions();
        this.hydrateFromStorage();
        this.hydrateFromUrl(this.router.routerState.snapshot.root?.queryParams ?? {});
        this.isHydrating = false;
        this.isReady = true;
        this.updateScalingFactor(this.cameraViewData.getValue().destination.alt);
        this.persistStates();
        this.readySubject.next();

        this.router.events.pipe(filter(event => event instanceof NavigationEnd)).subscribe(() => {
            this.withHydration(() => this.hydrateFromUrl(this.router.routerState.snapshot.root?.queryParams ?? {}));
        });
    }

    ngOnDestroy(): void {
        this.stateSubscriptions.forEach(subscription => subscription.unsubscribe());
    }

    get cameraMoveUnits() {
        return this.baseCameraMoveM * this.scalingFactor / 75000;
    }

    get cameraZoomUnits() {
        return this.baseCameraZoomM * this.scalingFactor;
    }

    get legalInfoDialogVisible(): boolean {
        return this.legalInfoDialogVisibleState.getValue();
    }

    set legalInfoDialogVisible(value: boolean) {
        this.legalInfoDialogVisibleState.next(value);
    }

    get replaceUrl() {
        const currentValue = this._replaceUrl;
        this._replaceUrl = true;
        return currentValue;
    }

    private createState<T>(options: AppStateOptions<T>): AppState<T> {
        return new AppState<T>(this.statePool, options);
    }

    private setupStateSubscriptions() {
        // NOTE: Is this the best way to implement the internal subscription mechanism?
        for (const state of this.statePool.values()) {
            const subscription = (state as AppState<unknown>).pipe(skip(1)).subscribe(value => {
                this.onStateChanged(state as AppState<unknown>, value);
            });
            this.stateSubscriptions.push(subscription);
        }
    }

    private onStateChanged(state: AppState<unknown>, value: unknown): void {
        if (state === this.cameraViewData && value) {
            const camera = value as CameraViewState;
            this.updateScalingFactor(camera.destination.alt);
        }

        if (this.isHydrating || !this.isReady) {
            return;
        }

        this.pendingStorageSync = true;
        if (state.isUrlState()) {
            this.pendingUrlSync = true;
        }

        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        if (this.flushHandle) {
            return;
        }
        this.flushHandle = Promise.resolve().then(() => {
            this.flushHandle = null;
            if (this.isHydrating) {
                this.pendingStorageSync = false;
                this.pendingUrlSync = false;
                return;
            }
            if (this.pendingStorageSync) {
                this.persistStates();
            }
            if (this.pendingUrlSync) {
                this.syncUrl();
            }
            this.pendingStorageSync = false;
            this.pendingUrlSync = false;
        });
    }

    private persistStates(): void {
        for (const state of this.statePool.values()) {
            try {
                const serialized = state.serialize(false);
                if (serialized === undefined) {
                    continue;
                }
                for (const [k, v] of Object.entries(serialized)) {
                    localStorage.setItem(k, v);
                }
            } catch (error) {
                console.error(`[AppStateService] Failed to persist state '${state.name}'`, error);
            }
        }
    }

    private syncUrl(): void {
        const params: Record<string, string> = {};
        for (const state of this.statePool.values()) {
            if (!state.isUrlState()) {
                continue;
            }
            const serialized = state.serialize(true);
            if (serialized === undefined) {
                continue;
            }
            for (const [k, v] of Object.entries(serialized)) {
                params[k] = v;
            }
        }
        const replaceUrl = this.replaceUrl;
        this.router.navigate([], {
            queryParams: params,
            queryParamsHandling: 'merge',
            replaceUrl
        }).catch(error => {
            console.error('[AppStateService] Failed to sync URL parameters', error);
        });
    }

    private hydrateFromStorage(): void {
        this.withHydration(() => {
            for (const state of this.statePool.values()) {
                const raw = localStorage.getItem(state.name);
                if (raw) {
                    state.deserialize(raw);
                }
            }
        });
    }

    private hydrateFromUrl(params: Params): void {
        this.withHydration(() => {
            for (const state of this.statePool.values()) {
                state.deserialize(params);
            }
        });
    }

    private updateScalingFactor(altitude: number): void {
        if (!Number.isFinite(altitude) || altitude <= 0) {
            this.scalingFactor = 1;
            return;
        }
        this.scalingFactor = Math.pow(altitude / 1000, 1.1) / 2;
    }

    private withHydration(callback: () => void): void {
        const previous = this.isHydrating;
        this.isHydrating = true;
        try {
            callback();
        } finally {
            this.isHydrating = previous;
        }
    }

    // -----------------
    // Public API below
    // -----------------

    getCameraOrientation() {
        return this.cameraViewData.getValue().orientation;
    }

    getCameraPosition() {
        const destination = this.cameraViewData.getValue().destination;
        return Cartesian3.fromDegrees(destination.lon, destination.lat, destination.alt);
    }

    setView(destination: Cartesian3, orientation: { heading: number, pitch: number, roll: number }) {
        const cartographic = Cartographic.fromCartesian(destination);
        const view: CameraViewState = {
            destination: {
                lon: CesiumMath.toDegrees(cartographic.longitude),
                lat: CesiumMath.toDegrees(cartographic.latitude),
                alt: cartographic.height,
            },
            orientation: {
                heading: orientation.heading,
                pitch: orientation.pitch,
                roll: orientation.roll,
            }
        };
        this.cameraViewData.next(view);
    }

    setCameraState(camera: Camera) {
        const currentPositionCartographic = Cartographic.fromCartesian(camera.position);
        const nextView: CameraViewState = {
            destination: {
                lon: CesiumMath.toDegrees(currentPositionCartographic.longitude),
                lat: CesiumMath.toDegrees(currentPositionCartographic.latitude),
                alt: currentPositionCartographic.height,
            },
            orientation: {
                heading: camera.heading,
                pitch: camera.pitch,
                roll: camera.roll,
            }
        };
        this.cameraViewData.next(nextView);
    }

    set2DCameraState(camera: Camera) {
        const viewRect = camera.computeViewRectangle();
        const currentPositionCartographic = Cartographic.fromCartesian(camera.position);

        if (viewRect) {
            this.viewRectangleState.next([
                CesiumMath.toDegrees(viewRect.west),
                CesiumMath.toDegrees(viewRect.south),
                CesiumMath.toDegrees(viewRect.east),
                CesiumMath.toDegrees(viewRect.north)
            ]);
            const center = Cartographic.fromRadians(
                (viewRect.west + viewRect.east) / 2,
                (viewRect.north + viewRect.south) / 2
            );
            this.cameraViewData.next({
                destination: {
                    lon: CesiumMath.toDegrees(center.longitude),
                    lat: CesiumMath.toDegrees(center.latitude),
                    alt: currentPositionCartographic.height,
                },
                orientation: {
                    heading: camera.heading,
                    pitch: camera.pitch,
                    roll: camera.roll,
                }
            });
        } else {
            this.cameraViewData.next({
                destination: {
                    lon: CesiumMath.toDegrees(currentPositionCartographic.longitude),
                    lat: CesiumMath.toDegrees(currentPositionCartographic.latitude),
                    alt: currentPositionCartographic.height,
                },
                orientation: {
                    heading: camera.heading,
                    pitch: camera.pitch,
                    roll: camera.roll,
                }
            });
        }
    }

    setCameraMode(isEnabled: boolean) {
        this.mode2dState.next(isEnabled);
    }

    setSelectedSourceData(selection: SelectedSourceData) {
        this.selectedSourceDataState.next(selection);
    }

    unsetSelectedSourceData() {
        this.selectedSourceDataState.next(null);
    }

    getSelectedSourceData(): SelectedSourceData | null {
        return this.selectedSourceDataState.getValue();
    }

    setSelectedFeatures(newSelection: TileFeatureId[]) {
        const currentSelection = this.selectedFeaturesState.getValue();
        if (newSelection.length !== currentSelection.length || newSelection.some( (v, i) => v.featureId !== currentSelection[i].featureId || v.mapTileKey !== currentSelection[i].mapTileKey)) {
            return false;
        }
        this.selectedFeaturesState.next(newSelection.map(feature => ({...feature})));
        this._replaceUrl = false;
        return true;
    }

    setMarkerState(enabled: boolean) {
        this.markerState.next(enabled);
        if (!enabled) {
            this.setMarkerPosition(null, false);
        }
    }

    setMarkerPosition(position: Cartographic | null, delayUpdate: boolean = false) {
        if (position) {
            const longitude = CesiumMath.toDegrees(position.longitude);
            const latitude = CesiumMath.toDegrees(position.latitude);
            this.markedPositionState.next([longitude, latitude]);
        } else {
            this.markedPositionState.next([]);
        }
        if (!delayUpdate) {
            this._replaceUrl = false;
        }
    }

    mapLayerConfig(mapId: string, layerId: string, fallbackLevel: number): [boolean, number, boolean] {
        const conf = this.layersState.getValue().find(ml => ml[0] === `${mapId}/${layerId}`);
        if (conf !== undefined && conf[2]) {
            return [true, conf[1], conf[3]];
        }
        return [this.layersState.getValue().length === 0, fallbackLevel, false];
    }

    setMapLayerConfig(mapId: string, layerId: string, level: number, visible: boolean, tileBorders: boolean) {
        if (isSourceOrMetaData(layerId)) {
            return;
        }
        const mapLayerName = `${mapId}/${layerId}`;
        const layers = [...this.layersState.getValue()];
        const index = layers.findIndex(val => val[0] === mapLayerName);
        if (index !== -1) {
            layers[index] = [mapLayerName, level, visible, tileBorders];
        } else if (visible) {
            layers.push([mapLayerName, level, visible, tileBorders]);
        }
        this.layersState.next(layers);
    }

    setMapConfig(layerParams: {
        mapId: string,
        layerId: string,
        level: number,
        visible: boolean,
        tileBorders: boolean
    }[]) {
        const layers = [...this.layersState.getValue()];
        layerParams.forEach(params => {
            if (!isSourceOrMetaData(params.layerId)) {
                const mapLayerName = `${params.mapId}/${params.layerId}`;
                const index = layers.findIndex(val => val[0] === mapLayerName);
                if (index !== -1) {
                    layers[index] = [mapLayerName, params.level, params.visible, params.tileBorders];
                } else if (params.visible) {
                    layers.push([mapLayerName, params.level, params.visible, params.tileBorders]);
                }
            }
        });
        this.layersState.next(layers);
    }

    setInitialMapLayers(layers: Array<[string, number, boolean, boolean]>) {
        if (this.layersState.getValue().length) {
            return;
        }
        const filtered = layers.filter(layer => !isSourceOrMetaData(layer[0]));
        if (!filtered.length) {
            return;
        }
        this.layersState.next(filtered);
    }

    setInitialStyles(styles: Map<string, { params: StyleParameters }>) {
        if (Object.keys(this.stylesState.getValue()).length) {
            return;
        }
        const initial: Record<string, StyleURLParameters> = {};
        styles.forEach((style, styleId) => {
            const params = style?.params;
            if (params) {
                initial[styleId] = this.styleParamsToURLParams(params);
            }
        });
        if (Object.keys(initial).length) {
            this.stylesState.next(initial);
        }
    }

    styleConfig(styleId: string): StyleParameters {
        const styles = this.stylesState.getValue();
        if (styles.hasOwnProperty(styleId)) {
            return this.styleURLParamsToParams(styles[styleId]);
        }
        return {
            visible: true,
            options: {}
        };
    }

    setStyleConfig(styleId: string, params: StyleParameters) {
        const styles = {...this.stylesState.getValue()};
        styles[styleId] = this.styleParamsToURLParams(params);
        this.stylesState.next(styles);
    }

    setCoordinatesAndTileIds(selectedOptions: Array<string>) {
        this.enabledCoordsTileIdsState.next([...selectedOptions]);
    }

    getCoordinatesAndTileIds() {
        return this.enabledCoordsTileIdsState.getValue();
    }

    resetSearchHistoryState() {
        this.searchState.next([]);
    }

    setSearchHistoryState(value: [number, string] | null, saveHistory: boolean = true) {
        const trimmed = value ? [value[0], value[1].trim()] as [number, string] : null;
        if (trimmed && saveHistory) {
            this.saveHistoryStateValue(trimmed);
        }
        this.searchState.next(trimmed ? trimmed : []);
        this._replaceUrl = false;
        this.lastSearchHistoryEntry.next(trimmed);
    }

    private saveHistoryStateValue(value: [number, string]) {
        const searchHistoryString = localStorage.getItem("searchHistory");
        if (searchHistoryString) {
            let parsed = JSON.parse(searchHistoryString) as any;
            let searchHistory: Array<[number, string]>;
            if (Array.isArray(parsed) && parsed.length && Array.isArray(parsed[0])) {
                searchHistory = parsed as Array<[number, string]>;
            } else if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'number' && typeof parsed[1] === 'string') {
                searchHistory = [parsed as [number, string]];
            } else {
                searchHistory = [];
            }
            searchHistory = searchHistory.filter((entry: [number, string]) => !(entry[0] === value[0] && entry[1] === value[1]));
            searchHistory.unshift(value);
            while (searchHistory.length > 100) {
                searchHistory.pop();
            }
            localStorage.setItem("searchHistory", JSON.stringify(searchHistory));
        } else {
            localStorage.setItem("searchHistory", JSON.stringify([value]));
        }
    }

    resetStorage() {
        for (const state of this.statePool.values()) {
            state.resetToDefault();
            localStorage.removeItem(state.name);
        }
        localStorage.removeItem('searchHistory');
        const {origin, pathname} = window.location;
        window.location.href = origin + pathname;
    }

    onInspectionContainerResize(event: MouseEvent): void {
        const element = event.target as HTMLElement;
        if (!element.classList.contains("resizable-container")) {
            return;
        }
        if (!element.offsetWidth || !element.offsetHeight) {
            return;
        }
        this.baseFontSize = parseFloat(window.getComputedStyle(document.documentElement).fontSize);
        const currentEmWidth = element.offsetWidth / this.baseFontSize;
        if (currentEmWidth < 40.0) {
            this.inspectionContainerWidth = 40 * this.baseFontSize;
        } else {
            this.inspectionContainerWidth = element.offsetWidth;
        }
        this.inspectionContainerHeight = element.offsetHeight;

        const panel: PanelSizeState = [
            this.inspectionContainerWidth / this.baseFontSize,
            this.inspectionContainerHeight / this.baseFontSize
        ];
        this.panelState.next(panel);
    }

    pruneMapLayerConfig(mapItems: Array<MapInfoItem>): boolean {
        const mapLayerIds = new Set<string>();
        mapItems.forEach(mapItem => {
            mapItem.layers.keys().forEach(layerId => {
                mapLayerIds.add(`${mapItem.mapId}/${layerId}`);
            });
        });

        const filteredLayers = this.layersState.getValue().filter(layer => {
            return mapLayerIds.has(layer[0]) && !isSourceOrMetaData(layer[0]);
        });
        this.layersState.next(filteredLayers);
        return filteredLayers.length === 0;
    }

    private styleParamsToURLParams(params: StyleParameters): StyleURLParameters {
        return { v: params.visible, o: params.options };
    }

    private styleURLParamsToParams(params: StyleURLParameters): StyleParameters {
        return { visible: params.v, options: params.o };
    }
}
