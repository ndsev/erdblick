import {Injectable, OnDestroy} from "@angular/core";
import {NavigationEnd, NavigationStart, Params, Router} from "@angular/router";
import {BehaviorSubject, skip, Subscription, take} from "rxjs";
import {filter} from "rxjs/operators";
import {Cartographic, CesiumMath} from "../integrations/cesium";
import {AppState, AppStateOptions, Boolish, MapViewState, StyleState} from "./app-state";
import {z} from "zod";
import {MapTreeNode} from "../mapdata/map.tree.model";
import {ErdblickStyle} from "../styledata/style.service";
import {coreLib} from "../integrations/wasm";

export const MAX_NUM_TILES_TO_LOAD = 2048;
export const MAX_NUM_TILES_TO_VISUALIZE = 512;
export const VIEW_SYNC_PROJECTION = "proj";
export const VIEW_SYNC_POSITION = "pos";
export const VIEW_SYNC_MOVEMENT = "mov";
export const VIEW_SYNC_LAYERS = "lay";
export const MAX_NUM_SELECTIONS = 3;
export const DEFAULT_EM_WIDTH = 30;
export const DEFAULT_EM_HEIGHT = 40;
export const DEFAULT_HIGHLIGHT_COLORS = [
    "#fff314",
    "#4ad6d6",
    "#8f52ff",
    "#ff1212",
    "#3474ff",
    "#ff04d6",
    "#ffa600",
    "#b3ff99",
    "#ccefff",
    "#58cf08"
]

export interface TileFeatureId {
    featureId: string;
    mapTileKey: string;
}

export interface SelectedSourceData {
    mapTileKey: string;
    address?: bigint;
}

export interface InspectionPanelModel<FeatureRepresentation> {
    id: number;
    features: FeatureRepresentation[];
    pinned: boolean;
    size: [number, number];
    sourceData?: SelectedSourceData;
    color: string;
}

export interface CameraViewState {
    destination: { lon: number, lat: number, alt: number };
    orientation: { heading: number, pitch: number, roll: number };
}

