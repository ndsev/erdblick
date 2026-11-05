import { COORDINATE_SYSTEM } from "@deck.gl/core";
import { PolygonLayer } from "@deck.gl/layers";
import type { Color } from "../../integrations/geo.adapter";
import { DECK_OVERLAY_PARAMETERS } from "./deck-overlay.constants";

/** Shared rectangle overlay datum for tile outlines and jump-area highlights. */
interface DeckRectangleOverlayDatum {
    polygon: [number, number][];
    fillColor: [number, number, number, number];
    lineColor: [number, number, number, number];
    lineWidthPixels: number;
}

/** Inserts or replaces one rectangle overlay layer with depth testing disabled. */
export function createRectangleOverlayLayer(
    layerKey: string,
    data: DeckRectangleOverlayDatum[]
): PolygonLayer<DeckRectangleOverlayDatum> {
    const layer = new PolygonLayer<DeckRectangleOverlayDatum>({
        id: layerKey,
        data,
        getPolygon: (datum: DeckRectangleOverlayDatum) => datum.polygon,
        getFillColor: (datum: DeckRectangleOverlayDatum) => datum.fillColor,
        getLineColor: (datum: DeckRectangleOverlayDatum) => datum.lineColor,
        getLineWidth: (datum: DeckRectangleOverlayDatum) => datum.lineWidthPixels,
        lineWidthUnits: "pixels",
        coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
        filled: true,
        stroked: true,
        extruded: false,
        wrapLongitude: false,
        pickable: false,
        parameters: DECK_OVERLAY_PARAMETERS
    });
    return layer;
}

/** Converts one rectangle into one or more overlay data records depending on world-wrap needs. */
export function rectangleOverlayData(
    west: number,
    south: number,
    east: number,
    north: number,
    fillColor: [number, number, number, number],
    lineColor: [number, number, number, number],
    lineWidthPixels: number
): DeckRectangleOverlayDatum[] {
    return rectangleOverlayPolygons(west, south, east, north).map(polygon => ({
        polygon,
        fillColor,
        lineColor,
        lineWidthPixels
    }));
}

/** Splits a wrapped rectangle into multiple polygons when it spans the full world. */
export function rectangleOverlayPolygons(
    west: number,
    south: number,
    east: number,
    north: number
): [number, number][][] {
    if (east - west >= 360 - 1e-6) {
        return [
            [
                [-180, south],
                [-180, north],
                [0, north],
                [0, south]
            ],
            [
                [0, south],
                [0, north],
                [180, north],
                [180, south]
            ]
        ];
    }
    return [[
        [west, south],
        [west, north],
        [east, north],
        [east, south]
    ]];
}

/** Converts Cesium-style colors to deck RGBA tuples with a caller-supplied fallback. */
export function toDeckColor(
    color: Color | undefined,
    fallback: [number, number, number, number]
): [number, number, number, number] {
    if (!color) {
        return fallback;
    }
    return [
        Math.max(0, Math.min(255, Math.round(color.r * 255))),
        Math.max(0, Math.min(255, Math.round(color.g * 255))),
        Math.max(0, Math.min(255, Math.round(color.b * 255))),
        Math.max(0, Math.min(255, Math.round(color.a * 255)))
    ];
}
