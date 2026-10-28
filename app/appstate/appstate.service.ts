import { Injectable, OnDestroy } from "@angular/core";
import {
    NavigationEnd,
    NavigationStart,
    Params,
    Router
} from "@angular/router";
import {
    BehaviorSubject,
    distinctUntilChanged,
    Observable,
    skip,
    Subject,
    Subscription,
    take
} from "rxjs";
import { filter } from "rxjs/operators";
import { MessageService } from "primeng/api";
import {
    AppState,
    AppStateOptions,
    AppStateProjection,
    deepCopy,
    deepEquals,
    PerViewState,
    StyleState
} from "./appstate.model";
import {
    ConfigDefaultStateMeta,
    ConfigDefaultStateMetaEntry,
    hashStateValue,
    SnapshotImportLimits,
    SnapshotNormalizationResult
} from "./appstate-values.model";

/** The persistence ownership attached to an edit when it is staged. */
type MutationOrigin = "user" | "system" | "hydration" | "config";

/**
 * Domain coordination needed when several storage keys describe one value.
 *
 * For example, a restored view ID list must be established before positional
 * cameras, layers and inspections can be attached to those views. AppUrlStateService
 * owns that ordering and the compact URL dictionaries. This persistence registry
 * only knows when to prepare, apply and publish the resulting edit.
 *
 * The prepare methods validate and return detached input without changing live
 * values. The apply/hydrate methods run within the registry's transaction.
 */
export interface AppUrlProjection {
    /** Encodes current shareable values, extending the supplied non-state query parameters. */
    serialize(params: Record<string, string | string[]>): Record<string, string | string[]>;
    /** Restores a validated URL into its domain owners, including legacy positional links. */
    hydrate(params: Params): void;
    /** Runs startup migrations with accepted URL params, or an empty set after URL rejection. */
    initialize(params: Params): void;
    /** Aligns snapshot values and identities; replacement may generate IDs for omitted views. */
    prepareSnapshot(values: Record<string, unknown>, replaceMissing: boolean): Record<string, unknown>;
    /** Applies coordinated owner values and returns the keys already consumed before generic codecs run. */
    applySnapshot(values: Record<string, unknown>): ReadonlySet<string>;
    /** Validates an incoming query before navigation or resetting omitted values. */
    prepareUrl(params: Params, resetMissing: boolean): Params;
    /** Aligns legacy stored arrays with the identities selected by storage, config and URL. */
    prepareStoredViews(values: Map<string, string>, params: Params, configKeys: ReadonlySet<string>): void;
}

/**
 * Persistence and publication coordinator for the domain-owned AppStates.
 *
 * A domain's .state.ts container declares values and codecs. This registry gives
 * those values three shared mechanisms: synchronous edits with rollback, a single
 * completed-state notification, and deferred writes to storage/the browser URL.
 * It neither performs domain workflows nor discovers actions from storage keys.
 *
 * Startup precedence is declared defaults, deployment defaults, user storage,
 * then the incoming URL. Ownership metadata distinguishes a saved deployment
 * default from an intentional user override, so changing a server configuration
 * does not unexpectedly replace the user's preferences.
 *
 * Read a single slot through its ordinary AppState subscription. Read related
 * slots through observe(), which samples their current values after the complete
 * transaction, including synchronous derived edits. Persistence follows in a
 * microtask; URL writes are additionally throttled to respect browser limits.
 */
@Injectable({ providedIn: 'root' })
export class AppStateService implements OnDestroy {

