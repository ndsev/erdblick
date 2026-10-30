import {z} from "zod";

/** Application-wide point-cloud preferences; view allocations are derived at runtime. */
export interface PointCloudPolicy {
    enabled: boolean;
    /** Retained for saved-state compatibility; count-based sampling ignores screen-space spacing. */
    detailPixels: number;
    workingMemoryMiB: number;
    gpuMemoryMiB: number;
}

/** Transient policy for one immutable subset; never persisted in AppState. */
export interface PointCloudRenderPolicy {
    enabled: boolean;
    maxPoints: number;
    spacingMeters: number;
    cacheKey: string;
}

/** Keep complete objects below 14 million points; larger objects retain exactly this many. */
export const POINT_CLOUD_MAX_POINTS = 13_999_999;

export const DEFAULT_POINT_CLOUD_POLICY: Readonly<PointCloudPolicy> = {
    enabled: true,
    detailPixels: 2,
    workingMemoryMiB: 6144,
    gpuMemoryMiB: 3072
};

export const pointCloudDetailSchema = z.coerce.number().finite().min(0.5).max(32);
export const pointCloudWorkingMemorySchema = z.coerce.number().finite().int().min(32).max(16384);
export const pointCloudGpuMemorySchema = z.coerce.number().finite().int().min(16).max(8192);
export const pointCloudPolicySchema = z.object({
    enabled: z.boolean(),
    detailPixels: pointCloudDetailSchema,
    workingMemoryMiB: pointCloudWorkingMemorySchema,
    gpuMemoryMiB: pointCloudGpuMemorySchema
});
