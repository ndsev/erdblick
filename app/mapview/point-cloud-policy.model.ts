import {z} from "zod";

/** Application-wide point-cloud sampling preferences. */
export interface PointCloudPolicy {
    enabled: boolean;
    maxPoints: number;
    /** Retained for saved-state compatibility; count-based sampling ignores screen-space spacing. */
    detailPixels: number;
}

/** Transient policy for one immutable subset; never persisted in AppState. */
export interface PointCloudRenderPolicy {
    enabled: boolean;
    maxPoints: number;
    spacingMeters: number;
    cacheKey: string;
}

/** Default per-object detail, not a worker or GPU allocation limit. */
export const DEFAULT_POINT_CLOUD_MAX_POINTS = 14_000_000;
export const MIN_POINT_CLOUD_MAX_POINTS = 100_000;
export const MAX_POINT_CLOUD_MAX_POINTS = 14_000_000;

export const DEFAULT_POINT_CLOUD_POLICY: Readonly<PointCloudPolicy> = {
    enabled: true,
    maxPoints: DEFAULT_POINT_CLOUD_MAX_POINTS,
    detailPixels: 2
};

export const pointCloudDetailSchema = z.coerce.number().finite().min(0.5).max(32);
export const pointCloudMaxPointsSchema = z.coerce.number().int()
    .min(MIN_POINT_CLOUD_MAX_POINTS).max(MAX_POINT_CLOUD_MAX_POINTS);
export const pointCloudPolicySchema = z.object({
    enabled: z.boolean(),
    maxPoints: pointCloudMaxPointsSchema,
    detailPixels: pointCloudDetailSchema
});
