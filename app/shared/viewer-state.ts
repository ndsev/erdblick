import {computed, Injector, Signal} from "@angular/core";
import {getState, patchState, signalStore, StateSource, type, watchState} from "@ngrx/signals";
import {withEntities} from "@ngrx/signals/entities";
import {Observable, Subject} from "rxjs";
import {withCoordinatesPolicy} from "../coords/coordinates-policy.service.state";
import {withCoordinates} from "../coords/coordinates.service.state";
import {withDiagnosticsState} from "../diagnostics/diagnostics.facade.service.state";
import {withInspectionState} from "../inspection/inspection-state.service.state";
import {withMapLayerState} from "../mapdata/map-layer-state.service.state";
import {withMapTileStream} from "../mapdata/map-tile-stream.service.state";
import {withMapViewState} from "../mapview/map-view-state.service.state";
import type {ViewIdentity} from "../mapview/view-id";
import {withFeatureSearch} from "../search/feature.search.service.state";
import {withLocationSearch} from "../search/location.search.service.state";
import {withStyleEditorRequest} from "../styledata/style-editor-request.service.state";
import {withStyle} from "../styledata/style.service.state";
import {withAppConfig} from "./app-config.service.state";
import {withAppLayout} from "./app-layout.service.state";
import {deepEquals} from "./state-value";

/**
 * The one durable value store. Domain features supply named state members;
 * services own operations and resource lifetimes. Codecs bind directly to these values.
 */
export const ViewerStore = signalStore(
    {protectedState: false},
    withMapViewState(),
    withMapLayerState(),
    withInspectionState(),
    withAppLayout(),
    withStyle(),
    withFeatureSearch(),
    withMapTileStream(),
    withCoordinates(),
    withCoordinatesPolicy(),
    withLocationSearch(),
    withStyleEditorRequest(),
    withAppConfig(),
    withDiagnosticsState(),
    withEntities({entity: type<ViewIdentity>(), collection: "view"})
);
export type ViewerValues = InstanceType<typeof ViewerStore> extends StateSource<infer Values> ? Values : never;

export type StateWriteOrigin = "user" | "system" | "hydration" | "config";

/** A codec binding reads the store and prepares writes; it never caches a value. */
export interface StateBinding<T> {
    readonly signal: Signal<T>;
    readonly commits: Observable<void>;
    readonly writeOrigin?: () => StateWriteOrigin | undefined;
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

    private readonly preparations = new Map<() => void, (() => StateWriteOrigin | undefined) | undefined>();
    beforeCommit(prepare: () => void, origin?: () => StateWriteOrigin | undefined): () => void {
        this.preparations.set(prepare, origin);
        return () => this.preparations.delete(prepare);
    }

    private originProvider: () => StateWriteOrigin = () => "user";
    setOriginProvider(provider: () => StateWriteOrigin): void {
        this.originProvider = provider;
    }
    private preparationOrigin: StateWriteOrigin | undefined;
    private draftOrigins: Map<object, StateWriteOrigin> | undefined;
    private pendingOrigins = new Map<object, StateWriteOrigin>();
    private publishedOrigins = new Map<object, StateWriteOrigin>();

    private draft: ViewerValues | undefined;
    private originalBindings: Map<object, unknown> | undefined;
    private publishing = false;
    private pendingPatch: Partial<ViewerValues> | undefined;
    private readonly watcher = watchState(
        this.store,
        () => {
            this.publishing = true;
            try {
                this.committed.next();
            } finally {
                this.publishing = false;
            }
            if (this.pendingPatch) {
                const patch = this.pendingPatch;
                this.pendingPatch = undefined;
                const origins = this.pendingOrigins;
                this.pendingOrigins = new Map();
                this.publish(patch, origins);
            }
        },
        {injector: this.injector}
    );

    private publish(patch: Partial<ViewerValues>, origins: Map<object, StateWriteOrigin>): void {
        this.publishedOrigins = origins;
        patchState(this.store, patch);
    }

    /** Nested domain preparation joins the transaction; an exception rolls back its writes. */
    transaction<T>(operation: () => T): T {
        const parent = this.draft;
        const parentBindings = this.originalBindings;
        const parentOrigins = this.draftOrigins;
        this.originalBindings = new Map(parentBindings);
        this.draftOrigins = new Map(parentOrigins);
        const initial = parent ?? {...getState(this.store), ...this.pendingPatch};
        this.draft = initial;
        try {
            const result = operation();
            if (!parent)
                for (const [prepare, origin] of this.preparations) {
                    this.preparationOrigin = origin?.();
                    try {
                        prepare();
                    } finally {
                        this.preparationOrigin = undefined;
                    }
                }
            const next = this.draft;
            if (!parent) {
                this.draft = undefined;
                this.originalBindings = undefined;
                const origins = this.draftOrigins!;
                this.draftOrigins = undefined;
                const patch = Object.fromEntries(
                    Object.entries(next).filter(([key, value]) => {
                        const previous = initial[key as keyof ViewerValues];
                        if (value === previous) return false;
                        // A reverted binding reuses its original value. Check only the small
                        // touched owner slice's field identities, never its layer/style contents.
                        if (
                            Object.getPrototypeOf(value) === Object.prototype &&
                            Object.getPrototypeOf(previous) === Object.prototype
                        ) {
                            const fields = Object.keys(value);
                            const before = previous as Record<string, unknown>;
                            const after = value as Record<string, unknown>;
                            if (
                                fields.length === Object.keys(before).length &&
                                fields.every((field) => after[field] === before[field])
                            )
                                return false;
                        }
                        return true;
                    })
                ) as Partial<ViewerValues>;
                if (Object.keys(patch).length) {
                    if (this.publishing) {
                        this.pendingPatch = {...this.pendingPatch, ...patch};
                        this.pendingOrigins = new Map([...this.pendingOrigins, ...origins]);
                    } else this.publish(patch, origins);
                }
            }
            return result;
        } catch (error) {
            this.draft = parent;
            this.originalBindings = parentBindings;
            this.draftOrigins = parentOrigins;
            throw error;
        }
    }

    bind<T>(
        read: (state: ViewerValues) => T,
        update: (state: ViewerValues, value: T) => Partial<ViewerValues>,
        select: () => T = () => read(getState(this.store))
    ): StateBinding<T> {
        const key = {};
        return {
            signal: computed(select),
            commits: this.committed,
            writeOrigin: () => (this.draft ? this.draftOrigins?.get(key) : this.publishedOrigins.get(key)),
            read: () => (this.draft ? read(this.draft) : select()),
            write: (value) => {
                const apply = () => {
                    const state = this.draft!;
                    const previous = read(state);
                    if (deepEquals(previous, value)) return;
                    const originals = this.originalBindings!;
                    const alreadyTouched = originals.has(key);
                    if (!alreadyTouched) originals.set(key, previous);
                    const reverted = alreadyTouched && deepEquals(originals.get(key), value);
                    if (reverted) {
                        value = originals.get(key) as T;
                        this.draftOrigins!.delete(key);
                    } else this.draftOrigins!.set(key, this.preparationOrigin ?? this.originProvider());
                    this.draft = {...state, ...update(state, value)};
                };
                if (this.draft) apply();
                else this.transaction(apply);
            }
        };
    }

    destroy(): void {
        this.watcher.destroy();
        this.committed.complete();
        this.injector.destroy();
    }
}
