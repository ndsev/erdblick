import {describe, expect, it} from "vitest";
import {
    AppDialogBounds,
    AppDialogResizeLimits,
    resizeAppDialogBounds
} from "./app-dialog-resize";

const START: AppDialogBounds = {left: 200, top: 100, width: 400, height: 300};
const LIMITS: AppDialogResizeLimits = {
    viewportWidth: 1000,
    viewportHeight: 800,
    minWidth: 200,
    minHeight: 150,
    maxWidth: 700,
    maxHeight: 600
};

describe("resizeAppDialogBounds", () => {
    it("resizes southeast while preserving the northwest corner", () => {
        expect(resizeAppDialogBounds(START, 80, 50, "se", LIMITS)).toEqual({
            left: 200,
            top: 100,
            width: 480,
            height: 350
        });
    });

    it("resizes northwest while preserving the southeast corner", () => {
        expect(resizeAppDialogBounds(START, -50, -40, "nw", LIMITS)).toEqual({
            left: 150,
            top: 60,
            width: 450,
            height: 340
        });
    });

    it("resizes northeast while preserving the southwest corner", () => {
        expect(resizeAppDialogBounds(START, 60, 30, "ne", LIMITS)).toEqual({
            left: 200,
            top: 130,
            width: 460,
            height: 270
        });
    });

    it("resizes southwest while preserving the northeast corner", () => {
        expect(resizeAppDialogBounds(START, 70, 45, "sw", LIMITS)).toEqual({
            left: 270,
            top: 100,
            width: 330,
            height: 345
        });
    });

    it("clamps shrinking at the minimum dimensions", () => {
        expect(resizeAppDialogBounds(START, -1000, -1000, "se", LIMITS)).toEqual({
            left: 200,
            top: 100,
            width: 200,
            height: 150
        });
    });

    it("clamps growth at the viewport and configured maxima", () => {
        expect(resizeAppDialogBounds(START, 1000, 1000, "se", LIMITS)).toEqual({
            left: 200,
            top: 100,
            width: 700,
            height: 600
        });
    });

    it("keeps west and north edges inside the viewport", () => {
        expect(resizeAppDialogBounds(START, -1000, -1000, "nw", LIMITS)).toEqual({
            left: 0,
            top: 0,
            width: 600,
            height: 400
        });
    });

    it("reduces the effective minimum when the viewport has less available space", () => {
        expect(resizeAppDialogBounds(
            {left: 50, top: 30, width: 100, height: 80},
            -100,
            -100,
            "se",
            {...LIMITS, viewportWidth: 120, viewportHeight: 90}
        )).toEqual({
            left: 50,
            top: 30,
            width: 70,
            height: 60
        });
    });
});
