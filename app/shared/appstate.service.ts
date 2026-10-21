import {Injectable, OnDestroy, Signal, computed} from "@angular/core";
import {NavigationEnd, NavigationStart, Params, Router} from "@angular/router";
import {BehaviorSubject, Subject, Subscription, skip, take} from "rxjs";
import {filter} from "rxjs/operators";
import {coreLib} from "../integrations/wasm";
import {AppState, AppStateOptions, MapViewState, StyleState, deepCopy} from "./app-state";
import {
    ConfigDefaultStateMeta,
    ConfigDefaultStateMetaEntry,
    SnapshotImportLimits,
    SnapshotNormalizationResult,
    hashStateValue
} from "./app-state-persistence.model";
import {InfoMessageService} from "./info.service";
import {ViewerState, type StateBinding, type StateWriteOrigin, type ViewerValues} from "./viewer-state";

type OwnerSlice = Exclude<keyof ViewerValues, "viewIds" | "viewEntityMap">;

@Injectable({providedIn: "root"})
/**
 * Registers owner codecs and coordinates storage, hydration timing, snapshots and config ownership.
 * Domain URL dictionaries are supplied by AppUrlStateService after owner registration.
 */
export class AppStateService implements OnDestroy {
    private url: {serialize(params: Params): Params; hydrate(params: Params): void} | undefined;
    registerUrlCodec(codec: {serialize(params: Params): Params; hydrate(params: Params): void}): void {
        if (this.url) throw new Error("URL state owner was already registered");
        this.url = codec;
    }
    private urlCodec() {
        if (!this.url) throw new Error("URL state owner was not registered");
        return this.url;
    }
    get registeredStates(): Iterable<AppState<unknown>> {
        return this.statePool.values();
    }

    private registrationClosed = false;
    get registeredStateNames(): readonly string[] {
        return [...this.statePool.keys()];
    }
    sealRegistration(): void {
        this.registrationClosed = true;
    }

    private readonly statePool = new Map<string, AppState<unknown>>();
    readonly values = new ViewerState();
    readonly store = this.values.store;

    /** Register a persisted codec against its owner's named SignalStore value. */
    register<S extends OwnerSlice, K extends keyof ViewerValues[S]>(
        options: AppStateOptions<ViewerValues[S][K]>,
        slice: S,
        key: K
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
        options: AppStateOptions<ViewerValues[S][K] extends Record<string, infer T> ? T : never>,
        slice: S,
        key: K
    ): MapViewState<ViewerValues[S][K] extends Record<string, infer T> ? T : never> {
        if (this.registrationClosed || this.isReady) throw new Error(`Late state registration: ${options.name}`);
        type Value = ViewerValues[S][K] extends Record<string, infer T> ? T : never;
        const records = this.bind(slice, key) as unknown as StateBinding<Record<string, Value>>;
        const ids = () => this.values.read((state) => state.viewIds, this.store.viewIds).map(String);
        records.write(Object.fromEntries(ids().map((id) => [id, options.defaultValue])));
        // Legacy arrays are projected only for codecs and positional UI adapters.
        // The record and its native per-ID selectors are the authoritative value.
        const binding: StateBinding<Value[]> = {
            signal: computed(() => this.store.viewIds().map((id) => records.signal()[id] ?? options.defaultValue)),
            commits: records.commits,
            writeOrigin: () => records.writeOrigin?.() ?? this.persisted("viewIds").writeOrigin,
            read: () =>
                ids().map(
                    (id, index) =>
                        records.read()[id] ??
                        records.read()[String(this.store.viewIds()[index])] ??
                        options.defaultValue
                ),
            write: (values) =>
                records.write(Object.fromEntries(ids().map((id, index) => [id, values[index] ?? options.defaultValue])))
        };
        this.values.beforeCommit(
            () => {
                if (this.values.read((state) => state.viewIds, this.store.viewIds) === this.store.viewIds()) return;
                const currentIds = ids();
                const values = records.read();
                const previousIds = this.store.viewIds().map(String);
                if (currentIds.length === Object.keys(values).length && currentIds.every((id) => id in values)) return;
                const sourceId = previousIds.at(-1);
                const source = sourceId ? (values[sourceId] ?? options.defaultValue) : options.defaultValue;
                records.write(
                    Object.fromEntries(
                        currentIds.map((id, index) => [
                            id,
                            values[id] ??
                                deepCopy(
                                    values[
                                        this.values.read(
                                            (state) => state.viewEntityMap[id]?.copySourceId,
                                            () => this.store.viewEntityMap()[id]?.copySourceId
                                        ) ?? previousIds[index]
                                    ] ?? source
                                )
                        ])
                    )
                );
            },
            () => this.persisted("viewIds").writeOrigin
        );
        const state = new MapViewState<Value>(this.statePool, options, binding, {
            idAt: (index) => ids()[index],
            read: (id) =>
                records.read()[id] ??
                records.read()[String(this.store.viewIds()[ids().indexOf(id)])] ??
                options.defaultValue,
            write: (id, value) => {
                if (!ids().includes(id)) throw new Error(`View ${id} is unavailable`);
                records.write({...records.read(), [id]: value});
            },
            select: (id) =>
                computed(() => {
                    const slots = this.store[slice] as unknown as Record<string, Record<string, Signal<Value>>>;
                    return slots[String(key)][id]?.() ?? options.defaultValue;
                })
        });
        this.mapViewStates.push(state as MapViewState<unknown>);
        return state;
    }

