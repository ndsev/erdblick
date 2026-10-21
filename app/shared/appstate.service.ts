import {stateStore, type ViewerValues, type StateBinding} from "./viewer-state";
import {computed, Injectable, OnDestroy, Signal} from "@angular/core";
import {NavigationEnd, NavigationStart, Params, Router} from "@angular/router";
import {BehaviorSubject, skip, Subject, Subscription, take} from "rxjs";
import {filter} from "rxjs/operators";
import {Cartographic, GeoMath} from "../integrations/geo";
import {AppState, AppStateOptions, Boolish, deepCopy, MapViewState, StyleState} from "./app-state";
import {z} from "zod";
import {
    PointCloudPolicy, DEFAULT_POINT_CLOUD_POLICY, pointCloudPolicySchema,
    pointCloudDetailSchema, pointCloudWorkingMemorySchema, pointCloudGpuMemorySchema
} from "./point-cloud-policy";
import {MapTreeNode} from "../mapdata/map.tree.model";
import {ErdblickStyle} from "../styledata/style.service";
import {coreLib} from "../integrations/wasm";
import {InfoMessageService} from "./info.service";
import type {FeatureWrapper} from "../mapdata/feature-inspection.model";
import type {DiagnosticsExportOptions, DiagnosticsLogFilter} from "../diagnostics/diagnostics.model";
import {
    BackgroundLayerConfig,
    clampBackgroundOpacity,
    DEFAULT_BACKGROUND_LAYER_ID,
    DEFAULT_BACKGROUND_OPACITY
} from "./app-config.service";
import {
    createFeatureSearchStateEntry,
    FeatureSearchStateEntry,
    FeatureSearchStatePatch,
    FeatureSearchStateSchema,
    normalizeFeatureSearchState,
    serializeFeatureSearchState
} from "./feature-search-state";
import {stripFeatureInspectionTarget} from "./tile-feature-id";
import {
    ConnectionRetryPolicy, DEFAULT_CONNECTION_RETRY_POLICY,
    connectionRetryPolicySchema, retryDelaySchema, retryMultiplierSchema
} from "./connection-retry-policy";
import type {LayerPresetRef} from "../styledata/layer-preset.model";
import {
    compressUrlCsvRuns,
    decodeLayerNamesV2,
    decodeMapNamesV2,
    decodeSelectionsV2,
    decodeStyleOptionsV2,
    encodeLayerNamesV2,
    encodeSelectionsV2,
    encodeStyleOptionsV2,
    featureSelectionLayerNames,
    firstParamValue,
    sourceDataSelectionMapIds
} from "./url-state-codec";
import type {UrlV2MapTileKeyFactory} from "./url-state-codec";
import {
    clampTileSubsetRenderWorkerCount
} from "./tile-render-policy";
import {
    clampLod3TileThreshold,
    DEFAULT_LOD3_TILE_THRESHOLD
} from "./lod-policy";
import {parseMapPartitionKey} from "../mapdata/partition.model";

export {
    AUTO_TILE_SUBSET_RENDER_WORKER_COUNT,
    clampTileSubsetRenderWorkerCount,
    MAX_TILE_SUBSET_RENDER_WORKER_COUNT,
    MIN_TILE_SUBSET_RENDER_WORKER_COUNT
} from "./tile-render-policy";
export {
    clampLod3TileThreshold,
    DEFAULT_LOD3_TILE_THRESHOLD,
    MAX_LOD3_TILE_THRESHOLD,
    MIN_LOD3_TILE_THRESHOLD
} from "./lod-policy";

export * from "./app-state.model";
import {COORDINATE_STATE_DECIMAL_PLACES, COORDINATE_STATE_PRECISION, DEFAULT_FEATURE_SEARCH_GROUPING, FEATURE_SEARCH_GROUPING_OPTION_IDS, MAX_SIMULTANEOUS_INSPECTIONS, DEFAULT_DRILL_PICK_RADIUS, MIN_DRILL_PICK_RADIUS, MAX_DRILL_PICK_RADIUS, MAX_COMPARE_PANELS, MAX_NUM_TILES_TO_LOAD, DEFAULT_LOCATION_SEARCH_RESULT_LIMIT, MAX_LOCATION_SEARCH_RESULT_LIMIT, DEFAULT_MAP_ZOOM_STEP, MIN_MAP_ZOOM_STEP, MAX_MAP_ZOOM_STEP, DEFAULT_FEATURE_ZOOM_CLEARANCE_METERS, MIN_FEATURE_ZOOM_CLEARANCE_METERS, MAX_FEATURE_ZOOM_CLEARANCE_METERS, DEFAULT_TILE_GRID_LEVEL, DEFAULT_TILE_GRID_COLOR, DEFAULT_TILE_GRID_OPACITY, VIEW_SYNC_PROJECTION, VIEW_SYNC_POSITION, VIEW_SYNC_MOVEMENT, VIEW_SYNC_LAYERS, DEFAULT_EM_WIDTH, DEFAULT_EM_HEIGHT, DEFAULT_DOCKED_EM_HEIGHT, ABOUT_DIALOG_LAYOUT_ID, LEGAL_INFO_DIALOG_LAYOUT_ID, PREFERENCES_DIALOG_LAYOUT_ID, KEYBOARD_DIALOG_LAYOUT_ID, DATASOURCES_EDITOR_DIALOG_LAYOUT_ID, ADVANCED_PREFERENCES_DIALOG_LAYOUT_ID, DIAGNOSTICS_PERFORMANCE_DIALOG_LAYOUT_ID, DIAGNOSTICS_LOG_DIALOG_LAYOUT_ID, DIAGNOSTICS_EXPORT_DIALOG_LAYOUT_ID, CACHE_RESET_DIALOG_LAYOUT_ID, STYLES_DIALOG_LAYOUT_ID, STYLE_EDITOR_DIALOG_LAYOUT_ID, STYLE_PRESET_EDITOR_DIALOG_LAYOUT_ID, FEATURE_SEARCH_DIALOG_LAYOUT_ID, FEATURE_SEARCH_EXPORT_DIALOG_LAYOUT_ID, SOURCE_DATA_SELECTION_DIALOG_LAYOUT_ID, INSPECTION_DOCK_TAB_ID, SEARCH_DOCK_TAB_ID, DEFAULT_HIGHLIGHT_COLORS, normalizeFeatureSearchGrouping, clampLocationSearchResultLimit, Versions, TileFeatureId, HoverLabelFieldConfig, defaultHoverLabelFieldKey, DEFAULT_HOVER_LABEL_FIELDS, SelectedSourceData, InspectionPanelModel, InspectionTreeExpansionSnapshot, InspectionTreeExpansionState, AppDialogPosition, AppDialogSize, AppDialogLayout, InspectionDialogLayout, InspectionComparisonEntry, InspectionComparisonModel, InspectionComparisonOption, CameraViewState, BackgroundLayerViewState, LayerViewConfig, StyleOptionStateUpdate, LayerPresetSelections, MapPresetSelections, LAYER_PRESET_REF_SCHEMA, STORED_LAYER_PRESET_REF_SCHEMA, ViewSyncOptionDescriptor, TileGridMode, tileGridMaxLevel, clampTileGridLevel, normalizeTileGridColor, clampTileGridOpacity, tileGridRgba, SnapshotImportLimits, SnapshotNormalizationResult, ConfigDefaultStateMetaEntry, ConfigDefaultStateMeta, isSourceOrMetaData, roundCoordinateStateValue, clampMapZoomStep, clampFeatureZoomClearanceMeters, cloneStateValue, stableSerializeStateValue, hashStateValue} from "./app-state.model";

