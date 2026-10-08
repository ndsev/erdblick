import "@angular/compiler";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ViewerUiService} from "./viewer-ui.service";
import {viewerUiActions} from "./viewer-ui.contract";

describe("bounded viewer UI actions", () => {
    let ui: ViewerUiService;
    let root: HTMLDivElement;

    beforeEach(() => {
        ui = new ViewerUiService();
        root = document.createElement("div");
        root.dataset['testid'] = "fixture";
        document.body.append(root);
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
            return new DOMRect(10, 10, parseFloat(this.style.width) || 100, parseFloat(this.style.height) || 40);
        });
    });
    afterEach(() => { root.remove(); vi.restoreAllMocks(); Reflect.deleteProperty(document, "elementFromPoint"); });

    /** Finds a current reference through the public snapshot contract. */
    function uid(testId: string): string {
        return viewerUiActions.viewer_take_snapshot.outputSchema.parse(ui.snapshot({})).elements.find(element => element.testId === testId)!.uid;
    }

    /** Adds one small fixture control without involving Angular or map state. */
    function input(type = "text"): HTMLInputElement {
        const field = document.createElement("input");
        field.type = type;
        field.dataset['testid'] = "field";
        root.append(field);
        return field;
    }

    it("reports labels, state and bounded values but omits password/file values and hidden subtrees", () => {
        const field = input();
        field.setAttribute("aria-label", "Filter inspections");
        field.value = "😀".repeat(600);
        const password = input("password");
        password.value = "do-not-expose";
        const hidden = document.createElement("div");
        hidden.style.display = "none";
        hidden.textContent = "hidden-secret";
        root.append(hidden);
        const button = document.createElement("button");
        button.append("Visible action", hidden.cloneNode(true));
        root.append(button);
        const result = viewerUiActions.viewer_take_snapshot.outputSchema.parse(ui.snapshot({}));
        expect(result.elements.find(element => element.name === "Filter inspections"))
            .toMatchObject({value: "😀".repeat(512), valueTruncated: true, disabled: false});
        expect(JSON.stringify(result)).not.toContain("do-not-expose");
        expect(JSON.stringify(result)).not.toContain("hidden-secret");
        expect(result.elements.find(element => element.tag === "button")!.name).toBe("Visible action");
    });

    it("rejects previous-snapshot, detached, hidden and repurposed-row references", () => {
        const field = input();
        const old = uid("field");
        let current = uid("field");
        expect(() => ui.getElement({uid: old})).toThrow(/fresh snapshot/);
        field.remove();
        expect(() => ui.getElement({uid: current})).toThrow(/fresh snapshot/);
        const row = document.createElement("div");
        row.setAttribute("role", "row");
        row.append("Feature A", field);
        root.append(row);
        current = uid("field");
        row.firstChild!.textContent = "Feature B";
        expect(() => ui.getElement({uid: current})).toThrow(/fresh snapshot/);
        current = uid("field");
        row.style.display = "none";
        expect(() => ui.getElement({uid: current})).toThrow(/fresh snapshot/);
    });

    it("paginates bounded snapshots without retaining the whole document", () => {
        for (let index = 0; index < 40; index++) {
            const button = document.createElement("button");
            button.textContent = `Button ${index}`;
            root.append(button);
        }
        const first = ui.snapshot({limit: 5});
        expect(first).toMatchObject({complete: false, nextOffset: 5, reason: "element_limit"});
        const second = ui.snapshot({rootUid: first.rootUid, offset: first.nextOffset, limit: 5});
        expect(second.elements).toHaveLength(5);
        expect(second.elements[0].name).not.toBe(first.elements[0].name);
        expect(() => ui.getElement({uid: first.elements[0].uid})).toThrow();
    });

    it("honors work budgets for deeply nested markup", () => {
        let parent: HTMLElement = root;
        for (let index = 0; index < 90; index++) {
            const child = document.createElement("div");
            parent.append(child);
            parent = child;
        }
        expect(ui.snapshot({})).toMatchObject({complete: false, reason: "work_limit"});
    });

    it("fills a normal input through both ordinary events and clicks a checkbox only when needed", () => {
        const field = input();
        const scroll = field.scrollIntoView = vi.fn();
        document.elementFromPoint = vi.fn(() => field);
        const onInput = vi.fn(), onChange = vi.fn();
        field.addEventListener("input", onInput);
        field.addEventListener("change", onChange);
        expect(ui.fill({uid: uid("field"), value: "lane"})).toEqual({status: "applied"});
        expect(field.value).toBe("lane");
        expect(onInput).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(scroll).toHaveBeenCalled();
        field.type = "checkbox";
        const id = uid("field");
        ui.fill({uid: id, value: "true"});
        ui.fill({uid: id, value: "true"});
        expect(field.checked).toBe(true);
        expect(onChange).toHaveBeenCalledTimes(2);
    });

    it("rejects unsupported, readonly, disabled and covered controls", () => {
        const field = input("password");
        expect(() => ui.fill({uid: uid("field"), value: "secret"})).toThrow(/not supported/);
        field.type = "text";
        field.readOnly = true;
        expect(() => ui.fill({uid: uid("field"), value: "x"})).toThrow(/Read-only/);
        field.readOnly = false;
        field.disabled = true;
        expect(() => ui.click({uid: uid("field")})).toThrow(/disabled/);
        field.disabled = false;
        field.scrollIntoView = vi.fn();
        document.elementFromPoint = vi.fn(() => root);
        expect(() => ui.click({uid: uid("field")})).toThrow(/covered/);
    });

    it("resizes through the registered owner and rejects unsupported dimensions, busy surfaces and retired owners", () => {
        let busy = false;
        const resize = vi.fn(size => { root.style.width = `${Math.min(size.widthPx, 640)}px`; });
        const unregister = ui.registerResizeTarget(root, {describe: () => ({kind: "dock", dimensions: ["widthPx"], busy}), resize});
        const id = uid("fixture");
        expect(ui.resize({uid: id, size: {widthPx: 800}}).element.bounds.width).toBe(640);
        expect(resize).toHaveBeenCalledTimes(1);
        expect(() => ui.resize({uid: id, size: {heightPx: 200}})).toThrow(/advertised/);
        busy = true;
        expect(() => ui.resize({uid: id, size: {widthPx: 500}})).toThrow(/dragged/);
        unregister();
        expect(() => ui.resize({uid: id, size: {widthPx: 500}})).toThrow(/no resize owner/);
    });

    it("validates split membership and percentage sum before touching the owner", () => {
        const resize = vi.fn();
        ui.registerResizeTarget(root, {describe: () => ({kind: "split", dimensions: ["panelSizes"], busy: false, panelSizes: [50, 50]}), resize});
        const id = uid("fixture");
        expect(() => ui.resize({uid: id, size: {panelSizes: [70, 50]}})).toThrow(/sum to 100/);
        expect(resize).not.toHaveBeenCalled();
        ui.resize({uid: id, size: {panelSizes: [65, 35]}});
        expect(resize).toHaveBeenCalledWith({panelSizes: [65, 35]});
    });
});
