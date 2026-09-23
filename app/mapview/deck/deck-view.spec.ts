import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {DeckMapView} from "./deck-view";

describe("DeckMapView", () => {
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
