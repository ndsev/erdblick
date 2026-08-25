import "@angular/compiler";
import {Subject} from "rxjs";
import {describe, expect, it, vi} from "vitest";

import {
    CameraViewState,
    VIEW_SYNC_MOVEMENT,
    VIEW_SYNC_POSITION
} from "../shared/appstate.service";
import {
    LiveCameraViewStateUpdate,
    MapViewStateService
} from "./map-view-state.service";

/** Builds a complete camera value with explicit target-relative position. */
function camera(
    lon: number,
    lat: number,
    alt: number,
    heading: number,
    position: [number, number, number]
): CameraViewState {
    return {
        destination: {lon, lat, alt},
        orientation: {heading, pitch: -0.5, roll: 0},
        position
    };
}

/** Creates the service with inert visualization collaborators for camera-only tests. */
function createService(cameras: CameraViewState[], viewSync: string[]) {
    const stateService = {
        numViews: cameras.length,
        focusedView: 0,
        viewSync,
        cameraViewDataState: {getValue: (viewIndex: number) => cameras[viewIndex]},
        numViewsState: new Subject<number>(),
        lod3TileThresholdState: new Subject<number>()
    };
    const mapInfo = {
        layerStateChanged: new Subject<string>(),
        reapplySyncOptionsForAllViews: vi.fn()
    };
    return {
        service: new MapViewStateService(stateService as never, mapInfo as never),
        stateService
    };
}

describe("MapViewStateService live camera synchronization", () => {
    it("routes complete position previews to sibling renderers", () => {
        const cameras = [
            camera(11, 48, 1000, 0.1, [1, 2, 3]),
            camera(12, 49, 2000, 0.2, [4, 5, 6])
        ];
        const {service} = createService(cameras, [VIEW_SYNC_POSITION]);
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
        const {service} = createService([source, target], [VIEW_SYNC_MOVEMENT]);
        const updates: Array<{cameraViewData: CameraViewState}> = [];
        service.liveCameraViewStateTopic.subscribe(update => updates.push(update));

        service.publishLiveCameraViewState(
            0,
            camera(11.25, 47.75, 4000, 0.4, [7, 8, 9])
        );

        expect(updates).toHaveLength(1);
        expect(updates[0].cameraViewData).toEqual({
            destination: {lon: 20.25, lat: 39.75, alt: 2000},
            orientation: target.orientation,
            position: target.position
        });
    });

    it("ignores previews from a view that is not focused", () => {
        const cameras = [
            camera(11, 48, 1000, 0.1, [1, 2, 3]),
            camera(12, 49, 2000, 0.2, [4, 5, 6])
        ];
        const {service, stateService} = createService(cameras, [VIEW_SYNC_POSITION]);
        const updates = vi.fn();
        service.liveCameraViewStateTopic.subscribe(updates);
        stateService.focusedView = 1;

        service.publishLiveCameraViewState(0, cameras[0]);

        expect(updates).not.toHaveBeenCalled();
    });
});
