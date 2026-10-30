import {describe, expect, it} from "vitest";
import {
    DEFAULT_POINT_CLOUD_POLICY,
    pointCloudPolicySchema
} from "../../../app/mapview/point-cloud-policy.model";

describe("point-cloud policy", () => {
    it("accepts the default allowances and rejects invalid resource preferences", () => {
        expect(pointCloudPolicySchema.safeParse(DEFAULT_POINT_CLOUD_POLICY).success).toBe(true);
        for (const workingMemoryMiB of [0, -1, Infinity, NaN, 16385, 64.5]) {
            expect(pointCloudPolicySchema.safeParse({...DEFAULT_POINT_CLOUD_POLICY, workingMemoryMiB}).success).toBe(false);
        }
        for (const gpuMemoryMiB of [0, -1, Infinity, NaN, 8193, 64.5]) {
            expect(pointCloudPolicySchema.safeParse({...DEFAULT_POINT_CLOUD_POLICY, gpuMemoryMiB}).success).toBe(false);
        }
        expect(pointCloudPolicySchema.safeParse({...DEFAULT_POINT_CLOUD_POLICY, detailPixels: 0}).success).toBe(false);
    });
});
