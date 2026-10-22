import "@angular/compiler";
import {computed, signal} from "@angular/core";
import {signalStore, withMethods, withProps, withState} from "@ngrx/signals";
import {Observable} from "rxjs";
import {describe, expect, it, vi} from "vitest";
import {z} from "zod";
import {action} from "./action";
import {ActionCatalog} from "./app-action";
import {control, ControlDeclaration} from "./control";
import {omnibarProvider} from "./omnibar";
import {withViewerActions} from "./viewer-actions.store-feature";

const close = {
    name: "close",
    description: "Close a live panel",
    mutation: true,
    inputSchema: z.strictObject({id: z.number()}),
    outputSchema: z.strictObject({closed: z.number()})
};
const projection = {
    name: "projection",
    description: "View projection",
    readable: true,
    writable: true,
    persistence: "local-storage",
    synchronization: "none",
    selectorSchema: z.strictObject({viewId: z.string()}),
    valueSchema: z.enum(["2d", "3d"])
} satisfies ControlDeclaration;

describe("feature action discovery", () => {
    it("discovers feature metadata without reading signals, starting providers or invoking resources", () => {
        const resource = vi.fn(({id}: {id: number}) => ({closed: id}));
        const calculate = vi.fn(() => 1);
        const suggest = vi.fn(() => []);
        const Store = signalStore(
            withState({untouched: 7}),
            withProps(() => ({expensive: computed(calculate), suggestions: omnibarProvider({name: "local", order: 0, suggest})})),
            withMethods(() => ({closePanel: action(close, resource)})),
            withViewerActions()
        );
        const store = new Store();
        expect(store.actionCatalog.declarations.map(value => value.name)).toContain("close");
        expect(resource).not.toHaveBeenCalled();
        expect(calculate).not.toHaveBeenCalled();
        expect(suggest).not.toHaveBeenCalled();
        expect(store.untouched()).toBe(7);
        expect(store.closePanel({id: 3})).toEqual({closed: 3});
        expect(store.actionCatalog.execute("close", {id: 4})).toEqual({closed: 4});
        expect(resource.mock.calls.map(([input]) => input.id)).toEqual([3, 4]);
    });

    it("rejects duplicate public names before exposing the store", () => {
        const operation = action(close, ({id}) => ({closed: id}));
        expect(() => new ActionCatalog({first: operation, second: operation})).toThrow("Duplicate action");
        const setting = control(projection, {read: () => "2d" as const, write() {}});
        expect(() => new ActionCatalog({first: setting, second: setting})).toThrow("Duplicate control");
    });

    it("uses the same validated operation for direct calls and live omnibar choices", async () => {
        let current = true;
        const handler = vi.fn(({id}: {id: number}) => ({closed: id}));
        const closePanel = action(close, handler, {
            suggest: () => [{
                id: "close:7", name: "Close Road.1", icon: "pi-times", color: "orange",
                enabled: true, label: "Inspection", arguments: {id: 7},
                validate: () => true, isCurrent: () => current
            }]
        });
        const catalog = new ActionCatalog({closePanel});
        const candidate = catalog.omnibarTargets("close")[0];
        expect(() => catalog.execute("close", {id: "wrong"})).toThrow();
        expect(handler).not.toHaveBeenCalled();
        expect(closePanel({id: 3})).toEqual({closed: 3});
        await candidate.execute!("close");
        expect(handler.mock.calls.map(([input]) => input.id)).toEqual([3, 7]);
        expect(candidate.saveToHistory!("close")).toBe(false);
        current = false;
        expect(candidate.validate("close")).toBe(false);
        await expect(candidate.execute!("close")).rejects.toMatchObject({detail: {code: "not_available"}});
        expect(handler).toHaveBeenCalledTimes(2);
    });

    it("preserves synchronous browser gestures and aborts before invoking a handler", () => {
        const open = vi.fn();
        const openViewer = action({...close, outputSchema: z.void()}, () => open());
        const catalog = new ActionCatalog({openViewer});
        expect(catalog.execute("close", {id: 1})).toBeUndefined();
        expect(open).toHaveBeenCalledOnce();
        const abort = new AbortController();
        abort.abort();
        expect(() => openViewer({id: 1}, {signal: abort.signal})).toThrow();
        expect(open).toHaveBeenCalledOnce();
    });

    it("validates asynchronous results and retains asynchronous rejection", async () => {
        const read = action(close, async ({id}) => ({closed: id}));
        expect(read({id: 8})).toBeInstanceOf(Promise);
        await expect(read({id: 8})).resolves.toEqual({closed: 8});
        const invalid = action({...close, outputSchema: z.strictObject({closed: z.number().positive()})}, async () => ({closed: -1}));
        await expect(invalid({id: 8})).rejects.toThrow();
    });

    it("cancels network candidate production when the search panel retires its subscription", () => {
        const cancel = vi.fn();
        const catalog = new ActionCatalog({locations: omnibarProvider({
            name: "locations", order: 0, search: () => new Observable(() => cancel)
        })});
        const subscription = catalog.asyncOmnibarTargets("Munich").subscribe();
        subscription.unsubscribe();
        expect(cancel).toHaveBeenCalledOnce();
    });

    it("bounds control overviews and validates the entire assignment before writing", () => {
        const value = signal<"2d" | "3d">("2d");
        const write = vi.fn((_: unknown, next: "2d" | "3d") => value.set(next));
        const catalog = new ActionCatalog({projection: control(projection, {
            read: value, write,
            overview: () => Array.from({length: 40}, (_, index) => ({viewId: `view-${index}`}))
        })});
        expect(catalog.execute("viewer_get_controls", {})).toMatchObject({complete: false,
            omissions: [{target: {control: "projection", viewId: "view-32"}, reason: "item_limit", omittedCount: 8}]});
        const target = {control: "projection", viewId: "view-0"};
        expect(() => catalog.execute("viewer_set_control", {target, value: 42})).toThrow();
        expect(write).not.toHaveBeenCalled();
        expect(catalog.execute("viewer_set_control", {target, value: "3d"})).toMatchObject({changed: true, value: "3d"});
        expect(value()).toBe("3d");
    });
});
