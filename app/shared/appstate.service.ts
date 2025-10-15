import {Injectable, OnDestroy} from "@angular/core";
import {NavigationEnd, Params, Router} from "@angular/router";
import {BehaviorSubject, skip, Subscription, take} from "rxjs";
import {filter} from "rxjs/operators";
import {Cartographic, CesiumMath} from "../integrations/cesium";
import {SelectedSourceData} from "../inspection/inspection.service";
import {AppState, AppStateOptions, Boolish, MapViewState} from "./app-state";
import {z} from "zod";
import {MapTreeNode} from "../mapdata/map.tree.model";

export const MAX_NUM_TILES_TO_LOAD = 2048;
export const MAX_NUM_TILES_TO_VISUALIZE = 512;
export const VIEW_SYNC_PROJECTION = "proj";
export const VIEW_SYNC_POSITION = "pos";

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

export interface LayerViewConfig {
    level: number;
    visible: boolean;
    tileBorders: boolean;

    // TODO: We need style options here.
}

export type PanelSizeState = [] | [number, number];

function isSourceOrMetaData(mapLayerNameOrLayerId: string): boolean {
    return mapLayerNameOrLayerId.includes('/SourceData-') ||
        mapLayerNameOrLayerId.includes('/Metadata-');
}

@Injectable({providedIn: 'root'})
export class AppStateService implements OnDestroy {

    private readonly statePool = new Map<string, AppState<unknown>>();
    readonly ready = new BehaviorSubject<boolean>(false);

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

    readonly numViewsState = this.createState<number>({
        name: "numberOfViews",
        defaultValue: 1,
        schema: z.coerce.number().positive(),
        urlParamName: "n"
    });

    readonly searchState = this.createState<[number, string] | []>({
        name: 'search',
        defaultValue: [],
        schema: z.union([
            z.tuple([]),
            z.tuple([z.coerce.number(), z.string()]),
        ]),
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
        schema: z.union([
            z.tuple([]),
            z.tuple([z.coerce.number(), z.coerce.number()]),
        ]),
        urlParamName: 'mp',
        urlIncludeInVisualizationOnly: false,
    });

    readonly selectedFeaturesState = this.createState<[number, TileFeatureId][]>({
        name: 'selected',
        defaultValue: [],
        schema: z.array(z.tuple([
            z.coerce.number().nonnegative(),
            z.object({
                featureId: z.string(),
                mapTileKey: z.string(),
            })
        ])),
        urlParamName: 'sel',
        urlIncludeInVisualizationOnly: false,
    });

    readonly focusedViewState = this.createState<number>({
        name: 'focus',
        defaultValue: 0,
        schema: z.coerce.number().nonnegative(),
        urlParamName: 'f',
        urlIncludeInVisualizationOnly: false,
    });

    readonly viewSyncState = this.createState<string[]>({
        name: 'viewSync',
        defaultValue: [],
        schema: z.array(z.union([z.literal(VIEW_SYNC_PROJECTION), z.literal(VIEW_SYNC_POSITION)])),
        urlParamName: 'sync',
        urlIncludeInVisualizationOnly: false,
    });