    private transactionDepth = 0;
    /** Slot notifications may stage derived values; drain them before the commit. */
    private publishing = false;
    /** Commit observers must all see the same values; their writes form the next edit. */
    private announcingCommit = false;
    /** New observers inside an edit wait for its completed or rolled-back values. */
    private readonly pendingInitialObservers = new Set<() => void>();
    private readonly deferredWrites: Array<() => void> = [];
    private readonly pendingPublications = new Map<AppState<unknown>, { publish: () => void; origin: MutationOrigin }>();
    private readonly publishedOrigins = new Map<AppState<unknown>, MutationOrigin>();
    private readonly projectionSources = new Map<AppState<unknown>, AppState<unknown>>();
    private readonly commits = new Subject<void>();
    /** Each nesting level records only the original values it actually touches. */
    private readonly rollbackFrames: Array<Map<AppState<unknown>, unknown>> = [];
    private urlProjection?: AppUrlProjection;
    private registrationSealed = false;
    /** Snapshot owners reconcile dependent values inside the enclosing import transaction. */
    readonly snapshotReplaced = new Subject<void>();

    /** Read-only inventory for persistence consumers; registration remains startup-only. */
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

    /** Finds the domain-owned adapter for the deployed multi-key style-option format. */
    private get styleStorage(): StyleState {
        const state = [...this.statePool.values()].find(value => value instanceof StyleState);
        if (!state) throw new Error("Style storage must be registered before persistence starts.");
        return state as StyleState;
    }

    /**
     * Publishes several slot writes as one completed application edit.
     *
     * next() stages values immediately, so getValue()/value inside the callback
     * see previous writes from this edit. Notifications wait for the outermost
     * callback to finish. A thrown exception restores the touched values and
     * pending notifications; a net no-op retains the original object identities.
     * Nested edits have their own rollback frames and join the outer publication.
     *
     * Use this for operations such as setting marker position and visibility
     * together. The callback is synchronous: finish asynchronous loading first.
     * Observers spanning slots must use observe(), since combineLatest retains
     * the last notification from each input, even while their staged values are
     * already current. Writes requested by a commit observer wait for its peers.
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

    /**
     * Observes a coherent selection of current values after each completed edit.
     *
     * Unlike combineLatest([enabled, position]), this does not assemble a result
     * from independently cached slot notifications. It re-runs read() once the
     * transaction and its synchronous derived writes have finished. A subscriber
     * normally gets an initial value immediately; subscribing during an edit
     * delays that first read until the edit finishes or rolls back.
     *
     * Every commit re-evaluates read(); there is no automatic dependency tracking.
     * Keep it synchronous, cheap and free of effects. Object.is suppresses equal
     * scalar/reference results; pass deepEquals when returning fresh records.
     * Unsubscribing removes both the commit listener and any pending initial read.
     *
     * @example
     * persistence.observe(() => ({
     *     enabled: coordinates.markerState.value,
     *     position: coordinates.markedPositionState.value
     * }), deepEquals).subscribe(marker => updateMarkerOverlay(marker));
     */
    observe<T>(read: () => T, equal: (a: T, b: T) => boolean = Object.is): Observable<T> {
        return new Observable<T>(subscriber => {
            const emit = () => {
                if (subscriber.closed) return;
                try {
                    subscriber.next(read());
                } catch (error) {
                    subscriber.error(error);
                }
            };
            // Subscribe before the initial read so a synchronous downstream
            // effect cannot create a commit which this observation misses.
            const subscription = this.commits.subscribe(emit);
            if (this.transactionDepth || this.publishing) {
                this.pendingInitialObservers.add(emit);
            } else {
                emit();
            }
            return () => {
                this.pendingInitialObservers.delete(emit);
                subscription.unsubscribe();
            };
        }).pipe(distinctUntilChanged(equal));
    }

