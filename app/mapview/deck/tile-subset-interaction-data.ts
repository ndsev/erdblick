import {
    interactionColor,
    type DeckInteractionEffect,
    type DeckRgba
} from "./deck-interaction-effect";
import {packVariablePathOffsetVectors} from
    "./deck-variable-path-offset.extension";
import type {
    DeckPathData,
    DeckPointData,
    DeckSurfaceData
} from "./tile-subset-render-data";

export interface DeckGlowMaterial {
    key: string;
    color: DeckRgba;
    radius: number;
}

/** Groups authored glow columns into stable material buckets. */
export function groupTileSubsetGlows(
    colors: Uint8Array | undefined,
    radii: Float32Array | undefined,
    count: number
): Array<{material: DeckGlowMaterial; indices: Set<number>}> {
    if (!colors || !radii || colors.length < count * 4 ||
        radii.length < count) {
        return [];
    }
    const groups = new Map<
        string,
        {material: DeckGlowMaterial; indices: Set<number>}
    >();
    for (let index = 0; index < count; ++index) {
        const color = Array.from(colors.subarray(
            index * 4,
            index * 4 + 4)) as DeckRgba;
        const radius = Number(radii[index]);
        if (color[3] <= 0 || !Number.isFinite(radius) || radius <= 0) {
            continue;
        }
        const key = `${color.join(",")}:${radius.toPrecision(7)}`;
        const group = groups.get(key) ?? {
            material: {key, color, radius},
            indices: new Set<number>()
        };
        group.indices.add(index);
        groups.set(key, group);
    }
    return [...groups.values()];
}

/** Converts one authored glow material to the common screen-space effect. */
export function tileSubsetGlowEffect(
    material: DeckGlowMaterial
): DeckInteractionEffect {
    return {
        tintMix: 0,
        opacity: 1,
        edgeWidth: 0,
        haloColor: material.color,
        haloRadius: material.radius,
        haloOpacity: 1,
        // Style glow is always behind/outside authored geometry. The interior
        // semantic-halo branch would otherwise muddy thin path fills.
        interiorHalo: false,
        stripeSpacing: 0,
        stripeWidth: 0,
        stripeOpacity: 0,
        stripeAngle: 45,
        stripeOffset: 0,
        stripeSoftness: 1
    };
}

