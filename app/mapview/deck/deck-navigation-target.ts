import type {WebMercatorViewport} from "@deck.gl/core";
import {addMetersToLngLat} from "@math.gl/web-mercator";

import type {
    NavigationAnchor,
    NavigationScreenPosition,
    NavigationSurfaceNormal,
    NavigationVisualTarget
} from "./navigation/feature-navigation.types";
import {longitudeInNearestWorld} from "./navigation/web-mercator-feature-navigation";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const TARGET_RADIUS_PX = 8;
const TARGET_CENTER_RADIUS_PX = 2.5;
const TARGET_RING_SEGMENTS = 40;
const TARGET_COLOR = "rgb(0, 229, 255)";

/** Screen-space geometry for one navigation target. */
export interface NavigationTargetProjection {
    center: NavigationScreenPosition;
    ring: NavigationScreenPosition[];
}

/**
 * Screen overlay for the navigation target.
 *
 * The target is a UI indicator rather than map geometry. Drawing its projected
 * outline in CSS pixels keeps its size independent of altitude, perspective,
 * device-pixel ratio, and transient WebGL drawing-buffer resizes.
 */
export class NavigationTargetOverlay {
    private readonly svg: SVGSVGElement;
    private readonly ring: SVGPathElement;
    private readonly center: SVGCircleElement;

    constructor(container: HTMLElement) {
        this.svg = document.createElementNS(SVG_NAMESPACE, "svg");
        this.svg.setAttribute("aria-hidden", "true");
        this.svg.setAttribute("data-testid", "navigation-target-overlay");
        this.svg.setAttribute("data-navigation-state", "clear");
        Object.assign(this.svg.style, {
            position: "absolute",
            inset: "0",
            width: "100%",
            height: "100%",
            overflow: "hidden",
            pointerEvents: "none",
            zIndex: "900",
            display: "none"
        });

        this.ring = document.createElementNS(SVG_NAMESPACE, "path");
        this.ring.setAttribute("fill", "none");
        this.ring.setAttribute("stroke", TARGET_COLOR);
        this.ring.setAttribute("stroke-width", "3");
        this.ring.setAttribute("stroke-linecap", "round");
        this.ring.setAttribute("stroke-linejoin", "round");

        this.center = document.createElementNS(SVG_NAMESPACE, "circle");
        this.center.setAttribute("r", TARGET_CENTER_RADIUS_PX.toString());
        this.center.setAttribute("fill", TARGET_COLOR);

        this.svg.append(this.ring, this.center);
        container.appendChild(this.svg);
    }

    /** Projects and displays a target, or hides it when it is outside the clip volume. */
    update(
        target: NavigationVisualTarget,
        viewport: WebMercatorViewport,
        state: "hover" | "active" = "hover"
    ): void {
        const projection = projectNavigationTarget(target, viewport);
        if (!projection) {
            this.clear();
            return;
        }
        this.ring.setAttribute("d", closedSvgPath(projection.ring));
        this.center.setAttribute("cx", projection.center[0].toString());
        this.center.setAttribute("cy", projection.center[1].toString());
        this.svg.setAttribute("data-navigation-state", state);
        this.svg.style.display = "block";
    }

    /** Hides the target without removing its reusable DOM nodes. */
    clear(): void {
        this.svg.setAttribute("data-navigation-state", "clear");
        this.svg.style.display = "none";
    }

    /** Removes the overlay from its owning map container. */
    destroy(): void {
        this.svg.remove();
    }
}

/**
 * Projects a fixed-size ring into the target's surface plane.
 *
 * For an oriented surface, the local tangent basis is projected with deck's
 * active viewport and normalized by its largest singular value. The major
 * radius is therefore exactly eight CSS pixels while the minor radius retains
 * the correct perspective foreshortening. Targets without a surface normal use
 * a screen-facing circle.
 */
export function projectNavigationTarget(
    target: NavigationVisualTarget,
    viewport: WebMercatorViewport
): NavigationTargetProjection | null {
    const position: NavigationAnchor = [
        longitudeInNearestWorld(target.position[0], viewport.longitude),
        target.position[1],
        target.position[2]
    ];
    const targetInfo = viewport.getTargetInfo(position);
    if (!targetInfo?.isValid) {
        return null;
    }
    const projectedCenter = targetInfo.projectedPosition;
    const center: NavigationScreenPosition = [projectedCenter[0], projectedCenter[1]];
    const projectedBasis = target.surfaceNormal
        ? surfacePlaneScreenBasis(position, target.surfaceNormal, viewport)
        : null;
    const first: NavigationScreenPosition = projectedBasis?.[0] ?? [TARGET_RADIUS_PX, 0];
    const second: NavigationScreenPosition = projectedBasis?.[1] ?? [0, TARGET_RADIUS_PX];
    const ring: NavigationScreenPosition[] = [];
    for (let index = 0; index < TARGET_RING_SEGMENTS; ++index) {
        const angle = index / TARGET_RING_SEGMENTS * Math.PI * 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        ring.push([
            center[0] + first[0] * cos + second[0] * sin,
            center[1] + first[1] * cos + second[1] * sin
        ]);
    }
    return {center, ring};
}