type OwnerSlice = Exclude<keyof ViewerValues, "legacy" | "viewIds" | "viewEntityMap">;

@Injectable({providedIn: 'root'})
/**
 * Centralizes persisted viewer state, URL/storage hydration, dialog layout, selection state,
 * and cross-view synchronization.
 */
export class AppStateService implements OnDestroy {

    private registrationClosed = false;
    get registeredStateNames(): readonly string[] { return [...this.statePool.keys()]; }
    sealRegistration(): void { this.registrationClosed = true; }

    private readonly statePool = new Map<string, AppState<unknown>>();
    readonly values = stateStore(this.statePool);
    readonly store = this.values.store;

    /** Register a persisted codec against its owner's named SignalStore value. */
    register<S extends OwnerSlice, K extends keyof ViewerValues[S]>(
        options: AppStateOptions<ViewerValues[S][K]>, slice: S, key: K
    ): AppState<ViewerValues[S][K]> {
        if (this.registrationClosed || this.isReady) throw new Error(`Late state registration: ${options.name}`);
        const binding = this.bind(slice, key);
        binding.write(options.defaultValue);
        return new AppState(this.statePool, options, binding);
    }

    /** Register a codec supplied by an owner when its persisted shape differs from its stored shape. */
    registerCodec<T>(options: AppStateOptions<T>, binding: StateBinding<T>): AppState<T> {
        if (this.registrationClosed || this.isReady) throw new Error(`Late state registration: ${options.name}`);
        return new AppState(this.statePool, options, binding);
    }

    registerView<S extends OwnerSlice, K extends keyof ViewerValues[S]>(
        options: AppStateOptions<ViewerValues[S][K] extends Record<string, infer T> ? T : never>, slice: S, key: K
    ): MapViewState<ViewerValues[S][K] extends Record<string, infer T> ? T : never> {
        if (this.registrationClosed || this.isReady) throw new Error(`Late state registration: ${options.name}`);
        type Value = ViewerValues[S][K] extends Record<string, infer T> ? T : never;
        const records = this.bind(slice, key) as unknown as StateBinding<Record<string, Value>>;
        const ids = () => this.values.read(state => state.viewIds, this.store.viewIds).map(String);
        records.write(Object.fromEntries(ids().map(id => [id, options.defaultValue])));
        // Legacy arrays are projected only for codecs and positional UI adapters.
        // The record and its native per-ID selectors are the authoritative value.
        const binding: StateBinding<Value[]> = {
            signal: computed(() => this.store.viewIds().map(id => records.signal()[id] ?? options.defaultValue)),
            commits: records.commits,
            read: () => ids().map((id, index) => records.read()[id]
                ?? records.read()[String(this.store.viewIds()[index])] ?? options.defaultValue),
            write: values => records.write(Object.fromEntries(ids().map((id, index) =>
                [id, values[index] ?? options.defaultValue])))
        };
        this.beforeCommit(() => {
            if (this.values.read(state => state.viewIds, this.store.viewIds) === this.store.viewIds()) return;
            const currentIds = ids();
            const values = records.read();
            const previousIds = this.store.viewIds().map(String);
            if (currentIds.length === Object.keys(values).length && currentIds.every(id => id in values)) return;
            const sourceId = previousIds.at(-1);
            const source = sourceId ? values[sourceId] ?? options.defaultValue : options.defaultValue;
            records.write(Object.fromEntries(currentIds.map((id, index) =>
                [id, values[id] ?? deepCopy(values[previousIds[index]] ?? source)])));
        });
        const state = new MapViewState<Value>(this.statePool, options, binding, {
            idAt: index => ids()[index],
            read: id => records.read()[id]
                ?? records.read()[String(this.store.viewIds()[ids().indexOf(id)])] ?? options.defaultValue,
            write: (id, value) => {
                if (!ids().includes(id)) throw new Error(`View ${id} is unavailable`);
                records.write({...records.read(), [id]: value});
            },
            select: id => computed(() => {
                const slots = this.store[slice] as unknown as Record<string, Record<string, Signal<Value>>>;
                return slots[String(key)][id]?.() ?? options.defaultValue;
            })
        });
        this.mapViewStates.push(state as MapViewState<unknown>);
        return state;
    }

    registerStyles(): StyleState {
        if (this.registrationClosed || this.isReady) throw new Error("Late state registration: styleOptions");
        type Option = string | number | boolean;
        const records = this.bind("layers", "options");
        records.write(new Map());
        const ids = () => this.values.read(state => state.viewIds, this.store.viewIds).map(String);
        const project = (values: Map<string, Record<string, Option>>, order: readonly string[], fallback: readonly string[] = []) =>
            new Map([...values].map(([key, byId]) => [key, order.map((id, index) => byId[id] ?? byId[fallback[index]])]));
        const binding: StateBinding<Map<string, Option[]>> = {
            signal: computed(() => project(records.signal(), this.store.viewIds().map(String))),
            commits: records.commits,
            read: () => project(records.read(), ids(), this.store.viewIds().map(String)),
            write: values => records.write(new Map([...values].map(([key, array]) =>
                [key, Object.fromEntries(ids().map((id, index) => [id, array[index]]))])))
        };
        this.beforeCommit(() => {
            if (this.values.read(state => state.viewIds, this.store.viewIds) === this.store.viewIds()) return;
            const order = ids();
            const values = records.read();
            const sourceId = this.store.viewIds().at(-1);
            const next = new Map(values);
            let changed = false;
            for (const [key, byId] of values) {
                if (Object.keys(byId).length === order.length && order.every(id => id in byId)) continue;
                changed = true;
                next.set(key, Object.fromEntries(order.map((id, index) => [id,
                    byId[id] ?? byId[this.store.viewIds()[index]] ?? (sourceId ? byId[sourceId] : false)])));
            }
            if (changed) records.write(next);
        });
        return new StyleState(this.statePool, binding);
    }

    private bind<S extends OwnerSlice, K extends keyof ViewerValues[S]>(slice: S, key: K): StateBinding<ViewerValues[S][K]> {
        return this.values.bind<ViewerValues[S][K]>(
            state => state[slice][key],
            (state, value) => ({[slice]: {...state[slice], [key]: value}}),
            () => {
                const signals = this.store[slice] as unknown as {[P in keyof ViewerValues[S]]: Signal<ViewerValues[S][P]>};
                return (signals[key] as Signal<ViewerValues[S][K]>)();
            }
        );
    }