/** Copies selected paths into a direct fallback interaction layer. */
export function buildTileSubsetInteractionPathData(
    source: DeckPathData,
    effect: DeckInteractionEffect,
    matches: (address: number) => boolean
): DeckPathData | null {
    const positions: number[] = [];
    const colors: number[] = [];
    const widths: number[] = [];
    const offsets: number[] = [];
    const offsetVectors: number[] = [];
    const offsetScaleThresholds: number[] = [];
    const dashes: number[] = [];
    const starts = [0];
    const addresses: number[] = [];
    const sourceDashes = source.attributes.instanceDashArrays?.value;
    for (let pathIndex = 0; pathIndex < source.length; ++pathIndex) {
        const address = source.featureAddressesByPath[pathIndex];
        if (!matches(address)) {
            continue;
        }
        const start = source.startIndices[pathIndex];
        const end = source.startIndices[pathIndex + 1];
        for (let vertex = start; vertex < end; ++vertex) {
            positions.push(...source.attributes.getPath.value.subarray(
                vertex * 3,
                vertex * 3 + 3));
            colors.push(...interactionColor(
                source.attributes.instanceColors.value,
                vertex * 4,
                effect));
            const sourceWidth =
                source.attributes.instanceStrokeWidths.value[vertex];
            const targetWidth = sourceWidth + effect.edgeWidth;
            widths.push(targetWidth);
            // The GPU path offset is a line-width factor. Preserve the authored
            // absolute pixel displacement when the effect changes line width.
            offsets.push(targetWidth > 0
                ? source.attributes.instanceOffsets.value[vertex] *
                    sourceWidth / targetWidth
                : 0);
            if (source.offsetVectorsPx) {
                offsetVectors.push(
                    source.offsetVectorsPx[vertex * 2],
                    source.offsetVectorsPx[vertex * 2 + 1]);
            }
            if (sourceDashes) {
                dashes.push(...sourceDashes.subarray(
                    vertex * 2,
                    vertex * 2 + 2));
            }
        }
        addresses.push(address);
        offsetScaleThresholds.push(
            source.offsetScaleThresholds?.[pathIndex] ?? 0);
        starts.push(positions.length / 3);
    }
    if (!addresses.length) {
        return null;
    }
    const startIndices = new Uint32Array(starts);
    const offsetValues = new Float32Array(offsets);
    const variableOffset = Boolean(
        source.attributes.instanceVariableOffsets && source.offsetVectorsPx);
    const offsetVectorValues = variableOffset
        ? new Float32Array(offsetVectors)
        : undefined;
    return {
        length: addresses.length,
        billboard: source.billboard,
        depthTest: false,
        coordinateOrigin: source.coordinateOrigin,
        startIndices,
        featureAddressesByPath: new Uint32Array(addresses),
        offsetVectorsPx: offsetVectorValues,
        offsetScaleThresholds: variableOffset
            ? new Float32Array(offsetScaleThresholds)
            : undefined,
        attributes: {
            getPath: {value: new Float32Array(positions), size: 3},
            instanceColors: {value: new Uint8Array(colors), size: 4},
            instanceStrokeWidths: {
                value: new Float32Array(widths),
                size: 1
            },
            instanceOffsets: {value: offsetValues, size: 1},
            ...(offsetVectorValues
                ? {instanceVariableOffsets: {
                    value: packVariablePathOffsetVectors(
                        offsetVectorValues,
                        startIndices,
                        offsetScaleThresholds),
                    size: 4
                }}
                : {}),
            ...(sourceDashes
                ? {instanceDashArrays: {
                    value: new Float32Array(dashes),
                    size: 2
                }}
                : {})
        }
    };
}

/** Copies selected points into a direct fallback interaction layer. */
export function buildTileSubsetInteractionPointData(
    source: DeckPointData,
    effect: DeckInteractionEffect,
    matches: (address: number) => boolean
): DeckPointData | null {
    const positions: number[] = [];
    const colors: number[] = [];
    const radii: number[] = [];
    const addresses: number[] = [];
    for (let index = 0; index < source.length; ++index) {
        const address = source.featureAddresses[index];
        if (!matches(address)) {
            continue;
        }
        positions.push(...source.attributes.getPosition.value.subarray(
            index * 3,
            index * 3 + 3));
        colors.push(...interactionColor(
            source.attributes.getFillColor.value,
            index * 4,
            effect));
        radii.push(
            source.attributes.getRadius.value[index] +
            effect.edgeWidth * 0.5);
        addresses.push(address);
    }
    return addresses.length ? {
        length: addresses.length,
        billboard: source.billboard,
        depthTest: false,
        coordinateOrigin: source.coordinateOrigin,
        featureAddresses: new Uint32Array(addresses),
        attributes: {
            getPosition: {value: new Float32Array(positions), size: 3},
            getFillColor: {value: new Uint8Array(colors), size: 4},
            getRadius: {value: new Float32Array(radii), size: 1}
        }
    } : null;
}

