import {describe, expect, it, vi} from "vitest";

import {
    buildTileSubsetInteractionPathData,
    buildTileSubsetInteractionPathMask,
    buildTileSubsetInteractionSurfaceMask
} from "./tile-subset-interaction-data";

const EFFECT = {
    tintMix: 0,
    opacity: 1,
    edgeWidth: 2,
    haloRadius: 0,
    haloOpacity: 0,
    stripeSpacing: 0,
    stripeWidth: 0,
    stripeOpacity: 0,
    stripeAngle: 45,
    stripeOffset: 0,
    stripeSoftness: 1
};

function pathSource() {
    return {
        length: 1,
        billboard: false,
        depthTest: true,
        coordinateOrigin: [11, 48, 0],
        startIndices: new Uint32Array([0, 2]),
        featureAddressesByPath: new Uint32Array([7]),
        attributes: {
            getPath: {
                value: new Float32Array([0, 0, 0, 10, 0, 0]),
                size: 3
            },
            instanceColors: {
                value: new Uint8Array([
                    255, 0, 0, 255,
                    255, 0, 0, 255
                ]),
                size: 4
            },
            instanceStrokeWidths: {
                value: new Float32Array([4, 4]),
                size: 1
            },
            instanceOffsets: {
                value: new Float32Array([0.75, 0.75]),
                size: 1
            }
        }
    } as any;
}

describe("tile subset interaction data", () => {
    it("preserves absolute pixel offsets when interaction width changes", () => {
        const highlighted = buildTileSubsetInteractionPathData(
            pathSource(),
            EFFECT,
            () => true
        )!;

        expect([...highlighted.attributes.instanceStrokeWidths.value])
            .toEqual([6, 6]);
        expect([...highlighted.attributes.instanceOffsets.value])
            .toEqual([0.5, 0.5]);
    });

    it("feeds authored path width and semantic identity into the GPU mask", () => {
        const identityColor = vi.fn(() =>
            [17, 34, 51, 255] as [number, number, number, number]
        );
        const mask = buildTileSubsetInteractionPathMask(
            pathSource(),
            () => true,
            identityColor
        )!;

        expect([...mask.attributes.instanceStrokeWidths.value])
            .toEqual([4, 4]);
        expect([...mask.attributes.instanceOffsets.value])
            .toEqual([0.75, 0.75]);
        expect([...mask.attributes.instancePickingColors!.value])
            .toEqual([17, 34, 51, 17, 34, 51]);
        expect(identityColor).toHaveBeenCalledOnce();
        expect(identityColor).toHaveBeenCalledWith(7);
    });

    it("builds one stable feature-id mask for split mesh triangles", () => {
        const source = {
            length: 2,
            depthTest: true,
            coordinateOrigin: [11, 48, 0],
            startIndices: new Uint32Array([0, 3, 6]),
            featureAddresses: new Uint32Array([7, 7]),
            surfaceNormals: new Float32Array([
                0, 0, 1,
                0, 0, 1
            ]),
            attributes: {
                getPolygon: {
                    value: new Float32Array([
                        0, 0, 0,
                        1, 0, 0,
                        1, 1, 0,
                        0, 0, 0,
                        1, 1, 0,
                        0, 1, 0
                    ]),
                    size: 3
                },
                indices: {
                    value: new Uint32Array([0, 1, 2, 3, 4, 5]),
                    size: 1
                },
                fillColors: {
                    value: new Uint8Array(new Array(6)
                        .fill([255, 0, 0, 255]).flat()),
                    size: 4
                }
            }
        } as any;
        const identityColor = vi.fn(() =>
            [17, 0, 0, 255] as [number, number, number, number]
        );
        const mask = buildTileSubsetInteractionSurfaceMask(
            source,
            () => true,
            identityColor
        )!;

        expect(mask.length).toBe(2);
        expect([...mask.startIndices]).toEqual([0, 3, 6]);
        expect([...mask.attributes.indices.value])
            .toEqual([0, 1, 2, 3, 4, 5]);
        expect([...mask.attributes.getPolygon.value])
            .toEqual([...source.attributes.getPolygon.value]);
        expect([...mask.attributes.fillColors.value])
            .toEqual([...source.attributes.fillColors.value]);
        expect([...mask.surfaceNormals]).toEqual([...source.surfaceNormals]);
        expect([...mask.attributes.pickingColors!.value])
            .toEqual(new Array(6).fill([17, 0, 0, 255]).flat());
        expect(identityColor).toHaveBeenCalledTimes(2);
    });
});
