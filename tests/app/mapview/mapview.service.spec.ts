import { testPersistence, stateOwners } from "../../support/state-owners";
import "@angular/compiler";
import { Subject, skip } from "rxjs";
import { describe, expect, it, vi } from "vitest";

import { CameraViewState, VIEW_SYNC_MOVEMENT, VIEW_SYNC_POSITION } from "../../../app/mapview/mapview.model";
import {
    LiveCameraViewStateUpdate,
    MapViewService,
    ViewRecalculationReason
} from "../../../app/mapview/mapview.service";
import { ViewVisualizationState } from "../../../app/mapview/view.visualization";
import type { RenderViewCameraState } from "../../../app/mapview/render-view";

/** Builds a complete camera value with explicit target-relative position. */
function camera(
    lon: number,
    lat: number,
    alt: number,
    heading: number,
    position: [number, number, number]
): CameraViewState {
    return {
        destination: { lon, lat, alt },
        orientation: { heading, pitch: -0.5, roll: 0 },
        position
    };
}

/** Creates the service with inert visualization collaborators for camera-only tests. */
function createService(cameras: CameraViewState[], viewSync: string[]) {
    const persistence = testPersistence();
    const owners = stateOwners(persistence);
    const stateService = owners.viewSettings;
    stateService.importViews(cameras.map((_, index) => String(index)));
    stateService.viewSync = viewSync;
    cameras.forEach((value, index) => stateService.cameraViewDataState.next(index, value));
    const mapInfo = { layerStateChanged: new Subject<string>(), reapplySyncOptionsForAllViews: vi.fn(), maps: { maps: new Map() } };
    return {
        service: new MapViewService(persistence, mapInfo as never, stateService, owners.configService),
        stateService, mapInfo
    };
}

describe("MapViewService live camera synchronization", () => {
    it("waits for the current camera footprint before reporting search coverage ready", async () => {
        const { service } = createService([camera(11, 48, 1000, 0, [0, 0, 0])], []);
        const state = new ViewVisualizationState();
        service["visualizationById"].set("0", state);
        const viewport = { ...state.viewport, camPosLon: 11, camPosLat: 48, width: 1, height: 1 };
        service.registerRenderView({ viewIndex: 0, viewId: "0", isAvailable: () => true, computeViewport: () => viewport } as never);
        let ready = false;
        const pending = service.waitForCurrentViewports(new AbortController().signal).then(() => { ready = true; });
        await Promise.resolve();
        expect(ready).toBe(false);
        service.viewStateChanged.next(ViewRecalculationReason.Visibility);
        await Promise.resolve();
        expect(ready).toBe(false);
        state.viewport = { ...viewport };
        service.viewStateChanged.next(ViewRecalculationReason.Viewport);
        await pending;
        expect(ready).toBe(true);
    });

    it("waits for a recreated renderer even when its retained viewport is already current", async () => {
        const { service } = createService([camera(11, 48, 1000, 0, [0, 0, 0])], []);
        const state = new ViewVisualizationState();
        service["visualizationById"].set("0", state);
        let ready = false;
        const pending = service.waitForCurrentViewports(new AbortController().signal).then(() => { ready = true; });
        await Promise.resolve();
        expect(ready).toBe(false);
        service.registerRenderView({ viewIndex: 0, viewId: "0", isAvailable: () => true, computeViewport: () => state.viewport } as never);
        await pending;
        expect(ready).toBe(true);
    });

    it("cancels viewport readiness when a presentation leaves before its renderer is ready", async () => {
        const { service } = createService([camera(11, 48, 1000, 0, [0, 0, 0])], []);
        const controller = new AbortController();
        const pending = service.waitForCurrentViewports(controller.signal);
        controller.abort();
        await expect(pending).rejects.toThrow();
    });

    it("does not let an old renderer teardown erase its replacement", () => {
        const { service } = createService([camera(0, 0, 100, 0, [0, 0, 0])], []);
        const oldView = { viewIndex: 0, viewId: "0", isAvailable: () => true };
        const nextView = { viewIndex: 0, viewId: "0", isAvailable: () => true };
        const unregisterOld = service.registerRenderView(oldView as never);
        const unregisterNext = service.registerRenderView(nextView as never);
        unregisterOld();
        expect(service.renderViewFor(0)).toBe(nextView);
        unregisterNext();
        expect(service.renderViewFor(0)).toBeUndefined();
    });

    it("changes the layout revision only for changed view counts", () => {
        const { service, stateService } = createService([camera(0, 0, 100, 0, [0, 0, 0])], []);
        vi.spyOn(service, "requestViewRecalculation").mockImplementation(() => undefined);
        expect(service.viewLayoutRevision).toBe(1);
        stateService.numViewsState.next(1);
        expect(service.viewLayoutRevision).toBe(1);
        stateService.numViewsState.next(2);
        expect(service.viewLayoutRevision).toBe(2);
        stateService.numViewsState.next(1);
        expect(service.viewLayoutRevision).toBe(3);
    });
    it("routes complete position previews to sibling renderers", () => {
        const cameras = [
            camera(11, 48, 1000, 0.1, [1, 2, 3]),
            camera(12, 49, 2000, 0.2, [4, 5, 6])
        ];
        const { service } = createService(cameras, [VIEW_SYNC_POSITION]);
        const updates: LiveCameraViewStateUpdate[] = [];
        service.liveCameraViewStateTopic.subscribe(update => updates.push(update));
        const preview = camera(13, 50, 3000, 0.3, [7, 8, 9]);

        service.publishLiveCameraViewState(0, preview);

        expect(updates).toEqual([{
            sourceView: 0,
            targetView: 1,
            cameraViewData: preview
        }]);
        expect(updates[0].cameraViewData).not.toBe(preview);
    });

    it("applies movement deltas against persisted sibling baselines", () => {
        const source = camera(11, 48, 1000, 0.1, [1, 2, 3]);
        const target = camera(20, 40, 2000, 0.9, [4, 5, 6]);
        const { service } = createService([source, target], [VIEW_SYNC_MOVEMENT]);
        const updates: Array<{ cameraViewData: CameraViewState }> = [];
        service.liveCameraViewStateTopic.subscribe(update => updates.push(update));

        service.publishLiveCameraViewState(
            0,
            camera(11.25, 47.75, 4000, 0.4, [7, 8, 9])
        );

        expect(updates).toHaveLength(1);
        expect(updates[0].cameraViewData).toEqual({
            destination: { lon: 20.25, lat: 39.75, alt: 2000 },
            orientation: target.orientation,
            position: target.position
        });
    });

    it("ignores previews from a view that is not focused", () => {
        const cameras = [
            camera(11, 48, 1000, 0.1, [1, 2, 3]),
            camera(12, 49, 2000, 0.2, [4, 5, 6])
        ];
        const { service, stateService } = createService(cameras, [VIEW_SYNC_POSITION]);
        const updates = vi.fn();
        service.liveCameraViewStateTopic.subscribe(updates);
        stateService.focusedView = 1;

        service.publishLiveCameraViewState(0, cameras[0]);

        expect(updates).not.toHaveBeenCalled();
    });
});

