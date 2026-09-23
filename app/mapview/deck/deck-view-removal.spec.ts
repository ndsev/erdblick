import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {DeckMapView3D} from "./deck-view3d";
import type {RenderViewCameraState} from "../render-view.model";

/** Constructs a real camera owner with inert collaborators and no WebGL canvas. */
function createView() {
    const state = {setView: vi.fn(), numViews: 2, focusedView: 1, viewSync: []};
    const viewState = {setViewport: vi.fn()};
    const view = new DeckMapView3D(1, 'camera-test', {} as never, viewState as never,
        {} as never, {setHoveredFeatures: vi.fn()} as never, {} as never,
        {} as never, {} as never, state as never, {} as never,
        {setCameraInteracting: vi.fn(), clearDeckPresentationDiagnostics: vi.fn()} as never);
    return {view, state, viewState};
}

describe('Deck view removal camera handoff', () => {
    it('captures unpersisted camera motion and blocks late persistence and viewport writes', async () => {
        const {view, state, viewState} = createView();
        view['viewState'] = {...view['viewState'], longitude: 11, latitude: 48, bearing: 42, pitch: 20, position: [1, 2, 3]};
        view['isCameraInteracting'] = true;
        view['scheduleViewStatePush']();
        expect(state.setView).not.toHaveBeenCalled();

        const captured = view.prepareForViewRemoval();
        expect(captured.camera.destination.lon).toBe(11);
        expect(captured.camera.destination.lat).toBe(48);
        expect(captured.camera.position).toEqual([1, 2, 3]);
        expect(captured.camera.orientation.heading).toBeCloseTo(42 * Math.PI / 180);
        view['isCameraInteracting'] = false;
        view['scheduleViewStatePush']();
        view['updateViewport']();
        await view.destroy();
        expect(state.setView).not.toHaveBeenCalled();
        expect(viewState.setViewport).not.toHaveBeenCalled();
    });

    it('restores first-person location and look direction while retaining the return-to-map pose', async () => {
        const {view} = createView();
        const handoff: RenderViewCameraState = {
            camera: {destination: {lon: 11, lat: 48, alt: 1000},
                orientation: {heading: 0.5, pitch: -0.8, roll: 0}, position: [0, 0, 0]},
            firstPerson: {position: [11.1, 48.2, 120], bearing: 72, pitch: -12}
        };
        view.restoreCameraState(handoff);
        expect(view.isFirstPersonViewActive()).toBe(true);
        const captured = view.prepareForViewRemoval();
        expect(captured.firstPerson).toEqual({
            position: [expect.closeTo(11.1), 48.2, 120], bearing: 72, pitch: -12
        });
        expect(captured.camera.destination.lon).toBeCloseTo(11);
        expect(captured.camera.destination.lat).toBeCloseTo(48);
        expect(captured.camera.destination.alt).toBeCloseTo(1000);
        view.exitFirstPersonView();
        expect(view.isFirstPersonViewActive()).toBe(false);
        expect(view.prepareForViewRemoval().camera).toEqual(captured.camera);
        await view.destroy();
    });
});
