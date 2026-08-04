import {
    isValidSurfaceRingTopology,
    surfaceRingNormal,
    triangulateSurfaceIndices
} from "./surface-triangulation";
import type {
    TileSubsetPathBuffers,
    TileSubsetPointBuffers,
    TileSubsetSurfaceBuffers
} from "./tile-subset-layer-render.worker.protocol";
import {
    packVariablePathOffsetVectors,
    quantizeVariablePathOffsetScaleThreshold
} from "./deck-variable-path-offset.extension";

export interface DeckBinaryAttribute<T extends ArrayLike<number>> {
    value: T;
    size: number;
}

export interface DeckPathData {
    length: number;
    billboard: boolean;
    depthTest: boolean;
    coordinateOrigin: [number, number, number];
    startIndices: Uint32Array;
    featureAddressesByPath: Uint32Array;
    glowColors?: Uint8Array;
    glowRadii?: Float32Array;
    /** Per-vertex local XY pixel vectors retained for copying/arena merges. */
    offsetVectorsPx?: Float32Array;
    /** Quantized metres-per-pixel adaptive scale threshold per path. */
    offsetScaleThresholds?: Float32Array;
    attributes: {
        getPath: DeckBinaryAttribute<Float32Array>;
        instanceColors: DeckBinaryAttribute<Uint8Array>;
        instanceStrokeWidths: DeckBinaryAttribute<Float32Array>;
        instanceOffsets: DeckBinaryAttribute<Float32Array>;
        instanceVariableOffsets?: DeckBinaryAttribute<Uint32Array>;
        instanceDashArrays?: DeckBinaryAttribute<Float32Array>;
        instancePickingColors?: DeckBinaryAttribute<Uint8Array>;
    };
}

export interface DeckPointData {
    length: number;
    billboard: boolean;
    depthTest: boolean;
    coordinateOrigin: [number, number, number];
    featureAddresses: Uint32Array;
    glowColors?: Uint8Array;
    glowRadii?: Float32Array;
    attributes: {
        getPosition: DeckBinaryAttribute<Float32Array>;
        getFillColor: DeckBinaryAttribute<Uint8Array>;
        getRadius: DeckBinaryAttribute<Float32Array>;
        instancePickingColors?: DeckBinaryAttribute<Uint8Array>;
    };
}

export interface DeckSurfaceData {
    length: number;
    depthTest: boolean;
    coordinateOrigin: [number, number, number];
    startIndices: Uint32Array;
    featureAddresses: Uint32Array;
    surfaceNormals: Float32Array;
    glowColors?: Uint8Array;
    glowRadii?: Float32Array;
    attributes: {
        getPolygon: DeckBinaryAttribute<Float32Array>;
        indices: DeckBinaryAttribute<Uint32Array>;
        fillColors: DeckBinaryAttribute<Uint8Array>;
        pickingColors?: DeckBinaryAttribute<Uint8Array>;
    };
}

export interface DeckArrowMarker {
    featureAddress: number;
    position: [number, number, number];
    color: [number, number, number, number];
    sizePx: number;
    angleDeg: number;
    pixelOffset: [number, number];
    /** Local XY displacement plus its adaptive metres-per-pixel threshold. */
    localPixelOffset: [number, number, number];
}

const MAX_PATHS = 1_000_000;
const MAX_SURFACES = 1_000_000;
const MAX_POINTS = 10_000_000;
export const MAX_TILE_SUBSET_RENDER_VERTICES = 20_000_000;

/**
 * Validate and partition worker path buffers into homogeneous Deck buckets.
 * This is deliberately pure: visualization lifecycle and registry ownership do
 * not belong in the worker-buffer compiler.
 */
