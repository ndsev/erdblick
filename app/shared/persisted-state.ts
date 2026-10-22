import {Injector} from "@angular/core";
import type {Params} from "@angular/router";
import {
    getState,
    patchState,
    signalStoreFeature,
    StateSource,
    watchState,
    withProps,
    withState,
    WritableStateSource,
} from "@ngrx/signals";
import {Observable} from "rxjs";
import {z} from "zod";
import {StateCodec} from "./state-codec";
import {AppStateOptions, deepCopy, deepEquals} from "./state-value";

export type StateWriteOrigin = "user" | "system" | "hydration" | "config";
export const INITIAL_VIEW_ID = "view-main";

/**
 * Camera and display preferences belong to logical view IDs in the running store.
 * Existing URLs and saved state still use arrays in visible view order; this
 * declaration lets persistence convert between those two representations.
 */
export interface PerViewField<T> {
    readonly perView: true;
    readonly options: AppStateOptions<T>;
}

/**
 * Values such as pending dialog opens belong to their domain feature but are not
 * saved. A complete state import resets them to the declared runtime default.
 */
export interface TransientField<T> {
    readonly transient: true;
    readonly defaultValue: T;
}

export type StateField<T> =
    | AppStateOptions<T>
    | TransientField<T>
    | (T extends Record<string, infer Value> ? PerViewField<Value> : never);

export function perView<T>(options: AppStateOptions<T>): PerViewField<T> {
    return {perView: true, options};
}

export function transient<T>(defaultValue: T): TransientField<T> {
    return {transient: true, defaultValue};
}

type StateRecord = Record<string, unknown>;

/**
 * Connects a deployed storage name and codec to a field in the native store.
 * The old AppState combined this information with its own reactive value. Here
 * the feature owns the only value; a descriptor receives state from its caller.
 *
 * Import methods return ordinary objects without publishing them. Persistence
 * can therefore prepare a complete snapshot before the store publishes it once.
 */
export class PersistenceDescriptor<T = any> {
    constructor(
        readonly slice: string,
        readonly key: string,
        readonly codec: StateCodec<T>,
        readonly perViewDefault?: {value: unknown},
    ) {}

    get name(): string {
        return this.codec.name;
    }

    read(state: object): T {
        const root = state as StateRecord;
        const value = this.slice
            ? (root[this.slice] as StateRecord)[this.key]
            : root[this.key];
        if (!this.perViewDefault) {
            return value as T;
        }

        const ids = root["viewIds"] as string[];
        return ids.map(id => (value as StateRecord)[id] ?? this.perViewDefault!.value) as T;
    }

    /** Return a complete root value for a caller's local calculation; this never publishes it. */
    replace<S extends object>(state: S, value: T): S {
        const root = state as StateRecord;
        const previous = this.slice
            ? (root[this.slice] as StateRecord)[this.key]
            : root[this.key];
        const next = this.perViewDefault
            ? Object.fromEntries((root["viewIds"] as string[]).map((id, index) => [
                id,
                (value as unknown[])[index] ?? deepCopy(this.perViewDefault!.value),
            ]))
            : value;
        if (deepEquals(previous, next)) {
            return state;
        }

        return this.slice
            ? {...state, [this.slice]: {...root[this.slice] as StateRecord, [this.key]: next}}
            : {...state, [this.key]: next};
    }

    /** Skip codec projection when neither this native value nor its view order changed. */
    hasChanged(previous: object, current: object): boolean {
        const before = previous as StateRecord;
        const after = current as StateRecord;
        const readNative = (root: StateRecord) => this.slice
            ? (root[this.slice] as StateRecord)[this.key]
            : root[this.key];
        if (readNative(before) === readNative(after) && before["viewIds"] === after["viewIds"]) {
            return false;
        }
        return !deepEquals(this.read(previous), this.read(current));
    }

    serialize(state: object, forUrl: boolean) {
        return this.codec.serialize(this.read(state), forUrl);
    }

    snapshot(state: object): unknown {
        return this.codec.toSnapshotValue(this.read(state));
    }

    deserialize<S extends object>(state: S, raw: string | Params): S {
        return this.replace(state, this.codec.deserialize(raw, this.read(state)));
    }

    importSnapshot<S extends object>(state: S, raw: unknown): S {
        return this.replace(state, this.codec.validateSnapshotValue(raw, this.read(state)));
    }

    reset<S extends object>(state: S): S {
        return this.replace(state, deepCopy(this.codec.defaultValue));
    }
}

/**
 * Holds a feature's declarations, including defaults for runtime-only fields.
 * It holds no current store values and can be shared by instances of the store.
 */
export class FeaturePersistence {
    readonly fields: PersistenceDescriptor[] = [];
    private readonly defaults: StateRecord = {};
    readonly transientKeys: string[] = [];

    initial(): StateRecord {
        return deepCopy(this.defaults);
    }

