import {
    beforeAll,
    describe,
    expect,
    it
} from "vitest";
import {coreLib, initializeLibrary, uint8ArrayToWasmOrThrow} from "../../../app/integrations/wasm.adapter";

describe("native WASM style validation recovery", () => {
    beforeAll(async () => { await initializeLibrary(); });

    it("reports malformed YAML and can validate a subsequent valid style in the same module", () => {
        const validate = (source: string) => uint8ArrayToWasmOrThrow(buffer => {
            const style = new coreLib.FeatureLayerStyle(buffer);
            try { return style.validationReport(); }
            finally { style.delete(); }
        }, new TextEncoder().encode(source));
        expect(validate("rules: [unterminated").valid).toBe(false);
        expect(validate("name: Repaired\nversion: 2\nrules:\n  - geometry: line\n").valid).toBe(true);
    });

    it("retains the property and rule for an invalid attribute regex and accepts its repair", () => {
        const source = (pattern: string) => `name: RegexRecovery
version: 2
rules:
  - type: Link
    geometry: line
  - type: Link
    scope: attribute
    attribute-type: '${pattern}'
    geometry: line
`;
        const validate = (text: string) => uint8ArrayToWasmOrThrow(buffer => {
            const style = new coreLib.FeatureLayerStyle(buffer);
            try { return style.validationReport() as {valid: boolean; issues: Array<{property?: string; rulePath?: string; message: string}>}; }
            finally { style.delete(); }
        }, new TextEncoder().encode(text));

        const invalid = validate(source("*SPEED*"));
        expect(invalid.valid).toBe(false);
        expect(invalid.issues).toEqual(expect.arrayContaining([expect.objectContaining({
            property: "attribute-type", rulePath: "rules[1]"
        })]));
        const repaired = validate(source(".*SPEED.*"));
        expect(repaired.valid).toBe(true);
        expect(repaired.issues).toEqual([]);
    });
});
