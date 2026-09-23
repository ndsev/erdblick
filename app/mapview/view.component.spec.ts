import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {MapViewComponent} from "./view.component";

describe("MapViewComponent", () => {
    it("detaches the layer controller before destroying its renderer", () => {
        const calls: string[] = [];
        const component = Object.create(MapViewComponent.prototype) as any;
        component.viewerSetupGeneration = 0;
        component.subscriptions = [];
        component.ngZone = {
            runOutsideAngular: (callback: () => Promise<void>) => callback()
        };
        component.clearPendingContextMenuOpenTimeout = vi.fn();
        component.teardownViewerContextMenuHandling = vi.fn();
        component.layerController = {
            detachScene: vi.fn(() => calls.push("detach")),
            dispose: vi.fn(() => calls.push("dispose"))
        };
        component.mapView = {
            destroy: vi.fn(async () => {
                calls.push("destroy");
            })
        };

        component.ngOnDestroy();

        expect(calls).toEqual(["detach", "destroy", "dispose"]);
        expect(component.mapView).toBeUndefined();
        expect(component.layerController).toBeUndefined();
    });
});
