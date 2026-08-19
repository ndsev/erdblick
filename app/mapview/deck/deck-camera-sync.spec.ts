import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";

import {VIEW_SYNC_POSITION} from "../../shared/appstate.service";
import {DeckMapView3D} from "./deck-view3d";

interface CameraSyncTestInternals {
    isCameraInteracting: boolean;
    viewState: {
        longitude: number;
        latitude: number;
        zoom: number;
        pitch: number;
        bearing: number;
        maxPitch: number;
        position: [number, number, number];
    };
    stateService: {
        numViews: number;
        viewSync: string[];
        setView: ReturnType<typeof vi.fn>;
    };
    mapViewState: {
        publishLiveCameraViewState: ReturnType<typeof vi.fn>;
    };
    scheduleViewStatePush(): void;
}

/** Creates a Deck view with only the camera synchronization collaborators installed. */
function createView(): CameraSyncTestInternals {
    const view = new DeckMapView3D(
        0,
        "canvas",
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    ) as unknown as CameraSyncTestInternals;
    view.stateService.numViews = 2;
    view.stateService.viewSync = [VIEW_SYNC_POSITION];
    view.stateService.setView = vi.fn();
    view.mapViewState.publishLiveCameraViewState = vi.fn();
    return view;
}

describe("DeckMapView split-camera synchronization", () => {
    it("coalesces renderer-local previews to the next animation frame", () => {
        const view = createView();
        const callbacks: FrameRequestCallback[] = [];
        const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame")
            .mockImplementation(callback => {
                callbacks.push(callback);
                return 17;
            });
        view.isCameraInteracting = true;

        try {
            view.scheduleViewStatePush();
            view.viewState.longitude = 12.5;
            view.scheduleViewStatePush();

            expect(requestAnimationFrame).toHaveBeenCalledOnce();
            expect(view.stateService.setView).not.toHaveBeenCalled();

            callbacks[0](0);

            expect(view.mapViewState.publishLiveCameraViewState).toHaveBeenCalledOnce();
            expect(view.mapViewState.publishLiveCameraViewState.mock.calls[0][0]).toBe(0);
            expect(view.mapViewState.publishLiveCameraViewState.mock.calls[0][1])
                .toMatchObject({destination: {lon: 12.5}});
            expect(view.stateService.setView).not.toHaveBeenCalled();
        } finally {
            requestAnimationFrame.mockRestore();
        }
    });

    it("cancels an unrendered preview and commits AppState when interaction settles", () => {
        const view = createView();
        const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame")
            .mockReturnValue(23);
        const cancelAnimationFrame = vi.spyOn(window, "cancelAnimationFrame")
            .mockImplementation(() => undefined);
        view.isCameraInteracting = true;

        try {
            view.scheduleViewStatePush();
            view.isCameraInteracting = false;
            view.scheduleViewStatePush();

            expect(cancelAnimationFrame).toHaveBeenCalledWith(23);
            expect(view.mapViewState.publishLiveCameraViewState).not.toHaveBeenCalled();
            expect(view.stateService.setView).toHaveBeenCalledOnce();
        } finally {
            requestAnimationFrame.mockRestore();
            cancelAnimationFrame.mockRestore();
        }
    });
});
