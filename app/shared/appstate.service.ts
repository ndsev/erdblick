import { Injectable, OnDestroy } from "@angular/core";
import { NavigationEnd, NavigationStart, Params, Router } from "@angular/router";
import { BehaviorSubject, distinctUntilChanged, Observable, skip, Subject, Subscription, take } from "rxjs";
import { filter } from "rxjs/operators";
import {
    AppState,
    AppStateOptions,
    AppStateProjection,
    deepCopy,
    deepEquals,
    MapViewState,
    StyleState
} from "./app-state";
import {
    ConfigDefaultStateMeta,
    ConfigDefaultStateMetaEntry,
    hashStateValue,
    SnapshotImportLimits,
    SnapshotNormalizationResult
} from "./app-state.model";
import { InfoMessageService } from "./info.service";

/** The persistence ownership attached to an edit when it is staged. */
type MutationOrigin = "user" | "system" | "hydration" | "config";

/**
 * The application supplies its shared legacy URL/snapshot grammar. Preparation
 * validates without mutation; application consumes coordinated owner values before
 * independent positional codecs run. AppStateService does not know their domains.
 */
export interface AppUrlProjection {
    serialize(params: Record<string, string | string[]>): Record<string, string | string[]>;
    hydrate(params: Params): void;
    /** Runs startup migrations with accepted URL params, or an empty set after URL rejection. */
    initialize(params: Params): void;
    prepareSnapshot(values: Record<string, unknown>, replaceMissing: boolean): Record<string, unknown>;
    /** Applies coordinated owner values and returns the keys already consumed before generic codecs run. */
    applySnapshot(values: Record<string, unknown>): ReadonlySet<string>;
    prepareUrl(params: Params, resetMissing: boolean): Params;
    prepareStoredViews(values: Map<string, string>, params: Params, configKeys: ReadonlySet<string>): void;
}

/**
 * Registers owner-created state and coordinates persistence, config ownership and
 * publication. Domain services supply URL projections and own all user operations.
 */
@Injectable({ providedIn: 'root' })
export class AppStateService implements OnDestroy {

    private transactionDepth = 0;
    private publishing = false;
    private announcingCommit = false;
    private readonly pendingInitialObservers = new Set<() => void>();
    private readonly deferredWrites: Array<() => void> = [];
    private readonly pendingPublications = new Map<AppState<unknown>, { publish: () => void; origin: MutationOrigin }>();
    private readonly publishedOrigins = new Map<AppState<unknown>, MutationOrigin>();
    private readonly projectionSources = new Map<AppState<unknown>, AppState<unknown>>();
    private readonly commits = new BehaviorSubject(0);
    private readonly rollbackFrames: Array<Map<AppState<unknown>, unknown>> = [];
    private urlProjection?: AppUrlProjection;
    private registrationSealed = false;
    readonly snapshotReplaced = new Subject<void>();

    get registeredStates(): ReadonlyMap<string, AppState<unknown>> {
        return this.statePool;
    }

    /** Ends explicit startup registration; a forgotten lazy owner fails at its registration site. */
    sealRegistration(): void {
        this.registrationSealed = true;
    }

    /** Installs the application URL coordinator before config seeding or hydration. */
    registerUrlProjection(projection: AppUrlProjection): void {
        if (this.urlProjection) throw new Error("The URL projection is already registered.");
        this.urlProjection = projection;
    }

    /** Requests a browser-history entry for the next durable navigation edit. */
    requestHistoryEntry(): void {
        this._replaceUrl = false;
    }

    /** Cancels a previously requested history entry when an operation is a no-op. */
    replaceHistoryEntry(): void {
        this._replaceUrl = true;
    }

    /** StyleState retains the deployed multi-key storage format behind one registration. */
    registerStyleState(viewIds: () => readonly string[]): StyleState {
        if (this.registrationSealed) throw new Error("State registration is closed.");
        const state = new StyleState(this.statePool, viewIds);
        this.registerPublication(state);
        return state;
    }

    private get styleStorage(): StyleState {
        const state = [...this.statePool.values()].find(value => value instanceof StyleState);
        if (!state) throw new Error("Style storage must be registered before persistence starts.");
        return state as StyleState;
    }

