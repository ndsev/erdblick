import type {Deck, PickingInfo} from "@deck.gl/core";
import {addMetersToLngLat} from "@math.gl/web-mercator";
import type {TileFeatureId} from "../../../shared/appstate.service";
import type {
    NavigationAnchor,
    NavigationScreenPosition,
    NavigationSurfaceNormal,
    NavigationTargetOrigin,
    NavigationVisualTarget
} from "./feature-navigation.types";

const NAVIGATION_PICK_DEPTH = 32;

/** Fixed CSS-pixel broad-phase tolerance for feature navigation. */
export const NAVIGATION_PICK_RADIUS_PIXELS = 4;

/** Picking metadata emitted by Erdblick feature-representation layers. */
export interface DeckFeaturePickLayerProps {
    tileKey?: string;
    searchResultFeatureIds?: string[];
    featureAddresses?: ArrayLike<number | null>;
    featureAddressesByPath?: ArrayLike<number | null>;
    subsetPickResolver?: (pickIndex: number) => TileFeatureId[];
    navigationAnchorEligible?: boolean;
    navigationAltitudeResolver?: (globalPickIndex: number) => number | undefined;
    markerAnchorEligible?: boolean;
    markerAnchorPositionIsWgs84?: boolean;
    drillPickEligible?: boolean;
    coordinateOrigin?: NavigationAnchor;
    anchorPositions?: ArrayLike<number>;
    surfaceNormals?: ArrayLike<number>;
    pathCenterline?: {
        positions: ArrayLike<number>;
        startIndices: ArrayLike<number>;
        coordinateOrigin: NavigationAnchor;
    };
}

/** Physical coordinate and application value accepted from one Erdblick deep pick. */
export interface NavigationAnchorPick<ValueT> {
    position: NavigationAnchor;
    surfaceNormal?: NavigationSurfaceNormal;
    origin?: NavigationTargetOrigin;
    value: ValueT;
}

/**
 * Resolves the topmost eligible physical representation whose application value
 * is accepted. When equality is supplied, a deeper representation of the same
 * feature may contribute a surface normal without changing the topmost anchor.
 */
export function pickNavigationAnchor<ValueT>(
    deck: Pick<Deck, "pickMultipleObjects">,
    screenPosition: NavigationScreenPosition,
    resolveValue: (picked: PickingInfo) => ValueT | null,
    sameValue?: (first: ValueT, second: ValueT) => boolean,
    radius = NAVIGATION_PICK_RADIUS_PIXELS,
    layerIds?: string[]
): NavigationAnchorPick<ValueT> | undefined {
    const pickedObjects = deck.pickMultipleObjects({
        x: screenPosition[0],
        y: screenPosition[1],
        radius,
        depth: NAVIGATION_PICK_DEPTH,
        ...(layerIds ? {layerIds} : {}),
        unproject3D: true
    });
    let firstMatch: NavigationAnchorPick<ValueT> | undefined;
    for (const picked of pickedObjects) {
        const target = navigationTargetFromPickingInfo({
            ...picked,
            x: screenPosition[0],
            y: screenPosition[1]
        }, radius);
        if (!target) {
            continue;
        }
        const value = resolveValue(picked);
        if (value === null) {
            continue;
        }
        if (!firstMatch) {
            firstMatch = {...target, value};
            if (target.surfaceNormal || !sameValue) {
                return firstMatch;
            }
            continue;
        }
        if (target.surfaceNormal && sameValue?.(firstMatch.value, value)) {
            return {...firstMatch, surfaceNormal: target.surfaceNormal};
        }
    }
    return firstMatch;
}

/** Returns the finite physical coordinate of an eligible camera-navigation layer. */
export function navigationAnchorFromPickingInfo(picked: PickingInfo): NavigationAnchor | null {
    return navigationTargetFromPickingInfo(picked)?.position ?? null;
}

/** Returns the finite physical target and optional surface orientation of a camera layer. */
export function navigationTargetFromPickingInfo(
    picked: PickingInfo,
    maxScreenDistancePx = NAVIGATION_PICK_RADIUS_PIXELS,
    preferPickedCoordinate = false
): NavigationVisualTarget | null {
    const layerProps = picked.layer?.props as DeckFeaturePickLayerProps | undefined;
    if (!layerProps?.navigationAnchorEligible) {
        return null;
    }
    const position = physicalAnchorFromPickingInfo(
        picked,
        layerProps,
        maxScreenDistancePx,
        preferPickedCoordinate
    );
    if (!position) {
        return null;
    }
    const surfaceNormal = surfaceNormalFromPickingInfo(picked, layerProps);
    const origin = navigationTargetOrigin(picked, layerProps);
    return surfaceNormal
        ? {position, surfaceNormal, origin}
        : {position, origin};
}

