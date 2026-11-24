import {describe, expect, it, vi} from "vitest";
import {SpatialExtentFocus, type SpatialExtentFocusTarget} from "../../../app/mapdata/spatial-extent-focus.presentation";
import type {SpatialExtentBounds} from "../../../app/mapdata/spatial-extent.model";

describe("spatial extent focus", () => {
    it("fits all original intervals together and retains only the latest envelope per target/view", () => {
        const bounds = vi.fn((_mapId: string, layerId: string): SpatialExtentBounds[] => layerId === "A"
            ? [[-170,0,-160,1], [10,0,20,1]] : [[100,0,110,1]]);
        const focus = new SpatialExtentFocus(bounds);
        const target: SpatialExtentFocusTarget = {viewId: "left", mapId: "Map", generation: 1,
            layers: [{layerId: "A", level: 13}, {layerId: "B", level: 13}]};
        const rectangle = focus.rectangle(target)!;
        expect(rectangle).toEqual({west: 10, east: 200, south: 0, north: 1});
        rectangle.west = -999;
        expect(focus.rectangle(target)?.west).toBe(10);
        expect(bounds).toHaveBeenCalledTimes(2);
        focus.invalidateMaps(["Other"]);
        focus.retainViews(["right", "left"]);
        focus.rectangle(target);
        expect(bounds).toHaveBeenCalledTimes(2);

        focus.rectangle({...target, layers: [{layerId: "A", level: 14}]});
        expect(bounds).toHaveBeenCalledTimes(3);
        focus.rectangle({...target, generation: 2});
        expect(bounds).toHaveBeenCalledTimes(5);
        focus.invalidateMaps(["Map"]);
        focus.rectangle(target);
        expect(bounds).toHaveBeenCalledTimes(7);
        focus.rectangle({...target, viewId: "right"});
        expect(bounds).toHaveBeenCalledTimes(9);
        focus.retainViews(["right"]);
        focus.rectangle({...target, viewId: "right"});
        expect(bounds).toHaveBeenCalledTimes(9);
        focus.rectangle(target);
        expect(bounds).toHaveBeenCalledTimes(11);
        for (let generation = 3; generation < 100; ++generation) focus.rectangle({...target, generation});
        expect(focus["entries"].size).toBe(2);
        focus.clear();
        expect(focus["entries"].size).toBe(0);
    });
});
