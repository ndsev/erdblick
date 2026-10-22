import {AppStore} from "../../shared/app.store";
import {ownerTestInjector} from "../../../test/owner-test-injector";
import "@angular/compiler";
import {Subject} from "rxjs";
import {describe, expect, it, vi} from "vitest";

import {VIEW_SYNC_POSITION} from "../map-view-state.model";
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
    store: AppStore;
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
        {} as never, ownerTestInjector().get(AppStore)
    ) as unknown as CameraSyncTestInternals;
    view.store.setNumViews(2);
    view.store.updateSelectedSyncOptions([VIEW_SYNC_POSITION]);
    vi.spyOn(view.store, "setView");
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
            expect(view.store.setView).not.toHaveBeenCalled();

            callbacks[0](0);

            expect(view.mapViewState.publishLiveCameraViewState).toHaveBeenCalledOnce();
            expect(view.mapViewState.publishLiveCameraViewState.mock.calls[0][0]).toBe(0);
            expect(view.mapViewState.publishLiveCameraViewState.mock.calls[0][1])
                .toMatchObject({destination: {lon: 12.5}});
            expect(view.store.setView).not.toHaveBeenCalled();
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
            expect(view.store.setView).toHaveBeenCalledOnce();
        } finally {
            requestAnimationFrame.mockRestore();
            cancelAnimationFrame.mockRestore();
        }
    });

    it("accepts an external camera update after a no-op renderer commit", () => {
        const view = createView() as any;
        for (const name of ["clearLocationHighlightTopic", "moveToLocationAreaTopic", "liveCameraViewStateTopic",
            "presentationCameraViewStateTopic", "moveToWgs84PositionTopic", "showLocationLabelTopic", "moveToRectangleTopic"]) {
            view.mapViewState[name] = new Subject();
        }
        view.stateService.stateApplied = new Subject();
        view.configService.config$ = new Subject();
        view.mapInfo.maps$ = new Subject();
        view.mapInfo.maps = {getViewTileGridLevel: () => 13, getViewTileGridAutoLevel: () => false,
            getViewTileGridColor: () => "#ffffff", getViewTileGridOpacity: () => 100};
        view.layerController.occupancyChanged = new Subject();
        view.featureSearchService.progress = new Subject();
        view.menuService.tileOutline = new Subject();
        for (const method of ["updateBackgroundLayer", "updateContactShadingTarget", "requestRender",
            "updateLocationMarkerOverlay", "scheduleTileGridOverlayUpdate", "scheduleSearchResultsOverlayUpdate"]) {
            vi.spyOn(view, method).mockImplementation(() => {});
        }
        const applied = vi.spyOn(view, "setViewFromState").mockImplementation(() => {});
        view.setupSubscriptions();
        view.pushViewStateToAppState();
        applied.mockClear();
        view.pushViewStateToAppState(); // Same camera; native patchState emits nothing.
        expect(applied).not.toHaveBeenCalled();
        const next = {...view.store.views.cameraViewData()[view.identity.id], destination: {lon: 12, lat: 49, alt: 100}};
        view.store.setCameraViewData(0, next);
        expect(applied).toHaveBeenCalledExactlyOnceWith(next);
        view.subscriptions.forEach((subscription: {unsubscribe(): void}) => subscription.unsubscribe());
    });
});
