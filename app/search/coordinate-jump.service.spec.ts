import "@angular/compiler";
import {Subject} from "rxjs";
import {beforeAll, describe, expect, it, vi} from "vitest";
import {ownerTestInjector} from "../../test/owner-test-injector";
import {AppActionService} from "../actions/app-action.service";
import {coreLib, initializeLibrary} from "../integrations/wasm";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {MapViewService} from "../mapview/map-view.service";
import {CoordinateJumpService} from "./coordinate-jump.service";

beforeAll(() => initializeLibrary());

function setup() {
    const renderer = {
        moveToWgs84PositionTopic: new Subject(),
        moveToRectangleTopic: new Subject(),
        showLocationLabelTopic: new Subject()
    };
    const injector = ownerTestInjector([
        CoordinateJumpService,
        MapViewStateService,
        {provide: MapViewService, useValue: renderer}
    ]);
    const coordinates = injector.get(CoordinateJumpService);
    const views = injector.get(MapViewStateService);
    views.viewIdsState.next(["left", "right"]);
    const point = vi.fn();
    const rectangle = vi.fn();
    renderer.moveToWgs84PositionTopic.subscribe(point);
    renderer.moveToRectangleTopic.subscribe(rectangle);
    return {coordinates, views, actions: injector.get(AppActionService), point, rectangle};
}

describe("coordinate owner actions", () => {
    it("routes all six parser presentations through a registered navigation operation", async () => {
        const h = setup();
        const inputs = new Map([
            ["j:packed-tile-id", String(coreLib.getTileIdFromPosition(11.75, 48.25, 13))],
            ["j:nds-x-y", "100000 200000"],
            ["j:nds-y-x", "200000 100000"],
            ["j:morton-code", "123456789"],
            ["j:wgs84-lon-lat", "11.75 48.25"],
            ["j:wgs84-lat-lon", "48.25 11.75"]
        ]);
        const dispatch = vi.spyOn(h.actions, "execute");
        for (const [parser, query] of inputs) {
            const candidate = h.coordinates.targets(query).find((item) => item.id === parser)!;
            expect(candidate.validate(query)).toBe(true);
            expect(candidate.jump).toBeUndefined();
            await candidate.execute!(query);
            expect(dispatch).toHaveBeenLastCalledWith("omnibar_coordinates", {
                parser,
                query,
                target: h.views.captureView(0)
            });
        }
        expect(h.point.mock.calls.length + h.rectangle.mock.calls.length).toBe(6);
        expect(h.views.markerControl()).toEqual({enabled: true, position: {lat: 48.25, lon: 11.75, alt: 0}});
        const before = h.views.markerControl();
        expect(() =>
            h.actions.execute("omnibar_coordinates", {
                parser: "j:wgs84-lat-lon",
                query: "not coordinates",
                target: h.views.captureView(0)
            })
        ).toThrow("Invalid coordinate input");
        expect(h.views.markerControl()).toEqual(before);
    });

    it("keeps a captured live destination across reorder and rejects a retired lifetime", async () => {
        const h = setup();
        const query = "48.25 11.75";
        const candidate = h.coordinates.targets(query).find((item) => item.id === "j:wgs84-lat-lon")!;
        h.views.reorderViews(["right", "left"]);
        await candidate.execute!(query);
        expect(h.point).toHaveBeenLastCalledWith(expect.objectContaining({targetView: 1, x: 11.75, y: 48.25}));
        h.views.viewIdsState.next(["right"]);
        h.views.viewIdsState.next(["right", "left"]);
        expect(candidate.validate(query)).toBe(false);
        await expect(candidate.execute!(query)).rejects.toThrow("no longer available");
        expect(h.point).toHaveBeenCalledOnce();

        // History reconstruction asks the owner for a fresh candidate after resolving its saved view ID.
        h.views.focusedView = 1;
        const restored = h.coordinates.targets(query).find((item) => item.id === candidate.id)!;
        await restored.execute!(query);
        expect(h.point).toHaveBeenCalledTimes(2);
    });
});