/** Classifies renderer-owned pick proxies without exposing that metadata to deck.gl. */
function navigationTargetOrigin(
    picked: PickingInfo,
    layerProps: DeckFeaturePickLayerProps
): NavigationTargetOrigin {
    if (layerProps.pathCenterline) {
        return "path";
    }
    if (String(picked.layer?.id ?? "").includes("/gltf-pick-proxy")) {
        return "gltf-proxy";
    }
    return "feature";
}

/** Returns the finite physical coordinate of an eligible persistent-marker layer. */
export function markerAnchorFromPickingInfo(picked: PickingInfo): NavigationAnchor | null {
    const layerProps = picked.layer?.props as DeckFeaturePickLayerProps | undefined;
    return layerProps?.markerAnchorEligible
        ? physicalAnchorFromPickingInfo(
            picked,
            layerProps,
            NAVIGATION_PICK_RADIUS_PIXELS
        )
        : null;
}

/** Resolves an explicitly requested depth sample before semantic geometry fallbacks. */
function physicalAnchorFromPickingInfo(
    picked: PickingInfo,
    layerProps: DeckFeaturePickLayerProps,
    maxScreenDistancePx: number,
    preferPickedCoordinate = false
): NavigationAnchor | null {
    const coordinate = picked.coordinate;
    // Custom vector shaders apply a small clip-space depth bias for stable
    // ordering. Unprojecting that biased depth produces a visually plausible
    // point whose physical altitude is wrong enough to move the controller's
    // true rotation center. Scene picks expose their physical altitude, so
    // intersect the pointer ray with that plane below instead.
    if (preferPickedCoordinate
        && !layerProps.navigationAltitudeResolver
        && coordinate
        && coordinate.length >= 3) {
        const position: NavigationAnchor = [coordinate[0], coordinate[1], coordinate[2]];
        if (position.every(Number.isFinite)) {
            return position;
        }
    }

    if (layerProps.pathCenterline) {
        const pathAnchor = nearestPathCenterlineAnchor(
            picked,
            layerProps.pathCenterline,
            maxScreenDistancePx
        );
        return pathAnchor;
    }

    const pickedIndex = Number(picked.index);
    if (layerProps.anchorPositions
        && layerProps.coordinateOrigin
        && Number.isInteger(pickedIndex)
        && pickedIndex >= 0) {
        const offset = pickedIndex * 3;
        if (offset + 2 < layerProps.anchorPositions.length) {
            return meterOffsetAnchor(
                layerProps.coordinateOrigin,
                [
                    Number(layerProps.anchorPositions[offset]),
                    Number(layerProps.anchorPositions[offset + 1]),
                    Number(layerProps.anchorPositions[offset + 2])
                ]
            );
        }
    }

    const objectPosition = picked.object?.position;
    if (Array.isArray(objectPosition) && objectPosition.length >= 3) {
        const position: NavigationAnchor = [
            Number(objectPosition[0]),
            Number(objectPosition[1]),
            Number(objectPosition[2])
        ];
        if (position.every(Number.isFinite)) {
            if (layerProps.markerAnchorPositionIsWgs84) {
                return position;
            }
            if (layerProps.coordinateOrigin) {
                return meterOffsetAnchor(layerProps.coordinateOrigin, position);
            }
        }
    }

    const globalPickIndex = Number(
        picked.object?.globalPickIndex ?? picked.index
    );
    const navigationAltitude = Number.isInteger(globalPickIndex)
        ? layerProps.navigationAltitudeResolver?.(globalPickIndex)
        : undefined;
    if (typeof navigationAltitude === "number"
        && Number.isFinite(navigationAltitude)
        && picked.viewport) {
        const screenPosition = [
            Number(picked.x) - Number(picked.viewport.x ?? 0),
            Number(picked.y) - Number(picked.viewport.y ?? 0)
        ];
        if (screenPosition.every(Number.isFinite)) {
            const unprojected = picked.viewport.unproject(
                screenPosition,
                {targetZ: navigationAltitude}
            );
            const position: NavigationAnchor = [
                Number(unprojected[0]),
                Number(unprojected[1]),
                Number(unprojected[2])
            ];
            if (position.every(Number.isFinite)) {
                return position;
            }
        }
    }

    if (!coordinate || coordinate.length < 3) {
        return null;
    }
    const position: NavigationAnchor = [coordinate[0], coordinate[1], coordinate[2]];
    return position.every(Number.isFinite) ? position : null;
}

