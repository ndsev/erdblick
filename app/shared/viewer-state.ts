import {computed, Injector, Signal} from "@angular/core";
import {getState, patchState, signalStore, StateSource, watchState, withState} from "@ngrx/signals";
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
    withState({legacy: {} as Record<string, unknown>}),
    withDiagnosticsState()
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
    private draft: ViewerValues | undefined;
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
        const initial = parent ?? {...getState(this.store), ...this.pendingPatch};
        this.draft = initial;
        try {
            const result = operation();
            const next = this.draft;
            if (!parent) {
                this.draft = undefined;
                const patch = Object.fromEntries(Object.entries(next).filter(([key, value]) =>
                    value !== initial[key as keyof ViewerValues])) as Partial<ViewerValues>;
                if (Object.keys(patch).length) {
                    if (this.publishing) this.pendingPatch = {...this.pendingPatch, ...patch};
                    else patchState(this.store, patch);
                }
            }
            return result;
        } catch (error) {
            this.draft = parent;
            throw error;
        }
    }

    bind<T>(read: (state: ViewerValues) => T, update: (state: ViewerValues, value: T) => Partial<ViewerValues>,
        select: () => T = () => read(getState(this.store))): StateBinding<T> {
        return {
            signal: computed(select),
            commits: this.committed,
            read: () => read(this.draft ?? getState(this.store)),
            write: value => {
                const apply = () => {
                    const state = this.draft!;
                    if (deepEquals(read(state), value)) return;
                    this.draft = {...state, ...update(state, deepCopy(value))};
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