    /**
     * Runs a synchronous coordinated edit. Slot readers see the complete staged values
     * before the first slot notification. Observers spanning several slots must use
     * observe(), because combineLatest caches earlier notifications independently.
     */
    transaction(edit: () => void): void {
        if (this.announcingCommit) {
            this.deferredWrites.push(() => this.transaction(edit));
            return;
        }
        const original = new Map<AppState<unknown>, unknown>();
        this.rollbackFrames.push(original);
        const previousPublications = new Map(this.pendingPublications);
        ++this.transactionDepth;
        try {
            edit();
            // Only touched slots are compared. Returning to the original value must
            // retain its identity and must not acquire user ownership in persistence.
            original.forEach((value, state) => {
                if (!deepEquals(value, state.value)) return;
                state.stage(value);
                const priorPublication = previousPublications.get(state);
                if (priorPublication) this.pendingPublications.set(state, priorPublication);
                else this.pendingPublications.delete(state);
            });
        } catch (error) {
            original.forEach((value, state) => state.stage(value));
            this.pendingPublications.clear();
            previousPublications.forEach((publish, state) => this.pendingPublications.set(state, publish));
            throw error;
        } finally {
            this.rollbackFrames.pop();
            if (--this.transactionDepth === 0) {
                this.publishTransaction();
                const initial = [...this.pendingInitialObservers];
                this.pendingInitialObservers.clear();
                initial.forEach(emit => emit());
            }
        }
    }

    /** Reads one coherent projection after all slot observers finish the current edit. */
    observe<T>(read: () => T, equal: (a: T, b: T) => boolean = Object.is): Observable<T> {
        return new Observable<T>(subscriber => {
            const emit = () => { if (!subscriber.closed) subscriber.next(read()); };
            const subscription = this.commits.pipe(skip(1)).subscribe(emit);
            if (this.transactionDepth || this.publishing) this.pendingInitialObservers.add(emit);
            else emit();
            return () => { this.pendingInitialObservers.delete(emit); subscription.unsubscribe(); };
        }).pipe(distinctUntilChanged(equal));
    }

    /** Drains synchronous derived edits before announcing the completed state. */
    private publishTransaction(): void {
        if (this.publishing || !this.pendingPublications.size) return;
        this.publishing = true;
        try {
            while (this.pendingPublications.size) {
                const publications = [...this.pendingPublications.values()];
                this.pendingPublications.clear();
                publications.forEach(({ publish, origin }) => this.withMutationOrigin(origin, publish));
            }
        } finally {
            this.publishing = false;
        }
        this.pendingInitialObservers.clear();
        this.announcingCommit = true;
        try {
            this.commits.next(this.commits.value + 1);
        } finally {
            this.announcingCommit = false;
        }
        if (this.deferredWrites.length) {
            const writes = this.deferredWrites.splice(0);
            this.transaction(() => writes.forEach(write => write()));
        }
    }

