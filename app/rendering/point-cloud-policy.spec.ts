import {describe, expect, it} from "vitest";
import {DEFAULT_POINT_CLOUD_POLICY, pointCloudPolicySchema, pointCloudSpacingMeters} from "./point-cloud-policy";

describe("point-cloud policy", () => {
    it("rejects non-finite and unsafe resource preferences", () => {
        for (const workingMemoryMiB of [0, -1, Infinity, NaN, 4097, 64.5]) {
            expect(pointCloudPolicySchema.safeParse({...DEFAULT_POINT_CLOUD_POLICY, workingMemoryMiB}).success).toBe(false);
        }
        expect(pointCloudPolicySchema.safeParse({...DEFAULT_POINT_CLOUD_POLICY, detailPixels: 0}).success).toBe(false);
    });

    it("keeps density stable near a threshold and changes it for a substantial zoom", () => {
        const first = pointCloudSpacingMeters(1, 2);
        expect(first).toBe(2);
        expect(pointCloudSpacingMeters(1.1, 2, first)).toBe(first);
        expect(pointCloudSpacingMeters(0.9, 2, first)).toBe(first);
        expect(pointCloudSpacingMeters(4, 2, first)).toBe(8);
        expect(pointCloudSpacingMeters(null, 2)).toBe(0);
    });
});
