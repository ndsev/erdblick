import {describe, expect, it} from "vitest";

import {
    compileTileSubsetArrowMarkers,
    compileTileSubsetPathData,
    compileTileSubsetPointData,
    compileTileSubsetSurfaceData
} from "./tile-subset-render-data";

describe("Tile subset render-data compiler", () => {
    it("packs a transition vector buffer without mixing in stock paths", () => {
        const buckets = compileTileSubsetPathData({
            positions: new Float32Array(15),
            colors: new Uint8Array(20),
            widths: new Float32Array([2, 2, 2, 2, 2]),
            lateralOffsetsPx: new Float32Array([2, 2, 2, 3, 4]),
            lateralOffsetVectorsPx: new Float32Array([
                0, -2,
                0, -2,
                -3, 0,
                -4, 0,
                -5, 0
            ]),
            lateralOffsetScaleThresholds: new Float32Array([0.08, 0.16]),
            zIndices: new Float64Array([10, 20]),
            startIndices: new Uint32Array([0, 2, 5]),
            featureAddresses: new Uint32Array([0, 1]),
            depthTests: new Uint8Array([1, 1]),
            glowColors: new Uint8Array([
                1, 2, 3, 4,
                5, 6, 7, 8
            ]),
            glowRadii: new Float32Array([5, 6])
        }, [11, 48, 0], false);

        expect(buckets).toHaveLength(1);
        const variable = buckets[0]!;
        expect([...variable.attributes.instanceOffsets.value]).toEqual([
            1, 1, 1, 1.5, 2
        ]);
        const packed = variable.attributes.instanceVariableOffsets?.value;
        const glowColors = variable.glowColors;
        const glowRadii = variable.glowRadii;
        const offsetScaleThresholds = variable.offsetScaleThresholds;
        if (!packed || !glowColors || !glowRadii || !offsetScaleThresholds) {
            throw new Error("Expected variable path buffers");
        }
        const unpack = (word: number): [number, number] => {
            const x = word & 0xfff;
            const y = (word >>> 12) & 0xfff;
            return [
                (x >= 2048 ? x - 4096 : x) / 8,
                (y >= 2048 ? y - 4096 : y) / 8
            ];
        };
        expect(Array.from(packed, unpack)).toEqual([
            [0, -2], [0, -2], [0, -2], [0, -2],
            [0, -2], [0, -2], [0, -2], [0, -2],
            [-3, 0], [-3, 0], [-4, 0], [-5, 0],
            [-3, 0], [-4, 0], [-5, 0], [-5, 0],
            [-4, 0], [-5, 0], [-5, 0], [-5, 0]
        ]);
        expect([...glowColors]).toEqual([
            1, 2, 3, 4,
            5, 6, 7, 8
        ]);
        expect([...glowRadii]).toEqual([5, 6]);
        expect(offsetScaleThresholds[0]).toBeCloseTo(0.08, 2);
        expect(offsetScaleThresholds[1]).toBeCloseTo(0.16, 2);
        expect(packed[0] >>> 24).not.toEqual(packed[8] >>> 24);
        const zIndexOffsets = variable.attributes.zIndexOffsets!.value;
        expect([...zIndexOffsets.subarray(0, 2)])
            .toEqual([zIndexOffsets[0], zIndexOffsets[0]]);
        expect(zIndexOffsets[2]).toBeGreaterThan(zIndexOffsets[0]);
        expect([...variable.zIndices!]).toEqual([10, 20]);
    });

    it("applies IconLayer's Y flip when aligning an arrow with its path", () => {
        const markers = compileTileSubsetArrowMarkers({
            length: 1,
            billboard: false,
            depthTest: false,
            coordinateOrigin: [11, 48, 0],
            startIndices: new Uint32Array([0, 3]),
            featureAddressesByPath: new Uint32Array([7]),
            attributes: {
                // Triangle tip is the middle point. Its world-space terminal
                // direction is north-east.
                getPath: {
                    value: new Float32Array([
                        0, 0, 0,
                        1, 1, 0,
                        0, 0, 0
                    ]),
                    size: 3
                },
                instanceColors: {
                    value: new Uint8Array([
                        10, 20, 30, 255,
                        10, 20, 30, 255,
                        10, 20, 30, 255
                    ]),
                    size: 4
                },
                instanceStrokeWidths: {
                    value: new Float32Array([5, 5, 5]),
                    size: 1
                },
                instanceOffsets: {
                    value: new Float32Array([4, 4, 4]),
                    size: 1
                }
            }
        });

        expect(markers).toHaveLength(1);
        // 4 * 5 = 20 px along the screen-space right normal. IconLayer
        // negates accessor Y after adding it, so the accessor's positive Y
        // becomes the path shader's negative screen-space Y.
        expect(markers[0].pixelOffset[0]).toBeCloseTo(Math.SQRT1_2 * 20);
        expect(markers[0].pixelOffset[1]).toBeCloseTo(Math.SQRT1_2 * 20);
        expect(markers[0].localPixelOffset).toEqual([0, 0, 0]);
    });

    it("uses the path's exact terminal vector for transition arrows", () => {
        const markers = compileTileSubsetArrowMarkers({
            length: 1,
            billboard: false,
            depthTest: false,
            coordinateOrigin: [11, 48, 0],
            startIndices: new Uint32Array([0, 3]),
            featureAddressesByPath: new Uint32Array([7]),
            offsetVectorsPx: new Float32Array([
                -12, 7,
                -12, 7,
                -12, 7
            ]),
            offsetScaleThresholds: new Float32Array([0.125]),
            attributes: {
                getPath: {
                    value: new Float32Array([
                        0, 0, 0,
                        1, 1, 0,
                        0, 0, 0
                    ]),
                    size: 3
                },
                instanceColors: {
                    value: new Uint8Array(12),
                    size: 4
                },
                instanceStrokeWidths: {
                    value: new Float32Array([5, 5, 5]),
                    size: 1
                },
                instanceOffsets: {
                    value: new Float32Array([99, 99, 99]),
                    size: 1
                }
            }
        });

        expect(markers[0].pixelOffset).toEqual([0, 0]);
        expect(markers[0].localPixelOffset).toEqual([-12, 7, 0.125]);
    });

    it("partitions points by depth behavior without losing identity", () => {
        const buckets = compileTileSubsetPointData({
            positions: new Float32Array([
                1, 2, 3,
                4, 5, 6
            ]),
            colors: new Uint8Array([
                10, 20, 30, 255,
                40, 50, 60, 255
            ]),
            radii: new Float32Array([2, 3]),
            zIndices: new Float64Array([Number.NaN, Number.NaN]),
            depthTests: new Uint8Array([1, 0]),
            featureAddresses: new Uint32Array([7, 9]),
            glowColors: new Uint8Array([
                1, 2, 3, 4,
                5, 6, 7, 8
            ]),
            glowRadii: new Float32Array([4, 5])
        }, [11, 48, 0], true);

        expect(buckets.map(bucket => bucket.depthTest)).toEqual([true, false]);
        expect(buckets.map(bucket => [...bucket.featureAddresses]))
            .toEqual([[7], [9]]);
        expect(buckets[0].billboard).toBe(true);
        expect([...buckets[1].attributes.getPosition.value])
            .toEqual([4, 5, 6]);
    });

    it("partitions and triangulates surfaces by depth behavior", () => {
        const buckets = compileTileSubsetSurfaceData({
            positions: new Float32Array([
                0, 0, 0,
                1, 0, 0,
                0, 1, 0,
                2, 0, 0,
                3, 0, 0,
                2, 1, 0
            ]),
            startIndices: new Uint32Array([0, 3, 6]),
            holeIndices: new Uint32Array(),
            holeIndexStarts: new Uint32Array([0, 0, 0]),
            colors: new Uint8Array(6 * 4),
            zIndices: new Float64Array([Number.NaN, Number.NaN]),
            depthTests: new Uint8Array([1, 0]),
            featureAddresses: new Uint32Array([12, 13]),
            glowColors: new Uint8Array(2 * 4),
            glowRadii: new Float32Array([0, 0])
        }, [11, 48, 0]);

        expect(buckets.map(bucket => bucket.depthTest)).toEqual([true, false]);
        expect(buckets.map(bucket => [...bucket.featureAddresses]))
            .toEqual([[12], [13]]);
        expect(buckets.map(bucket => [...bucket.surfaceNormals]))
            .toEqual([[0, 0, 1], [0, 0, 1]]);
        expect(buckets.map(bucket => bucket.attributes.indices.value.length))
            .toEqual([3, 3]);
    });
});