/** Copies selected authored paths into the common object-identity mask input. */
export function buildTileSubsetInteractionPathMask(
    source: DeckPathData,
    matches: (address: number) => boolean,
    identityColor: (address: number) => [number, number, number, number],
    includeIndex: ((index: number) => boolean) | null = null
): DeckPathData | null {
    const positions: number[] = [];
    const colors: number[] = [];
    const widths: number[] = [];
    const offsets: number[] = [];
    const offsetVectors: number[] = [];
    const offsetScaleThresholds: number[] = [];
    const dashes: number[] = [];
    const pickingColors: number[] = [];
    const starts = [0];
    const addresses: number[] = [];
    const sourceDashes = source.attributes.instanceDashArrays?.value;
    for (let pathIndex = 0; pathIndex < source.length; ++pathIndex) {
        const address = source.featureAddressesByPath[pathIndex];
        if (!matches(address) || (includeIndex && !includeIndex(pathIndex))) {
            continue;
        }
        const objectColor = identityColor(address);
        const start = source.startIndices[pathIndex];
        const end = source.startIndices[pathIndex + 1];
        for (let vertex = start; vertex < end; ++vertex) {
            positions.push(...source.attributes.getPath.value.subarray(
                vertex * 3,
                vertex * 3 + 3));
            colors.push(...source.attributes.instanceColors.value.subarray(
                vertex * 4,
                vertex * 4 + 4));
            widths.push(
                source.attributes.instanceStrokeWidths.value[vertex]);
            offsets.push(source.attributes.instanceOffsets.value[vertex]);
            if (source.offsetVectorsPx) {
                offsetVectors.push(
                    source.offsetVectorsPx[vertex * 2],
                    source.offsetVectorsPx[vertex * 2 + 1]);
            }
            pickingColors.push(
                objectColor[0], objectColor[1], objectColor[2]);
            if (sourceDashes) {
                dashes.push(...sourceDashes.subarray(
                    vertex * 2,
                    vertex * 2 + 2));
            }
        }
        addresses.push(address);
        offsetScaleThresholds.push(
            source.offsetScaleThresholds?.[pathIndex] ?? 0);
        starts.push(positions.length / 3);
    }
    if (!addresses.length) {
        return null;
    }
    const startIndices = new Uint32Array(starts);
    const offsetValues = new Float32Array(offsets);
    const variableOffset = Boolean(
        source.attributes.instanceVariableOffsets && source.offsetVectorsPx);
    const offsetVectorValues = variableOffset
        ? new Float32Array(offsetVectors)
        : undefined;
    return {
        length: addresses.length,
        billboard: source.billboard,
        depthTest: false,
        coordinateOrigin: source.coordinateOrigin,
        startIndices,
        featureAddressesByPath: new Uint32Array(addresses),
        offsetVectorsPx: offsetVectorValues,
        offsetScaleThresholds: variableOffset
            ? new Float32Array(offsetScaleThresholds)
            : undefined,
        attributes: {
            getPath: {value: new Float32Array(positions), size: 3},
            instanceColors: {value: new Uint8Array(colors), size: 4},
            instanceStrokeWidths: {
                value: new Float32Array(widths),
                size: 1
            },
            instanceOffsets: {value: offsetValues, size: 1},
            ...(offsetVectorValues
                ? {instanceVariableOffsets: {
                    value: packVariablePathOffsetVectors(
                        offsetVectorValues,
                        startIndices,
                        offsetScaleThresholds),
                    size: 4
                }}
                : {}),
            instancePickingColors: {
                value: new Uint8Array(pickingColors),
                size: 3
            },
            ...(sourceDashes
                ? {instanceDashArrays: {
                    value: new Float32Array(dashes),
                    size: 2
                }}
                : {})
        }
    };
}