/** Reads and normalizes one per-surface local east/north/up normal. */
function surfaceNormalFromPickingInfo(
    picked: PickingInfo,
    layerProps: DeckFeaturePickLayerProps
): NavigationSurfaceNormal | null {
    const pickedIndex = Number(picked.index);
    if (!layerProps.surfaceNormals
        || !Number.isInteger(pickedIndex)
        || pickedIndex < 0) {
        return null;
    }
    const offset = pickedIndex * 3;
    if (offset + 2 >= layerProps.surfaceNormals.length) {
        return null;
    }
    const normal: NavigationSurfaceNormal = [
        Number(layerProps.surfaceNormals[offset]),
        Number(layerProps.surfaceNormals[offset + 1]),
        Number(layerProps.surfaceNormals[offset + 2])
    ];
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    return Number.isFinite(length) && length > 1e-6
        ? [normal[0] / length, normal[1] / length, normal[2] / length]
        : null;
}

/** Converts one local meter-offset coordinate into its layer's WGS84 frame. */
function meterOffsetAnchor(
    coordinateOrigin: NavigationAnchor,
    offset: NavigationAnchor
): NavigationAnchor | null {
    const position = addMetersToLngLat(coordinateOrigin, offset);
    if (position.length < 3 || !position.every(Number.isFinite)) {
        return null;
    }
    return [position[0], position[1], position[2]];
}

/** Snaps a picked path ribbon point to the nearest point on its base XYZ centerline. */
function nearestPathCenterlineAnchor(
    picked: PickingInfo,
    path: DeckFeaturePickLayerProps["pathCenterline"],
    maxScreenDistancePx: number
): NavigationAnchor | null {
    const viewport = picked.viewport;
    const pathIndex = Number(picked.index);
    const screenPosition: NavigationScreenPosition = [
        Number(picked.x) - Number(viewport?.x ?? 0),
        Number(picked.y) - Number(viewport?.y ?? 0)
    ];
    if (!path
        || !picked.layer
        || !viewport
        || !screenPosition.every(Number.isFinite)
        || !Number.isInteger(pathIndex)
        || pathIndex < 0
        || pathIndex + 1 >= path.startIndices.length) {
        return null;
    }

    const start = Number(path.startIndices[pathIndex]);
    const end = Number(path.startIndices[pathIndex + 1]);
    if (end - start < 2) {
        return null;
    }

    let bestDistanceSquared = Number.POSITIVE_INFINITY;
    let bestSegment: {
        first: NavigationAnchor;
        second: NavigationAnchor;
        fraction: number;
    } | null = null;
    for (let vertexIndex = start; vertexIndex + 1 < end; vertexIndex++) {
        const firstOffset = vertexIndex * 3;
        const secondOffset = firstOffset + 3;
        const firstLocal: NavigationAnchor = [
            Number(path.positions[firstOffset]),
            Number(path.positions[firstOffset + 1]),
            Number(path.positions[firstOffset + 2])
        ];
        const secondLocal: NavigationAnchor = [
            Number(path.positions[secondOffset]),
            Number(path.positions[secondOffset + 1]),
            Number(path.positions[secondOffset + 2])
        ];
        const firstCommon = picked.layer.projectPosition(firstLocal, {autoOffset: false});
        const secondCommon = picked.layer.projectPosition(secondLocal, {autoOffset: false});
        const nearest = closestVisibleProjectedSegmentPoint(
            viewport.pixelProjectionMatrix,
            firstCommon,
            secondCommon,
            screenPosition
        );
        if (nearest && nearest.distanceSquared < bestDistanceSquared) {
            bestDistanceSquared = nearest.distanceSquared;
            bestSegment = {
                first: firstLocal,
                second: secondLocal,
                fraction: nearest.fraction
            };
        }
    }
    if (!bestSegment
        || bestDistanceSquared > Math.max(0, maxScreenDistancePx) ** 2) {
        return null;
    }
    const fraction = bestSegment.fraction;
    const localPosition: NavigationAnchor = [
        bestSegment.first[0] + (bestSegment.second[0] - bestSegment.first[0]) * fraction,
        bestSegment.first[1] + (bestSegment.second[1] - bestSegment.first[1]) * fraction,
        bestSegment.first[2] + (bestSegment.second[2] - bestSegment.first[2]) * fraction
    ];
    return meterOffsetAnchor(path.coordinateOrigin, localPosition);
}

