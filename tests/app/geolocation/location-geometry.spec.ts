import {describe, expect, it} from "vitest";
import {locationExtent, locationGeometryExtent, locationPolygons} from "../../../app/geolocation/location-geometry";

const outer = [[10, 47], [14, 47], [14, 49], [10, 49], [10, 47]];
const hole = [[11, 47.5], [12, 47.5], [12, 48.5], [11, 48.5], [11, 47.5]];

describe("Location geometry validation", () => {
    it("keeps polygon holes and every multipolygon component", () => {
        const coordinates = [[outer, hole], [outer.map(([x, y]) => [x + 50, y])]];
        const polygons = locationPolygons({type: "MultiPolygon", coordinates})!;
        expect(polygons).toEqual(coordinates);
        expect(locationGeometryExtent(polygons)).toEqual({west: 10, south: 47, east: 64, north: 49});
    });

    it.each([
        {type: "Point", coordinates: [10, 47]},
        {type: "Polygon", coordinates: []},
        {type: "Polygon", coordinates: [outer, [[11, 48]]]},
        {type: "Polygon", coordinates: [outer.slice(0, -1)]},
        {type: "Polygon", coordinates: [[[0, 0], [1, 1], [0, 0], [0, 0]]]},
        {type: "Polygon", coordinates: [[[0, 0], [181, 1], [2, 1], [0, 0]]]}
    ])("rejects unsupported or incomplete boundaries as a whole", value => {
        expect(locationPolygons(value)).toBeUndefined();
    });

    it("preserves eastward dateline extents and full-world width", () => {
        expect(locationExtent([[170, 47], [15, 2]])).toEqual({west: 170, south: 47, east: 185, north: 49});
        expect(locationExtent([[-180, -90], [360, 180]])).toEqual({west: -180, south: -90, east: 180, north: 90});
        const crossing = locationPolygons({type: "Polygon", coordinates: [[[170, 47], [-175, 47], [-175, 49], [170, 49], [170, 47]]]})!;
        expect(locationGeometryExtent(crossing, locationExtent([[170, 47], [15, 2]]))).toEqual({west: 170, south: 47, east: 185, north: 49});
        expect(locationGeometryExtent(crossing).east - locationGeometryExtent(crossing).west).toBe(360);
    });

    it.each([[[0, 0], [0, 1]], [[0, 0], [1, 0]], [[0, 0], [-1, 1]], [[0, 80], [1, 11]],
        [[0, 0], [361, 1]], [[0, 0], [NaN, 1]], [[null, 0], [1, 1]]].map(extent => ({extent})))("rejects unusable area extents", ({extent}) => {
        expect(locationExtent(extent)).toBeUndefined();
    });
});