export function compileTileSubsetPathData(
    raw: TileSubsetPathBuffers,
    origin: [number, number, number],
    billboard: boolean
): DeckPathData[] {
    if (raw.startIndices.length < 2 || raw.startIndices[0] !== 0) {
        return [];
    }
    const pathCount = raw.startIndices.length - 1;
    const vertexCount = raw.startIndices[pathCount];
    if (!pathCount || pathCount > MAX_PATHS ||
        vertexCount <= 1 ||
        vertexCount > MAX_TILE_SUBSET_RENDER_VERTICES ||
        raw.positions.length < vertexCount * 3 ||
        raw.colors.length < vertexCount * 4 ||
        raw.widths.length < vertexCount ||
        raw.lateralOffsetsPx.length < vertexCount ||
        raw.featureAddresses.length < pathCount ||
        raw.glowColors.length < pathCount * 4 ||
        raw.glowRadii.length < pathCount) {
        return [];
    }
    const groups = new Map<string, {
        depthTest: boolean;
        variableOffset: boolean;
        positions: number[];
        starts: number[];
        colors: number[];
        widths: number[];
        offsets: number[];
        offsetVectors?: number[];
        offsetScaleThresholds?: number[];
        addresses: number[];
        glowColors: number[];
        glowRadii: number[];
        dashes?: number[];
    }>();
    const hasDashes = !!raw.dashArrays &&
        raw.dashArrays.length >= vertexCount * 2;
    const hasOffsetVectors =
        (raw.lateralOffsetVectorsPx?.length ?? 0) >= vertexCount * 2;
    for (let pathIndex = 0; pathIndex < pathCount; ++pathIndex) {
        const start = raw.startIndices[pathIndex];
        const end = raw.startIndices[pathIndex + 1];
        if (end <= start || end > vertexCount) {
            return [];
        }
        const depthTest = !raw.depthTests?.length ||
            raw.depthTests[pathIndex] !== 0;
        const variableOffset = hasOffsetVectors;
        const groupKey = `${Number(depthTest)}:${Number(variableOffset)}`;
        const group = groups.get(groupKey) ?? {
            depthTest,
            variableOffset,
            positions: [],
            starts: [0],
            colors: [],
            widths: [],
            offsets: [],
            offsetVectors: variableOffset ? [] : undefined,
            offsetScaleThresholds: variableOffset ? [] : undefined,
            addresses: [],
            glowColors: [],
            glowRadii: [],
            dashes: hasDashes ? [] : undefined
        };
        for (let vertex = start; vertex < end; ++vertex) {
            group.positions.push(
                ...raw.positions.subarray(vertex * 3, vertex * 3 + 3));
            group.colors.push(
                ...raw.colors.subarray(vertex * 4, vertex * 4 + 4));
            group.widths.push(raw.widths[vertex]);
            const width = raw.widths[vertex];
            group.offsets.push(width > 0
                ? raw.lateralOffsetsPx[vertex] / width
                : 0);
            if (group.offsetVectors) {
                group.offsetVectors.push(
                    raw.lateralOffsetVectorsPx[vertex * 2],
                    raw.lateralOffsetVectorsPx[vertex * 2 + 1]);
            }
            if (group.dashes && raw.dashArrays) {
                group.dashes.push(
                    ...raw.dashArrays.subarray(vertex * 2, vertex * 2 + 2));
            }
        }
        group.addresses.push(raw.featureAddresses[pathIndex]);
        group.offsetScaleThresholds?.push(
            quantizeVariablePathOffsetScaleThreshold(
                raw.lateralOffsetScaleThresholds?.[pathIndex] ?? 0));
        group.glowColors.push(...raw.glowColors.subarray(
            pathIndex * 4,
            pathIndex * 4 + 4));
        group.glowRadii.push(raw.glowRadii[pathIndex]);
        group.starts.push(group.positions.length / 3);
        groups.set(groupKey, group);
    }
    return [...groups.values()].map(group => {
        const startIndices = new Uint32Array(group.starts);
        const offsetValues = new Float32Array(group.offsets);
        const offsetVectors = group.offsetVectors
            ? new Float32Array(group.offsetVectors)
            : undefined;
        return {
            length: group.addresses.length,
            billboard,
            depthTest: group.depthTest,
            coordinateOrigin: origin,
            startIndices,
            featureAddressesByPath: new Uint32Array(group.addresses),
            glowColors: new Uint8Array(group.glowColors),
            glowRadii: new Float32Array(group.glowRadii),
            offsetVectorsPx: offsetVectors,
            offsetScaleThresholds: group.offsetScaleThresholds
                ? new Float32Array(group.offsetScaleThresholds)
                : undefined,
            attributes: {
                getPath: {
                    value: new Float32Array(group.positions),
                    size: 3
                },
                instanceColors: {
                    value: new Uint8Array(group.colors),
                    size: 4
                },
                instanceStrokeWidths: {
                    value: new Float32Array(group.widths),
                    size: 1
                },
                instanceOffsets: {value: offsetValues, size: 1},
                ...(offsetVectors
                    ? {instanceVariableOffsets: {
                        value: packVariablePathOffsetVectors(
                            offsetVectors,
                            startIndices,
                            group.offsetScaleThresholds),
                        size: 4
                    }}
                    : {}),
                ...(group.dashes
                    ? {instanceDashArrays: {
                        value: new Float32Array(group.dashes),
                        size: 2
                    }}
                    : {})
            }
        };
    });
}

