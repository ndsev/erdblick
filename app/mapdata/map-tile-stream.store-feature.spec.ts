import {Injector} from "@angular/core";
import {signalStore, watchState} from "@ngrx/signals";
import {afterEach, describe, expect, it} from "vitest";
import {DEFAULT_CONNECTION_RETRY_POLICY} from "../shared/connection-retry-policy";
import {patchAppState} from "../shared/persisted-state";
import {ConnectionValues, withMapTileStream} from "./map-tile-stream.store-feature";

// This fixture also accepts decoded saved slots, as the persistence boundary does.
const ConnectionStore = signalStore({protectedState: false}, withMapTileStream());

describe("connection preferences", () => {
    const injectors: ReturnType<typeof Injector.create>[] = [];
    afterEach(() => injectors.splice(0).forEach(injector => injector.destroy()));

    it("publishes the complete retry form once and rejects inconsistent edits without changing it", () => {
        const store = new ConnectionStore();
        const injector = Injector.create({providers: []});
        injectors.push(injector);
        const observed: ConnectionValues[] = [];
        watchState(store, state => observed.push(state.connection), {injector});
        const policy = {enabled: false, initialDelayMs: 1000, backoffMultiplier: 3, maxDelayMs: 12000};

        store.setConnectionRetryPolicy(policy);

        expect(observed).toHaveLength(2);
        expect(store.connectionRetryPolicy()).toEqual(policy);
        const before = store.connection();
        expect(() => store.setConnectionRetryPolicy({...policy, maxDelayMs: 500})).toThrow();
        expect(store.connection()).toBe(before);
        expect(observed).toHaveLength(2);
    });

    it("preserves a disabled retry preference when imported timing slots disagree", () => {
        const store = new ConnectionStore();
        patchAppState(store, {
            connection: {
                ...store.connection(),
                connectionRetryEnabled: false,
                connectionRetryInitialDelayMs: 10000,
                connectionRetryMaxDelayMs: 1000
            }
        }, "hydration");

        expect(store.connectionRetryPolicy()).toEqual({...DEFAULT_CONNECTION_RETRY_POLICY, enabled: false});
        expect(store.connection.connectionRetryInitialDelayMs()).toBe(10000);
        expect(store.connection.connectionRetryMaxDelayMs()).toBe(1000);
    });
});
