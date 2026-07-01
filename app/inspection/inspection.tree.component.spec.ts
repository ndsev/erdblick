import {describe, expect, it} from "vitest";
import {inspectionSearchNumberLiteral} from "./inspection-search.util";
import {
    formatInspectionArrayContainerSummary,
    formatInspectionArrayValueCount
} from "./inspection-array-summary.util";

describe("inspectionSearchNumberLiteral", () => {
    it("keeps BigInt inspection integers as unquoted Simfil numeric literals", () => {
        expect(inspectionSearchNumberLiteral(50n)).toBe("50");
    });

    it("accepts finite numbers and strict numeric strings", () => {
        expect(inspectionSearchNumberLiteral(42)).toBe("42");
        expect(inspectionSearchNumberLiteral(" 1.25e+2 ")).toBe("1.25e+2");
    });

    it("rejects non-numeric strings instead of creating partial numeric literals", () => {
        expect(inspectionSearchNumberLiteral("50 km/h")).toBeUndefined();
        expect(inspectionSearchNumberLiteral("50n")).toBeUndefined();
    });
});

describe("feature inspection array summaries", () => {
    it("keeps array value counts out of the propagated value text", () => {
        const children = [
            {data: {key: "0", value: 1}},
            {data: {key: "1", value: 2}},
            {data: {key: "2", value: 3}}
        ];

        expect(formatInspectionArrayValueCount(children)).toBe("3");
        expect(formatInspectionArrayContainerSummary(children)).toBe("[1, 2, 3]");
    });
});
