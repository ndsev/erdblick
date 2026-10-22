import {Injectable, OnDestroy} from "@angular/core";
import {NavigationEnd, NavigationStart, Params, Router} from "@angular/router";
import {getState} from "@ngrx/signals";
import {BehaviorSubject, Subject, Subscription, take} from "rxjs";
import {filter} from "rxjs/operators";
import {coreLib} from "../integrations/wasm";
import {prepareLegacyOsmState} from "../mapdata/map-layer.store-feature";
import {normalizeSearchLayouts} from "../search/feature-search.store-feature";
import {normalizeInspections} from "../inspection/inspection.store-feature";
import {
    normalizeViewSnapshot,
    normalizeViewUrl,
    prepareViewMembership
} from "../mapview/map-view.store-feature";
import {AppUrlStateService} from "./app-url-state.service";
import {AppStore, AppStoreValues} from "./app.store";
import {
    ConfigDefaultStateMeta,
    ConfigDefaultStateMetaEntry,
    SnapshotImportLimits,
    SnapshotNormalizationResult,
    hashStateValue
} from "./app-state-persistence.model";
import {INSPECTION_DOCK_TAB_ID} from "./app-layout.model";
import {InfoMessageService} from "./info.service";
import {
    observeStore,
    persistenceDescriptors,
    PersistenceDescriptor,
    stateWriteOrigin
} from "./persisted-state";
import {StyleOptionsCodec} from "./state-codec";

/**
 * Browser integration for the one injected AppStore. Features supply codecs as
 * metadata, so adding a persisted field needs no owner-construction registration.
 * Every import calculates a complete next value before calling the store once;
 * normal feature operations never call back into this persistence service.
 */
@Injectable({providedIn: "root"})
export class AppStateService implements OnDestroy {
    private readonly statePool: Map<string, PersistenceDescriptor>;
    private readonly styleCodec = new StyleOptionsCodec();
    // These announce integration lifecycle events, not copies of persisted state.
    // Render/search resources use readiness to start after config, storage and URL
    // hydration have all been folded into the native store.
    readonly ready = new BehaviorSubject(false);
    readonly stateApplied = new Subject<void>();
    readonly importedSnapshot = new Subject<void>();
    readonly importedStartupUrl = new Subject<Params>();
    private readonly subscriptions: Subscription[] = [];
    private _replaceUrl = true;
    private isReady = false;
    private pendingPopstateHydration = false;
    private readonly pendingUrlSyncStates = new Set<PersistenceDescriptor>();
    private readonly pendingStorageSyncStates = new Set<PersistenceDescriptor>();
    private readonly pendingUserOwnershipStates = new Set<string>();
    private flushHandle: Promise<void> | null = null;
    private urlSyncHandle: ReturnType<typeof setTimeout> | null = null;
    private lastUrlSyncAt = 0;
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
    private readonly configDefaultValueHashes = new Map<string, string>();
    private readonly currentConfigDefaultKeys = new Set<string>();

