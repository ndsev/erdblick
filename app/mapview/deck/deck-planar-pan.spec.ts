import {WebMercatorViewport} from "@deck.gl/core";
import {describe, expect, it} from "vitest";
import {planarPanViewState} from "./deck-planar-pan";

describe("application planar pan", () => {
    it.each([
        [0, [0, 36]],
        [37, [-28, 19]]
    ] as const)("moves the centre-ground point in screen space at bearing %s", (bearing, offset) => {
        const viewport = new WebMercatorViewport({
            width: 900,
            height: 650,
            longitude: 11.12,
            latitude: 48,
            zoom: 15,
            pitch: 55,
            bearing,
            position: [250, -180, 400]
        });
        const center: [number, number] = [viewport.width / 2, viewport.height / 2];
        const ground = viewport.unproject(center, {targetZ: 0});
        const next = planarPanViewState(viewport, offset);

        expect(next).not.toBeNull();
        const moved = new WebMercatorViewport({
            width: viewport.width,
            height: viewport.height,
            ...next!
        });
        const projected = moved.project(ground);
        expect(projected[0]).toBeCloseTo(center[0] + offset[0], 4);
        expect(projected[1]).toBeCloseTo(center[1] + offset[1], 4);
        expect(next!.bearing).toBe(bearing);
        expect(next!.pitch).toBe(55);
        expect(next!.zoom).toBe(15);
    });
});
