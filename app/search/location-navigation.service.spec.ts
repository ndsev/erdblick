import "@angular/compiler";
import {BehaviorSubject, Observable, Subject, of} from "rxjs";
import {describe, expect, it, vi} from "vitest";
import {ownerTestInjector} from "../../test/owner-test-injector";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {MapViewService} from "../mapview/map-view.service";
import {ViewLayerDiagnosticsService} from "../mapview/view-layer-diagnostics.service";
import {AppStateService} from "../shared/appstate.service";
import {InfoMessageService} from "../shared/info.service";
import {JumpTargetService} from "./jump.service";
import {LocationNavigationService} from "./location-navigation.service";
import {LocationSearchService, ResolvedLocationNavigation} from "./location.search.service";

const areaResult: ResolvedLocationNavigation = {area: {label: "Place", rectangle: {west: 10, south: 47, east: 14, north: 49}}};

/** Creates controlled transport and renderer lifecycles without bootstrapping the map. */
function setup() {
    const response = new Subject<ResolvedLocationNavigation>();
    const locations = {
        resolveNavigation: vi.fn<() => Observable<ResolvedLocationNavigation>>(() => response),
        createSearchTarget: (match: {id: string; name: string}) => ({id: `loc:mapget-offline:${match.id}`,
            name: match.name, label: match.name, icon: "location_city", color: "green", enabled: true,
            payload: match, validate: () => true})
    };
    const camera = {destination: {lon: 1, lat: 2, alt: 300}, orientation: {heading: 0, pitch: -90, roll: 0}};
    const renderer = {rendererInvalidated: new Subject<void>(), getLiveCameraState: () => camera,
        isCameraInteractionActive: () => false, getCanvasClientRect: () => ({width: 600, height: 400}),
        onTick: vi.fn(), offTick: vi.fn()};
    const views = {renderViewFor: vi.fn(() => renderer), viewLayoutRevision: 0,
        moveToLocationAreaTopic: new Subject(), moveToRectangleTopic: new Subject(), moveToWgs84PositionTopic: new Subject(),
        clearLocationHighlightTopic: new Subject(), showLocationLabelTopic: new Subject(), presentationCameraViewStateTopic: new Subject(),
        locationBoundaryUnavailableTopic: new Subject<void>(), navigationStarted: new Subject<void>()};
    const diagnostics = {cameraInteracting: false, cameraInteracting$: new BehaviorSubject(false)};
    const jumps = {markedPosition: new Subject()};
    const messages = {showError: vi.fn(), showInfo: vi.fn()};
    const injector = ownerTestInjector([LocationNavigationService, MapViewStateService,
        {provide: LocationSearchService, useValue: locations}, {provide: MapViewService, useValue: views},
        {provide: ViewLayerDiagnosticsService, useValue: diagnostics},
        {provide: JumpTargetService, useValue: jumps}, {provide: InfoMessageService, useValue: messages}]);
    const persistence = injector.get(AppStateService);
    const viewState = injector.get(MapViewStateService);
    viewState.viewIdsState.next(["left", "right"]);
    viewState.cameraViewDataState.next(0, {...camera, position: [0, 0, 0]});
    const service = injector.get(LocationNavigationService);
    const area = vi.fn(), point = vi.fn(), marker = vi.fn();
    views.moveToLocationAreaTopic.subscribe(area);
    views.moveToWgs84PositionTopic.subscribe(point);
    jumps.markedPosition.subscribe(marker);
    return {service, response, locations, renderer, views, viewState, persistence, diagnostics, jumps, messages, area, point, marker};
}


describe("Location navigation ownership", () => {
    it("uses the typed candidate for a live lookup and rebuilds history after retirement", async () => {
        const h = setup();
        const match = {id: "wof:1", name: "Place", providerId: "mapget-offline", providerName: "Mapget"};
        const candidate = h.service.createTarget(match);
        await candidate.execute!("Place");
        expect(h.locations.resolveNavigation).toHaveBeenCalledWith("loc:mapget-offline:wof:1", match);
        h.viewState.viewIdsState.next(["right"]);
        h.viewState.viewIdsState.next(["left", "right"]);
        h.response.next(areaResult);
        expect(h.area).not.toHaveBeenCalled();
        await expect(candidate.execute!("Place")).rejects.toThrow("no longer available");
        h.locations.resolveNavigation.mockReturnValueOnce(of(areaResult));
        h.viewState.focusedView = 0;
        h.service.runFromHistory(candidate.id, match);
        expect(h.area).toHaveBeenCalledExactlyOnceWith({targetView: 0, area: areaResult.area});
    });

    it("commits an area once without creating a point marker", () => {
        const h = setup();
        h.service.navigate("loc:mapget-offline:wof:1");
        expect(h.area).not.toHaveBeenCalled();
        expect(h.point).not.toHaveBeenCalled();
        h.response.next(areaResult);
        expect(h.area).toHaveBeenCalledExactlyOnceWith({targetView: 0, area: areaResult.area});
        expect(h.marker).not.toHaveBeenCalled();
        expect(h.response.observed).toBe(false);
    });

    it("preserves representative-point marker and altitude behavior", () => {
        const h = setup();
        h.service.navigate("point");
        h.response.next({point: [11, 48], label: "Place"});
        expect(h.point).toHaveBeenCalledExactlyOnceWith({targetView: 0, x: 11, y: 48, z: 300});
        expect(h.marker).toHaveBeenCalledExactlyOnceWith([48, 11, 0]);
    });

    it.each(["focus", "gesture", "renderer", "layout", "camera", "reset", "point", "rectangle", "async navigation", "cancel"])(
        "discards delayed responses after %s, without fallback notices", event => {
            const h = setup();
            h.service.navigate("area");
            if (event === "focus") { h.viewState.focusedView = 1; }
            if (event === "gesture") h.diagnostics.cameraInteracting$.next(true);
            if (event === "renderer") h.renderer.rendererInvalidated.next();
            if (event === "layout") h.viewState.retainViews([1], new Map());
            if (event === "camera") { h.renderer.getLiveCameraState = () => ({destination: {lon: 3, lat: 4, alt: 500}, orientation: {heading: 0, pitch: -90, roll: 0}}); h.viewState.cameraViewDataState.next(0, {...h.viewState.cameraViewDataState.getValue(0), destination: {lon: 3, lat: 4, alt: 500}}); }
            if (event === "reset") h.persistence.stateApplied.next();
            if (event === "point") h.views.moveToWgs84PositionTopic.next({});
            if (event === "rectangle") h.views.moveToRectangleTopic.next({});
            if (event === "async navigation") h.views.navigationStarted.next();
            if (event === "cancel") h.service.cancel();
            h.response.next({...areaResult, notice: "Fallback"});
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
        h.renderer.getCanvasClientRect = () => ({width: 0, height: 0});
        h.service.navigate("area");
        h.response.next(areaResult);
        expect(h.area).not.toHaveBeenCalled();
        expect(h.renderer.onTick).toHaveBeenCalledOnce();
        h.service.cancel();
        expect(h.renderer.offTick).toHaveBeenCalledOnce();
    });
});
