import {z} from "zod";

/** Application-wide point-cloud preferences; view allocations are derived at runtime. */
export interface PointCloudPolicy {
    enabled: boolean;
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

export const DEFAULT_POINT_CLOUD_POLICY: Readonly<PointCloudPolicy> = {
    enabled: true,
    detailPixels: 2,
    workingMemoryMiB: 512,
    gpuMemoryMiB: 256
};

export const pointCloudDetailSchema = z.coerce.number().finite().min(0.5).max(32);
export const pointCloudWorkingMemorySchema = z.coerce.number().finite().int().min(32).max(4096);
export const pointCloudGpuMemorySchema = z.coerce.number().finite().int().min(16).max(2048);
export const pointCloudPolicySchema = z.object({
    enabled: z.boolean(),
    detailPixels: pointCloudDetailSchema,
    workingMemoryMiB: pointCloudWorkingMemorySchema,
    gpuMemoryMiB: pointCloudGpuMemorySchema
});

/** Quantize physical spacing with hysteresis so small camera changes reuse the same selection. */
export function pointCloudSpacingMeters(
    metersPerPixel: number | null, detailPixels: number, previous = 0
): number {
    if (metersPerPixel === null || !Number.isFinite(metersPerPixel) || metersPerPixel <= 0) return 0;
    const desired = metersPerPixel * detailPixels;
    if (previous > 0 && desired >= previous / 1.6 && desired <= previous * 1.6) return previous;
    return Math.max(0.01, Math.min(1024, 2 ** Math.round(Math.log2(desired))));
}
