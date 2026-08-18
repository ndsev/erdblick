import type {WebMercatorViewport} from "@deck.gl/core";

/**
 * Translates a perspective Web-Mercator camera parallel to the world plane so the
 * centre-ground point moves by the requested view-local pixel offset.
 */
export function planarPanViewState(
    viewport: WebMercatorViewport,
    pixelOffset: readonly [number, number]
): ReturnType<WebMercatorViewport["getTargetPanViewState"]> {
    const centerPixel: [number, number] = [viewport.width / 2, viewport.height / 2];
    const ground = viewport.unproject(centerPixel, {targetZ: 0});
    if (ground.length < 3 || !ground.every(Number.isFinite)) {
        return null;
    }
    return viewport.getTargetPanViewState({
        target: [ground[0], ground[1], ground[2]],
        screenPosition: [
            centerPixel[0] + pixelOffset[0],
            centerPixel[1] + pixelOffset[1]
        ]
    });
}