    readonly cameraViewDataState = this.createMapViewState<CameraViewState>({
        name: 'cameraView',
        defaultValue: {
            destination: {lon: 22.837473, lat: 38.490817, alt: 16000000},
            orientation: {heading: 6.0, pitch: -1.55, roll: 0.25},
        },
        schema: z.object({
            lon: z.coerce.number().optional(),
            lat: z.coerce.number().optional(),
            alt: z.coerce.number().optional(),
            h: z.coerce.number().optional(),
            p: z.coerce.number().optional(),
            r: z.coerce.number().optional()
        }),
        toStorage: (value: any) => ({
            lon: value.destination.lon,
            lat: value.destination.lat,
            alt: value.destination.alt,
            h: value.orientation.heading,
            p: value.orientation.pitch,
            r: value.orientation.roll,
        }),
        fromStorage: (payload: any, currentValue: CameraViewState) => ({
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

    readonly mode2dState = this.createMapViewState<boolean>({
        name: 'mode2d',
        defaultValue: false,
        schema: Boolish,
        urlParamName: 'm2d',
        urlIncludeInVisualizationOnly: false,
    });

    readonly osmEnabledState = this.createMapViewState<boolean>({
        name: 'osm',
        defaultValue: true,
        schema: Boolish,
        urlParamName: 'osm',
    });

    readonly osmOpacityState = this.createMapViewState<number>({
        name: 'osmOpacity',
        defaultValue: 30,
        schema: z.coerce.number().min(0).max(100).refine(value => Number.isInteger(value)),
        urlParamName: 'osmOp',
    });

    readonly layerNamesState = this.createState<Array<string>>({
        name: "layerNames",
        defaultValue: [],
        schema: z.array(z.string()),
        urlParamName: 'l'
    });

    readonly layerVisibilityState = this.createMapViewState<Array<boolean>>({
        name: "visibility",
        defaultValue: [],
        schema: z.array(Boolish),
        urlParamName: 'v'
    });

    readonly layerTileBordersState = this.createMapViewState<Array<boolean>>({
        name: "tileBorders",
        defaultValue: [],
        schema: z.array(Boolish),
        urlParamName: 'tb'
    });

    readonly layerZoomLevelState = this.createMapViewState<Array<number>>({
        name: "zoomLevel",
        defaultValue: [],
        schema: z.array(z.number().min(0).max(15)),
        urlParamName: 'z'
    });

    /*
    Style Option State Encoding:

       We have a compact schema for encoding style option values on a
       per-stylesheet per-map-layer per-view basis. For each style sheet,
       we encode its option values in a single URL parameter. This URL
       parameter is composed as follows:

       <short-style-id>~<dash-separated-layerName-indices>~<tilde-separated-option-names>=
       <tilde-separated-array-per-option-of-colon-separated-array-per-view-of-comma-separated-values-per-layer>

    For example:

       NY0X~1-2-3~showLanes~showLaneGroups~ADAS=1,0,0:1,0,0~1,1,1:0,0,0~0,0,0:0,0,0

       NY0X   - is the short style id.
       1-2-3  - The indices of the layer names in the layerNames state for which values are stored.
       showLanes~showLaneGroups~ADAS - The style option IDs for which values are stored.
       1,0,0:1,0,0~1,1,1:0,0,0~0,0,0:0,0,0 - breaks down into three pairs of tilde-separated per-view-per-layer option value arrays:
       a) 1,0,0:1,0,0 - The values for the showLanes option. Two arrays of values (one for each map view).
                        Three values, as there are three affected layers (1-2-3).
       b) 1,1,1:0,0,0 - The values for the showLaneGroups option. Again, two sets of values (per view) and three values
                        (one per layer) per view.
       b) 0,0,0:0,0,0 - The values for the ADAS option. Same encoding as for showLanes and showLaneGroups.
    */
    // TODO: Add a member variable which contains this information

    readonly stylesState = this.createState<Record<string, StyleURLParameters>>({
        name: 'styles',
        defaultValue: {},
        schema: z.record(z.string(), z.object({
            v: Boolish,
            o: z.record(z.string(), z.union([z.boolean(), z.number()])),
        })),
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
        schema: z.union([z.null(), z.object({
            mapId: z.string(),
            tileId: z.coerce.number(),
            layerId: z.string(),
            address: z.string().optional(),
            featureIds: z.string().optional(),
        })]),
        urlParamName: 'ssd',
        urlIncludeInVisualizationOnly: false,
        toStorage: (value) => {
            if (!value) {
                return value;
            }
            const address = value.address !== undefined ? value.address.toString() : undefined;
            return {
                ...value,
                address,
            };
        },
        fromStorage: (payload) => {
            if (!payload) {
                return null;
            }
            const stored = payload as any;
            let address: bigint | undefined = undefined;
            if (stored.address !== undefined && stored.address !== null && stored.address !== "") {
                try {
                    address = BigInt(stored.address);
                } catch (error) {
                    console.warn('[AppStateService] Failed to parse persisted source data address', stored.address, error);
                    address = undefined;
                }
            }
            return {
                ...stored,
                address,
            } as SelectedSourceData;
        },
    });

    readonly enabledCoordsTileIdsState = this.createState<string[]>({
        name: 'enabledCoordsTileIds',
        defaultValue: ["WGS84"],
        schema: z.array(z.string()),
    });

    readonly panelState = this.createState<PanelSizeState>({
        name: 'panel',
        defaultValue: [] as PanelSizeState,
        schema: z.union([
            z.tuple([]),
            z.tuple([z.coerce.number(), z.coerce.number()]),
        ]),
    });

    readonly legalInfoDialogVisibleState = this.createState<boolean>({
        name: 'legalInfoDialogVisible',
        defaultValue: false,
        schema: Boolish,
    });

    readonly lastSearchHistoryEntryState = this.createState<[number, string] | null>({
        name: 'lastSearchHistoryEntry',
        defaultValue: null,
        schema: z.union([
            z.null(),
            z.tuple([z.coerce.number(), z.string()]),
        ]),
    });

    constructor(private readonly router: Router) {
        this.baseFontSize = parseFloat(window.getComputedStyle(document.documentElement).fontSize);
        this.inspectionContainerWidth = 40 * this.baseFontSize;
        this.inspectionContainerHeight = window.innerHeight - 10.5 * this.baseFontSize;

        this.router.events.pipe(filter(event => event instanceof NavigationEnd), take(1)).subscribe(() => {
            this.setupStateSubscriptions();
            this.hydrateFromStorage();
            this.hydrateFromUrl(this.router.routerState.snapshot.root?.queryParams ?? {});
            this.isHydrating = false;
            this.isReady = true;
            this.persistStates();
            this.ready.next(true);
        });
    }

    ngOnDestroy(): void {
        this.stateSubscriptions.forEach(subscription => subscription.unsubscribe());
    }

    get replaceUrl() {
        const currentValue = this._replaceUrl;
        this._replaceUrl = true;
        return currentValue;
    }

    private createState<T>(options: AppStateOptions<T>): AppState<T> {
        return new AppState<T>(this.statePool, options);
    }

    private createMapViewState<T>(options: AppStateOptions<T>): MapViewState<T> {
        return new MapViewState<T>(this.statePool, options);
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

    get numViews() {return this.numViewsState.getValue();}
    set numViews(val: number) {this.numViewsState.next(val);};
    get search() {return this.searchState.getValue();}
    set search(val: [number, string] | []) {this.searchState.next(val);};
    get marker() {return this.markerState.getValue();}
    set marker(val: boolean) {this.markerState.next(val);};
    get markedPosition() {return this.markedPositionState.getValue();}
    set markedPosition(val: number[]) {this.markedPositionState.next(val);};
    get selectedFeatures() {return this.selectedFeaturesState.getValue();}
    set selectedFeatures(val: [number, TileFeatureId][]) {this.selectedFeaturesState.next(val);};
    get focusedView() {return this.focusedViewState.getValue();}
    set focusedView(val: number) {this.focusedViewState.next(val);};
    get layerNames() {return this.layerNamesState.getValue();}
    set layerNames(val: Array<string>) {this.layerNamesState.next(val);};
    get styles() {return this.stylesState.getValue();}
    set styles(val: Record<string, StyleURLParameters>) {this.stylesState.next(val);};
    get tilesLoadLimit() {return this.tilesLoadLimitState.getValue();}
    set tilesLoadLimit(val: number) {this.tilesLoadLimitState.next(val);};
    get tilesVisualizeLimit() {return this.tilesVisualizeLimitState.getValue();}
    set tilesVisualizeLimit(val: number) {this.tilesVisualizeLimitState.next(val);};
    get selectedSourceData() {return this.selectedSourceDataState.getValue();}
    set selectedSourceData(val: SelectedSourceData | null) {this.selectedSourceDataState.next(val);};
    get enabledCoordsTileIds() {return this.enabledCoordsTileIdsState.getValue();}
    set enabledCoordsTileIds(val: string[]) {this.enabledCoordsTileIdsState.next(val);};
    get panel() {return this.panelState.getValue();}
    set panel(val: PanelSizeState) {this.panelState.next(val);};
    get legalInfoDialogVisible() {return this.legalInfoDialogVisibleState.getValue();}
    set legalInfoDialogVisible(val: boolean) {this.legalInfoDialogVisibleState.next(val);};
    get lastSearchHistoryEntry() {return this.lastSearchHistoryEntryState.getValue();}
    set lastSearchHistoryEntry(val: [number, string] | null) {this.lastSearchHistoryEntryState.next(val);};
    get viewSync() {return this.viewSyncState.getValue();}
    set viewSync(val: string[]) {this.viewSyncState.next(val);};

    getCameraOrientation(viewIndex: number) {
        return this.cameraViewDataState.getValue(viewIndex).orientation;
    }

    getCameraPosition(viewIndex: number) {
        const destination = this.cameraViewDataState.getValue(viewIndex).destination;
        return Cartographic.fromDegrees(destination.lon, destination.lat, destination.alt);
    }

    private _setView(viewIndex: number, destination: Cartographic, orientation?: { heading: number, pitch: number, roll: number }) {
        const newOrientation = orientation !== undefined ? orientation : {
            heading: 0.0,
            pitch: -90,
            roll: 0.0
        }
        const view: CameraViewState = {
            destination: {
                lon: CesiumMath.toDegrees(destination.longitude),
                lat: CesiumMath.toDegrees(destination.latitude),
                alt: destination.height,
            },
            orientation: {
                heading: newOrientation.heading,
                pitch: newOrientation.pitch,
                roll: newOrientation.roll,
            }
        };
        this.cameraViewDataState.next(viewIndex, view);
    }

    setView(viewIndex: number, destination: Cartographic, orientation?: { heading: number, pitch: number, roll: number }) {
        if (this.viewSync.includes(VIEW_SYNC_POSITION)) {
            // Unfocused view is trying to update itself when the views are synchronized
            if (viewIndex !== this.focusedView) {
                return;
            }

            for (let i = 0; i < this.numViews; i++) {
                this._setView(i, destination, orientation);
            }
            return;
        }

        this._setView(viewIndex, destination, orientation);
    }

    setProjectionMode(viewIndex: number, is2DMode: boolean) {
        if (this.viewSync.includes(VIEW_SYNC_PROJECTION)) {
            // Unfocused view is trying to update itself when the views are synchronized
            if (viewIndex !== this.focusedView) {
                return;
            }

            for (let i = 0; i < this.numViews; i++) {
                this.mode2dState.next(i, is2DMode);
            }
            return;
        }
        this.mode2dState.next(viewIndex, is2DMode);
    }

    setSelectedFeatures(viewIndex: number, newSelection: TileFeatureId[]) {
        const currentSelection = this.selectedFeatures;
        if (newSelection.length === currentSelection.length &&
            newSelection.every((v, i) =>
                v.featureId === currentSelection[i][1].featureId && v.mapTileKey === currentSelection[i][1].mapTileKey)) {
            return false;
        }
        this.selectedFeatures = newSelection.map(feature => ([viewIndex, {...feature}]));
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

    mapLayerConfig(mapId: string, layerId: string, fallbackVisibility: boolean = true, fallbackLevel: number = 13): LayerViewConfig[] {
        if (isSourceOrMetaData(layerId)) {
            return [];
        }
        const mapLayerId = `${mapId}/${layerId}`;
        const names = this.layerNames;
        let layerIndex = names.findIndex(ml => ml === mapLayerId);
        if (layerIndex === -1) {
            layerIndex = names.length;
            // TODO: Ensure that this will not trigger bad things.
            this.layerNamesState.next([...names, mapLayerId]);
        }
        const result = new Array<LayerViewConfig>();
        const layerStateValue = <T>(state: MapViewState<Array<T>>, viewIndex: number, defaultValue: T) => {
            const resultForView = state.getValue(viewIndex);
            while (resultForView.length <= layerIndex) {
                resultForView.push(defaultValue);
            }
            // TODO: Ensure that this will not trigger bad things.
            state.next(viewIndex, resultForView);
            return resultForView[layerIndex];
        }

        for (let viewIndex = 0; viewIndex < this.numViewsState.getValue(); viewIndex++) {
            result.push({
                visible: layerStateValue(this.layerVisibilityState, viewIndex, fallbackVisibility),
                level: layerStateValue(this.layerZoomLevelState, viewIndex, fallbackLevel),
                tileBorders: layerStateValue(this.layerTileBordersState, viewIndex, false),
            });
        }
        return result;
    }

    setMapLayerConfig(mapId: string, layerId: string, viewConfig: LayerViewConfig[], fallbackLevel: number = 13) {
        if (isSourceOrMetaData(layerId) || viewConfig.length < this.numViewsState.getValue()) {
            return;
        }
        const mapLayerId = `${mapId}/${layerId}`;
        const names = this.layerNames;
        let layerIndex = names.findIndex(ml => ml === mapLayerId);
        if (layerIndex === -1) {
            layerIndex = names.length;
            // TODO: Ensure that this will not trigger bad things.
            this.layerNamesState.next([...names, mapLayerId]);
        }

        const insertLayerState = <T>(state: MapViewState<T[]>, viewIndex: number, value: T, defaultValue: T) => {
            const values = state.getValue(viewIndex);
            while (values.length <= layerIndex) {
                values.push(defaultValue);
            }
            values[layerIndex] = value;
            // TODO: Ensure that this will not trigger bad things.
            state.next(viewIndex, values);
        };

        for (let viewIndex = 0; viewIndex < viewConfig.length; viewIndex++) {
            insertLayerState(this.layerVisibilityState, viewIndex, viewConfig[viewIndex].visible, false);
            insertLayerState(this.layerZoomLevelState, viewIndex, viewConfig[viewIndex].level, fallbackLevel);
            insertLayerState(this.layerTileBordersState, viewIndex, viewConfig[viewIndex].tileBorders,false);
        }
    }


    /**
     * Get style option values for a specific map layer style option.
     * The returned values correspond to the number of parallel views.
     * Note: This will NOT change the layerConfig array. Instead, if the
     * map layer does not exist in layerNames, an exception will be thrown.
     */
    styleOptionValues(mapId: string, layerId: string, shortStyleId: string, optionId: string, optionType: string, defaultValue: string|number|boolean): (string|number|boolean)[] {
        // TODO: Implement
    }

    /**
     * Set style option values for a specific map layer style combination.
     * Note: This will NOT change the layerConfig array. Instead, if the
     *  map layer does not exist in layerNames, an exception will be thrown.
     */
    setStyleOptionValues(mapId: string, layerId: string, shortStyleId: string, optionId: string, viewOptionValues: (string|number|boolean)[]) {
        // TODO: Implement
    }

    /** DEPRECATED */
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

    /** DEPRECATED - Will be replaced in favor of new per-view per-layer styleOptionValues API. */
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

    /** DEPRECATED - Will be replaced in favor of new per-view per-layer styleOptionValues API. */
    setStyleConfig(styleId: string, params: StyleParameters) {
        const styles = {...this.stylesState.getValue()};
        styles[styleId] = this.styleParamsToURLParams(params);
        this.stylesState.next(styles);
    }

    setSearchHistoryState(value: [number, string] | null, saveHistory: boolean = true) {
        const trimmed = value ? [value[0], value[1].trim()] as [number, string] : null;
        if (trimmed && saveHistory) {
            this.saveHistoryStateValue(trimmed);
        }
        this.searchState.next(trimmed ? trimmed : []);
        this._replaceUrl = false;
        this.lastSearchHistoryEntryState.next(trimmed);
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

    // TODO: This is view logic which should be in Inspection Panel component upon
    //  main View template fully moving there as a first-level citizen: currently
    //  the View implementation is split across Feature and SourceData components
    //  which complicates their state management.
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

    pruneMapLayerConfig(mapItems: Array<MapTreeNode>): boolean {
        // TODO: Fix, use.
        // TODO: Must also prune style options for the pruned layers.
        const mapLayerIds = new Set<string>();
        mapItems.forEach(mapItem => {
            mapItem.layers.keys().forEach(layerId => {
                mapLayerIds.add(`${mapItem.id}/${layerId}`);
            });
        });

        const indicesToRemove = this.layerNamesState.getValue().reduce((acc, l, i) => {
            if (!mapLayerIds.has(l) || isSourceOrMetaData(l)) {
                acc.add(i);
            }
            return acc;
        }, new Set<number>());

        const layerNames = this.layerNamesState.getValue().filter((_, i) => !indicesToRemove.has(i));
        for (let viewIndex = 0; viewIndex < this.numViewsState.getValue(); viewIndex++) {
            const visibilities = this.layerVisibilityState.getValue(viewIndex).filter((_, i) => !indicesToRemove.has(i));
            const levels = this.layerZoomLevelState.getValue(viewIndex).filter((_, i) => !indicesToRemove.has(i));
            const tileBorders = this.layerTileBordersState.getValue(viewIndex).filter((_, i) => !indicesToRemove.has(i));
            this.layerVisibilityState.next(viewIndex, visibilities);
            this.layerZoomLevelState.next(viewIndex, levels);
            this.layerTileBordersState.next(viewIndex, tileBorders);
        }
        this.layerNamesState.next(layerNames);

        // If all layers were pruned, return true.
        return layerNames.length === 0;
    }

    /** DEPRECATED */
    private styleParamsToURLParams(params: StyleParameters): StyleURLParameters {
        return { v: params.visible, o: params.options };
    }

    /** DEPRECATED */
    private styleURLParamsToParams(params: StyleURLParameters): StyleParameters {
        return { visible: params.v, options: params.o };
    }
}
