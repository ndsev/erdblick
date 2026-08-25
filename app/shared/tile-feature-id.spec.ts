import {describe, expect, it} from "vitest";

import {
    formatFeatureInspectionTarget,
    hasFeatureInspectionValidity,
    isFeatureInspectionSubTarget,
    parseFeatureInspectionTarget,
    stripFeatureInspectionTarget,
    stripFeatureInspectionValidity,
    tileFeatureInteractionTargetsEqual
} from "./tile-feature-id";

const target = (featureId: string, mapTileKey = "Map/Layer/42") => ({
    featureId,
    mapTileKey
});

describe("tile feature interaction identity", () => {
    it("round-trips canonical attribute and relation targets", () => {
        const attribute = parseFeatureInspectionTarget(
            "Road.7:attribute#2:validity#1"
        );
        const relation = parseFeatureInspectionTarget(
            "Road.7:relation#4:validity#0"
        );

        expect(attribute).toEqual({
            scope: "attribute",
            baseFeatureId: "Road.7",
            attributeIndex: 2,
            validityIndex: 1
        });
        expect(relation).toEqual({
            scope: "relation",
            baseFeatureId: "Road.7",
            relationIndex: 4,
            validityIndex: 0
        });
        expect(formatFeatureInspectionTarget(attribute))
            .toBe("Road.7:attribute#2:validity#1");
        expect(formatFeatureInspectionTarget(relation))
            .toBe("Road.7:relation#4:validity#0");
    });

    it("reads legacy comma validity targets and formats their parent canonically", () => {
        const legacy = "Lane.24:attribute#1,validity#0";

        expect(parseFeatureInspectionTarget(legacy)).toEqual({
            scope: "attribute",
            baseFeatureId: "Lane.24",
            attributeIndex: 1,
            validityIndex: 0
        });
        expect(stripFeatureInspectionValidity(legacy))
            .toBe("Lane.24:attribute#1");
        expect(stripFeatureInspectionTarget(legacy)).toBe("Lane.24");
    });

    it("does not reinterpret malformed suffixes as inspection targets", () => {
        const malformed = "Road.7:attribute#oops";

        expect(parseFeatureInspectionTarget(malformed)).toEqual({
            scope: "feature",
            baseFeatureId: malformed
        });
        expect(isFeatureInspectionSubTarget(malformed)).toBe(false);
        expect(stripFeatureInspectionTarget(malformed)).toBe(malformed);
    });

    it("distinguishes entry targets from exact validity targets", () => {
        expect(isFeatureInspectionSubTarget("Road.7:relation#3")).toBe(true);
        expect(hasFeatureInspectionValidity("Road.7:relation#3")).toBe(false);
        expect(hasFeatureInspectionValidity(
            "Road.7:relation#3:validity#2"
        )).toBe(true);
    });

    it("keeps inspection descendants independently hoverable", () => {
        expect(tileFeatureInteractionTargetsEqual(
            target("Road.7"),
            target("Road.7:attribute#2:validity#1")
        )).toBe(false);
        expect(tileFeatureInteractionTargetsEqual(
            target("Road.7:attribute#2"),
            target("Road.7:attribute#2:validity#1")
        )).toBe(false);
    });

    it("matches only the same target in the same tile", () => {
        expect(tileFeatureInteractionTargetsEqual(
            target("Road.7:attribute#2"),
            target("Road.7:attribute#2")
        )).toBe(true);
        expect(tileFeatureInteractionTargetsEqual(
            target("Road.7:attribute#2"),
            target("Road.7:attribute#3")
        )).toBe(false);
        expect(tileFeatureInteractionTargetsEqual(
            target("Road.7"),
            target("Road.7", "Map/Layer/43")
        )).toBe(false);
    });
});