    constructor(readonly slice: string, declarations: Record<string, unknown>) {
        for (const [key, declaration] of Object.entries(declarations)) {
            const field = declaration as AppStateOptions<unknown> | PerViewField<unknown> | TransientField<unknown>;
            if ("transient" in field) {
                this.defaults[key] = deepCopy(field.defaultValue);
                this.transientKeys.push(key);
            } else if ("perView" in field) {
                const options = field.options;
                this.defaults[key] = {};

                // Apply the original field codec to each visible view while keeping
                // its released array representation in storage and shared links.
                const codec = new StateCodec<unknown[]>({
                    ...options,
                    defaultValue: [deepCopy(options.defaultValue)],
                    schema: z.array(options.schema),
                    toStorage: values => values.map(value =>
                        options.toStorage ? options.toStorage(value) : value
                    ),
                    fromStorage: (raw, current) => (raw as unknown as unknown[]).map((value, index) => {
                        if (!options.fromStorage) {
                            return value;
                        }
                        return options.fromStorage(
                            value as z.ZodTypeAny,
                            current[index] ?? deepCopy(options.defaultValue),
                        );
                    }),
                });
                this.fields.push(new PersistenceDescriptor(slice, key, codec, {value: options.defaultValue}));
            } else {
                this.defaults[key] = deepCopy(field.defaultValue);
                this.fields.push(new PersistenceDescriptor(slice, key, new StateCodec(field)));
            }
        }
    }
}

/**
 * Declares a domain's native state and persistence metadata together. For example,
 * the layout declaration creates the signal `store.layout.dockOpen()` while its
 * descriptor retains the existing `dockOpenState` key in saved state.
 */
export function withPersistedState<Name extends string, Values extends object>(
    slice: Name,
    fields: {[Key in keyof Values]: StateField<Values[Key]>},
) {
    const metadata = Symbol(`persistence:${slice}`);
    const descriptor = new FeaturePersistence(slice, fields);
    return signalStoreFeature(
        withState(() => ({[slice]: descriptor.initial()}) as {[Key in Name]: Values}),
        withProps(() => ({[metadata]: descriptor})),
    );
}

/** All composed features are discovered; there is no separately maintained registration list. */
export function persistenceFeatures(store: object): FeaturePersistence[] {
    return Reflect.ownKeys(store)
        .map(key => Reflect.get(store, key) as unknown)
        .filter((value): value is FeaturePersistence => value instanceof FeaturePersistence);
}

export function persistenceDescriptors(store: object): PersistenceDescriptor[] {
    return [
        ...persistenceFeatures(store).flatMap(feature => feature.fields),
        ...Reflect.ownKeys(store)
            .map(key => Reflect.get(store, key) as unknown)
            .filter((value): value is PersistenceDescriptor => value instanceof PersistenceDescriptor),
    ];
}

interface WriteProvenance {
    current: StateWriteOrigin | Readonly<Record<string, StateWriteOrigin>>;
}

/**
 * Gives synchronous persistence observers the cause of the current publication.
 * This is metadata on the store instance, so changing it does not notify the UI.
 */
export function withStateProvenance() {
    return signalStoreFeature(
        withProps(() => ({
            _writeProvenance: {current: "user"} as WriteProvenance,
        })),
    );
}

/**
 * Publish one already calculated change. Provenance is visible only during NgRx's
 * synchronous notification, so a later async operation cannot inherit an old import context.
 * A mixed update can mark each deployed storage key independently (for example catalog
 * defaults remain system-owned while the user's new map selection becomes user-owned).
 */
export function patchAppState<State extends object>(
    store: WritableStateSource<State>,
    patch: Partial<State>,
    origin: StateWriteOrigin | Readonly<Record<string, StateWriteOrigin>> = "user",
): void {
    const provenance = Reflect.get(store, "_writeProvenance") as WriteProvenance | undefined;
    const previous = provenance?.current;
    if (provenance) {
        provenance.current = origin;
    }
    try {
        const current = getState(store);
        const changed = Object.fromEntries(
            Object.entries(patch).filter(([key, value]) =>
                !deepEquals(current[key as keyof State], value)
            ),
        );
        if (Object.keys(changed).length) {
            patchState(store, changed as Partial<State>);
        }
    } finally {
        if (provenance) {
            provenance.current = previous!;
        }
    }
}

export function stateWriteOrigin(store: object, storageKey: string): StateWriteOrigin {
    const provenance = Reflect.get(store, "_writeProvenance") as WriteProvenance | undefined;
    if (typeof provenance?.current === "object") {
        return provenance.current[storageKey] ?? "system";
    }
    return provenance?.current ?? "user";
}

/**
 * Resource engines need callbacks for changes such as a tile stream's retry policy.
 * This observes native NgRx publications synchronously without staging another value
 * or write. UI templates read the store's signals directly.
 *
 * Each subscription owns a watcher. The resource must unsubscribe when its work ends
 * or it is destroyed; that also destroys the watcher's injector.
 */
export function observeStore<State extends object, Value>(
    store: StateSource<State>,
    select: (state: State) => Value,
    equals: (a: Value, b: Value) => boolean = Object.is,
): Observable<Value> {
    return new Observable(subscriber => {
        const injector = Injector.create({providers: []});
        let initialized = false;
        let previous: Value;
        const watcher = watchState(store, state => {
            const value = select(state);
            if (!initialized || !equals(previous, value)) {
                previous = value;
                initialized = true;
                subscriber.next(value);
            }
        }, {injector});
        return () => {
            watcher.destroy();
            injector.destroy();
        };
    });
}
