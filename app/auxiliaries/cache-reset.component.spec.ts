import "@angular/compiler";
import {HttpErrorResponse} from "@angular/common/http";
import {BehaviorSubject, firstValueFrom} from "rxjs";
import {describe, expect, it, vi} from "vitest";

import {CacheResetComponent} from "./cache-reset.component";

const createComponent = (enabled = true) => {
    const maps$ = new BehaviorSubject({
        maps: new Map([
            ["Ready", {id: "Ready", info: {status: "ready", addOn: false}}],
            ["Loading", {id: "Loading", info: {status: "initializing", addOn: false}}],
            ["AddOn", {id: "AddOn", info: {status: "ready", addOn: true}}]
        ])
    });
    const mapInfo = {maps$};
    const cacheReset = {reset: vi.fn().mockResolvedValue(undefined)};
    const config = {snapshot: {serverConfig: {cacheReset: enabled}}};
    const messages = {showSuccess: vi.fn(), showError: vi.fn()};
    const state = {
        isDialogOpen: vi.fn(() => true),
        setDialogOpen: vi.fn()
    };
    const component = new CacheResetComponent(
        mapInfo as any,
        cacheReset as any,
        config as any,
        messages as any,
        state as any
    );
    return {component, cacheReset, messages, state};
};

describe("CacheResetComponent", () => {
    it("lists only ready primary maps in catalog order", async () => {
        const {component} = createComponent();

        expect(await firstValueFrom(component.mapIds$)).toEqual(["Ready"]);
    });

    it("runs one enabled reset and reports success", async () => {
        const {component, cacheReset, messages} = createComponent();

        await component.reset("Ready");

        expect(cacheReset.reset).toHaveBeenCalledWith("Ready");
        expect(messages.showSuccess).toHaveBeenCalledOnce();
        expect(component.isPending("Ready")).toBe(false);
    });

    it("does not call the endpoint when the capability is disabled", async () => {
        const {component, cacheReset} = createComponent(false);

        await component.reset("Ready");

        expect(cacheReset.reset).not.toHaveBeenCalled();
    });

    it("uses a generic map-unavailable message for a 404", async () => {
        const {component, cacheReset, messages} = createComponent();
        cacheReset.reset.mockRejectedValue(new HttpErrorResponse({status: 404}));

        await component.reset("Ready");

        expect(messages.showError).toHaveBeenCalledWith(
            "Map “Ready” is no longer available for cache reset."
        );
    });
});
