import { testPersistence, stateOwners } from "../../support/state-owners";
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import {
    BehaviorSubject,
    Observable,
    Subject,
    of
} from "rxjs";
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from "vitest";
import { MapViewService } from "../../../app/mapview/mapview.service";
import { ViewLayerDiagnosticsService } from "../../../app/mapview/view-layer-diagnostics.service";
import { AppStateService } from "../../../app/appstate/appstate.service";
import { InfoMessageService } from "../../../app/diagnostics/info.service";
import { JumpTargetService } from "../../../app/navigation/jump.service";
import { GeolocationService, ResolvedLocationNavigation } from "../../../app/geolocation/geolocation.service";
import { LocationNavigationService } from "../../../app/navigation/location-navigation.service";

const areaResult: ResolvedLocationNavigation = { area: { label: "Place", rectangle: { west: 10, south: 47, east: 14, north: 49 } } };

/** Creates controlled transport and renderer lifecycles without bootstrapping the map. */
function setup() {
    const response = new Subject<ResolvedLocationNavigation>();
    const locations = { resolveNavigation: vi.fn<() => Observable<ResolvedLocationNavigation>>(() => response) };
    const camera = { destination: { lon: 1, lat: 2, alt: 300 }, orientation: { heading: 0, pitch: -90, roll: 0 } };
    const renderer = {
        rendererInvalidated: new Subject<void>(), getLiveCameraState: () => camera,
        isCameraInteractionActive: () => false, getCanvasClientRect: () => ({ width: 600, height: 400 }),
        onTick: vi.fn(), offTick: vi.fn()
    };
    const state = testPersistence();
    const viewSettings = stateOwners(state).viewSettings;
    viewSettings.importViews(['first', 'second']);
    viewSettings.cameraViewDataState.next(0, camera);
    const views = {
        generation: 1, captureView: () => ({ viewId: viewSettings.focusedViewIdState.value, generation: views.generation }),
        resolveCapturedView: (target: { viewId: string; generation: number }) => target.generation === views.generation && viewSettings.viewIds.includes(target.viewId) ? renderer : undefined,
        moveToLocationAreaTopic: new Subject(), moveToRectangleTopic: new Subject(), moveToWgs84PositionTopic: new Subject(),
        clearLocationHighlightTopic: new Subject(), showLocationLabelTopic: new Subject(), presentationCameraViewStateTopic: new Subject(),
        locationBoundaryUnavailableTopic: new Subject<void>(), navigationStarted: new Subject<void>()
    };
    const diagnostics = { cameraInteracting: false, cameraInteracting$: new BehaviorSubject(false) };
    const jumps = { markedPosition: new Subject() };
    const messages = { showError: vi.fn(), showInfo: vi.fn() };
    const service = new LocationNavigationService(locations as never, views as never, state, diagnostics as never,
        jumps as never, messages as never, viewSettings, {} as never, {} as never, {} as never);
    const area = vi.fn(), point = vi.fn(), marker = vi.fn();
    views.moveToLocationAreaTopic.subscribe(area);
    views.moveToWgs84PositionTopic.subscribe(point);
    jumps.markedPosition.subscribe(marker);
    return { viewSettings, service, response, locations, renderer, views, state, diagnostics, jumps, messages, area, point, marker };
}

afterEach(() => TestBed.resetTestingModule());

describe("Location navigation ownership", () => {
    it("commits an area once without creating a point marker", () => {
        const h = setup();
        h.service.navigate("loc:mapget-offline:wof:1");
        expect(h.area).not.toHaveBeenCalled();
        expect(h.point).not.toHaveBeenCalled();
        h.response.next(areaResult);
        expect(h.area).toHaveBeenCalledExactlyOnceWith({ targetView: 0, area: areaResult.area });
        expect(h.marker).not.toHaveBeenCalled();
        expect(h.response.observed).toBe(false);
    });

    it('follows the captured logical target when views reorder during lookup', () => {
        const h = setup();
        h.service.navigate('area');
        h.viewSettings.retainViews([1, 0], new Map());
        h.response.next(areaResult);
        expect(h.area).toHaveBeenCalledExactlyOnceWith({ targetView: 1, area: areaResult.area });
    });

    it("preserves representative-point marker and altitude behavior", () => {
        const h = setup();
        h.service.navigate("point");
        h.response.next({ point: [11, 48], label: "Place" });
        expect(h.point).toHaveBeenCalledExactlyOnceWith({ targetView: 0, x: 11, y: 48, z: 300 });
        expect(h.marker).toHaveBeenCalledExactlyOnceWith([48, 11, 0]);
    });

    it.each(["focus", "gesture", "renderer", "layout", "camera", "reset", "point", "rectangle", "async navigation", "cancel"])(
        "discards delayed responses after %s, without fallback notices", event => {
            const h = setup();
            h.service.navigate("area");
            if (event === "focus") { h.viewSettings.focusedView = 1; }
            if (event === "gesture") h.diagnostics.cameraInteracting$.next(true);
            if (event === "renderer") h.renderer.rendererInvalidated.next();
            if (event === "layout") h.views.generation++;
            if (event === "camera") { h.renderer.getLiveCameraState = () => ({ destination: { lon: 3, lat: 4, alt: 500 }, orientation: { heading: 0, pitch: -90, roll: 0 } }); h.viewSettings.cameraViewDataState.next(0, h.renderer.getLiveCameraState()); }
            if (event === "reset") h.state.stateApplied.next();
            if (event === "point") h.views.moveToWgs84PositionTopic.next({});
            if (event === "rectangle") h.views.moveToRectangleTopic.next({});
            if (event === "async navigation") h.views.navigationStarted.next();
            if (event === "cancel") h.service.cancel();
            h.response.next({ ...areaResult, notice: "Fallback" });
            expect(h.area).not.toHaveBeenCalled();
            expect(h.messages.showInfo).not.toHaveBeenCalled();
            expect(h.messages.showError).not.toHaveBeenCalled();
            expect(h.response.observed).toBe(false);
        });

    it("unsubscribes a superseded lookup and accepts a synchronous replacement", () => {
        const h = setup();
        h.service.navigate("first");
        h.locations.resolveNavigation.mockReturnValueOnce(of(areaResult));
        h.service.navigate("second");
        expect(h.response.observed).toBe(false);
        expect(h.area).toHaveBeenCalledOnce();
        h.response.next(areaResult);
        expect(h.area).toHaveBeenCalledOnce();
    });

    it("waits for a visible pane and releases its frame callback on cancellation", () => {
        const h = setup();
        h.renderer.getCanvasClientRect = () => ({ width: 0, height: 0 });
        h.service.navigate("area");
        h.response.next(areaResult);
        expect(h.area).not.toHaveBeenCalled();
        expect(h.renderer.onTick).toHaveBeenCalledOnce();
        h.service.cancel();
        expect(h.renderer.offTick).toHaveBeenCalledOnce();
    });
});
