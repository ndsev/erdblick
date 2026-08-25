import {describe, expect, it, vi} from "vitest";

import {
    buildZIndexOffsets,
    DeckZIndexExtension
} from "./deck-z-index.extension";

describe("DeckZIndexExtension", () => {
    it("keeps layers without an authored order on Deck's stock path", () => {
        expect(buildZIndexOffsets(
            new Float32Array([Number.NaN, Number.NaN]),
            new Uint32Array([1, 2])
        )).toBeUndefined();
    });

    it("preserves primary order and first-emitted same-order tie breaks", () => {
        const values = new Float32Array([20, -5, 20, Number.NaN, 0]);
        const addresses = new Uint32Array([11, 12, 13, 14, 15]);
        const first = buildZIndexOffsets(values, addresses)!;
        const second = buildZIndexOffsets(values, addresses)!;

        expect([...first]).toEqual([...second]);
        expect(first[0]).toBeGreaterThan(first[1]);
        expect(first[2]).toBeGreaterThan(first[1]);
        expect(first[0]).toBeGreaterThan(first[3]);
        expect(first[2]).toBeGreaterThan(first[3]);
        expect(first[2]).toBeGreaterThan(first[0]);
        expect(first[4]).toBeGreaterThan(first[3]);
        expect(Math.max(...first)).toBeLessThan(0.00025);
    });

    it("ranks source-order fractions that Float32 would collapse", () => {
        const values = new Float64Array([
            65535,
            65535.0001,
            65535.0002
        ]);
        expect(new Set(new Float32Array(values)).size).toBe(1);

        const offsets = buildZIndexOffsets(
            values,
            new Uint32Array([1, 2, 3])
        )!;
        expect(offsets[1]).toBeGreaterThan(offsets[0]);
        expect(offsets[2]).toBeGreaterThan(offsets[1]);
    });

    it("registers a perspective-independent clip-space depth attribute", () => {
        const add = vi.fn();
        const extension = new DeckZIndexExtension();
        Reflect.apply(extension.initializeState, {
            getAttributeManager: () => ({add})
        }, [{}]);
        const shaders = extension.getShaders() as {
            modules: Array<{inject: Record<string, string>}>;
        };

        expect(add).toHaveBeenCalledWith({
            zIndexOffsets: expect.objectContaining({
                size: 1,
                stepMode: "dynamic",
                accessor: "getZIndexOffset"
            })
        });
        expect(shaders.modules[0].inject["vs:DECKGL_FILTER_GL_POSITION"])
            .toContain("position.z -= zIndexOffsets * position.w");
    });
});