    /** URL codecs share positional dictionaries; these accessors never own domain behavior. */
    private persisted<T>(name: string): AppState<T> {
        const state = this.statePool.get(name);
        if (!state) throw new Error(`State owner was not registered: ${name}`);
        return state as AppState<T>;
    }
    private perView<T>(name: string): MapViewState<T> {
        const state = this.mapViewStates.find(state => state.appState.name === name);
        if (!state) throw new Error(`View-state owner was not registered: ${name}`);
        return state as MapViewState<T>;
    }

    private readonly urlNormalizers: Array<(params: Params, resetMissing: boolean) => Params> = [];
    registerUrlNormalizer(normalize: (params: Params, resetMissing: boolean) => Params): void {
        this.urlNormalizers.push(normalize);
    }
    private prepareUrl(params: Params, resetMissing = false): Params {
        return this.urlNormalizers.reduce((value, normalize) => normalize(value, resetMissing), params);
    }

    readonly importingUrl = new Subject<Params>();
    readonly importedStartupUrl = new Subject<Params>();
    readonly importedSnapshot = new Subject<void>();
    pushNextUrl(): void { this._replaceUrl = false; }

    private get numViewsState(): AppState<number> { return this.persisted("numberOfViews"); }
    private get focusedViewState(): AppState<number> { return this.persisted("focus"); }
    private get cameraViewDataState(): MapViewState<CameraViewState> { return this.perView("cameraView"); }
    private get layerNamesState(): AppState<Array<string>> { return this.persisted("layerNames"); }
    private get layerVisibilityState(): MapViewState<Array<boolean>> { return this.perView("visibility"); }
    private get layerZoomLevelState(): MapViewState<Array<number>> { return this.perView("zoomLevel"); }
    private get layerAutoZoomLevelState(): MapViewState<Array<boolean>> { return this.perView("autoZoomLevel"); }
    private get stylesState(): StyleState { return this.persisted("styleOptions") as StyleState; }
    private get selectionState(): AppState<InspectionPanelModel<TileFeatureId>[]> { return this.persisted("selected"); }
    private get featureSearchState(): AppState<FeatureSearchStateEntry[]> { return this.persisted("featureSearchState"); }
    private get styles() { return this.stylesState.getValue(); }
    private get selection() { return this.selectionState.getValue(); }
    private get numViews() { return this.numViewsState.getValue(); }
    private get layerNames() { return this.layerNamesState.getValue(); }
    private get focusedView() { return this.focusedViewState.getValue(); }

    /** Prepare related owner writes and expose one coherent SignalStore commit. */
    /** Owners prepare related invariants inside the same patch, including imported values. */
    beforeCommit(prepare: () => void): () => void { return this.values.beforeCommit(prepare); }

    transaction<T>(operation: () => T): T { return this.values.transaction(operation); }

    private readonly mapViewStates: Array<MapViewState<unknown>> = [];
    readonly ready = new BehaviorSubject<boolean>(false);
    /** Emits synchronously after an externally supplied state replacement has completed. */
    readonly stateApplied = new Subject<void>();

    private readonly stateSubscriptions: Subscription[] = [];

    private _replaceUrl = true;

    private isHydrating = false;
    private isSeedingConfigDefaults = false;
    private isSystemStateMutation = false;
    private isReady = false;
    private subscriptionsSetup = false;
    private pendingUrlSyncStates = new Set<AppState<any>>;
    private pendingStorageSyncStates = new Set<AppState<any>>;
    private pendingUserOwnershipStates = new Set<string>();
    private pendingPopstateHydration = false;
    private flushHandle: Promise<void> | null = null;
    private urlSyncHandle: ReturnType<typeof setTimeout> | null = null;
    private lastUrlSyncAt = 0;
    // One-shot guard used to keep inbound links stable during passive startup.
    private skipNextUrlSync = false;
    private readonly STYLE_OPTIONS_STORAGE_KEY = 'styleOptions';
    private readonly CONFIG_DEFAULT_STATE_META_KEY = "erdblickConfigDefaultStateMeta";
    private readonly SNAPSHOT_UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
    private readonly RETIRED_URL_PARAM_KEYS = new Set(["s"]);
    private readonly RETIRED_STATE_KEYS = new Set(["mapPresets"]);
    private static readonly URL_SYNC_MIN_INTERVAL_MS = 50;
    private configDefaultStateMeta: ConfigDefaultStateMeta = {
        version: 1,
        sourceHash: "",
        entries: Object.create(null)
    };
    private configDefaultValueHashes = new Map<string, string>();
    private currentConfigDefaultKeys = new Set<string>();

    /** Registers all persisted state slots and wires startup hydration/persistence flow. */
    constructor(private readonly router: Router,
                private readonly infoMessageService: InfoMessageService) {
        this.retireMapPresetDefinitionStorage();
        // Perform initial hydration after the initial NavigationEnd event arrives.
        this.router.events.pipe(filter(event => event instanceof NavigationEnd), take(1)).subscribe(() => {
            this.initializePersistence();
        });

        // Subsequently, Navigation events may come from usage of the browser back/forward-buttons.
        this.router.events.subscribe(event => {
            if (event instanceof NavigationStart) {
                const nav = this.router.getCurrentNavigation();
                this.pendingPopstateHydration = nav?.trigger === 'popstate';
                if (this.pendingPopstateHydration) {
                    this.cancelPendingStateSync();
                }
            } else if (event instanceof NavigationEnd) {
                if (!this.pendingPopstateHydration) {
                    return;
                }
                this.pendingPopstateHydration = false;
                if (!this.isReady) {
                    return;
                }
                try { this.applyHydratedUrlState(this.currentBrowserQueryParams()); }
                catch (error) { this.infoMessageService.showError(`Could not import view link: ${String(error)}`); }
            }
        });

    }

    /** Hydrates persisted state once config defaults are known and marks the service ready. */
    initializePersistence(): void {
        if (this.isReady) {
            return;
        }
        if (!coreLib) {
            return;
        }
        this.sealRegistration();
        this.setupStateSubscriptions();
        const queryParams = this.currentBrowserQueryParams();
        this.hydrateFromStorage();
        try {
            this.hydrateFromUrl(this.prepareUrl(queryParams));
            this.importedStartupUrl.next(queryParams);
        } catch (error) {
            this.infoMessageService.showError(`Could not import view link: ${String(error)}`);
        }
        this.isHydrating = false;
        // Keep inbound links stable during passive startup hydration.
        this.skipNextUrlSync = true;

        // Ensure that the merged app state after hydration is reflected in local storage and URL.
        this.syncAllStates();

        this.isReady = true;
        this.ready.next(true);
    }

    /** Replaces the current query and hydrates it without navigating the browser document. */
    async replaceUrlState(params: Params, resetMissing = false): Promise<void> {
        if (!this.isReady) {
            throw new Error("URL state cannot be replaced before AppStateService is ready.");
        }

        const prepared = this.prepareUrl(params, resetMissing);
        this.cancelPendingStateSync();
        await this.router.navigate([], {
            queryParams: params,
            queryParamsHandling: "replace",
            replaceUrl: true
        });
        this.withHydration(() => {
            if (resetMissing) this.applyNormalizedSnapshot({}, true);
            this.hydrateFromUrl(prepared);
        });
        this.stateApplied.next();
    }