    /**
     * Completes publication in three phases: notify changed slots, announce one
     * coherent commit, then run edits requested by commit observers.
     *
     * A slot observer may normalize another slot or update a legacy projection.
     * Drain those notifications before sampling completed state. During the commit
     * itself, writes are queued so a subscriber cannot change values underneath
     * the remaining subscribers. The queued edits then form a new transaction.
     */
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
            this.commits.next();
        } finally {
            this.announcingCommit = false;
        }
        if (this.deferredWrites.length) {
            const writes = this.deferredWrites.splice(0);
            this.transaction(() => writes.forEach(write => write()));
        }
    }

    private readonly statePool = new Map<string, AppState<unknown>>();

    /** Becomes true once the initial config/storage/URL merge and migrations finish. */
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
    /**
     * Old snapshots/config defaults may contain values that are now runtime
     * metadata or server-owned catalogs. Ignore these keys without rejecting the
     * user's remaining preferences; never recreate writable states for them.
     */
    private readonly RETIRED_STATE_KEYS = new Set(["mapPresets", "distributionVersions", "erdblickVersion"]);
    private static readonly URL_SYNC_MIN_INTERVAL_MS = 50;
    private configDefaultStateMeta: ConfigDefaultStateMeta = {
        version: 1,
        sourceHash: "",
        entries: Object.create(null)
    };
    private configDefaultValueHashes = new Map<string, string>();
    private currentConfigDefaultKeys = new Set<string>();

    /**
     * Wires initial hydration and browser back/forward navigation.
     *
     * Domain containers must register before the first NavigationEnd. Subsequent
     * router writes from this service do not hydrate again; only popstate restores
     * the address bar into live values. Cancel stale writes before that restore so
     * a queued edit cannot overwrite the history entry the user just selected.
     */
    constructor(private readonly router: Router,
        private readonly messages: MessageService) {
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

    /**
     * Performs the one-time startup merge after deployment defaults are seeded.
     *
     * Storage restores user overrides, then URL codecs apply incoming values and
     * the domain coordinator runs migrations. A malformed URL is reported without
     * discarding valid saved preferences. Storage is reconciled afterwards, but
     * the first URL write is suppressed to preserve the incoming link verbatim.
     */
    initializePersistence(): void {
        if (this.isReady) {
            return;
        }
        if (!this.registrationSealed) {
            throw new Error("State owners must be registered before persistence starts.");
        }
        this.setupStateSubscriptions();
        const queryParams = this.currentBrowserQueryParams();
        try {
            this.hydrateFromStorage(queryParams);
        } catch (error) {
            this.reportHydrationError("saved state", error);
            this.hydrateFromStorage({});
        }
        let acceptedQueryParams = queryParams;
        try {
            this.hydrateFromUrl(queryParams);
        } catch (error) {
            this.reportHydrationError("share link", error);
            acceptedQueryParams = {};
        }
        this.urlProjection?.initialize(acceptedQueryParams);
        this.isHydrating = false;
        // Keep inbound links stable during passive startup hydration.
        this.skipNextUrlSync = true;

        // Persist the merged values; skipNextUrlSync preserves the incoming URL.
        this.syncAllStates();

        this.isReady = true;
        this.ready.next(true);
    }

    /**
     * Restores a supplied link without reloading the document or adding history.
     *
     * Validate view identities before changing the address or values. With
     * resetMissing, presentation-controlled slots omitted by the link return to
     * defaults; ordinary link application retains omitted preferences. The domain
     * coordinator establishes view membership before applying positional codecs.
     */
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

    /** Queues all slots for deferred persistence without acquiring user ownership. */
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

    /** Consumes the next navigation's history policy, restoring replace mode afterwards. */
    get replaceUrl() {
        const currentValue = this._replaceUrl;
        this._replaceUrl = true;
        return currentValue;
    }

    /**
     * Registers a domain's value, validation and persistence codecs at startup.
     * The returned AppState remains the directly observable/writable value; this
     * service attaches staging and publication rather than storing a second copy.
     */
    registerState<T>(options: AppStateOptions<T>): AppState<T> {
        if (this.registrationSealed) throw new Error(`State registration is closed: ${options.name}`);
        const state = new AppState<T>(this.statePool, options);
        this.registerPublication(state);
        return state;
    }

    /**
     * Keeps a deployed key as a projection of an authoritative value.
     * For example, numberOfViews reads ordered view IDs instead of holding a
     * second count. Persistence inherits the source edit's ownership, so restoring
     * or normalizing IDs cannot accidentally claim a user override on the alias.
     */
    registerProjection<T>(options: AppStateOptions<T>, source: AppStateProjection<T>): AppState<T> {
        if (this.registrationSealed) throw new Error(`State registration is closed: ${options.name}`);
        const state = new AppState<T>(this.statePool, options, source);
        this.projectionSources.set(state as AppState<unknown>, source.sourceState);
        return state;
    }

    /** Captures the current write scope before publication can outlive that scope. */
    private mutationOrigin(): MutationOrigin {
        return this.isHydrating ? "hydration" : this.isSeedingConfigDefaults ? "config"
            : this.isSystemStateMutation ? "system" : "user";
    }

    /**
     * Restores a staged write's origin while notifying its observers.
     * Derived writes then inherit that origin even if the original hydration or
     * system scope has already returned. Nested scopes restore their caller's flags.
     */
    private withMutationOrigin(origin: MutationOrigin, action: () => void): void {
        const previous = [this.isHydrating, this.isSeedingConfigDefaults, this.isSystemStateMutation];
        this.isHydrating = origin === "hydration";
        this.isSeedingConfigDefaults = origin === "config";
        this.isSystemStateMutation = origin === "system";
        try {
            action();
        } finally {
            [this.isHydrating, this.isSeedingConfigDefaults, this.isSystemStateMutation] = previous;
        }
    }

    /**
     * Installs the write hook used by AppState.next().
     *
     * Save each touched slot once per rollback frame, detach the caller's mutable
     * input, and queue one notification for its latest value. An isolated write
     * publishes immediately. During a completed-state notification, copy and defer
     * the write so the remaining observers still sample the same completed edit.
     */
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
    private serializeUrlV2(): Record<string, string | string[]> {
        return this.urlProjection?.serialize(this.preservedUnknownUrlParams()) ?? {};
    }

    /** Creates a state entry scoped to each map view. */
    registerPerViewState<T>(options: AppStateOptions<T>, viewIds: () => readonly string[]): PerViewState<T> {
        if (this.registrationSealed) throw new Error(`State registration is closed: ${options.name}`);
        const state = new PerViewState<T>(this.statePool, options, viewIds);
        this.registerPublication(state.appState);

        return state;
    }

    /** Subscribes to all persisted state slots so storage and URL remain in sync. */
    private setupStateSubscriptions() {
        if (this.subscriptionsSetup) return;
        // Registration is sealed, so this subscription set is complete. Skip
        // BehaviorSubject's initial values: hydration performs one explicit sync
        // after config, local storage and URL precedence have been resolved.
        for (const state of this.statePool.values()) {
            const subscription = (state as AppState<unknown>).pipe(skip(1)).subscribe(() => {
                const source = this.projectionSources.get(state as AppState<unknown>);
                const origin = source ? this.publishedOrigins.get(source) : undefined;
                if (origin) this.withMutationOrigin(origin, () => this.onStateChanged(state as AppState<unknown>));
                else this.onStateChanged(state as AppState<unknown>);
            });
            this.stateSubscriptions.push(subscription);
        }
        this.subscriptionsSetup = true;
    }

    /**
     * Marks a published slot for storage and, when eligible, URL synchronization.
     *
     * User edits acquire ownership when persisted. Hydration, config seeding and
     * system cleanup must not turn deployment defaults into user overrides. Force
     * queues a reconciliation even before readiness without changing ownership.
     */
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

    /**
     * Coalesces synchronous edits into one microtask that persists their final values.
     * Slot/commit observers have already run by this point. Storage writes happen
     * first; URL navigation may wait longer for the browser history rate limit.
     */
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

    /**
     * Writes only queued slots and updates deployment-default ownership hashes.
     *
     * StyleState expands into compact per-option keys, so remove its previous keys
     * before writing the complete new set. A value equal to the current deployment
     * default returns to config ownership; an intentional differing edit belongs
     * to the user. System edits update hashes without taking ownership.
     */
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

    /**
     * Throttles history writes to at most one per 50 ms without delaying state itself.
     * Repeated edits share the pending timer, whose callback reads the latest values.
     * This is throttling, not a debounce that keeps moving the deadline.
     */
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

    /** Applies a queued URL write unless hydration or the startup preservation guard owns it. */
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

    /**
     * Rebuilds managed query parameters after a live state edit and preserves others.
     * This is normal address-bar synchronization. Copying a share link reads the
     * existing browser URL directly and never invokes these codecs a second time.
     */
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

    /**
     * Restores saved overrides after config defaults have been seeded.
     *
     * Config-owned saved values yield to the new defaults; retired defaults reset
     * instead of becoming user preferences. Unknown legacy ownership is preserved.
     * Prepare view identities before positional arrays, then restore ordinary
     * slots and compact style options. Individual malformed entries are skipped.
     */
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
            // PerViewState and any identity-bearing owner values use the same prepared IDs.
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
        // Persistence only publishes a toast. Depending on the modal-dialog
        // service here would make every state container import dialog and map controllers.
        this.messages.add({
            key: "tc",
            severity: "error",
            summary: "Error",
            detail: `Could not restore ${source}: ${error instanceof Error ? error.message : String(error)}`
        });
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

    /**
     * Applies an inbound restore as one transaction with hydration ownership.
     * Values and observers still update, but incoming data does not immediately
     * write itself back over the URL/storage source. Startup requests its explicit
     * reconciliation after all sources have been merged.
     */
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

    /**
     * Exports snapshot-eligible values through their deployed compatibility codecs.
     * Local-only preferences stay out; style options retain their compact keys.
     * This is a detached state document, separate from the browser's share URL.
     */
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

    /**
     * Applies validated deployment defaults before local storage and URL overrides.
     *
     * Track the hash of each explicitly configured key. Future startups can then
     * refresh defaults while preserving deliberate user choices and legacy values
     * without ownership metadata. Identity preparation may supply dependent values,
     * but those implicit values must not acquire configuration ownership.
     * Returns validation errors without applying an invalid configuration.
     */
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

    /**
     * Merges a user-imported snapshot as one ordinary edit, retaining omitted slots.
     * Validate before mutation and return actionable errors. The transaction rolls
     * back slot values if an owner rejects the import; successful edits acquire
     * user ownership through the normal deferred persistence path.
     */
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

    /**
     * Coordinates identity-bearing values before applying remaining slot codecs.
     * The coordinator reports consumed keys to avoid applying them twice. Full
     * presentation replacement resets omitted eligible slots and style options;
     * a user import keeps them. Notify dependent owners inside the same transaction.
     */
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

    /**
     * Validates a detached snapshot without writing any live value.
     * Bound size/depth, reject unsafe object keys, discard retired or ineligible
     * entries, validate coordinated view identities, then run each slot's schema.
     * Compact style-option keys are the one supported family outside the registry.
     */
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

    /**
     * Reads only recognized ownership records from local storage.
     * Missing or corrupt metadata falls back to no ownership claims, preserving
     * existing user/legacy values when new deployment defaults are applied.
     */
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

    /**
     * Batches automatic maintenance without claiming a user override.
     * Use for catalog pruning or normalization, not deliberate preference edits.
     * Notifications retain system origin even if an outer transaction delays them.
     */
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

    /**
     * Copies plain snapshot data into bounded, prototype-free records.
     * Paths identify the offending value in validation messages. This structural
     * pass rejects unsafe shapes before domain schemas examine individual values.
     */
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
    }

    /**
     * Clears registered preferences and ownership metadata, then reloads a clean URL.
     * The next startup reapplies deployment defaults and reconstructs runtime
     * resources. Unrelated application storage is left to its own owners.
     */
    resetStorage() {
        for (const state of this.statePool.values()) {
            state.resetToDefault();
            localStorage.removeItem(state.name);
        }
        this.clearStyleOptionStorageEntries();
        localStorage.removeItem(this.STYLE_OPTIONS_STORAGE_KEY);
        localStorage.removeItem(this.CONFIG_DEFAULT_STATE_META_KEY);
        const { origin, pathname } = window.location;
        window.location.href = origin + pathname;
    }
}