    constructor(
        private readonly router: Router,
        private readonly infoMessageService: InfoMessageService,
        readonly store: AppStore,
        private readonly urlState: AppUrlStateService
    ) {
        const fields = persistenceDescriptors(store);
        // Released camera/layer codecs use positional arrays. Resolve the ordered
        // identity list and count first; only then can their values be keyed by ID.
        const priority = (name: string) =>
            name === "viewIds" ? 0 : name === "numberOfViews" ? 1 : name === "focus" ? 2 : 3;
        fields.sort((left, right) => priority(left.name) - priority(right.name));
        this.statePool = new Map(fields.map((field) => [field.name, field]));
        if (fields.length !== this.statePool.size) {
            throw new Error("Duplicate persisted state declaration");
        }
        this.retireMapPresetDefinitionStorage();
        // Native watchState runs synchronously during patchState. Capture write
        // provenance here, while the originating operation is still on the stack;
        // actual browser I/O is coalesced into the microtask below.
        let previous = getState(store);
        this.subscriptions.push(
            observeStore(store, (state) => state).subscribe((current) => {
                if (
                    current.views.pushUrlRevision > previous.views.pushUrlRevision ||
                    current.inspection.pushUrlRevision > previous.inspection.pushUrlRevision
                ) {
                    this.pushNextUrl();
                }
                for (const field of fields) {
                    if (field.hasChanged(previous, current)) {
                        this.onStateChanged(field);
                    }
                }
                previous = current;
            })
        );
        this.subscriptions.push(
            router.events
                .pipe(
                    filter((event) => event instanceof NavigationEnd),
                    take(1)
                )
                .subscribe(() => this.initializePersistence())
        );
        this.subscriptions.push(
            router.events.subscribe((event) => {
                if (event instanceof NavigationStart) {
                    this.pendingPopstateHydration = router.getCurrentNavigation()?.trigger === "popstate";
                    if (this.pendingPopstateHydration) {
                        this.cancelPendingStateSync();
                    }
                } else if (event instanceof NavigationEnd && this.pendingPopstateHydration) {
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
            })
        );
    }

    /** Persisted field names discovered from the composed feature graph. */
    get persistedStateNames(): readonly string[] {
        return [...this.statePool.keys()];
    }

    /** A plain native snapshot for codecs; consumers read AppStore signals directly. */
    get currentValues(): AppStoreValues {
        return getState(this.store);
    }

    get stylesPersistence(): PersistenceDescriptor {
        return this.statePool.get("styleOptions")!;
    }

    descriptor(name: string): PersistenceDescriptor {
        const field = this.statePool.get(name);
        if (!field) {
            throw new Error(`Unknown persisted state '${name}'`);
        }
        return field;
    }

    /** Feature selection and marker jumps create history entries; continuous camera motion replaces them. */
    pushNextUrl(): void {
        this._replaceUrl = false;
    }
    get replaceUrl(): boolean {
        const value = this._replaceUrl;
        this._replaceUrl = true;
        return value;
    }

    /**
     * Restore the initial browser state after config and WASM startup. Config has
     * already seeded defaults. Saved user values override those defaults, and URL
     * fields override the resulting saved state. Only the final candidate is
     * published, so a renderer cannot observe a saved camera with URL layer data.
     */
    initializePersistence(): void {
        if (this.isReady || !coreLib) {
            return;
        }
        this.store.initializeViews();
        const params = this.currentBrowserQueryParams();
        let next = this.prepareStorage(this.currentValues);
        let accepted: Params = {};
        try {
            next = this.prepareUrlState(next, params);
            accepted = params;
        } catch (error) {
            this.infoMessageService.showError(`Could not import view link: ${String(error)}`);
        }
        next = prepareLegacyOsmState(next, accepted, localStorage);
        this.store.restorePersistedState(next, "hydration");
        this.importedStartupUrl.next(accepted);
        this.skipNextUrlSync = true;
        this.syncAllStates();
        this.isReady = true;
        this.ready.next(true);
    }

    /** Prepare URL state without mutating the current value or notifying runtime consumers. */
    private prepareUrlState(
        current: AppStoreValues,
        params: Params,
        resetMissing = false,
        revealDockedInspection = false
    ): AppStoreValues {
        const prepared = normalizeViewUrl(params, current.viewIds, resetMissing);
        let next = current;
        if (resetMissing) {
            next = this.prepareSnapshotValues(next, normalizeViewSnapshot({}, next.viewIds, true), true);
        }
        if (!Object.keys(prepared).length) {
            return next;
        }
        // Membership is resolved before positional camera/layer/style codecs consume the query.
        const ids =
            prepared["vid"] === undefined ? next.viewIds.map(String) : String(prepared["vid"]).split(",");
        next = prepareViewMembership(next, ids, [...this.statePool.values()], undefined, true);
        next = normalizeInspections(
            normalizeSearchLayouts(this.urlState.prepare(next, prepared)),
            current.inspection.selection
        );
        // Query-authored presentation scenes encode each panel's docking mode,
        // but have no separate field for the visible dock. Resolve that intent
        // in the import candidate so selection and dock appear together.
        if (
            revealDockedInspection &&
            next.inspection.selection.some((panel) => !panel.undocked && panel.features.length > 0)
        ) {
            next = {...next, layout: {...next.layout, dockActiveTab: INSPECTION_DOCK_TAB_ID, dockOpen: true}};
        }
        return next;
    }

    /** Validate before navigation, then apply against the latest state after the router settles. */
    async replaceUrlState(
        params: Params,
        resetMissing = false,
        options: {revealDockedInspection?: boolean} = {}
    ): Promise<void> {
        if (!this.isReady) {
            throw new Error("URL state cannot be replaced before AppStateService is ready.");
        }
        this.prepareUrlState(this.currentValues, params, resetMissing, options.revealDockedInspection);
        this.cancelPendingStateSync();
        await this.router.navigate([], {
            queryParams: params,
            queryParamsHandling: "replace",
            replaceUrl: true
        });
        const next = this.prepareUrlState(
            this.currentValues,
            params,
            resetMissing,
            options.revealDockedInspection
        );
        this.store.restorePersistedState(next, "hydration");
        this.stateApplied.next();
    }

    private applyHydratedUrlState(params: Params): void {
        const next = this.prepareUrlState(this.currentValues, params);
        this.cancelPendingStateSync();
        this.store.restorePersistedState(next, "hydration");
        this.stateApplied.next();
    }

    /** Replace a presentation scene, resetting omitted snapshot fields in the same publication. */
    replaceSnapshotState(snapshot: unknown): string[] {
        if (!this.isReady) {
            throw new Error("Snapshot state cannot be replaced before AppStateService is ready.");
        }
        const result = this.normalizeSnapshot(snapshot, false, true);
        if (result.errors.length) {
            return result.errors;
        }
        const next = this.prepareSnapshotValues(this.currentValues, result.normalized!, true);
        this.cancelPendingStateSync();
        this.store.restorePersistedState(next, "hydration");
        this.importedSnapshot.next();
        this.stateApplied.next();
        return [];
    }

    /** Apply a user-imported partial snapshot; fields omitted by the file keep their current values. */
    importSnapshot(snapshot: unknown): string[] {
        const result = this.normalizeSnapshot(snapshot);
        if (result.errors.length) {
            return result.errors;
        }
        const next = this.prepareSnapshotValues(this.currentValues, result.normalized!, false);
        this.store.restorePersistedState(next, "user");
        this.importedSnapshot.next();
        return [];
    }

    /** Export the deployed formats, projecting ID-keyed state into each codec's positional view order. */
    exportSnapshot(): Record<string, unknown> {
        const current = this.currentValues;
        const snapshot: Record<string, unknown> = Object.create(null);
        for (const field of this.statePool.values()) {
            if (field.codec.isSnapshotState()) {
                snapshot[field.name] = field.snapshot(current);
            }
        }
        return Object.assign(snapshot, this.stylesPersistence.serialize(current, false));
    }

    validateSnapshot(snapshot: unknown): string[] {
        return this.normalizeSnapshot(snapshot).errors;
    }

    /** Decode all ordinary fields against a locally prepared membership before publishing anything. */
    private prepareSnapshotValues(
        current: AppStoreValues,
        snapshot: Record<string, unknown>,
        replaceMissing: boolean,
        configOnly = false
    ): AppStoreValues {
        let next = current;
        if (snapshot["viewIds"] !== undefined) {
            next = prepareViewMembership(
                next,
                snapshot["viewIds"] as string[],
                [...this.statePool.values()],
                undefined,
                true
            );
        }
        for (const field of this.statePool.values()) {
            if (field.name === "viewIds" || field.name === "numberOfViews") {
                continue;
            }
            if (!(configOnly ? field.codec.isConfigDefaultState() : field.codec.isSnapshotState())) {
                continue;
            }
            if (Object.prototype.hasOwnProperty.call(snapshot, field.name)) {
                next = field.importSnapshot(next, snapshot[field.name]);
            } else if (replaceMissing) {
                next = field.reset(next);
            }
        }
        if (replaceMissing) {
            next = this.stylesPersistence.reset(next);
            next = {...next, layout: {...next.layout, pendingOpenDialogs: []}};
        }
        const styles = this.extractStyleOptionSnapshotEntries(snapshot);
        if (Object.keys(styles).length) {
            next = this.stylesPersistence.deserialize(next, styles);
        }
        // An explicitly saved dock preference is authoritative, including an
        // intentionally empty open dock. A partial selection-only import can
        // still collapse the dock when it removes its final existing panel.
        const previousSelection = Object.prototype.hasOwnProperty.call(snapshot, "dockOpenState")
            ? undefined
            : current.inspection.selection;
        return normalizeInspections(normalizeSearchLayouts(next), previousSelection);
    }

    /**
     * Seed server-provided defaults before browser hydration. Ownership is tracked
     * per released storage key: later server changes may replace an old configured
     * default, while a value explicitly changed by the user remains theirs.
     */
    seedConfigDefaultState(snapshot: unknown, sourceHash: string): string[] {
        this.store.initializeViews();
        this.configDefaultStateMeta = this.loadConfigDefaultStateMeta();
        this.configDefaultStateMeta.sourceHash = sourceHash || "";
        this.configDefaultValueHashes.clear();
        this.currentConfigDefaultKeys.clear();
        if (
            snapshot === null ||
            snapshot === undefined ||
            (typeof snapshot === "object" && !Array.isArray(snapshot) && !Object.keys(snapshot).length)
        ) {
            this.persistConfigDefaultStateMeta();
            return [];
        }
        const result = this.normalizeSnapshot(snapshot, true);
        if (result.errors.length) {
            result.errors.forEach((error) =>
                console.warn(`[AppStateService] Ignoring invalid config state: ${error}`)
            );
            return result.errors;
        }
        const normalized = result.normalized!;
        const next = this.prepareSnapshotValues(this.currentValues, normalized, false, true);
        this.store.restorePersistedState(next, "config");
        for (const [key, field] of this.statePool) {
            if (
                !field.codec.isConfigDefaultState() ||
                !Object.prototype.hasOwnProperty.call(normalized, key)
            ) {
                continue;
            }
            // Normalization derives identities for a count-only config. Those are
            // runtime defaults, not configured identities: saved IDs must survive
            // a restart even when the configured number of panes changes.
            if (key === "viewIds" && !Object.prototype.hasOwnProperty.call(snapshot, key)) {
                continue;
            }
            const hash = this.stateValueHashForMeta(field);
            this.currentConfigDefaultKeys.add(key);
            this.configDefaultValueHashes.set(key, hash);
            if (this.configDefaultMayOwnStorageKey(key)) {
                this.setMetaOwner(key, "config", hash);
            }
        }
        const styleEntries = this.extractStyleOptionSnapshotEntries(normalized);
        for (const [key, value] of Object.entries(this.stylesPersistence.serialize(next, false) ?? {})) {
            if (!this.styleCodec.isStyleOptionUrlParamKey(key) || !(key in styleEntries)) {
                continue;
            }
            const hash = hashStateValue(value);
            this.currentConfigDefaultKeys.add(key);
            this.configDefaultValueHashes.set(key, hash);
            if (this.configDefaultMayOwnStorageKey(key)) {
                this.setMetaOwner(key, "config", hash);
            }
        }
        this.persistConfigDefaultStateMeta();
        return [];
    }

    /**
     * Decode storage into a candidate. Config-owned entries follow the current
     * config (or reset when removed); user and legacy unowned entries use storage.
     * Style options keep their historical individual compact storage keys, so
     * the same ownership decision is made for each option rather than the Map.
     */
    private prepareStorage(current: AppStoreValues): AppStoreValues {
        this.configDefaultStateMeta = this.loadConfigDefaultStateMeta();
        const configured = new Map(
            [...this.currentConfigDefaultKeys].flatMap((name) => {
                const field = this.statePool.get(name);
                return field ? [[name, field.snapshot(current)] as const] : [];
            })
        );
        let next = current;
        for (const field of this.statePool.values()) {
            if (field === this.stylesPersistence) {
                continue;
            }
            const raw = localStorage.getItem(field.name);
            if (raw === null) {
                continue;
            }
            const entry = this.configDefaultStateMeta.entries[field.name];
            if (entry?.owner === "config") {
                if (this.currentConfigDefaultKeys.has(field.name)) {
                    next = field.importSnapshot(next, configured.get(field.name));
                } else {
                    next = field.reset(next);
                    localStorage.removeItem(field.name);
                    delete this.configDefaultStateMeta.entries[field.name];
                }
            } else {
                next = field.deserialize(next, raw);
            }
            if (field.name === "numberOfViews") {
                next = prepareViewMembership(
                    next,
                    next.viewIds.map(String),
                    [...this.statePool.values()],
                    undefined,
                    true,
                    current.viewIds
                );
            }
        }
        // An identity-only saved entry also needs native entity lifetimes and keyed defaults.
        if (!next.viewIds.length) {
            next = {...next, viewIds: current.viewIds};
        }
        next = prepareViewMembership(
            next,
            next.viewIds.map(String),
            [...this.statePool.values()],
            undefined,
            true,
            current.viewIds
        );
        const styles = this.collectStyleOptionStorageEntries();
        const filtered: Record<string, string> = Object.create(null);
        for (const [key, value] of Object.entries(styles)) {
            if (this.configDefaultStateMeta.entries[key]?.owner === "config") {
                if (!this.currentConfigDefaultKeys.has(key)) {
                    localStorage.removeItem(key);
                    delete this.configDefaultStateMeta.entries[key];
                }
            } else {
                filtered[key] = value;
            }
        }
        if (Object.keys(filtered).length) {
            next = this.stylesPersistence.deserialize(next, filtered);
        }
        this.persistConfigDefaultStateMeta();
        return normalizeInspections(normalizeSearchLayouts(next));
    }

    syncAllStates(): void {
        this.statePool.values().forEach((field) => this.onStateChanged(field, true));
    }

    /** Record persistence work without changing state or making runtime observers reenter the store. */
    private onStateChanged(field: PersistenceDescriptor, force = false): void {
        const origin = stateWriteOrigin(this.store, field.name);
        if (!force && this.isReady && origin === "user") {
            this.pendingUserOwnershipStates.add(field.name);
        }
        if (!force && (!this.isReady || origin === "hydration" || origin === "config")) {
            return;
        }
        this.pendingStorageSyncStates.add(field);
        if (field.codec.isUrlState()) {
            this.pendingUrlSyncStates.add(field);
        }
        this.scheduleFlush();
    }

    private stateValueHashForMeta(field: PersistenceDescriptor): string {
        return hashStateValue(field.snapshot(this.currentValues));
    }

    ngOnDestroy(): void {
        this.subscriptions.forEach((subscription) => subscription.unsubscribe());
        this.cancelPendingStateSync();
        this.ready.complete();
        this.stateApplied.complete();
        this.importedSnapshot.complete();
        this.importedStartupUrl.complete();
    }

    /** Schedules browser I/O after the complete semantic operation has been published. */
    private scheduleFlush(): void {
        if (this.flushHandle) {
            return;
        }
        this.flushHandle = Promise.resolve().then(() => {
            this.flushHandle = null;
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
                const serialized = state.serialize(this.currentValues, false);
                if (serialized === undefined) {
                    continue;
                }
                if (state === this.stylesPersistence) {
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

                if (state === this.stylesPersistence) {
                    const serializedStyleEntries =
                        this.stylesPersistence.serialize(this.currentValues, false) ?? {};
                    const serializedStyleKeys = new Set(
                        Object.keys(serializedStyleEntries).filter((key) =>
                            this.styleCodec.isStyleOptionUrlParamKey(key)
                        )
                    );
                    for (const key of Object.keys(this.configDefaultStateMeta.entries)) {
                        if (this.styleCodec.isStyleOptionUrlParamKey(key) && !serializedStyleKeys.has(key)) {
                            delete this.configDefaultStateMeta.entries[key];
                        }
                    }
                    for (const [key, value] of Object.entries(serializedStyleEntries)) {
                        if (!this.styleCodec.isStyleOptionUrlParamKey(key)) {
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
        const params = this.urlState.serializeUrlV2(true, this.currentBrowserQueryParams());
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
        if (typeof serialized !== "string") {
            return {errors: ["Snapshot payload must be a JSON object."]};
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
            const stateIsAllowed = forConfigDefault
                ? state.codec.isConfigDefaultState()
                : state.codec.isSnapshotState();
            if (!stateIsAllowed) {
                delete normalized[key];
            }
        }
        if (errors.length) {
            return {errors};
        }

        // Validate all present entries before import so rejection publishes no partial state.
        for (const key of Object.keys(normalized)) {
            const state = this.statePool.get(key);
            if (!state) {
                continue;
            }
            const stateIsAllowed = forConfigDefault
                ? state.codec.isConfigDefaultState()
                : state.codec.isSnapshotState();
            if (!stateIsAllowed) {
                continue;
            }
            try {
                state.codec.validateSnapshotValue(normalized[key], state.read(this.currentValues));
            } catch (error: any) {
                errors.push(`Invalid value for '${key}': ${error?.message ?? "schema validation failed"}`);
            }
        }
        if (errors.length) {
            return {errors};
        }
        try {
            const prepared = normalizeViewSnapshot(normalized, this.store.viewIds(), replaceMissing);
            this.prepareSnapshotValues(this.currentValues, prepared, replaceMissing, forConfigDefault);
            return {normalized: prepared, errors: []};
        } catch (error) {
            return {errors: [`Invalid snapshot: ${error instanceof Error ? error.message : String(error)}`]};
        }
    }

    /** Returns whether a snapshot key is a compact style-option storage key. */
    private validateStyleOptionSnapshotEntry(key: string, value: unknown, errors: string[]): boolean {
        if (!this.styleCodec.isStyleOptionUrlParamKey(key)) {
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
            if (this.styleCodec.isStyleOptionUrlParamKey(key) && typeof value === "string") {
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
            if (!key || !this.styleCodec.isStyleOptionUrlParamKey(key)) {
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
            if (key && this.styleCodec.isStyleOptionUrlParamKey(key)) {
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
                normalized[key] = this.normalizeSnapshotNode(
                    entry,
                    `${path}.${key}`,
                    depth + 1,
                    limits,
                    errors
                );
            }
            return normalized;
        }

        if (typeof value === "string" && value.length > limits.maxStringLength) {
            errors.push(`Snapshot string at '${path}' exceeds max length.`);
            return undefined;
        }
        return value;
    }

    /** Clear the deployed persisted keys, then restart without saved URL state. */
    resetStorage(): void {
        for (const field of this.statePool.values()) {
            localStorage.removeItem(field.name);
        }
        this.clearStyleOptionStorageEntries();
        localStorage.removeItem("searchHistory");
        localStorage.removeItem(this.STYLE_OPTIONS_STORAGE_KEY);
        localStorage.removeItem(this.CONFIG_DEFAULT_STATE_META_KEY);
        window.location.href = window.location.origin + window.location.pathname;
    }
}
