import {Injector} from "@angular/core";
import {signalStore} from "@ngrx/signals";
import {afterEach, describe, expect, it, vi} from "vitest";
import {withDiagnosticsActions} from "../diagnostics/diagnostics-actions.store-feature";
import {DiagnosticsFacadeService} from "../diagnostics/diagnostics.facade.service";
import {withStyleActions} from "../styledata/style-actions.store-feature";
import {StyleService} from "../styledata/style.service";
import {getActionMetadata} from "./action";
import {withViewerUiActions} from "./viewer-ui-actions.store-feature";
import {ViewerUiService} from "./viewer-ui.service";

const ResourceActionStore = signalStore(withStyleActions(), withDiagnosticsActions(), withViewerUiActions());

describe("resource operation features", () => {
    let injector: ReturnType<typeof Injector.create>;
    afterEach(() => injector?.destroy());

    it("discovers every resource operation without resolving a runtime service", () => {
        injector = Injector.create({providers: [ResourceActionStore]});
        const store = injector.get(ResourceActionStore);
        const names = Object.values(store)
            .map((member) => getActionMetadata(member)?.declaration.name)
            .filter((name) => name !== undefined)
            .sort();

        expect(names).toEqual([
            "viewer_click",
            "viewer_edit_style",
            "viewer_fill",
            "viewer_get_diagnostics",
            "viewer_get_element",
            "viewer_get_style",
            "viewer_list_styles",
            "viewer_resize",
            "viewer_screenshot",
            "viewer_scroll",
            "viewer_take_snapshot",
            "viewer_validate_style"
        ]);
    });

    it("validates style input before lazy resolution and preserves synchronous results", () => {
        const getStyle = vi.fn(() => ({
            styleId: "roads",
            source: "name: roads",
            imported: false,
            modified: false,
            visible: true
        }));
        const createStyles = vi.fn(() => ({getStyle}));
        injector = Injector.create({providers: [
            ResourceActionStore,
            {provide: StyleService, useFactory: createStyles}
        ]});
        const store = injector.get(ResourceActionStore);

        expect(() => store.getStyle({styleId: ""})).toThrow();
        expect(createStyles).not.toHaveBeenCalled();

        const result = store.getStyle({styleId: "roads"});
        expect(result).not.toBeInstanceOf(Promise);
        expect(result).toMatchObject({styleId: "roads", source: "name: roads", visible: true});
        expect(getStyle).toHaveBeenCalledExactlyOnceWith({styleId: "roads"});
        expect(createStyles).toHaveBeenCalledTimes(1);
    });

    it("resolves diagnostics only for an explicit request and preserves its bounded result", () => {
        const getDiagnostics = vi.fn(() => ({
            observedAt: "2026-10-22T09:00:00.000Z",
            complete: true,
            executionContext: "browser",
            interpretation: "Cached browser transport counters",
            metrics: [{section: "transport", name: "connected", value: true, scope: "tab"}],
            errors: [],
            unavailable: []
        }));
        const createDiagnostics = vi.fn(() => ({getDiagnostics}));
        injector = Injector.create({providers: [
            ResourceActionStore,
            {provide: DiagnosticsFacadeService, useFactory: createDiagnostics}
        ]});
        const store = injector.get(ResourceActionStore);
        expect(createDiagnostics).not.toHaveBeenCalled();

        expect(store.getDiagnostics({sections: ["transport"]})).toMatchObject({
            executionContext: "browser",
            complete: true,
            metrics: [{section: "transport", name: "connected", value: true, scope: "tab"}]
        });
        expect(getDiagnostics).toHaveBeenCalledExactlyOnceWith({sections: ["transport"]});
    });

    it("keeps screenshot cancellation and asynchronous capture with the runtime owner", async () => {
        const screenshot = vi.fn(async () => ({
            image: {mimeType: "image/jpeg", data: "AAAA"},
            metadata: {
                scope: "application-viewport",
                width: 640,
                height: 480,
                viewportWidth: 1280,
                viewportHeight: 960,
                viewLayoutRevision: 2,
                capturedAt: "2026-10-22T09:00:00.000Z",
                readiness: {status: "unknown"},
                warnings: []
            }
        }));
        const createUi = vi.fn(() => ({screenshot}));
        injector = Injector.create({providers: [
            ResourceActionStore,
            {provide: ViewerUiService, useFactory: createUi}
        ]});
        const store = injector.get(ResourceActionStore);
        const cancelled = new AbortController();
        cancelled.abort();
        expect(() => store.screenshot({}, {signal: cancelled.signal})).toThrow();
        expect(createUi).not.toHaveBeenCalled();

        const controller = new AbortController();
        const result = store.screenshot({maxWidth: 640}, {signal: controller.signal});
        expect(result).toBeInstanceOf(Promise);
        await expect(result).resolves.toMatchObject({metadata: {width: 640, height: 480}});
        expect(screenshot).toHaveBeenCalledExactlyOnceWith({maxWidth: 640}, controller.signal);
    });
});
