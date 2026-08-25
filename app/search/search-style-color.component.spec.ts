import "@angular/compiler";
import {describe, expect, it} from "vitest";

import {SearchStyleColorComponent} from "./search-style-color.component";
import {defaultSearchStyleColorDraft} from "./search-style-color.util";

describe("SearchStyleColorComponent", () => {
    it("keeps category select options stable until the selected field changes", () => {
        const component = new SearchStyleColorComponent() as any;
        component.draft = {
            ...defaultSearchStyleColorDraft("status"),
            mode: "categories"
        };
        component.fieldOptions = [
            {
                label: "Status",
                value: "status",
                valueKind: "enum",
                enumValues: ["OPEN", "CLOSED"]
            },
            {
                label: "Direction",
                value: "direction",
                valueKind: "enum",
                enumValues: ["FORWARD", "BACKWARD"]
            }
        ];
        component.ngOnChanges({draft: {}, fieldOptions: {}});

        const statusOptions = component.categoryValueOptions;
        expect(statusOptions).toEqual([
            {label: "OPEN", value: "OPEN"},
            {label: "CLOSED", value: "CLOSED"}
        ]);
        expect(component.categoryValueOptions).toBe(statusOptions);

        component.draft = structuredClone(component.draft);
        component.ngOnChanges({draft: {}});
        expect(component.categoryValueOptions).toBe(statusOptions);

        component.setField("direction");

        expect(component.categoryValueOptions).not.toBe(statusOptions);
        expect(component.categoryValueOptions).toEqual([
            {label: "FORWARD", value: "FORWARD"},
            {label: "BACKWARD", value: "BACKWARD"}
        ]);
    });

    it("uses OnPush change detection to prune idle color editors", () => {
        expect((SearchStyleColorComponent as any).ɵcmp.onPush).toBe(true);
    });
});
