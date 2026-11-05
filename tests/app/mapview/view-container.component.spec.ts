import "@angular/compiler";
import { RendererFactory2 } from "@angular/core";
import { Subject } from "rxjs";
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from "vitest";
import { stateOwners, testPersistence } from "../../support/state-owners";
import { KeyboardService } from "../../../app/keyboard/keyboard.service";
import { MapViewService } from "../../../app/mapview/mapview.service";
import { MapViewContainerComponent } from "../../../app/mapview/view-container.component";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(destroy => destroy()));

/** Exercises real keyboard registration and logical-view/renderer ownership without Deck. */
function createContainer() {
    const persistence = testPersistence();
    const owners = stateOwners(persistence);
    owners.viewSettings.importViews(["left", "right"]);
    let keydown!: (event: KeyboardEvent) => void;
    const keyboard = new KeyboardService({
        createRenderer: () => ({
            listen: (_target: unknown, _event: string, callback: typeof keydown) => {
                keydown = callback;
                return () => undefined;
            }
        })
    } as unknown as RendererFactory2, {} as never);
    cleanup.push(() => keyboard.ngOnDestroy());
    const mapViews = new MapViewService(
        persistence,
        {
            layerStateChanged: new Subject(),
            reapplySyncOptionsForAllViews: vi.fn(),
            maps: { maps: new Map() }
        } as never,
        owners.viewSettings, owners.configService
    );
    const mount = () => {
        const component = new MapViewContainerComponent(
            persistence, keyboard, {} as never, owners.viewSettings, owners.layout.state, mapViews
        );
        cleanup.push(() => component.ngOnDestroy());
        return component;
    };
    const component = mount();
    const renderer = (viewId: string) => ({
        viewId,
        isAvailable: () => true,
        zoomIn: vi.fn(), zoomOut: vi.fn(),
        moveUp: vi.fn(), moveLeft: vi.fn(), moveDown: vi.fn(), moveRight: vi.fn(),
        resetOrientation: vi.fn()
    });
    const press = (key: string, ctrlKey = false) => keydown(new KeyboardEvent("keydown", { key, ctrlKey }));
    return { component, mount, mapViews, views: owners.viewSettings, renderer, press };
}

describe("focused view keyboard commands", () => {
    it("resolves a renderer attached after the container without replaying unchanged focus", () => {
        const fixture = createContainer();
        fixture.press("q");
        const left = fixture.renderer("left");
        fixture.mapViews.registerRenderView(left as never);

        fixture.press("q");
        fixture.press("e");
        fixture.press("w");
        fixture.press("a");
        fixture.press("s");
        fixture.press("d");
        fixture.press("r");

        for (const method of [left.zoomIn, left.zoomOut, left.moveUp, left.moveLeft,
            left.moveDown, left.moveRight, left.resetOrientation]) {
            expect(method).toHaveBeenCalledOnce();
        }
    });

    it("follows logical focus through reorder and removal", () => {
        const fixture = createContainer();
        const left = fixture.renderer("left");
        const right = fixture.renderer("right");
        fixture.mapViews.registerRenderView(left as never);
        fixture.mapViews.registerRenderView(right as never);
        fixture.press("ArrowRight", true);
        expect(fixture.views.focusedViewIdState.value).toBe("right");
        fixture.press("q");
        expect(right.zoomIn).toHaveBeenCalledTimes(1);

        fixture.views.importViews(["right", "left"]);
        fixture.press("q");
        expect(right.zoomIn).toHaveBeenCalledTimes(2);
        fixture.views.importViews(["left"]);
        fixture.press("q");
        expect(left.zoomIn).toHaveBeenCalledOnce();
        expect(right.zoomIn).toHaveBeenCalledTimes(2);

        fixture.views.importViews(["left", "right"]);
        fixture.views.focusedView = 1;
        fixture.press("q");
        expect(right.zoomIn).toHaveBeenCalledTimes(2);
        const restored = fixture.renderer("right");
        fixture.mapViews.registerRenderView(restored as never);
        fixture.press("q");
        expect(restored.zoomIn).toHaveBeenCalledOnce();
    });

    it("uses the current renderer generation and unregisters only its own callbacks", () => {
        const fixture = createContainer();
        const old = fixture.renderer("left");
        const replacement = fixture.renderer("left");
        const retireOld = fixture.mapViews.registerRenderView(old as never);
        fixture.mapViews.registerRenderView(replacement as never);
        retireOld();
        fixture.press("q");
        expect(old.zoomIn).not.toHaveBeenCalled();
        expect(replacement.zoomIn).toHaveBeenCalledOnce();

        const nextContainer = fixture.mount();
        fixture.component.ngOnDestroy();
        fixture.press("q");
        expect(replacement.zoomIn).toHaveBeenCalledTimes(2);
        nextContainer.ngOnDestroy();
        fixture.press("q");
        fixture.press("ArrowRight", true);
        expect(replacement.zoomIn).toHaveBeenCalledTimes(2);
        expect(fixture.views.focusedViewIdState.value).toBe("left");
    });
});