/** Validate and partition worker point buffers by depth behavior. */
export function compileTileSubsetPointData(
    raw: TileSubsetPointBuffers,
    origin: [number, number, number],
    billboard: boolean
): DeckPointData[] {
    if (!raw.positions.length || raw.positions.length % 3 !== 0) {
        return [];
    }
    const pointCount = raw.positions.length / 3;
    if (pointCount > MAX_POINTS ||
        raw.colors.length < pointCount * 4 ||
        raw.radii.length < pointCount ||
        raw.featureAddresses.length < pointCount ||
        raw.glowColors.length < pointCount * 4 ||
        raw.glowRadii.length < pointCount) {
        return [];
    }
    const groups = new Map<boolean, {
        positions: number[];
        colors: number[];
        radii: number[];
        addresses: number[];
        glowColors: number[];
        glowRadii: number[];
    }>();
    for (let index = 0; index < pointCount; ++index) {
        const depthTest = !raw.depthTests?.length ||
            raw.depthTests[index] !== 0;
        const group = groups.get(depthTest) ?? {
            positions: [],
            colors: [],
            radii: [],
            addresses: [],
            glowColors: [],
            glowRadii: []
        };
        group.positions.push(
            ...raw.positions.subarray(index * 3, index * 3 + 3));
        group.colors.push(
            ...raw.colors.subarray(index * 4, index * 4 + 4));
        group.radii.push(raw.radii[index]);
        group.addresses.push(raw.featureAddresses[index]);
        group.glowColors.push(
            ...raw.glowColors.subarray(index * 4, index * 4 + 4));
        group.glowRadii.push(raw.glowRadii[index]);
        groups.set(depthTest, group);
    }
    return [...groups].map(([depthTest, group]) => ({
        length: group.addresses.length,
        billboard,
        depthTest,
        coordinateOrigin: origin,
        featureAddresses: new Uint32Array(group.addresses),
        glowColors: new Uint8Array(group.glowColors),
        glowRadii: new Float32Array(group.glowRadii),
        attributes: {
            getPosition: {
                value: new Float32Array(group.positions),
                size: 3
            },
            getFillColor: {
                value: new Uint8Array(group.colors),
                size: 4
            },
            getRadius: {value: new Float32Array(group.radii), size: 1}
        }
    }));
}

/** Validate, triangulate, and partition worker surface buffers by depth behavior. */
export function compileTileSubsetSurfaceData(
    raw: TileSubsetSurfaceBuffers,
    origin: [number, number, number]
): DeckSurfaceData[] {
    if (raw.startIndices.length < 2 || raw.startIndices[0] !== 0) {
        return [];
    }
    const surfaceCount = raw.startIndices.length - 1;
    const vertexCount = raw.startIndices[surfaceCount];
    if (!surfaceCount || surfaceCount > MAX_SURFACES ||
        vertexCount < 3 ||
        vertexCount > MAX_TILE_SUBSET_RENDER_VERTICES ||
        raw.positions.length < vertexCount * 3 ||
        raw.colors.length < vertexCount * 4 ||
        raw.featureAddresses.length < surfaceCount ||
        raw.glowColors.length < surfaceCount * 4 ||
        raw.glowRadii.length < surfaceCount ||
        !isValidSurfaceRingTopology(raw, vertexCount)) {
        return [];
    }
    const groups = new Map<boolean, {
        positions: number[];
        starts: number[];
        holes: number[];
        holeStarts: number[];
        colors: number[];
        addresses: number[];
        normals: number[];
        glowColors: number[];
        glowRadii: number[];
    }>();
    for (let surface = 0; surface < surfaceCount; ++surface) {
        const start = raw.startIndices[surface];
        const end = raw.startIndices[surface + 1];
        if (end - start < 3 || end > vertexCount) {
            return [];
        }
        const depthTest = !raw.depthTests?.length ||
            raw.depthTests[surface] !== 0;
        const group = groups.get(depthTest) ?? {
            positions: [],
            starts: [0],
            holes: [],
            holeStarts: [0],
            colors: [],
            addresses: [],
            normals: [],
            glowColors: [],
            glowRadii: []
        };
        const firstHole = raw.holeIndexStarts.length >= surface + 2
            && raw.holeIndexStarts[surface] < raw.holeIndexStarts[surface + 1]
            ? raw.holeIndices[raw.holeIndexStarts[surface]]
            : end;
        group.normals.push(...surfaceRingNormal(raw.positions, start, firstHole));
        const groupStart = group.positions.length / 3;
        for (let vertex = start; vertex < end; ++vertex) {
            group.positions.push(
                ...raw.positions.subarray(vertex * 3, vertex * 3 + 3));
            group.colors.push(
                ...raw.colors.subarray(vertex * 4, vertex * 4 + 4));
        }
        if (raw.holeIndexStarts.length >= surface + 2) {
            for (let index = raw.holeIndexStarts[surface];
                 index < raw.holeIndexStarts[surface + 1];
                 ++index) {
                group.holes.push(groupStart + raw.holeIndices[index] - start);
            }
        }
        group.holeStarts.push(group.holes.length);
        group.addresses.push(raw.featureAddresses[surface]);
        group.glowColors.push(...raw.glowColors.subarray(
            surface * 4,
            surface * 4 + 4));
        group.glowRadii.push(raw.glowRadii[surface]);
        group.starts.push(group.positions.length / 3);
        groups.set(depthTest, group);
    }
    return [...groups].map(([depthTest, group]) => ({
        length: group.addresses.length,
        depthTest,
        coordinateOrigin: origin,
        startIndices: new Uint32Array(group.starts),
        featureAddresses: new Uint32Array(group.addresses),
        surfaceNormals: new Float32Array(group.normals),
        glowColors: new Uint8Array(group.glowColors),
        glowRadii: new Float32Array(group.glowRadii),
        attributes: {
            getPolygon: {
                value: new Float32Array(group.positions),
                size: 3
            },
            indices: {
                value: triangulateSurfaceIndices({
                    positions: group.positions,
                    startIndices: group.starts,
                    holeIndices: group.holes,
                    holeIndexStarts: group.holeStarts
                }),
                size: 1
            },
            fillColors: {
                value: new Uint8Array(group.colors),
                size: 4
            }
        }
    }));
}