/** Copies selected authored points into the common object-identity mask input. */
export function buildTileSubsetInteractionPointMask(
    source: DeckPointData,
    matches: (address: number) => boolean,
    identityColor: (address: number) => [number, number, number, number],
    includeIndex: ((index: number) => boolean) | null = null
): DeckPointData | null {
    const positions: number[] = [];
    const colors: number[] = [];
    const radii: number[] = [];
    const pickingColors: number[] = [];
    const addresses: number[] = [];
    for (let index = 0; index < source.length; ++index) {
        const address = source.featureAddresses[index];
        if (!matches(address) || (includeIndex && !includeIndex(index))) {
            continue;
        }
        positions.push(...source.attributes.getPosition.value.subarray(
            index * 3,
            index * 3 + 3));
        colors.push(...source.attributes.getFillColor.value.subarray(
            index * 4,
            index * 4 + 4));
        radii.push(source.attributes.getRadius.value[index]);
        const objectColor = identityColor(address);
        pickingColors.push(objectColor[0], objectColor[1], objectColor[2]);
        addresses.push(address);
    }
    return addresses.length ? {
        length: addresses.length,
        billboard: source.billboard,
        depthTest: false,
        coordinateOrigin: source.coordinateOrigin,
        featureAddresses: new Uint32Array(addresses),
        attributes: {
            getPosition: {value: new Float32Array(positions), size: 3},
            getFillColor: {value: new Uint8Array(colors), size: 4},
            getRadius: {value: new Float32Array(radii), size: 1},
            instancePickingColors: {
                value: new Uint8Array(pickingColors),
                size: 3
            }
        }
    } : null;
}

/** Copies selected triangles into the common object-identity mask input. */
export function buildTileSubsetInteractionSurfaceMask(
    source: DeckSurfaceData,
    matches: (address: number) => boolean,
    identityColor: (address: number) => [number, number, number, number],
    includeIndex: ((index: number) => boolean) | null = null
): DeckSurfaceData | null {
    const sourcePositions = source.attributes.getPolygon.value;
    const sourceColors = source.attributes.fillColors.value;
    const sourceIndices = source.attributes.indices.value;
    const positions: number[] = [];
    const colors: number[] = [];
    const pickingColors: number[] = [];
    const indices: number[] = [];
    const starts = [0];
    const addresses: number[] = [];
    const normals: number[] = [];
    let triangleOffset = 0;
    for (let surfaceIndex = 0; surfaceIndex < source.length; ++surfaceIndex) {
        const start = source.startIndices[surfaceIndex];
        const end = source.startIndices[surfaceIndex + 1];
        const address = source.featureAddresses[surfaceIndex];
        const selected = matches(address) &&
            (!includeIndex || includeIndex(surfaceIndex));
        const surfaceIndices: number[] = [];
        while (triangleOffset + 2 < sourceIndices.length &&
               sourceIndices[triangleOffset] < end) {
            const first = sourceIndices[triangleOffset++];
            const second = sourceIndices[triangleOffset++];
            const third = sourceIndices[triangleOffset++];
            if (selected &&
                first >= start && first < end &&
                second >= start && second < end &&
                third >= start && third < end) {
                surfaceIndices.push(
                    first - start,
                    second - start,
                    third - start);
            }
        }
        if (!selected || surfaceIndices.length === 0) {
            continue;
        }
        const vertexBase = positions.length / 3;
        positions.push(...sourcePositions.subarray(start * 3, end * 3));
        colors.push(...sourceColors.subarray(start * 4, end * 4));
        const objectColor = identityColor(address);
        for (let vertex = start; vertex < end; ++vertex) {
            pickingColors.push(...objectColor);
        }
        indices.push(...surfaceIndices.map(index => vertexBase + index));
        addresses.push(address);
        normals.push(...source.surfaceNormals.subarray(
            surfaceIndex * 3,
            surfaceIndex * 3 + 3));
        starts.push(positions.length / 3);
    }
    return addresses.length ? {
        length: addresses.length,
        depthTest: false,
        coordinateOrigin: source.coordinateOrigin,
        startIndices: new Uint32Array(starts),
        featureAddresses: new Uint32Array(addresses),
        surfaceNormals: new Float32Array(normals),
        attributes: {
            getPolygon: {value: new Float32Array(positions), size: 3},
            indices: {value: new Uint32Array(indices), size: 1},
            fillColors: {value: new Uint8Array(colors), size: 4},
            pickingColors: {
                value: new Uint8Array(pickingColors),
                size: 4
            }
        }
    } : null;
}