interface HomogeneousProjectedPoint {
    x: number;
    y: number;
    w: number;
    fraction: number;
}

/**
 * Returns the closest visible point on one perspective-projected common-space segment.
 * Segment endpoints are clipped in homogeneous space before division, avoiding the
 * enormous false projections produced when one source vertex is behind the camera.
 */
function closestVisibleProjectedSegmentPoint(
    pixelProjectionMatrix: number[],
    first: number[],
    second: number[],
    screenPosition: NavigationScreenPosition
): {fraction: number; distanceSquared: number} | null {
    let firstProjected = homogeneousProjection(pixelProjectionMatrix, first, 0);
    let secondProjected = homogeneousProjection(pixelProjectionMatrix, second, 1);
    const minimumW = Math.max(
        1,
        Math.abs(firstProjected.w),
        Math.abs(secondProjected.w)
    ) * 1e-9;
    if (firstProjected.w <= minimumW && secondProjected.w <= minimumW) {
        return null;
    }
    if (firstProjected.w <= minimumW) {
        firstProjected = clipProjectedEndpoint(firstProjected, secondProjected, minimumW);
    } else if (secondProjected.w <= minimumW) {
        secondProjected = clipProjectedEndpoint(secondProjected, firstProjected, minimumW);
    }

    const firstScreen = [
        firstProjected.x / firstProjected.w,
        firstProjected.y / firstProjected.w
    ];
    const secondScreen = [
        secondProjected.x / secondProjected.w,
        secondProjected.y / secondProjected.w
    ];
    if (![...firstScreen, ...secondScreen].every(Number.isFinite)) {
        return null;
    }
    const dx = secondScreen[0] - firstScreen[0];
    const dy = secondScreen[1] - firstScreen[1];
    const lengthSquared = dx * dx + dy * dy;
    const screenFraction = lengthSquared > 0
        ? Math.max(0, Math.min(1, (
            (screenPosition[0] - firstScreen[0]) * dx
            + (screenPosition[1] - firstScreen[1]) * dy
        ) / lengthSquared))
        : 0;
    const nearestX = firstScreen[0] + dx * screenFraction;
    const nearestY = firstScreen[1] + dy * screenFraction;
    const denominator = screenFraction * firstProjected.w
        + (1 - screenFraction) * secondProjected.w;
    if (!Number.isFinite(denominator) || Math.abs(denominator) <= 1e-12) {
        return null;
    }
    const clippedFraction = screenFraction * firstProjected.w / denominator;
    return {
        fraction: firstProjected.fraction
            + (secondProjected.fraction - firstProjected.fraction) * clippedFraction,
        distanceSquared:
            (screenPosition[0] - nearestX) ** 2
            + (screenPosition[1] - nearestY) ** 2
    };
}

/** Multiplies one common-space position by deck's column-major pixel projection matrix. */
function homogeneousProjection(
    matrix: number[],
    position: number[],
    fraction: number
): HomogeneousProjectedPoint {
    const x = Number(position[0]);
    const y = Number(position[1]);
    const z = Number(position[2]);
    return {
        x: matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        y: matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
        w: matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15],
        fraction
    };
}

/** Clips one behind-camera homogeneous endpoint to a small positive projection divisor. */
function clipProjectedEndpoint(
    endpoint: HomogeneousProjectedPoint,
    visibleEndpoint: HomogeneousProjectedPoint,
    minimumW: number
): HomogeneousProjectedPoint {
    const fraction = (minimumW - endpoint.w) / (visibleEndpoint.w - endpoint.w);
    return {
        x: endpoint.x + (visibleEndpoint.x - endpoint.x) * fraction,
        y: endpoint.y + (visibleEndpoint.y - endpoint.y) * fraction,
        w: minimumW,
        fraction: endpoint.fraction
            + (visibleEndpoint.fraction - endpoint.fraction) * fraction
    };
}
