import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {DeckMapView} from "./deck-view";

describe("DeckMapView", () => {
    it("captures immediately after the forced frame, without preserving the drawing buffer", () => {
        const calls: string[] = [];
        const canvas = {width: 800, height: 600, getContext: () => ({isContextLost: () => false})};
        const copy = {width: 0, height: 0, getContext: () => ({drawImage: vi.fn(() => calls.push("copy"))}),
            toDataURL: vi.fn(() => {calls.push("encode"); return "data:image/png;base64,AAAA";})};
        const view: DeckMapView = Object.assign(Object.create(DeckMapView.prototype), {
            deck: {isInitialized: true, getCanvas: () => canvas, redraw: () => calls.push("draw-with-overlays")}
        });
        const create = vi.spyOn(document, "createElement").mockReturnValue(copy as unknown as HTMLCanvasElement);
        try {
            expect(view.captureCanvas(0.5)).toEqual({canvas, dataUrl: "data:image/png;base64,AAAA"});
            expect(calls).toEqual(["draw-with-overlays", "copy", "encode"]);
            expect([copy.width, copy.height]).toEqual([400, 300]);
        } finally { create.mockRestore(); }
    });

    it("rejects capture before renderer initialization", () => {
        const view: DeckMapView = Object.assign(Object.create(DeckMapView.prototype), {deck: null});
        expect(() => view.captureCanvas(1)).toThrow("unavailable");
    });

    it("explicitly releases a retired WebGL device", () => {
        const calls: string[] = [];
        const view = Object.create(DeckMapView.prototype) as any;
        view.deckDevice = {
            destroy: vi.fn(() => calls.push("destroy")),
            loseDevice: vi.fn(() => {
                calls.push("lose");
                return true;
            })
        };

        view.releaseDeckDevice();

        expect(calls).toEqual(["destroy", "lose"]);
        expect(view.deckDevice).toBeNull();

        view.releaseDeckDevice();
        expect(calls).toEqual(["destroy", "lose"]);
    });
});
