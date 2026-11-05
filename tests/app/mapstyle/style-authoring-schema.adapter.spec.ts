import "@angular/compiler";
import {beforeAll, describe, expect, it} from "vitest";
import {initializeLibrary} from "../../../app/integrations/wasm.adapter";
import {styleAuthoringCompletions, styleAuthoringSchema} from "../../../app/mapstyle/style-authoring-schema.adapter";
import {StyleFieldInputComponent} from "../../../app/mapstyle/style-field-input.component";
import {StyleRecordEditorComponent} from "../../../app/mapstyle/style-record-editor.component";
import {StyleDocumentModel} from "../../../app/mapstyle/style-document.model";

describe("native style authoring contract", () => {
    beforeAll(async () => { await initializeLibrary(); });

    it("uses native fields in completions, including previously missing advanced fields", () => {
        const fields = styleAuthoringCompletions().map(value => value.label);
        expect(new Set(fields).size).toBe(fields.length);
        expect(fields).toEqual(expect.arrayContaining(["width-scale", "attribute-validity-geom", "point-cloud-max-points",
            "options", "internal", "presets", "optionId", "all-of", "label-background-border-radius"]));
        expect(fields).not.toContain("label-font");
    });

    it("does not offer top-level-only fields in branches but retains authored invalid fields for repair", () => {
        const form = new StyleRecordEditorComponent();
        form.catalog = styleAuthoringSchema();
        form.record = "rule";
        form.path = ["rules", 0, "all-of", 0];
        form.model = new StyleDocumentModel("name: Test\nversion: 2\nrules: [{all-of: [{scope: feature}]}]");
        form.ngOnChanges();
        const fields = form.groups.flatMap(group => group.fields.map(field => field.key));
        expect(fields).toContain("scope");
        expect(fields).not.toContain("lod-range");
        expect(fields).not.toContain("fidelity");
    });

    it("uses Boolean option defaults when the native type is omitted", () => {
        const control = new StyleFieldInputComponent();
        control.model = new StyleDocumentModel("name: Test\noptions: [{id: enabled, default: true}]\nrules: []");
        control.field = styleAuthoringSchema().records["option"]["default"];
        control.path = ["options", 0, "default"];
        expect(control.kind).toBe("boolean");
        expect(control.value).toBe(true);
    });

    it("retains each incomplete numeric cell until that cell is corrected", () => {
        const control = new StyleFieldInputComponent();
        control.model = new StyleDocumentModel("name: Test\nrules: [{offset: [1, 2, 3]}]");
        control.field = styleAuthoringSchema().records["rule"]["offset"];
        control.path = ["rules", 0, "offset"];
        const problems: string[] = [];
        control.problem.subscribe(problem => problems.push(problem.message));
        control.edit.subscribe(edit => {
            control.model = new StyleDocumentModel(control.model.edit(edit));
            control.ngOnChanges();
        });
        const first = control.child(0);
        const second = control.child(1);
        control.number({target: {value: "1e"}} as unknown as Event, first);
        control.number({target: {value: "5"}} as unknown as Event, second);
        expect(control.text(first)).toBe("1e");
        expect(control.model.value(first)).toBe(1n);
        expect(control.model.value(second)).toBe(5n);
        expect(problems.at(-1)).toBe("Enter a finite number.");
        control.number({target: {value: "1e2"}} as unknown as Event, first);
        expect(control.model.value(first)).toBe(100n);
        expect(control.text(first)).toBe("1e2");
        expect(problems.at(-1)).toBe("");
    });

    it("clears numeric buffers when the corresponding source value is replaced", () => {
        const control = new StyleFieldInputComponent();
        control.model = new StyleDocumentModel("name: Test\nrules: [{width: 2}]");
        control.field = styleAuthoringSchema().records["rule"]["width"];
        control.path = ["rules", 0, "width"];
        control.number({target: {value: "bad"}} as unknown as Event, control.path);
        expect(control.error).toBe("Enter a finite number.");
        control.model = new StyleDocumentModel("name: Test\nrules: [{width: 9}]");
        control.ngOnChanges();
        expect(control.text()).toBe("9");
        expect(control.error).toBe("");
    });

    it("keeps relation marker expressions in relation context and endpoints in feature context", () => {
        const form = new StyleRecordEditorComponent();
        form.catalog = styleAuthoringSchema();
        form.record = "rule";
        form.path = ["rules", 0];
        form.model = new StyleDocumentModel("name: Test\nrules: [{scope: relation}]");
        expect(form.childScope("relation-line-end-markers")).toBe("relation");
        expect(form.childScope("relation-source-style")).toBe("feature");
        expect(form.childScope("relation-target-style")).toBe("feature");
    });
});