export interface LayerViewConfig {
    level: number;
    visible: boolean;
    tileBorders: boolean;
}

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
    private subscriptionsSetup = false;
    private pendingUrlSyncStates = new Set<AppState<any>>;
    private pendingStorageSyncStates = new Set<AppState<any>>;
    private pendingPopstateHydration = false;
    private flushHandle: Promise<void> | null = null;
    private readonly STYLE_OPTIONS_STORAGE_KEY = 'styleOptions';

    // Base UI metrics
    get baseFontSize(): number {
        return parseFloat(window.getComputedStyle(document.documentElement).fontSize);
    }
    get defaultInspectionPanelSize(): [number, number] {
        return [DEFAULT_EM_WIDTH, DEFAULT_EM_HEIGHT];
    }

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
        urlIncludeInVisualizationOnly: false
    });

    readonly markerState = this.createState<boolean>({
        name: 'marker',
        defaultValue: false,
        schema: Boolish,
        urlParamName: 'm',
        urlIncludeInVisualizationOnly: false
    });

    readonly markedPositionState = this.createState<number[]>({
        name: 'markedPosition',
        defaultValue: [],
        schema: z.union([
            z.tuple([]),
            z.tuple([z.coerce.number(), z.coerce.number()]),
        ]),
        urlParamName: 'mp',
        urlIncludeInVisualizationOnly: false
    });

    // 2~0~features:map:layer:tile~featureid~layertype:map:layer:tile~featureid~layertype:map:layer:tile~featureid~245:56
    // 1~0~sourcedata:map:layer:tile~address~...features...~size
    // 0~1~...
    readonly selectionState = this.createState<InspectionPanelModel<TileFeatureId>[]>({
        name: 'selected',
        defaultValue: [],
        schema: z.array(z.string()),
        toStorage: (value: InspectionPanelModel<TileFeatureId>[])=> {
            return value.map(state => {
                let s = `${state.id}~${state.pinned ? 1 : 0}~`;
                if (state.sourceData) {
                    s += `${state.sourceData.mapTileKey}~${state.sourceData.address ?? ''}~`
                }
                s += `${state.features.map(id => `${id.mapTileKey}~${id.featureId}`).join('~')}~`;
                s += `${state.size[0]}:${state.size[1]}~${state.color}`;
                return s;
            });
        },
        fromStorage: (payload: any): InspectionPanelModel<TileFeatureId>[] => {
            const result: InspectionPanelModel<TileFeatureId>[] = []
            if (!payload || !payload.length) {
                return result;
            }
            for (const panelStateStr of payload) {
                const parts: string[] = panelStateStr.split('~');
                if (parts.length < 6) {
                    continue;
                }
                const id = Number(parts.shift()!);
                const pinState = parts.shift() === "1";
                const color = parts.pop()!;
                const sizeParts = parts.pop()!.split(':');
                const size = sizeParts.length === 2 ? [Number(sizeParts[0]), Number(sizeParts[1])] : this.defaultInspectionPanelSize;

                const newPanelState: InspectionPanelModel<TileFeatureId> = {
                    id: id,
                    features: [],
                    pinned: pinState,
                    size: size as [number, number],
                    color: color
                };

                // Check if the first MapTileKey is for SourceData.
                if (parts[0].startsWith("SourceData:")) {
                    const mapTileKey = parts.shift()!;
                    newPanelState.sourceData = {
                        mapTileKey: mapTileKey,
                        address: parts[0].length ? BigInt(parts[0]) : undefined
                    };
                    // Shift the address.
                    parts.shift();
                }

                // The remaining strings are MapTileKey-FeatureId-pairs.
                while (parts.length >= 2) {
                    newPanelState.features.push({
                        mapTileKey: parts.shift()!,
                        featureId: parts.shift()!
                    })
                }

                result.push(newPanelState);
            }
            return result;
        },
        urlParamName: 'sel',
        urlIncludeInVisualizationOnly: false
    });

    readonly focusedViewState = this.createState<number>({
        name: 'focus',
        defaultValue: 0,
        schema: z.coerce.number().nonnegative(),
        urlParamName: 'f',
        urlIncludeInVisualizationOnly: false
    });

    readonly viewSyncState = this.createState<string[]>({
        name: 'viewSync',
        defaultValue: [],
        schema: z.array(z.union([
            z.literal(VIEW_SYNC_PROJECTION),
            z.literal(VIEW_SYNC_POSITION),
            z.literal(VIEW_SYNC_MOVEMENT),
            z.literal(VIEW_SYNC_LAYERS)
        ])),
        urlParamName: 'sync',
        urlIncludeInVisualizationOnly: false
    });

    readonly cameraViewDataState = this.createMapViewState<CameraViewState>({
        name: 'cameraView',
        defaultValue: {
            destination: {lon: 22.837473, lat: 38.490817, alt: 16000000},
            orientation: {heading: 6.0, pitch: -1.55, roll: 0.25}
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
            r: value.orientation.roll
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
            }
        }),
        urlFormEncode: true
    });

    readonly mode2dState = this.createMapViewState<boolean>({
        name: 'mode2d',
        defaultValue: false,
        schema: Boolish,
        urlParamName: 'm2d',
        urlIncludeInVisualizationOnly: false
    });

    readonly layerSyncOptionsState = this.createMapViewState<boolean>({
        name: 'layerSyncOptions',
        defaultValue: false,
        schema: Boolish,
        urlIncludeInVisualizationOnly: false
    });

    readonly osmEnabledState = this.createMapViewState<boolean>({
        name: 'osm',
        defaultValue: true,
        schema: Boolish,
        urlParamName: 'osm'
    });

    readonly osmOpacityState = this.createMapViewState<number>({
        name: 'osmOpacity',
        defaultValue: 30,
        schema: z.coerce.number().min(0).max(100).refine(value => Number.isInteger(value)),
        urlParamName: 'osmOp'
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

    readonly stylesState = new StyleState(this.statePool);

    readonly styleVisibilityState = this.createState<Record<string, boolean>>({
        name: 'styleVisiblity',
        schema: z.record(z.string(), z.coerce.boolean()),
        defaultValue: {}
    });

    readonly tilesLoadLimitState = this.createState<number>({
        name: 'tilesLoadLimit',
        defaultValue: MAX_NUM_TILES_TO_LOAD,
        schema: z.coerce.number().nonnegative(),
        urlParamName: 'tll'
    });

    readonly tilesVisualizeLimitState = this.createState<number>({
        name: 'tilesVisualizeLimit',
        defaultValue: MAX_NUM_TILES_TO_VISUALIZE,
        schema: z.coerce.number().nonnegative(),
        urlParamName: 'tvl'
    });

    readonly enabledCoordsTileIdsState = this.createState<string[]>({
        name: 'enabledCoordsTileIds',
        defaultValue: ["WGS84"],
        schema: z.array(z.string())
    });

    readonly legalInfoDialogVisibleState = this.createState<boolean>({
        name: 'legalInfoDialogVisible',
        defaultValue: false,
        schema: Boolish
    });

    readonly lastSearchHistoryEntryState = this.createState<[number, string] | null>({
        name: 'lastSearchHistoryEntry',
        defaultValue: null,
        schema: z.union([
            z.null(),
            z.tuple([z.coerce.number(), z.string()]),
        ])
    });

    readonly unlimitNumSelections = this.createState<boolean>({
        name: 'unlimitNumSelections',
        defaultValue: false,
        schema: Boolish
    });

    constructor(private readonly router: Router) {
        // Perform initial hydration after the initial NavigationEnd event arrives.
        this.router.events.pipe(filter(event => event instanceof NavigationEnd), take(1)).subscribe(() => {
            this.setupStateSubscriptions();
            this.hydrateFromStorage();
            this.hydrateFromUrl(this.router.routerState.snapshot.root?.queryParams ?? {});
            this.isHydrating = false;

            // Ensure that the merged app state after hydration is reflected in local storage and URL.
            this.syncAllStates();

            this.isReady = true;
            this.ready.next(true);
        });

        // Subsequently, Navigation events may come from usage of the browser back/forward-buttons.
        this.router.events.subscribe(event => {
            if (event instanceof NavigationStart) {
                const nav = this.router.getCurrentNavigation();
                this.pendingPopstateHydration = nav?.trigger === 'popstate';
            } else if (event instanceof NavigationEnd) {
                if (!this.pendingPopstateHydration) {
                    return;
                }
                this.pendingPopstateHydration = false;
                if (!this.isReady) {
                    return;
                }
                this.withHydration(() => {
                    this.hydrateFromUrl(this.router.routerState.snapshot.root?.queryParams ?? {});
                });
            }
        });
    }

    private syncAllStates() {
        this.statePool.values().forEach(state => this.onStateChanged(state, true));
    }

    syncViews(): void {
        if (this.numViews < 2) {
            return;
        }
        if (this.viewSync.includes(VIEW_SYNC_POSITION)) {
            const camState = this.cameraViewDataState.getValue(this.focusedView);
            this.setView(this.focusedView,
                Cartographic.fromDegrees(camState.destination.lon, camState.destination.lat, camState.destination.alt));
        }
        if (this.viewSync.includes(VIEW_SYNC_PROJECTION)) {
            this.setProjectionMode(this.focusedView, this.mode2dState.getValue(this.focusedView));
        }
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
        if (this.subscriptionsSetup) return;
        // NOTE: Is this the best way to implement the internal subscription mechanism?
        for (const state of this.statePool.values()) {
            const subscription = (state as AppState<unknown>).pipe(skip(1)).subscribe(value => {
                this.onStateChanged(state as AppState<unknown>);
            });
            this.stateSubscriptions.push(subscription);
        }
        this.subscriptionsSetup = true;
    }

    private onStateChanged(state: AppState<any>, force: boolean = false): void {
        if (!force && (this.isHydrating || !this.isReady)) {
            return;
        }

        this.pendingStorageSyncStates.add(state);
        if (state.isUrlState()) {
            this.pendingUrlSyncStates.add(state);
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
                this.pendingStorageSyncStates.clear();
                this.pendingUrlSyncStates.clear();
                return;
            }
            this.syncStorage();
            this.syncUrl();
        });
    }

    private syncStorage(): void {
        for (const state of this.pendingStorageSyncStates) {
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
        this.pendingStorageSyncStates.clear();
    }

    private syncUrl(): void {
        const params: Record<string, string> = {};
        for (const state of this.pendingUrlSyncStates) {
            const serialized = state.serialize(true);
            if (serialized === undefined) {
                continue;
            }
            for (const [k, v] of Object.entries(serialized)) {
                params[k] = v;
            }
        }
        // The first URL sync will update the URL fully, with pruned state removed.
        // Detect this case with the following collection equality check.
        // In this case, use the "replace" handling to get rid of style options
        // for removed styles.
        const queryParamsHandling = this.pendingUrlSyncStates.size === [...this.statePool.values().filter(
            state => state.isUrlState())].length ? "replace" : "merge";
        this.pendingUrlSyncStates.clear();
        this.router.navigate([], {
            queryParams: params,
            queryParamsHandling: queryParamsHandling,
            replaceUrl: this.replaceUrl
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
    get selection() {return this.selectionState.getValue();}
    set selection(val: InspectionPanelModel<TileFeatureId>[]) {this.selectionState.next(val);};
    get focusedView() {return this.focusedViewState.getValue();}
    set focusedView(val: number) {this.focusedViewState.next(val);};
    get layerNames() {return this.layerNamesState.getValue();}
    set layerNames(val: Array<string>) {this.layerNamesState.next(val);};
    get styles() {return this.stylesState.getValue();}
    get styleVisibility() {return this.styleVisibilityState.getValue();}
    set styleVisibility(val: Record<string, boolean>) {this.styleVisibilityState.next(val);};
    get tilesLoadLimit() {return this.tilesLoadLimitState.getValue();}
    set tilesLoadLimit(val: number) {this.tilesLoadLimitState.next(val);};
    get tilesVisualizeLimit() {return this.tilesVisualizeLimitState.getValue();}
    set tilesVisualizeLimit(val: number) {this.tilesVisualizeLimitState.next(val);};
    get enabledCoordsTileIds() {return this.enabledCoordsTileIdsState.getValue();}
    set enabledCoordsTileIds(val: string[]) {this.enabledCoordsTileIdsState.next(val);};
    get legalInfoDialogVisible() {return this.legalInfoDialogVisibleState.getValue();}
    set legalInfoDialogVisible(val: boolean) {this.legalInfoDialogVisibleState.next(val);};
    get lastSearchHistoryEntry() {return this.lastSearchHistoryEntryState.getValue();}
    set lastSearchHistoryEntry(val: [number, string] | null) {this.lastSearchHistoryEntryState.next(val);};
    get viewSync() {return this.viewSyncState.getValue();}
    set viewSync(val: string[]) {
        const previous = new Set(this.viewSyncState.getValue());
        const uniqueValues = Array.from(new Set(val));
        const hasMovement = uniqueValues.includes(VIEW_SYNC_MOVEMENT);
        const hasPosition = uniqueValues.includes(VIEW_SYNC_POSITION);
        let sanitized = uniqueValues;

        if (hasMovement && hasPosition) {
            if (!previous.has(VIEW_SYNC_MOVEMENT)) {
                sanitized = uniqueValues.filter(value => value !== VIEW_SYNC_POSITION);
            } else if (!previous.has(VIEW_SYNC_POSITION)) {
                sanitized = uniqueValues.filter(value => value !== VIEW_SYNC_MOVEMENT);
            } else {
                sanitized = uniqueValues.filter(value => value !== VIEW_SYNC_POSITION);
            }
        }

        this.viewSyncState.next(sanitized);
    };

    getLayerSyncOption(viewIndex: number): boolean {
        return this.layerSyncOptionsState.getValue(viewIndex);
    }

    setLayerSyncOption(viewIndex: number, enabled: boolean): void {
        this.layerSyncOptionsState.next(viewIndex, enabled);
    }
    get isNumSelectionsUnlimited() {return this.unlimitNumSelections.getValue();}
    set isNumSelectionsUnlimited(val: boolean) {this.unlimitNumSelections.next(val);}

    getCameraOrientation(viewIndex: number) {
        return this.cameraViewDataState.getValue(viewIndex).orientation;
    }

    getCameraPosition(viewIndex: number) {
        const destination = this.cameraViewDataState.getValue(viewIndex).destination;
        return Cartographic.fromDegrees(destination.lon, destination.lat, destination.alt);
    }

    private _setView(viewIndex: number, destination: Cartographic, orientation?: { heading: number, pitch: number, roll: number }) {
        // Fall back to the current orientation if none was passed.
        orientation = orientation ?? this.cameraViewDataState.getValue(viewIndex).orientation;
        const view: CameraViewState = {
            destination: {
                lon: CesiumMath.toDegrees(destination.longitude),
                lat: CesiumMath.toDegrees(destination.latitude),
                alt: destination.height,
            },
            orientation: {
                heading: orientation.heading,
                pitch: orientation.pitch,
                roll: orientation.roll,
            }
        };
        this.cameraViewDataState.next(viewIndex, view);
    }

    setView(viewIndex: number, destination: Cartographic, orientation?: { heading: number, pitch: number, roll: number }) {
        const syncPosition = this.viewSync.includes(VIEW_SYNC_POSITION);
        const syncMovement = this.viewSync.includes(VIEW_SYNC_MOVEMENT);

        if (syncPosition || syncMovement) {
            // Unfocused view is trying to update itself when the views are synchronized
            if (viewIndex !== this.focusedView) {
                return;
            }

            if (syncPosition) {
                for (let i = 0; i < this.numViews; i++) {
                    this._setView(i, destination, orientation);
                }
                return;
            }

            if (syncMovement) {
                const previous = this.cameraViewDataState.getValue(viewIndex).destination;
                const destLon = CesiumMath.toDegrees(destination.longitude);
                const destLat = CesiumMath.toDegrees(destination.latitude);
                const deltaLon = destLon - previous.lon;
                const deltaLat = destLat - previous.lat;

                this._setView(viewIndex, destination, orientation);

                for (let i = 0; i < this.numViews; i++) {
                    if (i === viewIndex) {
                        continue;
                    }
                    const target = this.cameraViewDataState.getValue(i);
                    const newDestination = Cartographic.fromDegrees(
                        target.destination.lon + deltaLon,
                        target.destination.lat + deltaLat,
                        target.destination.alt
                    );
                    this._setView(i, newDestination);
                }
                return;
            }
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

    /*
    ## Current State

      View Click Event -> MapDataService -> InspectionService -> InspectionPanel
                                                              -> AppStateService

      (Hydration) AppStateService -> MapDataService -> InspectionService -> InspectionPanel
                                                                         -> AppStateService

    ## New Goal State

    // View Click Event -> AppStateService -> MapDataService -> InspectionService -> InspectionPanel
    //         (Hydration) AppStateService -> MapDataService -> InspectionService -> InspectionPanel
    //  InspectionPanel -> AppStateService -> MapDataService -> InspectionService -> InspectionPanel

     */
    setSelection(newSelection: TileFeatureId[] | SelectedSourceData, id?: number) {
        this._replaceUrl = false;
        const allPanels = this.selectionState.getValue();
        const sourceDataSelection = !Array.isArray(newSelection) ? newSelection as SelectedSourceData : undefined;
        let featureSelection = Array.isArray(newSelection) ? newSelection as TileFeatureId[] : [];
        // If a panel index was passed, change the SourceData-selection in that panel.
        if (id !== undefined) {
            const panelIndex = allPanels.findIndex(panel => panel.id === id);
            if (panelIndex !== -1) {
                allPanels[panelIndex].sourceData = sourceDataSelection;
                this.selectionState.next(allPanels);
                return id;
            }
        }
        // Filter out features which are already selected. If there are none left, we don't need to do anything.
        if (featureSelection.length) {
            featureSelection = featureSelection.filter(feature =>
                !allPanels.some(panel =>
                    panel.features.some(otherFeature =>
                        feature.featureId === otherFeature.featureId && feature.mapTileKey === otherFeature.mapTileKey)));
            if (!featureSelection.length) {
                this._replaceUrl = true;
                return;
            }
        }
        // Create a new panel if there is no existing one to change.
        if (allPanels.every(panel => panel.pinned)) {
            if (!this.isNumSelectionsUnlimited && allPanels.length >= MAX_NUM_SELECTIONS) {
                console.error(`Tried to set more selections than possible! Current max number: ${MAX_NUM_SELECTIONS}`);
                this._replaceUrl = true;
                return;
            }
            id = 1 + Math.max(-1, ...allPanels.map(panel => panel.id));
            allPanels.push({
                id: id,
                features: featureSelection,
                sourceData: sourceDataSelection,
                pinned: false,
                size: this.defaultInspectionPanelSize,
                color: DEFAULT_HIGHLIGHT_COLORS[id % DEFAULT_HIGHLIGHT_COLORS.length]
            });
            this.selectionState.next(allPanels);
            return id;
        }
        // Find the first unpinned panel and change the selection there.
        for (let i = 0; i < allPanels.length; i++) {
            if (allPanels[i].pinned) {
                continue;
            }
            id = allPanels[i].id;
            allPanels[i].features = featureSelection;
            allPanels[i].sourceData = sourceDataSelection;
            break;
        }
        this.selectionState.next(allPanels);
        return id;
    }

    setInspectionPanelSize(id: number, size: [number, number]) {
        const allPanels = this.selectionState.getValue();
        const index = allPanels.findIndex(panel => panel.id === id);
        if (index === -1) {
            return;
        }
        allPanels[index].size = size;
        this.onStateChanged(this.selectionState, true); // Do not retrigger the subscription - we only need to reflect the size in the url
    }

    setInspectionPanelPinnedState(id: number, isPinned: boolean) {
        const allPanels = this.selectionState.getValue();
        const index = allPanels.findIndex(panel => panel.id === id);
        if (index === -1) {
            return;
        }
        if (isPinned && !this.isNumSelectionsUnlimited &&
            allPanels.filter(panel => panel.pinned).length >= MAX_NUM_SELECTIONS - 1) {
            return;
        }
        allPanels[index].pinned = isPinned;
        this.selectionState.next(allPanels);
    }

    setInspectionPanelColor(id: number, color: string) {
        const allPanels = this.selectionState.getValue();
        const index = allPanels.findIndex(panel => panel.id === id);
        if (index === -1) {
            return;
        }
        allPanels[index].color = color;
        this.selectionState.next(allPanels);
    }

    unsetUnpinnedSelections() {
        this.selectionState.next(this.selectionState.getValue().filter(panel => panel.pinned));
    }

    unsetPanel(id: number) {
        const allPanels = this.selectionState.getValue();
        const index = allPanels.findIndex(panel => panel.id === id);
        if (index === -1) {
            return;
        }
        allPanels.splice(index, 1);
        this.selectionState.next(allPanels);
    }

    getNumSelections(): number {
        return this.selectionState.getValue().length;
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
            this.layerNamesState.next([...names, mapLayerId]);
        }
        const result = new Array<LayerViewConfig>();
        const layerStateValue = <T>(state: MapViewState<Array<T>>, viewIndex: number, defaultValue: T) => {
            const resultForView = state.getValue(viewIndex);
            while (resultForView.length <= layerIndex) {
                resultForView.push(defaultValue);
            }
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
            this.layerNamesState.next([...names, mapLayerId]);
        }

        const insertLayerState = <T>(state: MapViewState<T[]>, viewIndex: number, value: T, defaultValue: T) => {
            const values = state.getValue(viewIndex);
            while (values.length <= layerIndex) {
                values.push(defaultValue);
            }
            values[layerIndex] = value;
            state.next(viewIndex, values);
        };

        for (let viewIndex = 0; viewIndex < viewConfig.length; viewIndex++) {
            insertLayerState(this.layerVisibilityState, viewIndex, viewConfig[viewIndex].visible, false);
            insertLayerState(this.layerZoomLevelState, viewIndex, viewConfig[viewIndex].level, fallbackLevel);
            insertLayerState(this.layerTileBordersState, viewIndex, viewConfig[viewIndex].tileBorders,false);
        }
    }

    styleOptionValues(
        mapId: string,
        layerId: string,
        shortStyleId: string,
        optionId: string,
        optionType: string,
        defaultValue: string|number|boolean
    ): (string|number|boolean)[] {
        const mapLayerId = `${mapId}/${layerId}`;
        const layerIndex = this.layerNames.indexOf(mapLayerId);
        if (layerIndex === -1) {
            throw new Error(`[AppStateService] Unknown map layer '${mapLayerId}' when reading style option values`);
        }

        const key = this.stylesState.styleOptionKey(mapId, layerId, shortStyleId, optionId);
        const views = this.numViewsState.getValue();

        let values = this.styles.get(key);
        if (!values) {
            values = Array.from({length: views}, () => defaultValue);
            this.styles.set(key, values);
            return values.slice();
        }

        // Ensure array length matches the number of views
        if (values.length < views) {
            const pad = Array.from({length: views - values.length}, () => defaultValue);
            values = values.concat(pad);
            this.styles.set(key, values);
        } else if (values.length > views) {
            values = values.slice(0, views);
            this.styles.set(key, values);
        }

        // Trigger a URL update, as we might have added style option values for some view(s).
        this.stylesState.next(this.styles);
        return values.map(v => this.stylesState.coerceOptionValue(v, optionType));
    }

    /**
     * Set style option values for a specific map layer style combination.
     * Note: This will NOT change the layerConfig array. Instead, if the
     *  map layer does not exist in layerNames, an exception will be thrown.
     */
    setStyleOptionValues(mapId: string, layerId: string, shortStyleId: string, optionId: string, value: (string|number|boolean)[]) {
        const mapLayerId = `${mapId}/${layerId}`;
        const layerIndex = this.layerNames.indexOf(mapLayerId);
        if (layerIndex === -1) {
            throw new Error(`[AppStateService] Unknown map layer '${mapLayerId}' when writing style option values`);
        }
        const key = this.stylesState.styleOptionKey(mapId, layerId, shortStyleId, optionId);
        const views = this.numViewsState.getValue();

        let nextValues: (string|number|boolean)[] = Array.isArray(value) ? [...value] : [];
        if (nextValues.length < views) {
            const last = nextValues.length ? nextValues[nextValues.length - 1] : false;
            nextValues = nextValues.concat(Array.from({length: views - nextValues.length}, () => last));
        } else if (nextValues.length > views) {
            nextValues = nextValues.slice(0, views);
        }

        this.styles.set(key, nextValues);
        this.stylesState.next(this.styles);
    }

    getStyleVisibility(styleId: string, fallback: boolean = true): boolean {
        if (this.styleVisibility.hasOwnProperty(styleId)) {
            return this.styleVisibility[styleId];
        }
        return fallback;
    }

    setStyleVisibility(styleId: string, val: boolean) {
        this.styleVisibility[styleId] = val;
        // Trigger BehaviorSubject update.
        this.styleVisibilityState.next(this.styleVisibility);
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
        localStorage.removeItem(this.STYLE_OPTIONS_STORAGE_KEY);
        const {origin, pathname} = window.location;
        window.location.href = origin + pathname;
    }

    prune(presentMaps: Map<string, MapTreeNode>, presentStyles: Map<string, ErdblickStyle>) {
        // 1) Build sets of present maps, layers and styles
        const presentLayerIds = new Set<string>(); // entries of form `${mapId}/${layerId}`
        for (const [mapId, mapNode] of presentMaps.entries()) {
            // Use feature layers (exclude SourceData) via children
            for (const layer of mapNode.children) {
                presentLayerIds.add(`${mapId}/${layer.id}`);
            }
        }

        const presentStyleIds = new Set<string>([...presentStyles.keys()]); // full style ids
        const presentShortStyleIds = new Set<string>([...presentStyles.values()].map(s => s.shortId));

        // 2) Prune layerNames and per-view layer arrays (visibility, borders, zoom levels)
        const oldLayerNames = this.layerNames;
        if (oldLayerNames.length) {
            const keepIndices: number[] = [];
            const nextLayerNames: string[] = [];
            for (let i = 0; i < oldLayerNames.length; i++) {
                const name = oldLayerNames[i];
                if (presentLayerIds.has(name)) {
                    keepIndices.push(i);
                    nextLayerNames.push(name);
                }
            }

            if (keepIndices.length !== oldLayerNames.length) {
                // Update layer names
                this.layerNames = nextLayerNames;

                // Helper to filter layer-indexed arrays by keepIndices with fallback
                const filterLayerArray = <T>(arr: T[], fallback: T): T[] =>
                    keepIndices.map(idx => (idx < arr.length ? arr[idx] : fallback));

                const views = this.numViews;
                for (let v = 0; v < views; v++) {
                    const vis = this.layerVisibilityState.getValue(v);
                    const borders = this.layerTileBordersState.getValue(v);
                    const levels = this.layerZoomLevelState.getValue(v);
                    this.layerVisibilityState.next(v, filterLayerArray<boolean>(vis ?? [], false));
                    this.layerTileBordersState.next(v, filterLayerArray<boolean>(borders ?? [], false));
                    this.layerZoomLevelState.next(v, filterLayerArray<number>(levels ?? [], 13));
                }
            }
        }

        // 3) Prune style option values that reference pruned layers or non-present styles
        //    and 4) prune style visibility for non-present styles
        // Prune style visibility
        const styleVis = {...this.styleVisibility};
        let styleVisChanged = false;
        for (const key of Object.keys(styleVis)) {
            if (!presentStyleIds.has(key)) {
                delete styleVis[key];
                styleVisChanged = true;
            }
        }
        if (styleVisChanged) {
            this.styleVisibility = styleVis;
        }

        // Prune style option values
        const stylesMap = this.styles; // Map<string, (string|number|boolean)[]>
        let stylesChanged = false;
        for (const key of Array.from(stylesMap.keys())) {
            // Key format: `${mapId}/${layerId}/${shortStyleId}/${optionId}`
            const parts = key.split('/');
            if (parts.length < 4) {
                stylesMap.delete(key);
                stylesChanged = true;
                continue;
            }
            const shortStyleId = parts[parts.length - 2];
            const mapLayerId = parts.slice(0, -2).join('/');
            if (!presentLayerIds.has(mapLayerId) || !presentShortStyleIds.has(shortStyleId)) {
                stylesMap.delete(key);
                stylesChanged = true;
            }
        }

        // 5) Prune extra views in MapViewStates and in StyleState values
        const views = this.numViews;
        const pruneViews = <T>(state: MapViewState<T>) => {
            const arr = state.appState.getValue();
            if (arr.length > views) {
                state.appState.next(arr.slice(0, views));
            }
        };
        pruneViews(this.mode2dState);
        pruneViews(this.osmEnabledState);
        pruneViews(this.osmOpacityState);
        pruneViews(this.cameraViewDataState);
        pruneViews(this.layerVisibilityState);
        pruneViews(this.layerTileBordersState);
        pruneViews(this.layerZoomLevelState);

        // Also prune view-dimension from style option arrays
        for (const [k, vals] of stylesMap.entries()) {
            if (vals.length > views) {
                stylesMap.set(k, vals.slice(0, views));
                stylesChanged = true;
            }
        }
        if (stylesChanged) {
            this.stylesState.next(stylesMap);
        }

        // 6) Prune selections that reference maps/layers that are not present anymore
        const panels = this.selectionState.getValue();
        const nextPanels: InspectionPanelModel<TileFeatureId>[] = [];

        const parseKey = (tileKey: string): string | undefined => {
            try {
                const [mapId, layerId, _] = coreLib.parseMapTileKey(tileKey);
                // res is expected to be [mapId, layerId, tileId]
                return `${mapId}/${layerId}`
            } catch (_) {
                return;
            }
        };

        for (const panel of panels) {
            const updated: InspectionPanelModel<TileFeatureId> = {
                id: panel.id,
                features: [],
                pinned: panel.pinned,
                size: panel.size,
                sourceData: panel.sourceData ? { ...panel.sourceData } : undefined,
                color: panel.color
            };

            // Filter features
            for (const feat of panel.features) {
                const mapLayerId = parseKey(feat.mapTileKey);
                if (mapLayerId && presentLayerIds.has(mapLayerId)) {
                    updated.features.push(feat);
                }
            }

            // Validate sourceData if present
            if (updated.sourceData) {
                const mapLayerId = parseKey(updated.sourceData.mapTileKey);
                if (!mapLayerId || !presentLayerIds.has(mapLayerId)) {
                    delete updated.sourceData;
                }
            }

            if (updated.features.length || updated.sourceData) {
                nextPanels.push(updated);
            }
        }

        if (nextPanels.length !== panels.length) {
            this.selectionState.next(nextPanels);
        }

        // Sync all states, so the URL is replaced.
        this.syncAllStates();
    }
}
