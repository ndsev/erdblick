import "@angular/compiler";
import {Observable} from "rxjs";
import {describe, expect, it, vi} from "vitest";
import {z} from "zod";
import {AppActionService} from "./app-action.service";
import {createControlActions} from "./control-actions";
import type {ControlDeclaration} from "./control";

const close = {name: "close", description: "Close a live panel", mutation: true,
    inputSchema: z.strictObject({id: z.number()}), outputSchema: z.strictObject({closed: z.number()})};
const projection = {name: "projection", description: "View projection", readable: true, writable: true,
    persistence: "local-storage", synchronization: "none", selectorSchema: z.strictObject({viewId: z.string()}),
    valueSchema: z.enum(["2d", "3d"])} satisfies ControlDeclaration;

describe("owner action registration", () => {
    it("checks declaration identity and duplicate expectations before sealing public bindings", () => {
        const registry = new AppActionService();
        registry.registerAction(close, ({id}) => ({closed: id}));
        registry.registerControl(projection, {read: () => "2d" as const, write() {}});
        expect(() => registry.assertComplete([close, close])).toThrow("Duplicate");
        expect(() => registry.assertComplete([{...close}])).toThrow("contract");
        expect(() => registry.assertControlsComplete([projection, projection])).toThrow("Duplicate");
        expect(() => registry.assertControlsComplete([{...projection}])).toThrow("differs");
        registry.assertComplete([close]);
        registry.assertControlsComplete([projection]);
        expect(() => registry.registerAction({...close, name: "late"}, ({id}) => ({closed: id}))).toThrow("Late action");
        expect(() => registry.registerControl({...projection, name: "late"}, {read: () => "2d" as const, write() {}})).toThrow("Late control");
        // Runtime plugin/query producers are independent of the exported public catalog.
        const remove = registry.registerOmnibar("plugin", () => []);
        remove();
        expect(() => registry.registerOmnibar("plugin", () => [])).not.toThrow();
    });

    it("shares the exact handler across public dispatch and parameterized omnibar suggestions", async () => {
        const registry = new AppActionService();
        let current = true;
        const handler = vi.fn(({id}: {id: number}) => ({closed: id}));
        registry.registerAction(close, handler, {suggest: () => [{id: "close:7", name: "Close Road.1",
            icon: "pi-times", color: "orange", enabled: true, label: "Inspection", arguments: {id: 7},
            validate: () => true, isCurrent: () => current}]});
        const candidate = registry.omnibarTargets("close")[0];
        expect(registry.execute("close", {id: 3})).toEqual({closed: 3});
        await candidate.execute!("close");
        expect(handler.mock.calls.map(([input]) => input.id)).toEqual([3, 7]);
        expect(candidate.saveToHistory!("close")).toBe(false);
        current = false;
        expect(candidate.validate("close")).toBe(false);
        await expect(candidate.execute!("close")).rejects.toMatchObject({detail: {code: "not_available"}});
        expect(handler).toHaveBeenCalledTimes(2);
    });

    it("cancels async omnibar producers when the query subscription is retired", () => {
        const registry = new AppActionService();
        const cancel = vi.fn();
        registry.registerAsyncOmnibar("locations", () => new Observable(() => cancel));
        const subscription = registry.asyncOmnibarTargets("Munich").subscribe();
        subscription.unsubscribe();
        expect(cancel).toHaveBeenCalledOnce();
    });

    it("reports omitted overview targets and validates both directions of a control assignment", () => {
        const registry = new AppActionService();
        let value: "2d" | "3d" = "2d";
        const write = vi.fn((_: unknown, next: "2d" | "3d") => { value = next; });
        registry.registerControl(projection, {read: () => value, write,
            overview: () => Array.from({length: 40}, (_, index) => ({viewId: `view-${index}`}))});
        const controls = createControlActions([projection]);
        registry.registerControlActions(controls);
        expect(registry.execute(controls.getControls.name, {})).toMatchObject({complete: false,
            omissions: [{target: {control: "projection", viewId: "view-32"}, reason: "item_limit", omittedCount: 8}]});
        expect(() => registry.execute(controls.setControl.name, {target: {control: "projection", viewId: "view-0"}, value: 42})).toThrow();
        expect(write).not.toHaveBeenCalled();
        expect(registry.execute(controls.setControl.name, {target: {control: "projection", viewId: "view-0"}, value: "3d"}))
            .toMatchObject({changed: true, value: "3d"});
        expect(controls.setControl.outputSchema.safeParse({status: "applied", target: {control: "projection", viewId: "view-0"},
            value: 42, changed: true, readiness: {status: "unknown"}}).success).toBe(false);
    });
});
