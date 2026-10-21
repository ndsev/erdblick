import {describe, expect, it} from "vitest";
import {take} from "rxjs";
import {AppState} from "./app-state";
import {ViewerState} from "./viewer-state";
import {diagnosticsLogFilter, diagnosticsExportOptions} from "../diagnostics/diagnostics.facade.service.state";

function fixture() {
    const state = new ViewerState();
    const pool = new Map<string, AppState<unknown>>();
    const filter = new AppState(pool, diagnosticsLogFilter, state.bind(
        value => value.diagnostics.logFilter,
        (value, logFilter) => ({diagnostics: {...value.diagnostics, logFilter}}),
        state.store.diagnostics.logFilter
    ));
    const options = new AppState(pool, diagnosticsExportOptions, state.bind(
        value => value.diagnostics.exportOptions,
        (value, exportOptions) => ({diagnostics: {...value.diagnostics, exportOptions}}),
        state.store.diagnostics.exportOptions
    ));
    return {state, filter, options};
}

describe("SignalStore publication", () => {
    it("finishes codec consumers before layout observers and queues their reentrant writes", () => {
        const {state, filter, options} = fixture();
        const seen: Array<[string, boolean, boolean, boolean]> = [];
        let runtimeFilter = true;
        // Layout listeners may register before the codec-backed runtime bridge.
        const first = state.afterPublication.subscribe(() => {
            seen.push(["first", filter.signal().info, options.signal().includeLogs, runtimeFilter]);
            if (!filter.signal().info && options.signal().includeLogs) {
                options.next({...options.getValue(), includeLogs: false});
            }
        });
        const second = state.afterPublication.subscribe(() => {
            seen.push(["second", filter.signal().info, options.signal().includeLogs, runtimeFilter]);
        });
        const bridge = filter.subscribe(value => { runtimeFilter = value.info; });

        filter.next({...filter.getValue(), info: false});

        expect(seen).toEqual([
            ["first", false, true, false], ["second", false, true, false],
            ["first", false, false, false], ["second", false, false, false]
        ]);
        first.unsubscribe();
        second.unsubscribe();
        bridge.unsubscribe();
        filter.next({...filter.getValue(), info: true});
        expect(seen).toHaveLength(4);
        state.destroy();
    });

    it("discards a queued publication when a layout observer destroys the state owner", () => {
        const {state, filter, options} = fixture();
        state.afterPublication.subscribe(() => {
            options.next({...options.getValue(), includeLogs: false});
            state.destroy();
        });
        filter.next({...filter.getValue(), info: false});
        expect(options.signal().includeLogs).toBe(true);
    });

    it("does not publish or replace identities for a net-zero transaction", () => {
        const {state, filter, options} = fixture();
        const before = state.store.diagnostics();
        const seen: unknown[] = [];
        const subscription = filter.subscribe(value => seen.push(value));
        state.transaction(() => {
            filter.next({...filter.getValue(), info: false});
            state.transaction(() => filter.next({...filter.getValue(), info: true}));
            options.next({...options.getValue(), includeLogs: false});
            options.next({...options.getValue(), includeLogs: true});
        });
        expect(seen).toHaveLength(1);
        expect(state.store.diagnostics()).toBe(before);
        subscription.unsubscribe(); state.destroy();
    });
    it("observes a write made during initial replay and tears down take(1) observers", () => {
        const {state, filter} = fixture();
        const observed: boolean[] = [];
        const subscription = filter.subscribe(value => {
            observed.push(value.info);
            if (value.info) filter.next({...value, info: false});
        });
        expect(observed).toEqual([true, false]);
        let once = 0;
        filter.pipe(take(1)).subscribe(value => {
            ++once;
            filter.next({...value, info: true});
        });
        expect(once).toBe(1);
        subscription.unsubscribe();
        state.destroy();
    });
    it("does not reevaluate a bound native selector when an unrelated field changes", () => {
        const {state, options} = fixture();
        let selections = 0;
        const binding = state.bind(value => value.diagnostics.logFilter,
            (value, logFilter) => ({diagnostics: {...value.diagnostics, logFilter}}),
            () => { ++selections; return state.store.diagnostics.logFilter(); });
        const before = binding.signal();
        options.next({...options.getValue(), includeLogs: false});
        expect(binding.signal()).toBe(before);
        expect(selections).toBe(1);
        state.destroy();
    });
    it("publishes related values coherently to signals and synchronous subscriptions", () => {
        const {state, filter, options} = fixture();
        const observed: boolean[][] = [];
        const subscription = filter.subscribe(value => observed.push([value.info, options.signal().includeLogs]));
        state.transaction(() => {
            filter.next({info: false, warn: false, error: true});
            expect(filter.getValue().info).toBe(false);
            expect(filter.signal().info).toBe(true);
            options.next({...options.getValue(), includeLogs: false});
        });
        expect(observed).toEqual([[true, true], [false, false]]);
        subscription.unsubscribe();
        state.destroy();
    });

    it("discards a failed import and preserves the preceding snapshot", () => {
        const {state, filter, options} = fixture();
        const before = filter.signal();
        expect(() => state.transaction(() => {
            filter.next({info: false, warn: false, error: true});
            options.applySnapshotValue({includeLogs: "invalid"});
        })).toThrow();
        expect(filter.signal()).toBe(before);
        expect(filter.getValue().info).toBe(true);
        const editable = {...filter.getValue()};
        editable.info = false;
        filter.next(editable);
        expect(before.info).toBe(true);
        state.destroy();
    });

    it("suppresses structural no-ops and defers observer writes until all observers see the commit", () => {
        const {state, filter, options} = fixture();
        const seen: boolean[][] = [];
        let armed = false;
        const first = filter.subscribe(value => {
            if (armed && !value.info) options.next({...options.getValue(), includeLogs: false});
        });
        const second = filter.subscribe(value => seen.push([value.info, options.signal().includeLogs]));
        armed = true;
        filter.next({...filter.getValue()});
        expect(seen).toEqual([[true, true]]);
        filter.next({info: false, warn: false, error: true});
        expect(seen).toEqual([[true, true], [false, true]]);
        expect(options.signal().includeLogs).toBe(false);
        first.unsubscribe();
        second.unsubscribe();
        state.destroy();
    });

    it("allows a nested preparation to roll back without losing earlier outer writes", () => {
        const {state, filter, options} = fixture();
        state.transaction(() => {
            filter.next({info: false, warn: true, error: true});
            expect(() => state.transaction(() => {
                options.next({...options.getValue(), includeLogs: false});
                throw new Error("cancelled preparation");
            })).toThrow("cancelled preparation");
        });
        expect(filter.signal().info).toBe(false);
        expect(options.signal().includeLogs).toBe(true);
        state.destroy();
    });
});
