import {describe, expect, it} from "vitest";
import {inspectionValueBubbleClasses} from "./inspection-value-bubble.presentation";

describe("inspectionValueBubbleClasses", () => {
    it("assigns all enabled discriminators from a stable source key", () => {
        expect(inspectionValueBubbleClasses({
            kind: "scalar",
            colorKey: "properties.rules.speedLimit",
            label: "limit"
        }, {
            varyColors: true,
            varyOutlines: true,
            varyStriping: true
        })).toEqual({
            "inspection-value-bubble-scalar": true,
            "inspection-value-bubble-color-0": true,
            "inspection-value-bubble-outline-2": true,
            "inspection-value-bubble-stripe-3": true
        });
    });

    it("does not reshuffle classes when only the display label changes", () => {
        const options = {
            varyColors: true,
            varyOutlines: true,
            varyStriping: true
        };
        expect(inspectionValueBubbleClasses({
            colorKey: "typeId",
            label: "Type"
        }, options)).toEqual(inspectionValueBubbleClasses({
            colorKey: "typeId",
            label: "Feature type"
        }, options));
    });

    it("reserves the validity outline and honors disabled presentation switches", () => {
        expect(inspectionValueBubbleClasses({
            kind: "validity-complete",
            colorKey: "validity"
        }, {
            varyColors: false,
            varyOutlines: true,
            varyStriping: false
        })).toEqual({
            "inspection-value-bubble-validity-complete": true,
            "inspection-value-bubble-outline-6": true
        });
    });
});