    /**
     * Atomically replaces presentation-controlled state from a native snapshot.
     * Unlike the user-facing snapshot import, omitted persisted states are reset so
     * every presentation slide describes a complete and repeatable viewer state.
     */
    replaceSnapshotState(snapshot: unknown): string[] {
        if (!this.isReady) {
            throw new Error("Snapshot state cannot be replaced before AppStateService is ready.");
        }

        const normalizedResult = this.normalizeSnapshot(snapshot);
        if (normalizedResult.errors.length) {
            return normalizedResult.errors;
        }

        this.cancelPendingStateSync();
        this.withHydration(() => {
            this.applyNormalizedSnapshot(normalizedResult.normalized!, true);
        });
        this.stateApplied.next();
        return [];
    }

    /** Flushes all state slots to storage and URL after a batch update. */
    syncAllStates() {
        this.statePool.values().forEach(state => this.onStateChanged(state, true));
    }

    /** Cancels pending persistence work when the service is destroyed. */
    ngOnDestroy(): void {
        this.values.destroy();
        this.stateSubscriptions.forEach(subscription => subscription.unsubscribe());
        if (this.urlSyncHandle !== null) {
            clearTimeout(this.urlSyncHandle);
            this.urlSyncHandle = null;
        }
    }

    /** Returns whether state updates should replace the current URL. */
    get replaceUrl() {
        const currentValue = this._replaceUrl;
        this._replaceUrl = true;
        return currentValue;
    }

    /** Subscribes to all persisted state slots so storage and URL remain in sync. */
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

    /** Handles one state-slot change and schedules the required persistence work. */
    private onStateChanged(state: AppState<any>, force: boolean = false): void {
        const markUserOwned = !force
            && this.isReady
            && !this.isHydrating
            && !this.isSeedingConfigDefaults
            && !this.isSystemStateMutation;
        if (markUserOwned) {
            this.pendingUserOwnershipStates.add(state.name);
        }

        if (!force && (this.isHydrating || !this.isReady || this.isSeedingConfigDefaults)) {
            return;
        }

        this.pendingStorageSyncStates.add(state);
        if (state.isUrlState()) {
            this.pendingUrlSyncStates.add(state);
        }

        this.scheduleFlush();
    }