    registerStyles(records: StateBinding<Map<string, Record<string, string | number | boolean>>>): StyleState {
        if (this.registrationClosed || this.isReady) throw new Error("Late state registration: styleOptions");
        type Option = string | number | boolean;
        records.write(new Map());
        const ids = () => this.values.read((state) => state.viewIds, this.store.viewIds).map(String);
        const project = (
            values: Map<string, Record<string, Option>>,
            order: readonly string[],
            fallback: readonly string[] = []
        ) =>
            new Map(
                [...values].map(([key, byId]) => [key, order.map((id, index) => byId[id] ?? byId[fallback[index]])])
            );
        const binding: StateBinding<Map<string, Option[]>> = {
            signal: computed(() => project(records.signal(), this.store.viewIds().map(String))),
            commits: records.commits,
            writeOrigin: () => records.writeOrigin?.() ?? this.persisted("viewIds").writeOrigin,
            read: () => project(records.read(), ids(), this.store.viewIds().map(String)),
            write: (values) =>
                records.write(
                    new Map(
                        [...values].map(([key, array]) => [
                            key,
                            Object.fromEntries(ids().map((id, index) => [id, array[index]]))
                        ])
                    )
                )
        };
        this.values.beforeCommit(
            () => {
                if (this.values.read((state) => state.viewIds, this.store.viewIds) === this.store.viewIds()) return;
                const order = ids();
                const values = records.read();
                const sourceId = this.store.viewIds().at(-1);
                const next = new Map(values);
                let changed = false;
                for (const [key, byId] of values) {
                    if (Object.keys(byId).length === order.length && order.every((id) => id in byId)) continue;
                    changed = true;
                    next.set(
                        key,
                        Object.fromEntries(
                            order.map((id, index) => [
                                id,
                                byId[id] ??
                                    byId[
                                        this.values.read(
                                            (state) => state.viewEntityMap[id]?.copySourceId,
                                            () => this.store.viewEntityMap()[id]?.copySourceId
                                        ) ?? this.store.viewIds()[index]
                                    ] ??
                                    (sourceId ? byId[sourceId] : false)
                            ])
                        )
                    );
                }
                if (changed) records.write(next);
            },
            () => this.persisted("viewIds").writeOrigin
        );
        return new StyleState(this.statePool, binding);
    }

