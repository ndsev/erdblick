import "@angular/compiler";
import {SimpleChange} from "@angular/core";
import {describe, expect, it, vi} from "vitest";

import {SearchStyleSaveDialogComponent} from "./search-style-save.dialog.component";

describe("SearchStyleSaveDialogComponent", () => {
    const open = (component: SearchStyleSaveDialogComponent) => {
        component.visible = true;
        component.ngOnChanges({
            visible: new SimpleChange(false, true, false)
        });
    };

    it("resets to enabled and the supplied search layer affinity", () => {
        const component = new SearchStyleSaveDialogComponent();
        component.layerIds = ["Lane", "Road"];
        component.initialLayerIds = ["Road", "Road", "Unavailable"];
        component.name = "Old";
        component.enableUponSave = false;
        component.selectedLayerIds = ["Lane"];

        open(component);

        expect(component.name).toBe("Search Style");
        expect(component.enableUponSave).toBe(true);
        expect(component.selectedLayerIds).toEqual(["Road"]);
    });

    it("rejects a whitespace-only name", () => {
        const component = new SearchStyleSaveDialogComponent();
        const emitted = vi.fn();
        component.saveRequested.subscribe(emitted);
        open(component);
        component.name = "   ";

        component.submit();

        expect(component.showNameError).toBe(true);
        expect(emitted).not.toHaveBeenCalled();
    });

    it("emits an immutable exact-name payload", () => {
        const component = new SearchStyleSaveDialogComponent();
        let payload: any;
        component.saveRequested.subscribe(value => payload = value);
        open(component);
        component.name = "  Exact Name  ";
        component.enableUponSave = true;
        component.selectedLayerIds = ["roads", "lane[0]"];

        component.submit();
        component.selectedLayerIds.push("later");

        expect(payload).toEqual({
            action: "save",
            options: {
                name: "  Exact Name  ",
                defaultEnabled: true,
                layerIds: ["roads", "lane[0]"]
            }
        });
        expect(Object.isFrozen(payload)).toBe(true);
        expect(Object.isFrozen(payload.options)).toBe(true);
        expect(Object.isFrozen(payload.options.layerIds)).toBe(true);
    });

    it("distinguishes Save and Open from the default Save action", () => {
        const component = new SearchStyleSaveDialogComponent();
        const emitted = vi.fn();
        component.saveRequested.subscribe(emitted);
        open(component);

        component.submit("save-and-open");

        expect(emitted.mock.calls[0][0].action).toBe("save-and-open");
    });

    it("prevents duplicate submit while a save is pending and supports cancel", () => {
        const component = new SearchStyleSaveDialogComponent();
        const save = vi.fn();
        const visible = vi.fn();
        component.saveRequested.subscribe(save);
        component.visibleChange.subscribe(visible);
        open(component);
        component.saving = true;

        component.submit();
        component.cancel();
        component.onVisibleChange(false);
        expect(save).not.toHaveBeenCalled();
        expect(visible).not.toHaveBeenCalled();

        component.saving = false;
        component.cancel();
        expect(visible).toHaveBeenCalledWith(false);
    });
});