describe("MapViewService indexed removal", () => {
    it.each([-1, 2, 0.5, Number.NaN])("ignores invalid index %s", index => {
        const { service } = createService([camera(0, 0, 100, 0, [0, 0, 0]), camera(1, 1, 100, 0, [0, 0, 0])], []);
        const retire = vi.fn();
        service.beforeViewRemoval.subscribe(retire);
        service.removeView(index);
        expect(retire).not.toHaveBeenCalled();
    });

    it("keeps the final view", () => {
        const { service } = createService([camera(0, 0, 100, 0, [0, 0, 0])], []);
        const retire = vi.fn();
        service.beforeViewRemoval.subscribe(retire);
        service.removeView(0);
        expect(retire).not.toHaveBeenCalled();
    });

    it("retires first, compacts coverage, and preserves unconsumed camera handoffs across rapid closes", () => {
        const order: string[] = [];
        const { service, stateService: state, mapInfo } = createService([
            camera(0, 0, 100, 0, [0, 0, 0]), camera(1, 1, 100, 0, [0, 0, 0]), camera(2, 2, 100, 0, [0, 0, 0])
        ], []);
        mapInfo.reapplySyncOptionsForAllViews.mockClear();
        const retain = state.retainViews.bind(state);
        vi.spyOn(state, 'retainViews').mockImplementation((indices, cameras) => { order.push('state'); retain(indices, cameras); });
        state.numViewsState.pipe(skip(1)).subscribe(() => order.push('tree'));
        vi.spyOn(service, 'requestViewRecalculation').mockImplementation(() => order.push('coverage'));
        const states = [new ViewVisualizationState(), new ViewVisualizationState(), new ViewVisualizationState()];
        states.forEach((view, index) => service["visualizationById"].set(String(index), view));
        const handoff: RenderViewCameraState = {
            camera: camera(11, 48, 1000, 0.5, [1, 2, 3]),
            firstPerson: { position: [11, 48, 100], bearing: 42, pitch: 5 }
        };
        const subscription = service.beforeViewRemoval.subscribe(({ cameras }) => {
            order.push('retire');
            cameras.set(2, handoff);
        });

        service.removeView(0);
        expect(order).toEqual(['retire', 'state', 'tree', 'coverage']);
        expect(service.viewVisualizationState).toEqual([states[1], states[2]]);
        expect(mapInfo.reapplySyncOptionsForAllViews).not.toHaveBeenCalled();
        expect(state.retainViews).toHaveBeenCalledWith([1, 2], new Map([[2, handoff.camera]]));
        subscription.unsubscribe();

        service.removeView(0);
        expect(service.viewVisualizationState[0]).toBe(states[2]);
        expect(service.takeRetainedCamera(0)).toBe(handoff);
        expect(service.takeRetainedCamera(0)).toBeUndefined();
        expect(service.takeRetainedCamera(1)).toBeUndefined();
    });
});
