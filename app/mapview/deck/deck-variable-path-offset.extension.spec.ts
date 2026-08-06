import {describe, expect, it} from "vitest";

import {
    DeckLocalPixelOffsetExtension,
    DeckVariablePathOffsetExtension,
    packVariablePathOffsetVectors,
    patchVariableOffsetPathVertexShader,
    quantizeVariablePathOffsetScaleThreshold
} from "./deck-variable-path-offset.extension";

describe("DeckVariablePathOffsetExtension", () => {
    const unpackVector = (word: number): [number, number] => {
        const signed = (value: number) => value >= 2048
            ? value - 4096
            : value;
        return [
            signed(word & 0xfff) / 8,
            signed((word >>> 12) & 0xfff) / 8
        ];
    };

    it("packs exact joint neighborhoods into one uvec4 attribute", () => {
        const vectors = new Float32Array([
            1, 10,
            2, 20,
            3, 30,
            -4, -40,
            -5, -50
        ]);
        const starts = new Uint32Array([0, 3, 5]);

        const packed = packVariablePathOffsetVectors(vectors, starts);
        const unpacked = Array.from(packed, unpackVector);
        expect(unpacked).toEqual([
            [1, 10], [1, 10], [2, 20], [3, 30],
            [1, 10], [2, 20], [3, 30], [3, 30],
            [2, 20], [3, 30], [3, 30], [3, 30],
            [-4, -40], [-4, -40], [-5, -50], [-5, -50],
            [-4, -40], [-5, -50], [-5, -50], [-5, -50]
        ]);

        // Segment i at its end and segment i+1 at its start must present the
        // exact same prev/current/next triple to PathLayer's join function.
        expect(unpacked.slice(1, 4)).toEqual(unpacked.slice(4, 7));
    });

    it("uses stable fixed-point precision and clamps pathological offsets", () => {
        const packed = packVariablePathOffsetVectors(
            new Float32Array([
                1.03125, -1.03125,
                Number.NaN, 9999
            ]),
            new Uint32Array([0, 2])
        );
        expect(unpackVector(packed[1])).toEqual([1, -1]);
        expect(unpackVector(packed[2])).toEqual([0, 255.875]);
    });

    it("packs one quantized adaptive-scale threshold into every path word", () => {
        const threshold = 0.0825;
        const packed = packVariablePathOffsetVectors(
            new Float32Array([1, 2, 3, 4]),
            new Uint32Array([0, 2]),
            new Float32Array([threshold])
        );
        const encoded = packed[0] >>> 24;
        expect(encoded).toBeGreaterThan(0);
        expect(packed.every(word => (word >>> 24) === encoded)).toBe(true);
        expect(quantizeVariablePathOffsetScaleThreshold(threshold)).toBeCloseTo(
            threshold,
            2);
    });

    it("moves real PathLayer joins without a fragment clipping envelope", () => {
        const extension = new DeckVariablePathOffsetExtension();
        const shaders = Reflect.apply(
            extension.getShaders,
            {state: {pathTesselator: {}}},
            []
        ) as {
            modules: Array<{
                inject: Record<string, string>;
            }>;
        };
        const inject = shaders.modules[0].inject;
        const source = JSON.stringify(inject);

        expect(source).toContain("variable_path_project_screen_offset");
        expect(source).toContain("in uvec4 instanceVariableOffsets");
        expect(source).toContain("variable_path_unpack_offset");
        expect(source).toContain("variable_path_project_common_offset");
        expect(source).toContain("variable_path_project_common_direction");
        expect(source).toContain("variable_path_offset_scale");
        expect(source).toContain("variable_path_unpack_scale_threshold");
        expect(source).toContain("project_offset_(vec4(worldDirection, 0.0))");
        expect(source).toContain("originClip + directionClip");
        expect(source).toContain("projectedDirection / projectedLength");
        expect(source).toContain("projectedLength > 0.000000001");
        expect(source).not.toContain("projectedLength > 0.0001");
        expect(source).not.toContain(
            "position + vec3(localDirection, 0.0)");
        expect(source).not.toContain("projectedRadius");
        expect(source).not.toContain("miterDenominator");
        expect(inject["vs:#main-end"]).toBeUndefined();
        expect(source).not.toContain("DECKGL_FILTER_SIZE");
        expect(source).not.toContain("discard");

        const patched = patchVariableOffsetPathVertexShader(`
void main() {
  vec3 prevPosition = vec3(0.0);
  vec3 currPosition = vec3(0.0);
  vec3 nextPosition = vec3(0.0);
geometry.worldPosition = currPosition;
  if (path.billboard) {
vec4 prevPositionScreen = project_position_to_clipspace(prevPosition, prevPosition64Low, ZERO_OFFSET);
vec4 currPositionScreen = project_position_to_clipspace(currPosition, currPosition64Low, ZERO_OFFSET, geometry.position);
vec4 nextPositionScreen = project_position_to_clipspace(nextPosition, nextPosition64Low, ZERO_OFFSET);
  } else {
prevPosition = project_position(prevPosition, prevPosition64Low);
currPosition = project_position(currPosition, currPosition64Low);
nextPosition = project_position(nextPosition, nextPosition64Low);
  }
}`);
        expect(patched).toContain("variableLeftOffsetPixels");
        expect(patched).toContain("variableRightOffsetPixels");
        expect(patched).toContain("variableCurrentOffsetPixels");
        expect(patched).toContain(
            "variableLeftOffsetPixels *= variableOffsetScale");
        expect(patched).toContain(
            "variableRightOffsetPixels *= variableOffsetScale");
        expect(patched).not.toContain("variableCurvatureScale");
        expect(patched).toContain("prevPositionScreen.xy +=");
        expect(patched).toContain("prevPosition +=");
        expect(patched.indexOf("prevPositionScreen.xy +=")).toBeLessThan(
            patched.indexOf("prevPosition +="));
    });

    it("moves icon glyphs through the same pre-projection size hook", () => {
        const extension = new DeckLocalPixelOffsetExtension();
        const shaders = extension.getShaders() as {
            modules: Array<{
                inject: Record<string, string>;
            }>;
        };
        const inject = shaders.modules[0].inject;

        expect(inject["vs:DECKGL_FILTER_SIZE"]).toContain(
            "instanceLocalPixelOffsets");
        expect(inject["vs:DECKGL_FILTER_SIZE"]).toContain(
            "local_pixel_offset_project_common");
        expect(inject["vs:DECKGL_FILTER_SIZE"]).toContain(
            "local_pixel_offset_scale");
        expect(inject["vs:#decl"]).toContain(
            "local_pixel_offset_project_common_direction");
        expect(inject["vs:#decl"]).not.toContain(
            "position + vec3(localDirection, 0.0)");
        expect(inject["vs:#main-end"]).toBeUndefined();
    });
});
