import {describe, expect, it} from "vitest";
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
        const editable = filter.getValue();
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