/** Returns two projected tangent-plane axes normalized to a fixed major radius. */
function surfacePlaneScreenBasis(
    position: NavigationAnchor,
    normal: NavigationSurfaceNormal,
    viewport: WebMercatorViewport
): [NavigationScreenPosition, NavigationScreenPosition] | null {
    const basis = targetPlaneBasis(normal);
    if (!basis) {
        return null;
    }
    const center = viewport.project(position);
    const firstPoint = viewport.project(offsetAnchor(position, basis[0]));
    const secondPoint = viewport.project(offsetAnchor(position, basis[1]));
    const first: NavigationScreenPosition = [
        firstPoint[0] - center[0],
        firstPoint[1] - center[1]
    ];
    const second: NavigationScreenPosition = [
        secondPoint[0] - center[0],
        secondPoint[1] - center[1]
    ];
    const scale = largestSingularValue(first, second);
    if (!Number.isFinite(scale) || scale <= 1e-6) {
        return null;
    }
    const factor = TARGET_RADIUS_PX / scale;
    return [
        [first[0] * factor, first[1] * factor],
        [second[0] * factor, second[1] * factor]
    ];
}

/** Returns two orthonormal east/north/up axes spanning a surface plane. */
function targetPlaneBasis(
    normal: NavigationSurfaceNormal
): [NavigationSurfaceNormal, NavigationSurfaceNormal] | null {
    const normalLength = Math.hypot(normal[0], normal[1], normal[2]);
    if (!Number.isFinite(normalLength) || normalLength <= 1e-6) {
        return null;
    }
    const unitNormal: NavigationSurfaceNormal = [
        normal[0] / normalLength,
        normal[1] / normalLength,
        normal[2] / normalLength
    ];
    const reference: NavigationSurfaceNormal = Math.abs(unitNormal[2]) < 0.9
        ? [0, 0, 1]
        : [1, 0, 0];
    const first: NavigationSurfaceNormal = [
        reference[1] * unitNormal[2] - reference[2] * unitNormal[1],
        reference[2] * unitNormal[0] - reference[0] * unitNormal[2],
        reference[0] * unitNormal[1] - reference[1] * unitNormal[0]
    ];
    const firstLength = Math.hypot(first[0], first[1], first[2]);
    if (!Number.isFinite(firstLength) || firstLength <= 1e-6) {
        return null;
    }
    first[0] /= firstLength;
    first[1] /= firstLength;
    first[2] /= firstLength;
    const second: NavigationSurfaceNormal = [
        unitNormal[1] * first[2] - unitNormal[2] * first[1],
        unitNormal[2] * first[0] - unitNormal[0] * first[2],
        unitNormal[0] * first[1] - unitNormal[1] * first[0]
    ];
    return [first, second];
}

/** Returns the largest singular value of a two-axis screen-space transform. */
function largestSingularValue(
    first: NavigationScreenPosition,
    second: NavigationScreenPosition
): number {
    const firstSquared = first[0] ** 2 + first[1] ** 2;
    const secondSquared = second[0] ** 2 + second[1] ** 2;
    const dot = first[0] * second[0] + first[1] * second[1];
    const largestEigenvalue = 0.5 * (
        firstSquared + secondSquared
        + Math.sqrt((firstSquared - secondSquared) ** 2 + 4 * dot ** 2)
    );
    return Math.sqrt(Math.max(0, largestEigenvalue));
}

/** Applies one local east/north/up metre offset to a WGS84 position. */
function offsetAnchor(
    position: NavigationAnchor,
    offset: NavigationSurfaceNormal
): NavigationAnchor {
    const result = addMetersToLngLat(position, offset);
    return [result[0], result[1], result[2]];
}

/** Serializes a closed screen-space polyline for the SVG target ring. */
function closedSvgPath(points: NavigationScreenPosition[]): string {
    if (!points.length) {
        return "";
    }
    return `M ${points.map(point => `${point[0]} ${point[1]}`).join(" L ")} Z`;
}