    /** Schedules the batched storage flush used after state changes. */
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
            this.scheduleUrlSync();
        });
    }

    /** Cancels any pending batched URL/storage synchronization timers. */
    private cancelPendingStateSync(): void {
        // Prevent stale, queued writes from a previous URL hydration cycle.
        this.pendingStorageSyncStates.clear();
        this.pendingUrlSyncStates.clear();
        if (this.urlSyncHandle !== null) {
            clearTimeout(this.urlSyncHandle);
            this.urlSyncHandle = null;
        }
    }

    /** Writes all storage-backed state slots to local storage. */
    private syncStorage(): void {
        for (const state of this.pendingStorageSyncStates) {
            const markUserOwned = this.pendingUserOwnershipStates.has(state.name);
            try {
                const serialized = state.serialize(false);
                if (serialized === undefined) {
                    continue;
                }
                if (state === this.stylesState) {
                    localStorage.removeItem(this.STYLE_OPTIONS_STORAGE_KEY);
                    this.clearStyleOptionStorageEntries();
                }
                for (const [k, v] of Object.entries(serialized)) {
                    if (v === null) {
                        continue;
                    }
                    localStorage.setItem(k, v);
                }

                const stateHash = this.stateValueHashForMeta(state);
                const expectedConfigHash = this.configDefaultValueHashes.get(state.name);
                if (expectedConfigHash && expectedConfigHash === stateHash) {
                    this.setMetaOwner(state.name, "config", stateHash);
                } else if (markUserOwned) {
                    this.setMetaOwner(state.name, "user", stateHash);
                } else if (this.configDefaultStateMeta.entries[state.name]) {
                    this.configDefaultStateMeta.entries[state.name].valueHash = stateHash;
                }

                if (state === this.stylesState) {
                    const serializedStyleEntries = this.stylesState.serialize(false) ?? {};
                    const serializedStyleKeys = new Set(
                        Object.keys(serializedStyleEntries).filter(key =>
                            this.stylesState.isStyleOptionUrlParamKey(key)));
                    for (const key of Object.keys(this.configDefaultStateMeta.entries)) {
                        if (this.stylesState.isStyleOptionUrlParamKey(key) && !serializedStyleKeys.has(key)) {
                            delete this.configDefaultStateMeta.entries[key];
                        }
                    }
                    for (const [key, value] of Object.entries(serializedStyleEntries)) {
                        if (!this.stylesState.isStyleOptionUrlParamKey(key)) {
                            continue;
                        }
                        const valueHash = hashStateValue(value);
                        const expectedStyleConfigHash = this.configDefaultValueHashes.get(key);
                        if (expectedStyleConfigHash && expectedStyleConfigHash === valueHash) {
                            this.setMetaOwner(key, "config", valueHash);
                        } else if (markUserOwned) {
                            this.setMetaOwner(key, "user", valueHash);
                        } else if (this.configDefaultStateMeta.entries[key]) {
                            this.configDefaultStateMeta.entries[key].valueHash = valueHash;
                        }
                    }
                }
            } catch (error) {
                console.error(`[AppStateService] Failed to persist state '${state.name}'`, error);
            }
            this.pendingUserOwnershipStates.delete(state.name);
        }
        this.persistConfigDefaultStateMeta();
        this.pendingStorageSyncStates.clear();
    }

    /** Schedules debounced URL synchronization after state changes. */
    private scheduleUrlSync(): void {
        if (!this.pendingUrlSyncStates.size) {
            return;
        }
        if (this.urlSyncHandle !== null) {
            return;
        }
        // Browsers can reject rapid History API updates; keep URL writes below that threshold.
        const elapsed = Date.now() - this.lastUrlSyncAt;
        const delay = Math.max(0, AppStateService.URL_SYNC_MIN_INTERVAL_MS - elapsed);
        if (delay === 0) {
            this.flushUrlSync();
            return;
        }
        this.urlSyncHandle = setTimeout(() => {
            this.urlSyncHandle = null;
            this.flushUrlSync();
        }, delay);
    }

    /** Executes the debounced URL synchronization immediately. */
    private flushUrlSync(): void {
        if (this.isHydrating) {
            this.pendingUrlSyncStates.clear();
            return;
        }
        if (!this.pendingUrlSyncStates.size) {
            return;
        }
        if (this.skipNextUrlSync) {
            this.skipNextUrlSync = false;
            this.pendingUrlSyncStates.clear();
            return;
        }
        this.syncUrl();
        this.lastUrlSyncAt = Date.now();
        if (this.pendingUrlSyncStates.size) {
            this.scheduleUrlSync();
        }
    }

    /** Serializes URL-backed state and updates router query params accordingly. */
    private syncUrl(): void {
        const params = this.serializeUrlV2();
        this.pendingUrlSyncStates.clear();
        this.router.navigate([], {
            queryParams: params,
            queryParamsHandling: "replace",
            replaceUrl: this.replaceUrl
        }).catch(error => {
            console.error('[AppStateService] Failed to sync URL parameters', error);
        });
    }

    /** Returns current URL-backed state without copying authentication or unknown URL parameters. */
    shareableUrl(): string {
        const url = new URL(window.location.pathname, window.location.origin);
        for (const [key, value] of Object.entries(this.serializeUrlV2(false))) {
            for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
        }
        return url.href;
    }

    /** Builds a complete v2 query-param set so all layer-indexed params share one order. */
    private serializeUrlV2(includeUnknownParams = true): Record<string, string | string[]> {
        const params = includeUnknownParams ? this.preservedUnknownUrlParams() : {};
        params["v2"] = "1";

        const urlLayerNames = this.urlLayerNamesForSerialization();

        for (const state of this.statePool.values()) {
            if (state === this.layerNamesState
                || state === this.selectionState
                || state === this.stylesState
                || this.isLayerIndexedMapViewState(state)) {
                continue;
            }
            if (!state.isUrlState()) {
                continue;
            }
            const serialized = state.serialize(true);
            if (serialized === undefined) {
                continue;
            }
            for (const [key, value] of Object.entries(serialized)) {
                if (value !== null) {
                    params[key] = compressUrlCsvRuns(value);
                }
            }
        }

        const layerEncoding = encodeLayerNamesV2(
            urlLayerNames,
            sourceDataSelectionMapIds(this.selection)
        );
        if (layerEncoding.map) {
            params["map"] = layerEncoding.map;
        }
        if (layerEncoding.l !== null) {
            params["l"] = layerEncoding.l;
        } else if (!urlLayerNames.length) {
            params["l"] = "";
        }
        this.serializeLayerIndexedMapViewParam(params, "v", this.layerVisibilityState, urlLayerNames, false, value => value ? "1" : "0");
        this.serializeLayerIndexedMapViewParam(params, "z", this.layerZoomLevelState, urlLayerNames, 13, value => String(value));
        this.serializeLayerIndexedMapViewParam(params, "az", this.layerAutoZoomLevelState, urlLayerNames, true, value => value ? "1" : "0");

        const selection = encodeSelectionsV2(
            this.selection,
            urlLayerNames,
            layerEncoding.mapNames,
            DEFAULT_HIGHLIGHT_COLORS
        );
        if (selection) {
            params["sel"] = selection;
        }

        for (const [key, value] of Object.entries(encodeStyleOptionsV2(
            this.styles,
            urlLayerNames,
            this.numViews
        ))) {
            params[key] = value;
        }

        return params;
    }

    /** Returns URL layers that are currently visible or required by feature selections. */
    private urlLayerNamesForSerialization(): string[] {
        const selectedLayerNames = new Set(featureSelectionLayerNames(this.selection));
        const urlLayerNames: string[] = [];
        const addLayerName = (layerName: string) => {
            if (!urlLayerNames.includes(layerName)) {
                urlLayerNames.push(layerName);
            }
        };

        this.layerNames.forEach((layerName, layerIndex) => {
            if (selectedLayerNames.has(layerName) || this.isLayerVisibleInAnyView(layerIndex)) {
                addLayerName(layerName);
            }
        });
        selectedLayerNames.forEach(addLayerName);
        return urlLayerNames;
    }

    /** Returns whether a layer slot is active in at least one configured map view. */
    private isLayerVisibleInAnyView(layerIndex: number): boolean {
        for (let viewIndex = 0; viewIndex < Math.max(1, this.numViews); viewIndex++) {
            if (this.layerVisibilityState.getValue(viewIndex)[layerIndex]) {
                return true;
            }
        }
        return false;
    }

    /** Returns true for per-view arrays whose entries are indexed by `layerNames`. */
    private isLayerIndexedMapViewState(state: unknown): boolean {
        return state === this.layerVisibilityState.appState
            || state === this.layerZoomLevelState.appState
            || state === this.layerAutoZoomLevelState.appState;
    }

    /** Serializes one layer-indexed per-view state against the finalized v2 URL layer order. */
    private serializeLayerIndexedMapViewParam<T>(
        params: Record<string, string | string[]>,
        key: string,
        state: MapViewState<T[]>,
        urlLayerNames: readonly string[],
        fallback: T,
        encode: (value: T) => string
    ): void {
        if (!urlLayerNames.length) {
            return;
        }
        const currentLayerIndexByName = new Map(this.layerNames.map((layerName, index) => [layerName, index]));
        const groups: string[] = [];
        for (let viewIndex = 0; viewIndex < Math.max(1, this.numViews); viewIndex++) {
            const currentValues = state.getValue(viewIndex);
            groups.push(urlLayerNames.map(layerName => {
                const currentIndex = currentLayerIndexByName.get(layerName);
                const value = currentIndex !== undefined && currentIndex < currentValues.length
                    ? currentValues[currentIndex]
                    : fallback;
                return encode(value);
            }).join(","));
        }
        params[key] = compressUrlCsvRuns(groups.join(":"));
    }

    /** Keeps non-Erdblick query params while dropping stale v1 and v2 state params. */
    private preservedUnknownUrlParams(): Record<string, string | string[]> {
        const managedKeys = this.managedUrlParamKeys();
        const params: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(this.currentBrowserQueryParams())) {
            if (managedKeys.has(key) || this.stylesState.isStyleOptionUrlParamKey(key)) {
                continue;
            }
            params[key] = Array.isArray(value)
                ? value.map(entry => String(entry))
                : String(value);
        }
        return params;
    }

    /** Returns query-param keys owned by Erdblick URL state. */
    private managedUrlParamKeys(): Set<string> {
        const keys = new Set<string>(["v2", "map", "osm"]);
        this.RETIRED_URL_PARAM_KEYS.forEach(key => keys.add(key));
        for (const state of this.statePool.values()) {
            if (state === this.stylesState || !state.isUrlState()) {
                continue;
            }
            const serialized = state.serialize(true);
            if (serialized === undefined) {
                continue;
            }
            for (const key of Object.keys(serialized)) {
                keys.add(key);
            }
        }
        return keys;
    }

    /** Restores storage-backed state slots from local storage during startup. */
    private hydrateFromStorage(): void {
        this.withHydration(() => {
            this.configDefaultStateMeta = this.loadConfigDefaultStateMeta();
            for (const state of this.statePool.values()) {
                if (state === this.stylesState) {
                    continue;
                }
                const raw = localStorage.getItem(state.name);
                if (raw === null) {
                    continue;
                }

                const metaEntry = this.configDefaultStateMeta.entries[state.name];
                if (metaEntry?.owner === "config") {
                    if (this.currentConfigDefaultKeys.has(state.name)) {
                        // Keep freshly seeded config default in-memory values.
                        continue;
                    }

                    // Config-owned storage without current config default should be dropped.
                    state.resetToDefault();
                    localStorage.removeItem(state.name);
                    delete this.configDefaultStateMeta.entries[state.name];
                    continue;
                }

                this.deserializeStateSafely(state, raw);
            }

            const styleOptionEntries = this.collectStyleOptionStorageEntries();
            const filteredStyleOptionEntries: Record<string, string> = Object.create(null);
            for (const [key, value] of Object.entries(styleOptionEntries)) {
                const metaEntry = this.configDefaultStateMeta.entries[key];
                if (metaEntry?.owner === "config") {
                    if (this.currentConfigDefaultKeys.has(key)) {
                        continue;
                    }
                    localStorage.removeItem(key);
                    delete this.configDefaultStateMeta.entries[key];
                    continue;
                }
                filteredStyleOptionEntries[key] = value;
            }

            if (Object.keys(filteredStyleOptionEntries).length) {
                this.deserializeStateSafely(this.stylesState, filteredStyleOptionEntries);
            }
            this.persistConfigDefaultStateMeta();
        });
    }

    /** Restores URL-backed state slots from the current route query params. */
    private hydrateFromUrl(params: Params): void {
        this.withHydration(() => {
            this.importingUrl.next(params);
            if (Object.keys(params).length === 0) {
                return;
            }

            if (firstParamValue(params, "v2") === "1") {
                this.hydrateFromUrlV2(params);
                return;
            }

            for (const state of this.statePool.values()) {
                this.deserializeStateSafely(state, params);
            }
        });
    }

    /** Applies one runtime URL state and notifies derived projections after hydration. */
    private applyHydratedUrlState(params: Params): void {
        this.cancelPendingStateSync();
        this.hydrateFromUrl(this.prepareUrl(params));
        this.stateApplied.next();
    }

    /** Keeps one malformed persisted state entry from aborting startup hydration. */
    private deserializeStateSafely(
        state: {name: string; deserialize(raw: string | Params): void},
        raw: string | Params
    ): void {
        try {
            state.deserialize(raw);
        } catch (error) {
            console.error(`[AppStateService] Failed to hydrate ${state.name}.`, error);
        }
    }

    /** Creates persisted selection MapTileKeys exclusively through mapget's C++ serializer. */
    private readonly createMapTileKeyFromUrlComponents: UrlV2MapTileKeyFactory = (
        layerType,
        mapId,
        layerId,
        tileId
    ) => {
        return coreLib.createMapTileKey(
            layerType,
            mapId,
            layerId,
            tileId);
    };

    /** Restores v2 URL params through a coordinated layer-indexed decode path. */
    private hydrateFromUrlV2(params: Params): void {
        const mapParam = firstParamValue(params, "map");
        const layerParam = firstParamValue(params, "l");

        const decodedLayerNames = decodeLayerNamesV2(mapParam, layerParam);
        if (decodedLayerNames.length) {
            this.layerNamesState.next(decodedLayerNames);
        }

        for (const state of this.statePool.values()) {
            if (state === this.layerNamesState || state === this.selectionState || state === this.stylesState) {
                continue;
            }
            try {
                state.deserialize(params);
            } catch (error) {
                console.error(`[AppStateService] Failed to hydrate v2 state '${state.name}'`, error);
            }
        }

        if (this.hasStyleOptionParams(params)) {
            const decodedStyles = decodeStyleOptionsV2(
                params,
                this.layerNames,
                this.numViews,
                this.stylesState.getValue()
            );
            this.stylesState.next(decodedStyles);
        }

        const selectionParam = firstParamValue(params, "sel");
        if (selectionParam !== undefined) {
            try {
                const mapNames = mapParam ? decodeMapNamesV2(mapParam) : [];
                const panels = decodeSelectionsV2(
                    selectionParam,
                    this.layerNames,
                    mapNames,
                    DEFAULT_HIGHLIGHT_COLORS,
                    this.createMapTileKeyFromUrlComponents
                );
                if (panels.length || !this.looksLikeLegacySelectionParam(selectionParam)) {
                    this.selectionState.next(panels);
                } else {
                    this.selectionState.next([]);
                    this.deserializeStateSafely(this.selectionState, {sel: selectionParam});
                }
            } catch (error) {
                console.error("[AppStateService] Failed to hydrate v2 selection state", error);
            }
        } else {
            this.selectionState.next([]);
        }
    }

    /** Detects pre-v2 `sel` payloads that may still be attached to a v2 URL during upgrades or shared-link reuse. */
    private looksLikeLegacySelectionParam(selectionParam: string): boolean {
        if (!selectionParam.trim()) {
            return false;
        }
        return selectionParam.includes("Features:") || selectionParam.includes("SourceData:");
    }

    /** Returns whether the params contain compact style-option entries. */
    private hasStyleOptionParams(params: Params): boolean {
        return Object.keys(params).some(key => this.stylesState.isStyleOptionUrlParamKey(key));
    }

    /**
     * Reads query parameters from the browser URL before Angular Router can normalize unknown app-state keys away.
     */
    private currentBrowserQueryParams(): Params {
        const params: Params = {};
        const search = typeof window !== "undefined" ? window.location.search : "";
        if (!search) {
            return this.router.routerState.snapshot.root?.queryParams ?? {};
        }
        const urlParams = new URLSearchParams(search);
        for (const [key, value] of urlParams.entries()) {
            if (params[key] === undefined) {
                params[key] = value;
            } else if (Array.isArray(params[key])) {
                params[key].push(value);
            } else {
                params[key] = [params[key], value];
            }
        }
        return params;
    }

    /** Runs a callback while suppressing persistence side effects during hydration. */
    private withHydration(callback: () => void): void {
        const previous = this.isHydrating;
        this.isHydrating = true;
        try {
            this.transaction(callback);
        } finally {
            this.isHydrating = previous;
        }
    }

    /** Returns the current limits applied when importing a snapshot. */
    getSnapshotImportLimits(): SnapshotImportLimits {
        const stateCount = this.statePool.size;
        const maxCollectionEntries = Math.max(1024, stateCount * 512);
        return {
            // Keep an upper bound aligned with practical browser localStorage budgets.
            maxFileSizeBytes: 5 * 1024 * 1024,
            // Snapshot top-level keys are AppState names plus compact style-option storage keys.
            maxTopLevelEntries: maxCollectionEntries,
            // AppState payloads are shallow-to-moderately nested; reject pathological depth.
            maxNestingDepth: 16,
            // Derive broad collection limits from the number of registered states.
            maxCollectionEntries,
            maxStringLength: 1024 * 1024
        };
    }

    /** Exports the current persisted state into a snapshot object. */
    exportSnapshot(): Record<string, unknown> {
        const snapshot: Record<string, unknown> = Object.create(null);
        for (const [name, state] of this.statePool.entries()) {
            if (!state.isSnapshotState()) {
                continue;
            }
            snapshot[name] = state.toSnapshotValue();
        }
        for (const [name, value] of Object.entries(this.stylesState.serialize(false) ?? {})) {
            snapshot[name] = value;
        }
        return snapshot;
    }

    /** Validates a snapshot without mutating the current application state. */
    validateSnapshot(snapshot: unknown): string[] {
        return this.normalizeSnapshot(snapshot).errors;
    }

    /** Seeds config-provided default snapshot values before storage and URL hydration. */
    seedConfigDefaultState(snapshot: unknown, sourceHash: string): string[] {
        if (snapshot === null || snapshot === undefined) {
            this.configDefaultStateMeta = this.loadConfigDefaultStateMeta();
            this.configDefaultStateMeta.sourceHash = sourceHash || "";
            this.configDefaultValueHashes.clear();
            this.currentConfigDefaultKeys.clear();
            this.persistConfigDefaultStateMeta();
            return [];
        }
        if (typeof snapshot === "object" && !Array.isArray(snapshot) && Object.keys(snapshot as Record<string, unknown>).length === 0) {
            this.configDefaultStateMeta = this.loadConfigDefaultStateMeta();
            this.configDefaultStateMeta.sourceHash = sourceHash || "";
            this.configDefaultValueHashes.clear();
            this.currentConfigDefaultKeys.clear();
            this.persistConfigDefaultStateMeta();
            return [];
        }

        const normalizedResult = this.normalizeSnapshot(snapshot, true);
        if (normalizedResult.errors.length) {
            normalizedResult.errors.forEach(error =>
                console.warn(`[AppStateService] Ignoring invalid config state: ${error}`));
            return normalizedResult.errors;
        }

        const normalized = normalizedResult.normalized ?? {};
        const styleOptionEntries = this.extractStyleOptionSnapshotEntries(normalized);
        const appliedStateKeys = new Set<string>();

        this.configDefaultStateMeta = this.loadConfigDefaultStateMeta();
        this.configDefaultStateMeta.sourceHash = sourceHash || "";
        this.configDefaultValueHashes.clear();
        this.currentConfigDefaultKeys.clear();

        this.isSeedingConfigDefaults = true;
        try {
            for (const [key, value] of Object.entries(normalized)) {
                const state = this.statePool.get(key);
                if (!state || !state.isConfigDefaultState()) {
                    continue;
                }
                state.applySnapshotValue(value);
                appliedStateKeys.add(key);
            }

            if (Object.keys(styleOptionEntries).length) {
                this.deserializeStateSafely(this.stylesState, styleOptionEntries);
                this.stylesState.next(new Map(this.stylesState.getValue()));
            }
        } finally {
            this.isSeedingConfigDefaults = false;
        }

        for (const key of appliedStateKeys) {
            const state = this.statePool.get(key);
            if (!state) {
                continue;
            }
            const valueHash = this.stateValueHashForMeta(state);
            this.currentConfigDefaultKeys.add(key);
            this.configDefaultValueHashes.set(key, valueHash);
            if (this.configDefaultMayOwnStorageKey(key)) {
                this.setMetaOwner(key, "config", valueHash);
            }
        }

        const serializedStyleOptions = this.stylesState.serialize(false) ?? {};
        for (const [key, serializedValue] of Object.entries(serializedStyleOptions)) {
            if (!this.stylesState.isStyleOptionUrlParamKey(key)) {
                continue;
            }
            if (!Object.prototype.hasOwnProperty.call(styleOptionEntries, key)) {
                continue;
            }
            const valueHash = hashStateValue(serializedValue);
            this.currentConfigDefaultKeys.add(key);
            this.configDefaultValueHashes.set(key, valueHash);
            if (this.configDefaultMayOwnStorageKey(key)) {
                this.setMetaOwner(key, "config", valueHash);
            }
        }

        this.persistConfigDefaultStateMeta();
        return [];
    }

    /** Normalizes, validates, and applies a snapshot import. */
    importSnapshot(snapshot: unknown): string[] {
        const normalizedResult = this.normalizeSnapshot(snapshot);
        if (normalizedResult.errors.length) {
            return normalizedResult.errors;
        }
        this.transaction(() => this.applyNormalizedSnapshot(normalizedResult.normalized!, false));
        return [];
    }

    /** Applies a validated snapshot in state-registration order. */
    private applyNormalizedSnapshot(
        normalized: Record<string, unknown>,
        replaceMissing: boolean
    ): void {
        for (const [key, state] of this.statePool.entries()) {
            if (!state.isSnapshotState()) {
                continue;
            }
            if (Object.prototype.hasOwnProperty.call(normalized, key)) {
                state.applySnapshotValue(normalized[key]);
            } else if (replaceMissing) {
                state.resetToDefault();
            }
        }

        const styleOptionEntries = this.extractStyleOptionSnapshotEntries(normalized);
        if (replaceMissing) {
            this.stylesState.next(new Map());
        }
        if (Object.keys(styleOptionEntries).length) {
            this.deserializeStateSafely(this.stylesState, styleOptionEntries);
            this.stylesState.next(new Map(this.stylesState.getValue()));
        }
        this.importedSnapshot.next();
    }

    /** Normalizes legacy snapshot shapes before schema validation is applied. */
    private normalizeSnapshot(snapshot: unknown, forConfigDefault: boolean = false): SnapshotNormalizationResult {
        const limits = this.getSnapshotImportLimits();
        const errors: string[] = [];
        let serialized: string;
        try {
            serialized = JSON.stringify(snapshot);
        } catch {
            return { errors: ['Snapshot payload is not serializable JSON.'] };
        }
        if (serialized.length > limits.maxFileSizeBytes) {
            return { errors: [`Snapshot payload exceeds ${limits.maxFileSizeBytes} bytes.`] };
        }

        const normalizedRoot = this.normalizeSnapshotNode(snapshot, '$', 0, limits, errors);
        if (errors.length) {
            return {errors};
        }
        if (!normalizedRoot || Array.isArray(normalizedRoot) || typeof normalizedRoot !== 'object') {
            return {errors: ['Snapshot payload must be a JSON object.']};
        }
        const normalized = normalizedRoot as Record<string, unknown>;
        const keys = Object.keys(normalized);
        if (keys.length > limits.maxTopLevelEntries) {
            return {errors: ['Snapshot payload contains too many top-level entries.']};
        }

        for (const key of keys) {
            if (this.RETIRED_STATE_KEYS.has(key)) {
                delete normalized[key];
                continue;
            }
            const state = this.statePool.get(key);
            if (!state) {
                if (this.validateStyleOptionSnapshotEntry(key, normalized[key], errors)) {
                    continue;
                }
                errors.push(`Unknown snapshot state '${key}'.`);
                continue;
            }
            const stateIsAllowed = forConfigDefault
                ? state.isConfigDefaultState()
                : state.isSnapshotState();
            if (!stateIsAllowed) {
                delete normalized[key];
            }
        }
        if (errors.length) {
            return {errors};
        }

        // Validate all present entries before import to keep mutation transactional.
        for (const key of Object.keys(normalized)) {
            const state = this.statePool.get(key);
            if (!state) {
                continue;
            }
            const stateIsAllowed = forConfigDefault
                ? state.isConfigDefaultState()
                : state.isSnapshotState();
            if (!stateIsAllowed) {
                continue;
            }
            try {
                state.validateSnapshotValue(normalized[key]);
            } catch (error: any) {
                errors.push(`Invalid value for '${key}': ${error?.message ?? 'schema validation failed'}`);
            }
        }
        return errors.length ? {errors} : {normalized, errors: []};
    }

    /** Returns whether a snapshot key is a compact style-option storage key. */
    private validateStyleOptionSnapshotEntry(key: string, value: unknown, errors: string[]): boolean {
        if (!this.stylesState.isStyleOptionUrlParamKey(key)) {
            return false;
        }
        if (typeof value !== 'string') {
            errors.push(`Invalid value for '${key}': expected string style option payload.`);
        }
        return true;
    }

    /** Extracts compact style-option entries from a normalized snapshot. */
    private extractStyleOptionSnapshotEntries(snapshot: Record<string, unknown>): Record<string, string> {
        const entries: Record<string, string> = Object.create(null);
        for (const [key, value] of Object.entries(snapshot)) {
            if (this.stylesState.isStyleOptionUrlParamKey(key) && typeof value === 'string') {
                entries[key] = value;
            }
        }
        return entries;
    }

    /** Reads compact style-option entries from browser local storage. */
    private collectStyleOptionStorageEntries(): Record<string, string> {
        const entries: Record<string, string> = Object.create(null);
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (!key || !this.stylesState.isStyleOptionUrlParamKey(key)) {
                continue;
            }
            const value = localStorage.getItem(key);
            if (value !== null) {
                entries[key] = value;
            }
        }
        return entries;
    }

    /** Removes compact style-option entries from browser local storage. */
    private clearStyleOptionStorageEntries(): void {
        const keys: string[] = [];
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (key && this.stylesState.isStyleOptionUrlParamKey(key)) {
                keys.push(key);
            }
        }
        for (const key of keys) {
            localStorage.removeItem(key);
        }
    }

    /** Removes the obsolete browser-owned map-preset catalog and its ownership metadata. */
    private retireMapPresetDefinitionStorage(): void {
        localStorage.removeItem("mapPresets");
        const rawMeta = localStorage.getItem(this.CONFIG_DEFAULT_STATE_META_KEY);
        if (!rawMeta) {
            return;
        }
        try {
            const meta = JSON.parse(rawMeta) as {entries?: Record<string, unknown>};
            if (!meta.entries || !Object.prototype.hasOwnProperty.call(meta.entries, "mapPresets")) {
                return;
            }
            delete meta.entries["mapPresets"];
            localStorage.setItem(this.CONFIG_DEFAULT_STATE_META_KEY, JSON.stringify(meta));
        } catch {
            // The normal metadata loader handles malformed input.
        }
    }

    /** Loads metadata describing the configured default state. */
    private loadConfigDefaultStateMeta(): ConfigDefaultStateMeta {
        const emptyMeta: ConfigDefaultStateMeta = {
            version: 1,
            sourceHash: "",
            entries: Object.create(null)
        };

        const raw = localStorage.getItem(this.CONFIG_DEFAULT_STATE_META_KEY);
        if (!raw) {
            return emptyMeta;
        }

        try {
            const parsed = JSON.parse(raw) as Partial<ConfigDefaultStateMeta>;
            if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
                return emptyMeta;
            }

            const entries: Record<string, ConfigDefaultStateMetaEntry> = Object.create(null);
            for (const [key, entry] of Object.entries(parsed.entries)) {
                if (!entry || typeof entry !== "object") {
                    continue;
                }
                const owner = (entry as ConfigDefaultStateMetaEntry).owner;
                const valueHash = (entry as ConfigDefaultStateMetaEntry).valueHash;
                if ((owner !== "config" && owner !== "user") || typeof valueHash !== "string") {
                    continue;
                }
                entries[key] = {owner, valueHash};
            }

            return {
                version: 1,
                sourceHash: typeof parsed.sourceHash === "string" ? parsed.sourceHash : "",
                entries
            };
        } catch {
            return emptyMeta;
        }
    }

    /** Persists metadata for the configured default state. */
    private persistConfigDefaultStateMeta(): void {
        localStorage.setItem(this.CONFIG_DEFAULT_STATE_META_KEY, JSON.stringify(this.configDefaultStateMeta));
    }

    /** Assigns ownership metadata to a state entry. */
    private setMetaOwner(key: string, owner: "config" | "user", valueHash: string): void {
        this.configDefaultStateMeta.entries[key] = {owner, valueHash};
    }

    /**
     * Returns whether a freshly seeded config default may claim the persisted
     * slot instead of preserving an existing user or legacy local override.
     */
    private configDefaultMayOwnStorageKey(key: string): boolean {
        const metaEntry = this.configDefaultStateMeta.entries[key];
        return metaEntry?.owner === "config" || localStorage.getItem(key) === null;
    }

    /** Computes the hash stored in state metadata. */
    private stateValueHashForMeta(state: AppState<unknown>): string {
        return hashStateValue(state.toSnapshotValue());
    }

    /** Runs a state mutation without marking user-owned metadata. */
    withSystemStateMutation(action: () => void): void {
        const previous = this.isSystemStateMutation;
        this.isSystemStateMutation = true;
        try {
            this.transaction(action);
        } finally {
            this.isSystemStateMutation = previous;
        }
    }

    /** Recursively normalizes one snapshot subtree while collecting validation issues. */
    private normalizeSnapshotNode(
        value: unknown,
        path: string,
        depth: number,
        limits: SnapshotImportLimits,
        errors: string[]
    ): unknown {
        if (depth > limits.maxNestingDepth) {
            errors.push(`Snapshot payload exceeds max depth at '${path}'.`);
            return undefined;
        }

        if (Array.isArray(value)) {
            if (value.length > limits.maxCollectionEntries) {
                errors.push(`Snapshot array '${path}' exceeds max length.`);
                return undefined;
            }
            return value.map((entry, index) =>
                this.normalizeSnapshotNode(entry, `${path}[${index}]`, depth + 1, limits, errors)
            );
        }

        if (value && typeof value === 'object') {
            const proto = Object.getPrototypeOf(value);
            if (proto !== Object.prototype && proto !== null) {
                errors.push(`Snapshot object '${path}' has an unsupported prototype.`);
                return undefined;
            }
            const entries = Object.entries(value as Record<string, unknown>);
            if (entries.length > limits.maxCollectionEntries) {
                errors.push(`Snapshot object '${path}' exceeds max key count.`);
                return undefined;
            }
            const normalized: Record<string, unknown> = Object.create(null);
            for (const [key, entry] of entries) {
                if (this.SNAPSHOT_UNSAFE_KEYS.has(key)) {
                    errors.push(`Snapshot payload contains unsafe key '${key}' at '${path}'.`);
                    return undefined;
                }
                normalized[key] = this.normalizeSnapshotNode(entry, `${path}.${key}`, depth + 1, limits, errors);
            }
            return normalized;
        }

        if (typeof value === 'string' && value.length > limits.maxStringLength) {
            errors.push(`Snapshot string at '${path}' exceeds max length.`);
            return undefined;
        }
        return value;
    };;;;;;;;;;;;;;;;;;;;

    /** Clears persisted app state from local storage and resets URL-backed state. */
    resetStorage() {
        for (const state of this.statePool.values()) {
            state.resetToDefault();
            localStorage.removeItem(state.name);
        }
        this.clearStyleOptionStorageEntries();
        localStorage.removeItem('searchHistory');
        localStorage.removeItem(this.STYLE_OPTIONS_STORAGE_KEY);
        localStorage.removeItem(this.CONFIG_DEFAULT_STATE_META_KEY);
        const {origin, pathname} = window.location;
        window.location.href = origin + pathname;
    }
}