    private readonly statePool = new Map<string, AppState<unknown>>();

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
                this.applyHydratedUrlState(this.currentBrowserQueryParams());
            }
        });

    }

    /** Hydrates persisted state once config defaults are known and marks the service ready. */
    initializePersistence(): void {
        if (this.isReady) {
            return;
        }
        if (!this.registrationSealed) {
            throw new Error("State owners must be registered before persistence starts.");
        }
        this.setupStateSubscriptions();
        const queryParams = this.currentBrowserQueryParams();
        try { this.hydrateFromStorage(queryParams); }
        catch (error) { this.reportHydrationError("saved state", error); this.hydrateFromStorage({}); }
        let acceptedQueryParams = queryParams;
        try { this.hydrateFromUrl(queryParams); }
        catch (error) {
            this.reportHydrationError("share link", error);
            acceptedQueryParams = {};
        }
        this.urlProjection?.initialize(acceptedQueryParams);
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

        // Resolve and validate identities before either changing the browser URL
        // or resetting state. Invalid explicit IDs must preserve the prior page.
        const prepared = this.urlProjection!.prepareUrl(params, resetMissing);
        this.cancelPendingStateSync();
        await this.router.navigate([], {
            queryParams: params,
            queryParamsHandling: "replace",
            replaceUrl: true
        });
        if (resetMissing) {
            this.withHydration(() => this.applyNormalizedSnapshot({}, true));
        }
        this.applyHydratedUrlState(prepared);
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

    /** Creates an application state entry and registers it for persistence. */
    registerState<T>(options: AppStateOptions<T>): AppState<T> {
        if (this.registrationSealed) throw new Error(`State registration is closed: ${options.name}`);
        const state = new AppState<T>(this.statePool, options);
        this.registerPublication(state);
        return state;
    }

    /** Registers an old storage key projected from existing state, without a second writable value. */
    registerProjection<T>(options: AppStateOptions<T>, source: AppStateProjection<T>): AppState<T> {
        if (this.registrationSealed) throw new Error(`State registration is closed: ${options.name}`);
        const state = new AppState<T>(this.statePool, options, source);
        this.projectionSources.set(state as AppState<unknown>, source.sourceState);
        return state;
    }

    private mutationOrigin(): MutationOrigin {
        return this.isHydrating ? "hydration" : this.isSeedingConfigDefaults ? "config"
            : this.isSystemStateMutation ? "system" : "user";
    }

    /** Publication keeps each write's origin even when a surrounding batch outlives its scope. */
    private withMutationOrigin(origin: MutationOrigin, action: () => void): void {
        const previous = [this.isHydrating, this.isSeedingConfigDefaults, this.isSystemStateMutation];
        this.isHydrating = origin === "hydration";
        this.isSeedingConfigDefaults = origin === "config";
        this.isSystemStateMutation = origin === "system";
        try { action(); }
        finally { [this.isHydrating, this.isSeedingConfigDefaults, this.isSystemStateMutation] = previous; }
    }

    /** Attaches owner-created state to the same publication boundary as persistence. */
    private registerPublication<T>(state: AppState<T>): void {
        state.writeValue = value => {
            if (this.announcingCommit) {
                const queued = deepCopy(value);
                const origin = this.mutationOrigin();
                this.deferredWrites.push(() => this.withMutationOrigin(origin, () => state.next(queued)));
                return;
            }
            if (deepEquals(state.value, value)) return;
            for (const frame of this.rollbackFrames) {
                if (!frame.has(state as AppState<unknown>)) frame.set(state as AppState<unknown>, state.value);
            }
            state.stage(deepCopy(value));
            const previous = this.pendingPublications.get(state as AppState<unknown>);
            // A deliberate user edit in the same slot remains user-owned after
            // system normalization. Hydration cancels old pending writes separately.
            const origin = previous?.origin === "user" ? "user" : this.mutationOrigin();
            this.pendingPublications.set(state as AppState<unknown>, {
                origin, publish: () => {
                    this.publishedOrigins.set(state as AppState<unknown>, origin);
                    state.publish();
                }
            });
            if (!this.transactionDepth) this.publishTransaction();
        };
    }

    /** Delegates domain URL mechanics while retaining unknown query parameters. */
    private serializeUrlV2(includeUnknownParams = true): Record<string, string | string[]> {
        return this.urlProjection?.serialize(includeUnknownParams ? this.preservedUnknownUrlParams() : {}) ?? {};
    }

    /** Creates a state entry scoped to each map view. */
    registerMapViewState<T>(options: AppStateOptions<T>, viewIds: () => readonly string[]): MapViewState<T> {
        if (this.registrationSealed) throw new Error(`State registration is closed: ${options.name}`);
        const state = new MapViewState<T>(this.statePool, options, viewIds);
        this.registerPublication(state.appState);

        return state;
    }

    /** Subscribes to all persisted state slots so storage and URL remain in sync. */
    private setupStateSubscriptions() {
        if (this.subscriptionsSetup) return;
        // NOTE: Is this the best way to implement the internal subscription mechanism?
        for (const state of this.statePool.values()) {
            const subscription = (state as AppState<unknown>).pipe(skip(1)).subscribe(value => {
                const source = this.projectionSources.get(state as AppState<unknown>);
                const origin = source ? this.publishedOrigins.get(source) : undefined;
                if (origin) this.withMutationOrigin(origin, () => this.onStateChanged(state as AppState<unknown>));
                else this.onStateChanged(state as AppState<unknown>);
            });
            this.stateSubscriptions.push(subscription);
        }
        this.subscriptionsSetup = true;
    }

    /** Handles one state-slot change and schedules the required persistence work. */
    onStateChanged(state: AppState<any>, force: boolean = false): void {
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
        this.pendingUserOwnershipStates.clear();
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
                if (state === this.styleStorage) {
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

                if (state === this.styleStorage) {
                    const serializedStyleEntries = this.styleStorage.serialize(false) ?? {};
                    const serializedStyleKeys = new Set(
                        Object.keys(serializedStyleEntries).filter(key =>
                            this.styleStorage.isStyleOptionUrlParamKey(key)));
                    for (const key of Object.keys(this.configDefaultStateMeta.entries)) {
                        if (this.styleStorage.isStyleOptionUrlParamKey(key) && !serializedStyleKeys.has(key)) {
                            delete this.configDefaultStateMeta.entries[key];
                        }
                    }
                    for (const [key, value] of Object.entries(serializedStyleEntries)) {
                        if (!this.styleStorage.isStyleOptionUrlParamKey(key)) {
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

    /** Keeps non-Erdblick query params while dropping stale v1 and v2 state params. */
    private preservedUnknownUrlParams(): Record<string, string | string[]> {
        const managedKeys = this.managedUrlParamKeys();
        const params: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(this.currentBrowserQueryParams())) {
            if (managedKeys.has(key) || this.styleStorage.isStyleOptionUrlParamKey(key)) {
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
            if (state === this.styleStorage || !state.isUrlState()) {
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
    private hydrateFromStorage(params: Params): void {
        this.withHydration(() => {
            this.configDefaultStateMeta = this.loadConfigDefaultStateMeta();
            const values = new Map<string, string>();
            for (const state of this.statePool.values()) {
                if (state === this.styleStorage) continue;
                const raw = localStorage.getItem(state.name);
                if (raw === null) continue;
                const metaEntry = this.configDefaultStateMeta.entries[state.name];
                if (metaEntry?.owner === "config") {
                    if (this.currentConfigDefaultKeys.has(state.name)) continue;
                    state.resetToDefault();
                    localStorage.removeItem(state.name);
                    delete this.configDefaultStateMeta.entries[state.name];
                    continue;
                }
                values.set(state.name, raw);
            }
            this.urlProjection?.prepareStoredViews(values, params, this.currentConfigDefaultKeys);
            // MapViewState and any identity-bearing owner values use the same prepared IDs.
            for (const state of this.statePool.values()) {
                if (state === this.styleStorage) continue;
                const raw = values.get(state.name);
                if (raw !== undefined) this.deserializeStateSafely(state, raw);
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
                this.deserializeStateSafely(this.styleStorage, filteredStyleOptionEntries);
            }
            this.persistConfigDefaultStateMeta();
        });
    }

    /** Restores URL-backed state slots from the current route query params. */
    private hydrateFromUrl(params: Params): void {
        this.withHydration(() => {
            if (!this.urlProjection) throw new Error("URL owners have not been registered.");
            this.urlProjection.hydrate(params);
        });
    }

    /** Applies one runtime URL state and notifies derived projections after hydration. */
    private applyHydratedUrlState(params: Params): void {
        this.cancelPendingStateSync();
        try {
            this.hydrateFromUrl(params);
            this.stateApplied.next();
        } catch (error) {
            this.reportHydrationError("share link", error);
        }
    }

    /** Reports a rejected persisted field while its owner restores other valid saved values. */
    reportHydrationError(source: string, error: unknown): void {
        this.infoMessageService.showError(`Could not restore ${source}: ${error instanceof Error ? error.message : String(error)}`);
    }

    /** Keeps one malformed persisted state entry from aborting startup hydration. */
    deserializeStateSafely(
        state: { name: string; deserialize(raw: string | Params): void },
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
        if (this.announcingCommit) {
            this.deferredWrites.push(() => this.withHydration(callback));
            return;
        }
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
        for (const [name, value] of Object.entries(this.styleStorage.serialize(false) ?? {})) {
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
        if (this.announcingCommit) {
            // Validation is synchronous, but both values and their ownership
            // metadata belong to the next commit. Computing hashes now would
            // associate the previous values with the incoming configuration.
            if (snapshot != null) {
                const errors = this.normalizeSnapshot(snapshot, true).errors;
                if (errors.length) return errors;
            }
            const queued = deepCopy(snapshot);
            this.deferredWrites.push(() => { this.seedConfigDefaultState(queued, sourceHash); });
            return [];
        }
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

        const normalized = this.urlProjection?.prepareSnapshot(normalizedResult.normalized ?? {}, false) ?? normalizedResult.normalized ?? {};
        const styleOptionEntries = this.extractStyleOptionSnapshotEntries(normalized);
        const appliedStateKeys = new Set<string>();

        this.configDefaultStateMeta = this.loadConfigDefaultStateMeta();
        this.configDefaultStateMeta.sourceHash = sourceHash || "";
        this.configDefaultValueHashes.clear();
        this.currentConfigDefaultKeys.clear();

        this.isSeedingConfigDefaults = true;
        try {
            this.transaction(() => {
                const consumed = this.urlProjection?.applySnapshot(normalized);
                for (const [key, value] of Object.entries(normalized)) {
                    const state = this.statePool.get(key);
                    if (!state || !state.isConfigDefaultState()) {
                        continue;
                    }
                    if (!consumed?.has(key)) state.applySnapshotValue(value);
                    // Identity preparation may supply dependent codec values. Only
                    // explicitly configured keys acquire configuration ownership.
                    if (Object.hasOwn(normalizedResult.normalized!, key)) appliedStateKeys.add(key);
                }

                if (Object.keys(styleOptionEntries).length) {
                    this.deserializeStateSafely(this.styleStorage, styleOptionEntries);
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

        const serializedStyleOptions = this.styleStorage.serialize(false) ?? {};
        for (const [key, serializedValue] of Object.entries(serializedStyleOptions)) {
            if (!this.styleStorage.isStyleOptionUrlParamKey(key)) {
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
        try {
            this.transaction(() => this.applyNormalizedSnapshot(normalizedResult.normalized!, false));
            return [];
        } catch (error) {
            return [error instanceof Error ? error.message : String(error)];
        }
    }

    /** Applies a validated snapshot in state-registration order. */
    private applyNormalizedSnapshot(
        normalized: Record<string, unknown>,
        replaceMissing: boolean
    ): void {
        normalized = this.urlProjection?.prepareSnapshot(normalized, replaceMissing) ?? normalized;
        const consumed = this.urlProjection?.applySnapshot(normalized);
        for (const [key, state] of this.statePool.entries()) {
            if (!state.isSnapshotState() || consumed?.has(key)) {
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
            this.styleStorage.next(new Map());
        }
        if (Object.keys(styleOptionEntries).length) {
            this.deserializeStateSafely(this.styleStorage, styleOptionEntries);
        }
        this.snapshotReplaced.next();
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
            return { errors };
        }
        if (!normalizedRoot || Array.isArray(normalizedRoot) || typeof normalizedRoot !== 'object') {
            return { errors: ['Snapshot payload must be a JSON object.'] };
        }
        const normalized = normalizedRoot as Record<string, unknown>;
        const keys = Object.keys(normalized);
        if (keys.length > limits.maxTopLevelEntries) {
            return { errors: ['Snapshot payload contains too many top-level entries.'] };
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
            return { errors };
        }

        try { this.urlProjection?.prepareSnapshot(normalized, false); }
        catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }

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
        return errors.length ? { errors } : { normalized, errors: [] };
    }

    /** Returns whether a snapshot key is a compact style-option storage key. */
    private validateStyleOptionSnapshotEntry(key: string, value: unknown, errors: string[]): boolean {
        if (!this.styleStorage.isStyleOptionUrlParamKey(key)) {
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
            if (this.styleStorage.isStyleOptionUrlParamKey(key) && typeof value === 'string') {
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
            if (!key || !this.styleStorage.isStyleOptionUrlParamKey(key)) {
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
            if (key && this.styleStorage.isStyleOptionUrlParamKey(key)) {
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
            const meta = JSON.parse(rawMeta) as { entries?: Record<string, unknown> };
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
                entries[key] = { owner, valueHash };
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
        this.configDefaultStateMeta.entries[key] = { owner, valueHash };
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
        if (this.announcingCommit) {
            this.deferredWrites.push(() => this.withSystemStateMutation(action));
            return;
        }
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
    };;;;;;;;;;;;;;;;;;;;;;

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
        const { origin, pathname } = window.location;
        window.location.href = origin + pathname;
    }
}
