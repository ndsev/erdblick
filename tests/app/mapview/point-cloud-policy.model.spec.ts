import {describe, expect, it} from "vitest";
import {
    DEFAULT_POINT_CLOUD_POLICY,
    pointCloudPolicySchema
} from "../../../app/mapview/point-cloud-policy.model";

describe("point-cloud policy", () => {
    it("accepts the sampling default and validates saved preferences", () => {
        expect(pointCloudPolicySchema.safeParse(DEFAULT_POINT_CLOUD_POLICY).success).toBe(true);
        expect(pointCloudPolicySchema.safeParse({...DEFAULT_POINT_CLOUD_POLICY, enabled: false}).success).toBe(true);
        expect(pointCloudPolicySchema.safeParse({...DEFAULT_POINT_CLOUD_POLICY, enabled: "false"}).success).toBe(false);
        for (const detailPixels of [0, -1, Infinity, NaN, 33]) {
            expect(pointCloudPolicySchema.safeParse({...DEFAULT_POINT_CLOUD_POLICY, detailPixels}).success).toBe(false);
        }
    });
});
