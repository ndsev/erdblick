import "@angular/compiler";
import {runInInjectionContext} from "@angular/core";
import {Subject} from "rxjs";
import {describe, expect, it, vi} from "vitest";
import {ownerTestInjector} from "../../test/owner-test-injector";
import {ViewerUiService} from "../actions/viewer-ui.service";
import {MapInfoService} from "../mapdata/map-info.service";
import {MapTileStreamService} from "../mapdata/map-tile-stream.service";
import {AppConfigService} from "../shared/app-config.service";
import {AppLayoutService} from "../shared/app-layout.service";
import {KeyboardService} from "../shared/keyboard.service";
import {MapViewStateService} from "./map-view-state.service";
import {MapViewService} from "./map-view.service";
import {MapViewContainerComponent} from "./view.container.component";

/** Real keyboard dispatch and renderer ownership, without creating WebGL resources. */
function fixture() {
    let keydown: (event: KeyboardEvent) => void = () => {};
    const keyboard = new KeyboardService({
        createRenderer: () => ({listen: (_target: string, _type: string, handler: typeof keydown) => {
            keydown = handler;
            return () => {};
        }})
    } as never, {closeTopDialog: vi.fn()} as never);
    const injector = ownerTestInjector([
        MapViewStateService, MapViewService, AppLayoutService,
        {provide: AppConfigService, useValue: {}},
        {provide: MapTileStreamService, useValue: {}},
        {provide: MapInfoService, useValue: {
            maps: {maps: new Map()}, layerStateChanged: new Subject<string>(),
            reapplySyncOptionsForAllViews: vi.fn()
        }}
    ]);
    const views = injector.get(MapViewStateService);
    const renderers = injector.get(MapViewService);
    const createContainer = () => runInInjectionContext(injector, () =>
        new MapViewContainerComponent(renderers, keyboard, {} as ViewerUiService));
    const container = createContainer();
    const renderer = (index: number) => ({
        identity: views.captureView(index)!,
        isAvailable: () => true,
        zoomIn: vi.fn(), zoomOut: vi.fn(), moveUp: vi.fn(), moveDown: vi.fn(),
        moveLeft: vi.fn(), moveRight: vi.fn(), resetOrientation: vi.fn()
    });
    return {views, renderers, container, createContainer, renderer,
        press: (key: string) => keydown(new KeyboardEvent("keydown", {key}))};
}

describe("focused view keyboard commands", () => {
    it("uses renderers that become ready or are replaced without a focus-state change", () => {
        const {views, renderers, container, renderer, press} = fixture();
        const focus = views.focusedViewId();
        press("e"); // No renderer has completed its asynchronous setup yet.
        const first = renderer(0);
        const unregisterFirst = renderers.registerRenderView(first as never);
        press("e");
        expect(first.zoomOut).toHaveBeenCalledOnce();

        const replacement = renderer(0);
        renderers.registerRenderView(replacement as never);
        unregisterFirst();
        press("e");
        expect(replacement.zoomOut).toHaveBeenCalledOnce();
        expect(first.zoomOut).toHaveBeenCalledOnce();
        expect(views.focusedViewId()).toBe(focus);
        container.ngOnDestroy();
    });

    it("follows the focused identity through reorder/removal and rejects retired lifetimes", () => {
        const {views, renderers, container, renderer, press} = fixture();
        views.numViews = 2;
        const left = renderer(0);
        const right = renderer(1);
        renderers.registerRenderView(left as never);
        renderers.registerRenderView(right as never);
        views.focusedView = 1;
        press("e");
        expect(right.zoomOut).toHaveBeenCalledOnce();

        views.reorderViews([right.identity.id, left.identity.id]);
        press("w");
        expect(right.moveUp).toHaveBeenCalledOnce();
        expect(left.moveUp).not.toHaveBeenCalled();
        renderers.removeView(1);
        press("e");
        expect(right.zoomOut).toHaveBeenCalledTimes(2);

        views.viewIdsState.next([left.identity.id]);
        press("e");
        expect(left.zoomOut).not.toHaveBeenCalled();
        const restored = renderer(0);
        expect(restored.identity.generation).not.toBe(left.identity.generation);
        renderers.registerRenderView(restored as never);
        press("e");
        expect(restored.zoomOut).toHaveBeenCalledOnce();
        container.ngOnDestroy();
    });

    it("cleans up its shortcuts without removing a newer container's handlers", () => {
        const {renderers, container, createContainer, renderer, press} = fixture();
        const view = renderer(0);
        renderers.registerRenderView(view as never);
        const replacement = createContainer();
        container.ngOnDestroy();
        press("e");
        expect(view.zoomOut).toHaveBeenCalledOnce();
        replacement.ngOnDestroy();
        press("e");
        expect(view.zoomOut).toHaveBeenCalledOnce();
    });
});
