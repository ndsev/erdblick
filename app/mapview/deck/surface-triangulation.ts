import earcut from "earcut";

/** Surface buffers needed to triangulate deck.gl binary polygon data without losing hole boundaries. */
export interface SurfaceTriangulationInput {
    positions: ArrayLike<number>;
    startIndices: ArrayLike<number>;
    holeIndices?: ArrayLike<number>;
    holeIndexStarts?: ArrayLike<number>;
}

const emptyIndices = new Uint32Array();

/** Checks that optional polygon-hole metadata is aligned with the surface start-index buffer. */
export function isValidSurfaceRingTopology(input: SurfaceTriangulationInput, vertexCount: number): boolean {
    const surfaceCount = input.startIndices.length - 1;
    const holeIndices = input.holeIndices ?? emptyIndices;
    const holeIndexStarts = input.holeIndexStarts ?? emptyIndices;
    if (!holeIndexStarts.length) {
        return holeIndices.length === 0;
    }
    if (holeIndexStarts.length !== surfaceCount + 1 || holeIndexStarts[0] !== 0
        || holeIndexStarts[surfaceCount] !== holeIndices.length) {
        return false;
    }

    for (let surfaceIndex = 0; surfaceIndex < surfaceCount; surfaceIndex++) {
        const start = input.startIndices[surfaceIndex];
        const end = input.startIndices[surfaceIndex + 1];
        const holeStart = holeIndexStarts[surfaceIndex];
        const holeEnd = holeIndexStarts[surfaceIndex + 1];
        if (!Number.isFinite(holeStart) || !Number.isFinite(holeEnd) || holeStart > holeEnd
            || holeEnd > holeIndices.length || end > vertexCount) {
            return false;
        }
        let previousHoleVertex = start;
        for (let holeIndex = holeStart; holeIndex < holeEnd; holeIndex++) {
            const holeVertex = holeIndices[holeIndex];
            if (!Number.isFinite(holeVertex) || holeVertex <= start || holeVertex >= end
                || holeVertex <= previousHoleVertex) {
                return false;
            }
            previousHoleVertex = holeVertex;
        }
    }
    return true;
}

/** Computes a projected polygon area for one coordinate plane, matching deck.gl's full-3D tessellation choice. */
function projectedPlaneArea(
    positions: ArrayLike<number>,
    startVertex: number,
    endVertex: number,
    xIndex: number,
    yIndex: number
): number {
    const vertexCount = endVertex - startVertex;
    let area = 0;
    for (let i = 0; i < vertexCount; i++) {
        const j = (i + 1) % vertexCount;
        const lhs = (startVertex + i) * 3;
        const rhs = (startVertex + j) * 3;
        area += positions[lhs + xIndex] * positions[rhs + yIndex];
        area -= positions[rhs + xIndex] * positions[lhs + yIndex];
    }
    return Math.abs(area / 2);
}

/** Projects one possibly non-horizontal 3D polygon to the dominant 2D plane before earcut triangulation. */
function projectSurfaceForEarcut(
    positions: ArrayLike<number>,
    startVertex: number,
    endVertex: number
): number[] {
    const xyArea = projectedPlaneArea(positions, startVertex, endVertex, 0, 1);
    const xzArea = projectedPlaneArea(positions, startVertex, endVertex, 0, 2);
    const yzArea = projectedPlaneArea(positions, startVertex, endVertex, 1, 2);
    if (!xyArea && !xzArea && !yzArea) {
        return [];
    }

    const axes = xyArea > xzArea && xyArea > yzArea
        ? [0, 1]
        : xzArea > yzArea
            ? [0, 2]
            : [1, 2];
    const projected: number[] = [];
    for (let vertexIndex = startVertex; vertexIndex < endVertex; vertexIndex++) {
        const offset = vertexIndex * 3;
        projected.push(positions[offset + axes[0]], positions[offset + axes[1]]);
    }
    return projected;
}

/** Triangulates all surfaces, preserving absolute vertex indices expected by deck.gl's binary index buffer. */
export function triangulateSurfaceIndices(input: SurfaceTriangulationInput): Uint32Array {
    const holeIndices = input.holeIndices ?? emptyIndices;
    const holeIndexStarts = input.holeIndexStarts ?? emptyIndices;
    const indices: number[] = [];
    for (let surfaceIndex = 0; surfaceIndex + 1 < input.startIndices.length; surfaceIndex++) {
        const start = input.startIndices[surfaceIndex];
        const end = input.startIndices[surfaceIndex + 1];
        const localPositions = projectSurfaceForEarcut(input.positions, start, end);
        if (!localPositions.length) {
            continue;
        }
        const holes: number[] = [];
        if (holeIndexStarts.length) {
            for (let holeIndex = holeIndexStarts[surfaceIndex]; holeIndex < holeIndexStarts[surfaceIndex + 1]; holeIndex++) {
                holes.push(holeIndices[holeIndex] - start);
            }
        }
        for (const index of earcut(localPositions, holes, 2)) {
            indices.push(start + index);
        }
    }
    return new Uint32Array(indices);
}
