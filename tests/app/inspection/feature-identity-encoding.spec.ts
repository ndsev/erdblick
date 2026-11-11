import {describe, expect, it} from "vitest";

import {
    formatFeatureInspectionTarget,
    hasFeatureInspectionValidity,
    isFeatureInspectionSubTarget,
    namedFeatureReferenceJson,
    parseFeatureInspectionTarget,
    stripFeatureInspectionTarget,
    stripFeatureInspectionValidity,
    tileFeatureInteractionTargetsEqual
} from "../../../app/inspection/feature-identity.model";

const target = (featureId: string, mapTileKey = "Map/Layer/42") => ({
    featureId,
    mapTileKey
});

describe("tile feature interaction identity", () => {
    it("writes named foreign parts without losing integer precision, names or string types", () => {
        const reference = {
            mapId: "Target / map", typeId: "Road",
            id: Object.assign(Object.create(null), {large: 9223372036854775807n,
                negative: -9223372036854775808n, decimalText: "9223372036854775807", small: 42},
                JSON.parse('{"__proto__":"literal","quoted\\\"key":"\\\"\\\\"}'))
        };
        const json = namedFeatureReferenceJson(reference);
        expect(json).toContain('"large":9223372036854775807');
        expect(json).toContain('"negative":-9223372036854775808');
        expect(json).toContain('"decimalText":"9223372036854775807"');
        const decoded = JSON.parse(json);
        expect(decoded.id.__proto__).toBe("literal");
        expect(decoded.id['quoted"key']).toBe('"\\');
        expect(decoded.id.small).toBe(42);
    });

    it("rejects already rounded or out-of-range foreign integer parts", () => {
        const invalid: Array<Record<string, string | number | bigint>> = [
            {part: 9007199254740992}, {part: 9223372036854775808n}, {part: 1.5}, {}
        ];
        for (const id of invalid) {
            expect(() => namedFeatureReferenceJson({mapId: "Target", typeId: "Road", id})).toThrow();
        }
    });
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