/** Derive IconLayer arrow markers from renderer-emitted triangle paths. */
export function compileTileSubsetArrowMarkers(
    path: DeckPathData,
    includeIndex: ((index: number) => boolean) | null = null
): DeckArrowMarker[] {
    const result: DeckArrowMarker[] = [];
    const positions = path.attributes.getPath.value;
    const colors = path.attributes.instanceColors.value;
    const widths = path.attributes.instanceStrokeWidths.value;
    const offsets = path.attributes.instanceOffsets.value;
    for (let index = 0; index < path.length; ++index) {
        if (includeIndex && !includeIndex(index)) {
            continue;
        }
        const start = path.startIndices[index];
        const end = path.startIndices[index + 1];
        if (end - start < 3) {
            continue;
        }
        const tip = start + 1;
        const tipOffset = tip * 3;
        const leftOffset = start * 3;
        const rightOffset = (end - 1) * 3;
        const directionX = positions[tipOffset] -
            (positions[leftOffset] + positions[rightOffset]) * 0.5;
        const directionY = positions[tipOffset + 1] -
            (positions[leftOffset + 1] + positions[rightOffset + 1]) * 0.5;
        if (Math.hypot(directionX, directionY) <= 1e-6) {
            continue;
        }
        const colorOffset = tip * 4;
        const directionLength = Math.hypot(directionX, directionY);
        const lateralPixels = Number(offsets[tip] ?? offsets[start] ?? 0) *
            Number(widths[tip] ?? 0);
        const offsetVectors = path.offsetVectorsPx;
        const explicitOffset = offsetVectors && offsetVectors.length >=
            (tip + 1) * 2
            ? [
                offsetVectors[tip * 2],
                offsetVectors[tip * 2 + 1]
            ] as [number, number]
            : null;
        const offsetScaleThreshold = path.offsetScaleThresholds?.[index] ?? 0;
        result.push({
            featureAddress: path.featureAddressesByPath[index],
            position: [
                positions[tipOffset],
                positions[tipOffset + 1],
                positions[tipOffset + 2]
            ],
            color: [
                colors[colorOffset],
                colors[colorOffset + 1],
                colors[colorOffset + 2],
                colors[colorOffset + 3]
            ],
            sizePx: Math.max(8, widths[tip] * 4),
            angleDeg: normalizeDegrees(
                -((Math.atan2(directionX, directionY) * 180) / Math.PI)
            ),
            // PathLayer applies the y-up right normal (dy, -dx).
            // IconLayer negates the accessor's complete Y component, so
            // getPixelOffset must supply (dy, dx) to land on that same
            // displaced terminal point.
            pixelOffset: explicitOffset
                ? [0, 0]
                : [
                    directionY / directionLength * lateralPixels,
                    directionX / directionLength * lateralPixels
                ],
            localPixelOffset: explicitOffset
                ? [
                    explicitOffset[0],
                    explicitOffset[1],
                    offsetScaleThreshold
                ]
                : [0, 0, 0]
        });
    }
    return result;
}

function normalizeDegrees(value: number): number {
    const normalized = value % 360;
    return normalized < 0 ? normalized + 360 : normalized;
}
