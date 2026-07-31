import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {ViewLayerController} from "./view-layer.controller";

describe("ViewLayerController", () => {
    it("does not scan replacement coverage when no fallback exists", () => {
        const controller = Object.create(
            ViewLayerController.prototype
        ) as any;
        controller.retiringRegularLayers = new Map();
        controller.regularReplacementIsReady = vi.fn(() => false);

        controller.releaseRegularFallbackWhenReady({
            replacementSlot: "regular-slot"
        });

        expect(controller.regularReplacementIsReady).not.toHaveBeenCalled();
    });
});