    /** Binds an owner's codec to its native SignalStore field, including specialized codecs. */
    bind<S extends OwnerSlice, K extends keyof ViewerValues[S]>(
        slice: S,
        key: K
    ): StateBinding<ViewerValues[S][K]> {
        return this.values.bind<ViewerValues[S][K]>(
            (state) => state[slice][key],
            (state, value) => ({[slice]: {...state[slice], [key]: value}}),
            () => {
                const signals = this.store[slice] as unknown as {
                    [P in keyof ViewerValues[S]]: Signal<ViewerValues[S][P]>;
                };
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
    private readonly urlNormalizers: Array<(params: Params, resetMissing: boolean) => Params> = [];
    registerUrlNormalizer(normalize: (params: Params, resetMissing: boolean) => Params): void {
        this.urlNormalizers.push(normalize);
    }
    private prepareUrl(params: Params, resetMissing = false): Params {
        return this.urlNormalizers.reduce((value, normalize) => normalize(value, resetMissing), params);
    }

    private readonly snapshotNormalizers: Array<
        (snapshot: Record<string, unknown>, replaceMissing: boolean) => Record<string, unknown>
    > = [];

    /** Owners validate relationships between persisted projections before any import writes. */
    registerSnapshotNormalizer(
        normalize: (snapshot: Record<string, unknown>, replaceMissing: boolean) => Record<string, unknown>
    ): void {
        this.snapshotNormalizers.push(normalize);
    }

    readonly importingUrl = new Subject<Params>();
    readonly importedStartupUrl = new Subject<Params>();
    readonly importedSnapshot = new Subject<void>();
    pushNextUrl(): void {
        this._replaceUrl = false;
    }

    private get stylesState(): StyleState {
        return this.persisted("styleOptions") as StyleState;
    }

    /** Prepare related owner writes and expose one coherent SignalStore commit. */
    /** Owners prepare related invariants inside the same patch, including imported values. */
    beforeCommit(prepare: () => void, origin?: () => StateWriteOrigin | undefined): () => void {
        return this.values.beforeCommit(prepare, origin);
    }

    transaction<T>(operation: () => T): T {
        return this.values.transaction(operation);
    }

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
    private pendingUrlSyncStates = new Set<AppState<any>>();
    private pendingStorageSyncStates = new Set<AppState<any>>();
    private pendingUserOwnershipStates = new Set<string>();
    private pendingPopstateHydration = false;
    private flushHandle: Promise<void> | null = null;
    private urlSyncHandle: ReturnType<typeof setTimeout> | null = null;
    private lastUrlSyncAt = 0;
    // One-shot guard used to keep inbound links stable during passive startup.
    private skipNextUrlSync = false;
    private readonly STYLE_OPTIONS_STORAGE_KEY = "styleOptions";
    private readonly CONFIG_DEFAULT_STATE_META_KEY = "erdblickConfigDefaultStateMeta";
    private readonly SNAPSHOT_UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
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
    constructor(
        private readonly router: Router,
        private readonly infoMessageService: InfoMessageService
    ) {
        this.values.setOriginProvider(() =>
            this.isHydrating
                ? "hydration"
                : this.isSeedingConfigDefaults
                  ? "config"
                  : this.isSystemStateMutation
                    ? "system"
                    : "user"
        );
        this.retireMapPresetDefinitionStorage();
        // Perform initial hydration after the initial NavigationEnd event arrives.
        this.router.events
            .pipe(
                filter((event) => event instanceof NavigationEnd),
                take(1)
            )
            .subscribe(() => {
                this.initializePersistence();
            });

        // Subsequently, Navigation events may come from usage of the browser back/forward-buttons.
        this.router.events.subscribe((event) => {
            if (event instanceof NavigationStart) {
                const nav = this.router.getCurrentNavigation();
                this.pendingPopstateHydration = nav?.trigger === "popstate";
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
                try {
                    this.applyHydratedUrlState(this.currentBrowserQueryParams());
                } catch (error) {
                    this.infoMessageService.showError(`Could not import view link: ${String(error)}`);
                }
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
        let acceptedQueryParams: Params = {};
        try {
            this.hydrateFromUrl(this.prepareUrl(queryParams));
            acceptedQueryParams = queryParams;
        } catch (error) {
            this.infoMessageService.showError(`Could not import view link: ${String(error)}`);
        }
        // Legacy owners may still migrate saved state after a rejected URL, but must not consume its fields.
        this.importedStartupUrl.next(acceptedQueryParams);
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

        const normalizedResult = this.normalizeSnapshot(snapshot, false, true);
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
        this.statePool.values().forEach((state) => this.onStateChanged(state, true));
    }

    /** Cancels pending persistence work when the service is destroyed. */
    ngOnDestroy(): void {
        this.values.destroy();
        this.stateSubscriptions.forEach((subscription) => subscription.unsubscribe());
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
            const subscription = (state as AppState<unknown>).pipe(skip(1)).subscribe((value) => {
                this.onStateChanged(state as AppState<unknown>);
            });
            this.stateSubscriptions.push(subscription);
        }
        this.subscriptionsSetup = true;
    }

    /** Handles one state-slot change and schedules the required persistence work. */
    private onStateChanged(state: AppState<any>, force: boolean = false): void {
        const origin = state.writeOrigin;
        const markUserOwned =
            !force &&
            this.isReady &&
            (origin === "user" ||
                (!origin && !this.isHydrating && !this.isSeedingConfigDefaults && !this.isSystemStateMutation));
        if (markUserOwned) {
            this.pendingUserOwnershipStates.add(state.name);
        }

        if (
            !force &&
            (origin === "hydration" ||
                origin === "config" ||
                this.isHydrating ||
                !this.isReady ||
                this.isSeedingConfigDefaults)
        ) {
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
                        Object.keys(serializedStyleEntries).filter((key) =>
                            this.stylesState.isStyleOptionUrlParamKey(key)
                        )
                    );
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
        const params = this.urlCodec().serialize(this.currentBrowserQueryParams());
        this.pendingUrlSyncStates.clear();
        this.router
            .navigate([], {
                queryParams: params,
                queryParamsHandling: "replace",
                replaceUrl: this.replaceUrl
            })
            .catch((error) => {
                console.error("[AppStateService] Failed to sync URL parameters", error);
            });
    }

    /** Restores storage-backed state slots from local storage during startup. */
    private hydrateFromStorage(): void {
        this.withHydration(() => {
            this.configDefaultStateMeta = this.loadConfigDefaultStateMeta();
            // A stored identity list can change a projection that config already seeded
            // (for example numberOfViews). Reapply that config value at its normal
            // registration position before hydrating the corresponding per-view data.
            const configured = new Map(
                [...this.currentConfigDefaultKeys].flatMap((name) => {
                    const state = this.statePool.get(name);
                    return state ? [[name, state.toSnapshotValue()] as const] : [];
                })
            );
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
                        state.applySnapshotValue(configured.get(state.name));
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
            this.urlCodec().hydrate(params);
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
        if (
            typeof snapshot === "object" &&
            !Array.isArray(snapshot) &&
            Object.keys(snapshot as Record<string, unknown>).length === 0
        ) {
            this.configDefaultStateMeta = this.loadConfigDefaultStateMeta();
            this.configDefaultStateMeta.sourceHash = sourceHash || "";
            this.configDefaultValueHashes.clear();
            this.currentConfigDefaultKeys.clear();
            this.persistConfigDefaultStateMeta();
            return [];
        }

        const normalizedResult = this.normalizeSnapshot(snapshot, true);
        if (normalizedResult.errors.length) {
            normalizedResult.errors.forEach((error) =>
                console.warn(`[AppStateService] Ignoring invalid config state: ${error}`)
            );
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
            this.transaction(() => {
                for (const [key, state] of this.statePool) {
                    if (!state.isConfigDefaultState() || !Object.prototype.hasOwnProperty.call(normalized, key)) {
                        continue;
                    }
                    state.applySnapshotValue(normalized[key]);
                    appliedStateKeys.add(key);
                }

                if (Object.keys(styleOptionEntries).length) {
                    this.deserializeStateSafely(this.stylesState, styleOptionEntries);
                    this.stylesState.next(new Map(this.stylesState.getValue()));
                }
            });
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
    private applyNormalizedSnapshot(normalized: Record<string, unknown>, replaceMissing: boolean): void {
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
    private normalizeSnapshot(
        snapshot: unknown,
        forConfigDefault = false,
        replaceMissing = false
    ): SnapshotNormalizationResult {
        const limits = this.getSnapshotImportLimits();
        const errors: string[] = [];
        let serialized: string;
        try {
            serialized = JSON.stringify(snapshot);
        } catch {
            return {errors: ["Snapshot payload is not serializable JSON."]};
        }
        if (serialized.length > limits.maxFileSizeBytes) {
            return {errors: [`Snapshot payload exceeds ${limits.maxFileSizeBytes} bytes.`]};
        }

        const normalizedRoot = this.normalizeSnapshotNode(snapshot, "$", 0, limits, errors);
        if (errors.length) {
            return {errors};
        }
        if (!normalizedRoot || Array.isArray(normalizedRoot) || typeof normalizedRoot !== "object") {
            return {errors: ["Snapshot payload must be a JSON object."]};
        }
        const normalized = normalizedRoot as Record<string, unknown>;
        const keys = Object.keys(normalized);
        if (keys.length > limits.maxTopLevelEntries) {
            return {errors: ["Snapshot payload contains too many top-level entries."]};
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
            const stateIsAllowed = forConfigDefault ? state.isConfigDefaultState() : state.isSnapshotState();
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
            const stateIsAllowed = forConfigDefault ? state.isConfigDefaultState() : state.isSnapshotState();
            if (!stateIsAllowed) {
                continue;
            }
            try {
                state.validateSnapshotValue(normalized[key]);
            } catch (error: any) {
                errors.push(`Invalid value for '${key}': ${error?.message ?? "schema validation failed"}`);
            }
        }
        if (errors.length) return {errors};
        try {
            const prepared = this.snapshotNormalizers.reduce(
                (value, normalize) => normalize(value, replaceMissing),
                normalized
            );
            return {normalized: prepared, errors: []};
        } catch (error) {
            return {errors: [`Invalid snapshot: ${error instanceof Error ? error.message : String(error)}`]};
        }
    }

    /** Returns whether a snapshot key is a compact style-option storage key. */
    private validateStyleOptionSnapshotEntry(key: string, value: unknown, errors: string[]): boolean {
        if (!this.stylesState.isStyleOptionUrlParamKey(key)) {
            return false;
        }
        if (typeof value !== "string") {
            errors.push(`Invalid value for '${key}': expected string style option payload.`);
        }
        return true;
    }

    /** Extracts compact style-option entries from a normalized snapshot. */
    private extractStyleOptionSnapshotEntries(snapshot: Record<string, unknown>): Record<string, string> {
        const entries: Record<string, string> = Object.create(null);
        for (const [key, value] of Object.entries(snapshot)) {
            if (this.stylesState.isStyleOptionUrlParamKey(key) && typeof value === "string") {
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

        if (value && typeof value === "object") {
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

        if (typeof value === "string" && value.length > limits.maxStringLength) {
            errors.push(`Snapshot string at '${path}' exceeds max length.`);
            return undefined;
        }
        return value;
    }

    /** Clears persisted app state from local storage and resets URL-backed state. */
    resetStorage() {
        for (const state of this.statePool.values()) {
            state.resetToDefault();
            localStorage.removeItem(state.name);
        }
        this.clearStyleOptionStorageEntries();
        localStorage.removeItem("searchHistory");
        localStorage.removeItem(this.STYLE_OPTIONS_STORAGE_KEY);
        localStorage.removeItem(this.CONFIG_DEFAULT_STATE_META_KEY);
        const {origin, pathname} = window.location;
        window.location.href = origin + pathname;
    }
}
