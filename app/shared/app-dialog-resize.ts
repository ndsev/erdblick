export type AppDialogResizeCorner = "nw" | "ne" | "sw" | "se";

export interface AppDialogBounds {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface AppDialogResizeLimits {
    viewportWidth: number;
    viewportHeight: number;
    minWidth: number;
    minHeight: number;
    maxWidth: number;
    maxHeight: number;
}

/** Clamps one number to an ordered inclusive range. */
function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Resizes one horizontal or vertical interval while keeping the opposite edge fixed.
 * The effective minimum is reduced only when the available viewport itself is smaller.
 */
function resizeAxis(
    startLow: number,
    startHigh: number,
    delta: number,
    moveLowEdge: boolean,
    viewportSize: number,
    minimumSize: number,
    maximumSize: number
): [number, number] {
    const fixedEdge = moveLowEdge ? startHigh : startLow;
    const availableSize = moveLowEdge ? fixedEdge : viewportSize - fixedEdge;
    const effectiveMinimum = Math.min(Math.max(1, minimumSize), Math.max(1, availableSize));
    const effectiveMaximum = Math.max(
        effectiveMinimum,
        Math.min(Math.max(effectiveMinimum, maximumSize), Math.max(effectiveMinimum, availableSize))
    );

    if (moveLowEdge) {
        const minimumLow = Math.max(0, fixedEdge - effectiveMaximum);
        const maximumLow = fixedEdge - effectiveMinimum;
        return [clamp(startLow + delta, minimumLow, maximumLow), fixedEdge];
    }

    const minimumHigh = fixedEdge + effectiveMinimum;
    const maximumHigh = Math.min(viewportSize, fixedEdge + effectiveMaximum);
    return [fixedEdge, clamp(startHigh + delta, minimumHigh, maximumHigh)];
}

/** Calculates the viewport-clamped rectangle for one AppDialog corner-resize gesture. */
export function resizeAppDialogBounds(
    start: AppDialogBounds,
    deltaX: number,
    deltaY: number,
    corner: AppDialogResizeCorner,
    limits: AppDialogResizeLimits
): AppDialogBounds {
    const startRight = start.left + start.width;
    const startBottom = start.top + start.height;
    const [left, right] = resizeAxis(
        start.left,
        startRight,
        deltaX,
        corner.endsWith("w"),
        limits.viewportWidth,
        limits.minWidth,
        limits.maxWidth
    );
    const [top, bottom] = resizeAxis(
        start.top,
        startBottom,
        deltaY,
        corner.startsWith("n"),
        limits.viewportHeight,
        limits.minHeight,
        limits.maxHeight
    );

    return {
        left,
        top,
        width: right - left,
        height: bottom - top
    };
}
