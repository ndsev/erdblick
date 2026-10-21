import type {MapViewStateServiceValues} from "../mapview/map-view-state.service";
import type {MapLayerStateServiceValues} from "../mapdata/map-layer-state.service";
import type {InspectionStateServiceValues} from "../inspection/inspection-state.service";
import type {AppLayoutServiceValues} from "./app-layout.service";
import type {StyleServiceValues} from "../styledata/style.service";
import type {FeatureSearchServiceValues} from "../search/feature.search.service";
import type {MapTileStreamServiceValues} from "../mapdata/map-tile-stream.service";
import type {CoordinatesServiceValues} from "../coords/coordinates.service";
import type {CoordinatesPolicyServiceValues} from "../coords/coordinates-policy.service";
import type {LocationSearchServiceValues} from "../search/location.search.service";
import type {StyleEditorRequestServiceValues} from "../styledata/style-editor-request.service";
import type {AppConfigServiceValues} from "./app-config.service";
import type {ViewIdentity} from "../mapview/view-id";
import {withEntities} from "@ngrx/signals/entities";
import {computed, Injector, Signal} from "@angular/core";
import {getState, patchState, signalStore, StateSource, type, watchState, withState} from "@ngrx/signals";
import {Observable, Subject} from "rxjs";
import {withDiagnosticsState} from "../diagnostics/diagnostics.facade.service.state";
import {deepCopy, deepEquals} from "./state-value";

/**
 * The one durable value store. Domain features supply named state members;
 * services own operations and resource lifetimes. `legacy` is removed as the
 * remaining owners migrate in the following checkpoints.
 */
export const ViewerStore = signalStore(
    {protectedState: false},
    withState({
        legacy: {} as Record<string, unknown>,
        views: {} as MapViewStateServiceValues,
        layers: {} as MapLayerStateServiceValues,
        inspection: {} as InspectionStateServiceValues,
        layout: {} as AppLayoutServiceValues,
        styles: {} as StyleServiceValues,
        searches: {} as FeatureSearchServiceValues,
        connection: {} as MapTileStreamServiceValues,
        coordinates: {} as CoordinatesServiceValues,
        coordinatePolicy: {} as CoordinatesPolicyServiceValues,
        location: {} as LocationSearchServiceValues,
        styleEditor: {} as StyleEditorRequestServiceValues,
        config: {} as AppConfigServiceValues
    }),
    withDiagnosticsState(),
    withEntities({entity: type<ViewIdentity>(), collection: "view"})
);
export type ViewerValues = InstanceType<typeof ViewerStore> extends StateSource<infer Values> ? Values : never;

/** A codec binding reads the store and prepares writes; it never caches a value. */
export interface StateBinding<T> {
    readonly signal: Signal<T>;
    readonly commits: Observable<void>;
    read(): T;
    write(value: T): void;
}

/**
 * Gives synchronous RxJS consumers one notification after a coherent store patch.
 * NgRx's watchState is installed once, rather than once per slot or subscriber.
 * The temporary draft exists only inside a transaction and is discarded on failure.
 */
export class ViewerState {
    readonly store = new ViewerStore();
    private readonly injector = Injector.create({providers: []});
    private readonly committed = new Subject<void>();
    /** Read a prepared root only while coordinating a transaction; native readers stay narrow. */
    read<T>(fromDraft: (state: ViewerValues) => T, current: () => T): T {
        return this.draft ? fromDraft(this.draft) : current();
    }

    private readonly preparations = new Set<() => void>();
    beforeCommit(prepare: () => void): () => void {
        this.preparations.add(prepare);
        return () => this.preparations.delete(prepare);
    }

    private draft: ViewerValues | undefined;
    private originalBindings: Map<object, unknown> | undefined;
    private publishing = false;
    private pendingPatch: Partial<ViewerValues> | undefined;
    private readonly watcher = watchState(this.store, () => {
        this.publishing = true;
        try { this.committed.next(); }
        finally { this.publishing = false; }
        if (this.pendingPatch) {
            const patch = this.pendingPatch;
            this.pendingPatch = undefined;
            patchState(this.store, patch);
        }
    }, {injector: this.injector});

    /** Nested domain preparation joins the transaction; an exception rolls back its writes. */
    transaction<T>(operation: () => T): T {
        const parent = this.draft;
        const parentBindings = this.originalBindings;
        this.originalBindings = new Map(parentBindings);
        const initial = parent ?? {...getState(this.store), ...this.pendingPatch};
        this.draft = initial;
        try {
            const result = operation();
            if (!parent) for (const prepare of this.preparations) prepare();
            const next = this.draft;
            if (!parent) {
                this.draft = undefined;
                this.originalBindings = undefined;
                const patch = Object.fromEntries(Object.entries(next).filter(([key, value]) => {
                    const previous = initial[key as keyof ViewerValues];
                    if (value === previous) return false;
                    // A reverted binding reuses its original value. Check only the small
                    // touched owner slice's field identities, never its layer/style contents.
                    if (Object.getPrototypeOf(value) === Object.prototype && Object.getPrototypeOf(previous) === Object.prototype) {
                        const fields = Object.keys(value);
                        const before = previous as Record<string, unknown>;
                        const after = value as Record<string, unknown>;
                        if (fields.length === Object.keys(before).length && fields.every(field => after[field] === before[field])) return false;
                    }
                    return true;
                })) as Partial<ViewerValues>;
                if (Object.keys(patch).length) {
                    if (this.publishing) this.pendingPatch = {...this.pendingPatch, ...patch};
                    else patchState(this.store, patch);
                }
            }
            return result;
        } catch (error) {
            this.draft = parent;
            this.originalBindings = parentBindings;
            throw error;
        }
    }

    bind<T>(read: (state: ViewerValues) => T, update: (state: ViewerValues, value: T) => Partial<ViewerValues>,
        select: () => T = () => read(getState(this.store))): StateBinding<T> {
        const key = {};
        return {
            signal: computed(select),
            commits: this.committed,
            read: () => this.draft ? read(this.draft) : select(),
            write: value => {
                const apply = () => {
                    const state = this.draft!;
                    const previous = read(state);
                    if (deepEquals(previous, value)) return;
                    const originals = this.originalBindings!;
                    if (!originals.has(key)) originals.set(key, previous);
                    else if (deepEquals(originals.get(key), value)) value = originals.get(key) as T;
                    this.draft = {...state, ...update(state, value)};
                };
                if (this.draft) apply();
                else this.transaction(apply);
            }
        };
    }

    /** Legacy slots already use SignalStore while their owner modules migrate. */
    bindLegacy<T>(name: string, initial: T): StateBinding<T> {
        const binding = this.bind<T>(state => state.legacy[name] as T,
            (state, value) => ({legacy: {...state.legacy, [name]: value}}),
            () => this.store.legacy()[name] as T);
        binding.write(initial);
        return binding;
    }

    destroy(): void {
        this.watcher.destroy();
        this.committed.complete();
        this.injector.destroy();
    }
}

// Plain codec tests also share one SignalStore for all slots in their pool.
const poolStores = new WeakMap<object, ViewerState>();
export function stateStore(pool: object): ViewerState {
    let state = poolStores.get(pool);
    if (!state) {
        state = new ViewerState();
        poolStores.set(pool, state);
    }
    return state;
}
export function stateBinding<T>(pool: object, name: string, initial: T): StateBinding<T> {
    return stateStore(pool).bindLegacy(name, initial);
}
