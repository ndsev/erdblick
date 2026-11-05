import {describe, expect, it} from "vitest";
import {parseDocument} from "yaml";
import {parseStyleNumber, StyleDocumentModel} from "../../../app/mapstyle/style-document.model";

describe("source-backed style form edits", () => {
    it("edits native widths without search caps and preserves absent defaults, comments and unknown fields", () => {
        const source = `# root comment
name: Original
version: 2
extension: {keep: true}
rules:
  - geometry: polygon # geometry comment
    color: red
    width: 0.25 # width comment
    glow: {color: white, radius: 40}
  - geometry: gltf
    icon-url: model.glb
`;
        const model = new StyleDocumentModel(source);
        const edited = model.edit({op: "set", path: ["rules", 0, "width"], value: 300});
        const result = new StyleDocumentModel(edited);
        expect(edited).toContain("# root comment");
        expect(edited).toContain("# geometry comment");
        expect(edited).toContain("# width comment");
        expect(result.value(["rules", 0, "width"])).toBe(300n);
        expect(result.has(["rules", 0, "opacity"])).toBe(false);
        expect(result.value(["rules", 0, "color"])).toBe("red");
        expect(result.value(["extension"])).toEqual({keep: true});
        expect(result.value(["rules", 1])).toEqual(model.value(["rules", 1]));
    });

    it("edits and reorders nested branches without regenerating sibling rules", () => {
        const model = new StyleDocumentModel(`name: Tree
version: 2
rules:
  - geometry: [line, polygon]
    all-of:
      - filter: kind == 'a' # first branch
        width: 0.1
      - filter: kind == 'b' # second branch
        width: 99
`);
        const moved = new StyleDocumentModel(model.edit({op: "move", path: ["rules", 0, "all-of"], index: 1, to: 0}));
        const renamed = moved.edit({op: "rename", path: ["rules", 0, "all-of"], key: "first-of"});
        const result = new StyleDocumentModel(renamed);
        expect(result.value(["rules", 0, "first-of", 0, "filter"])).toBe("kind == 'b'");
        expect(result.value(["rules", 0, "first-of", 1, "width"])).toBe(0.1);
        expect(result.has(["rules", 0, "all-of"])).toBe(false);
        expect(renamed).toContain("# first branch");
        expect(renamed).toContain("# second branch");
    });

    it("preserves exact category key types including int64 values when editing another cell", () => {
        const model = new StyleDocumentModel(`name: Types
version: 2
rules:
  - geometry: line
    color-scale:
      mode: categorical
      expression: code
      stops: [[1, red], ["1", blue], [true, green], [9223372036854775807, white]]
`);
        const path = ["rules", 0, "color-scale", "stops"];
        const edited = model.edit({op: "set", path: [...path, 1, 1], value: "orange"});
        const result = new StyleDocumentModel(edited);
        expect(result.value([...path, 0, 0])).toBe(1n);
        expect(result.value([...path, 1, 0])).toBe("1");
        expect(result.value([...path, 2, 0])).toBe(true);
        expect(result.value([...path, 3, 0])).toBe(9223372036854775807n);
        expect(result.has(["rules", 0, "color-scale", "fallback"])).toBe(false);
    });

    it("materializes only an edited alias and duplicates without reusing anchors", () => {
        const source = `name: Aliases
version: 2
rules:
  - &shared
    geometry: line
    width: 3 # shared width
    glow: {color: red, radius: 2}
  - *shared
`;
        const model = new StyleDocumentModel(source);
        const edited = new StyleDocumentModel(model.edit({op: "set", path: ["rules", 1, "width"], value: 7}));
        expect(edited.value(["rules", 0, "width"])).toBe(3n);
        expect(edited.value(["rules", 1, "width"])).toBe(7n);
        expect(edited.source).toContain("# shared width");
        const copy = edited.edit({op: "duplicate", path: ["rules"], index: 0});
        expect(copy.match(/&shared/g)).toHaveLength(1);
        expect(parseDocument(copy).errors).toEqual([]);
        expect(new StyleDocumentModel(copy).length(["rules"])).toBe(3);
    });

    it("distinguishes unset fields from authored false, zero and empty text", () => {
        const model = new StyleDocumentModel("name: Test\nversion: 2\ndefault: false\nrules: [{opacity: 0, label-text: ''}]\n");
        expect(model.has(["default"])).toBe(true);
        expect(model.value(["default"])).toBe(false);
        expect(model.value(["rules", 0, "opacity"])).toBe(0n);
        expect(model.value(["rules", 0, "label-text"])).toBe("");
        const removed = new StyleDocumentModel(model.edit({op: "remove", path: ["rules", 0, "opacity"]}));
        expect(removed.has(["rules", 0, "opacity"])).toBe(false);
        expect(removed.value(["rules", 0, "label-text"])).toBe("");
    });

    it("retains a scalar anchor when its numeric value is replaced", () => {
        const model = new StyleDocumentModel("name: Anchored\nrules: [{width: &size 3}, {width: *size}]\n");
        const source = model.edit({op: "set", path: ["rules", 0, "width"], value: 7.5});
        const result = new StyleDocumentModel(source);
        expect(source).toContain("&size");
        expect(result.value(["rules", 1, "width"])).toBe(7.5);
    });

    it("switches same-node color modes without removing inherited modes", () => {
        const model = new StyleDocumentModel(`name: Inheritance
version: 2
rules:
  - color-expression: colorValue
    all-of: [{color: red, width: 2}]
`);
        const source = model.edit({op: "set", path: ["rules", 0, "all-of", 0, "color-scale"],
            value: {mode: "linear", expression: "speed", stops: [[0, "red"], [100, "blue"]]},
            remove: ["color", "color-expression"]});
        const result = new StyleDocumentModel(source);
        expect(result.value(["rules", 0, "color-expression"])).toBe("colorValue");
        expect(result.has(["rules", 0, "all-of", 0, "color"])).toBe(false);
        expect(result.value(["rules", 0, "all-of", 0, "width"])).toBe(2n);
    });

    it("keeps semantically invalid values editable while rejecting broken YAML", () => {
        const model = new StyleDocumentModel("name: Test\nversion: 2\nrules: [{width: nope}]\n");
        expect(model.value(["rules", 0, "width"])).toBe("nope");
        expect(() => new StyleDocumentModel("rules: [")).toThrow();
    });

    it("parses finite numeric inputs without silently rounding int64 keys", () => {
        expect(parseStyleNumber("9223372036854775807")).toBe(9223372036854775807n);
        expect(parseStyleNumber("0.125")).toBe(0.125);
        expect(parseStyleNumber("1e3")).toBe(1000);
        for (const text of ["", "1.2.3", "NaN", "Infinity", "1e999"]) expect(() => parseStyleNumber(text)).toThrow();
    });
});
