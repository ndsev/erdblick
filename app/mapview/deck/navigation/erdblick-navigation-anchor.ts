import type {Deck, PickingInfo} from "@deck.gl/core";
import {addMetersToLngLat} from "@math.gl/web-mercator";
import type {TileFeatureId} from "../../../shared/appstate.service";
import type {NavigationAnchor, NavigationScreenPosition} from "./feature-navigation.types";

const NAVIGATION_PICK_DEPTH = 10;

/** Picking metadata emitted by Erdblick feature-representation layers. */
export interface DeckFeaturePickLayerProps {
    tileKey?: string;
    searchResultFeatureIds?: string[];
    featureAddresses?: ArrayLike<number | null>;
    featureAddressesByPath?: ArrayLike<number | null>;
    subsetPickResolver?: (pickIndex: number) => TileFeatureId[];
    navigationAnchorEligible?: boolean;
    markerAnchorEligible?: boolean;
    markerAnchorPositionIsWgs84?: boolean;
    drillPickEligible?: boolean;
    coordinateOrigin?: NavigationAnchor;
    anchorPositions?: ArrayLike<number>;
    pathCenterline?: {
        positions: ArrayLike<number>;
        startIndices: ArrayLike<number>;
        coordinateOrigin: NavigationAnchor;
    };
}

/** Physical coordinate and application value accepted from one Erdblick deep pick. */
export interface NavigationAnchorPick<ValueT> {
    position: NavigationAnchor;
    value: ValueT;
}

/**
 * Resolves the first eligible physical representation whose application value
 * is accepted, continuing behind non-navigation layers and unresolved features.
 */
export function pickNavigationAnchor<ValueT>(
    deck: Pick<Deck, "pickMultipleObjects">,
    screenPosition: NavigationScreenPosition,
    resolveValue: (picked: PickingInfo) => ValueT | null
): NavigationAnchorPick<ValueT> | undefined {
    const pickedObjects = deck.pickMultipleObjects({
        x: screenPosition[0],
        y: screenPosition[1],
        radius: 0,
        depth: NAVIGATION_PICK_DEPTH,
        unproject3D: true
    });
    for (const picked of pickedObjects) {
        const position = navigationAnchorFromPickingInfo(picked);
        if (!position) {
            continue;
        }
        const value = resolveValue(picked);
        if (value !== null) {
            return {position, value};
        }
    }
    return undefined;
}

/** Returns the finite physical coordinate of an eligible camera-navigation layer. */
export function navigationAnchorFromPickingInfo(picked: PickingInfo): NavigationAnchor | null {
    const layerProps = picked.layer?.props as DeckFeaturePickLayerProps | undefined;
    return layerProps?.navigationAnchorEligible
        ? physicalAnchorFromPickingInfo(picked, layerProps)
        : null;
}

/** Returns the finite physical coordinate of an eligible persistent-marker layer. */
export function markerAnchorFromPickingInfo(picked: PickingInfo): NavigationAnchor | null {
    const layerProps = picked.layer?.props as DeckFeaturePickLayerProps | undefined;
    return layerProps?.markerAnchorEligible
        ? physicalAnchorFromPickingInfo(picked, layerProps)
        : null;
}

/** Resolves geometry metadata before falling back to deck.gl's depth coordinate. */
function physicalAnchorFromPickingInfo(
    picked: PickingInfo,
    layerProps: DeckFeaturePickLayerProps
): NavigationAnchor | null {
    const pathPosition = nearestPathCenterlineAnchor(picked, layerProps.pathCenterline);
    if (pathPosition) {
        return pathPosition;
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

    const coordinate = picked.coordinate;
    if (!coordinate || coordinate.length < 3) {
        return null;
    }
    const position: NavigationAnchor = [coordinate[0], coordinate[1], coordinate[2]];
    return position.every(Number.isFinite) ? position : null;
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
    path: DeckFeaturePickLayerProps["pathCenterline"]
): NavigationAnchor | null {
    const viewport = picked.viewport;
    const coordinate = picked.coordinate;
    const pathIndex = Number(picked.index);
    if (!path
        || !viewport
        || !coordinate
        || coordinate.length < 3
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

    const pickedCommon = viewport.projectPosition(coordinate);
    let bestDistanceSquared = Number.POSITIVE_INFINITY;
    let bestLocalPosition: NavigationAnchor | null = null;
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
        const firstWgs84 = addMetersToLngLat(path.coordinateOrigin, firstLocal);
        const secondWgs84 = addMetersToLngLat(path.coordinateOrigin, secondLocal);
        const firstCommon = viewport.projectPosition(firstWgs84);
        const secondCommon = viewport.projectPosition(secondWgs84);
        const segment = [
            secondCommon[0] - firstCommon[0],
            secondCommon[1] - firstCommon[1],
            secondCommon[2] - firstCommon[2]
        ];
        const segmentLengthSquared =
            segment[0] * segment[0]
            + segment[1] * segment[1]
            + segment[2] * segment[2];
        const fraction = segmentLengthSquared > 0
            ? Math.max(0, Math.min(1, (
                (pickedCommon[0] - firstCommon[0]) * segment[0]
                + (pickedCommon[1] - firstCommon[1]) * segment[1]
                + (pickedCommon[2] - firstCommon[2]) * segment[2]
            ) / segmentLengthSquared))
            : 0;
        const nearestCommon = [
            firstCommon[0] + segment[0] * fraction,
            firstCommon[1] + segment[1] * fraction,
            firstCommon[2] + segment[2] * fraction
        ];
        const distanceSquared =
            Math.pow(pickedCommon[0] - nearestCommon[0], 2)
            + Math.pow(pickedCommon[1] - nearestCommon[1], 2)
            + Math.pow(pickedCommon[2] - nearestCommon[2], 2);
        if (distanceSquared < bestDistanceSquared) {
            bestDistanceSquared = distanceSquared;
            bestLocalPosition = [
                firstLocal[0] + (secondLocal[0] - firstLocal[0]) * fraction,
                firstLocal[1] + (secondLocal[1] - firstLocal[1]) * fraction,
                firstLocal[2] + (secondLocal[2] - firstLocal[2]) * fraction
            ];
        }
    }
    return bestLocalPosition
        ? meterOffsetAnchor(path.coordinateOrigin, bestLocalPosition)
        : null;
}
