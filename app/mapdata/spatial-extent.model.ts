/** Sparse map preferences within one logical view. */
export interface SpatialExtentSettings {
    limitToSpatialExtent: boolean;
    showSpatialExtent: boolean;
}

/** Request policy understood by mapget, including destination maps of relations. */
export interface SpatialExtentPolicy {
    defaultLimit: boolean;
    maps: Record<string, boolean>;
}

/** Captured owner, never resolved from focus after asynchronous work starts. */
export interface SpatialRequestContext {
    viewId: string;
    policy: SpatialExtentPolicy;
    revision: string;
}

/** WGS84 rectangle; east may exceed 180 for a connected dateline-crossing area. */
export type SpatialExtentBounds = [number, number, number, number];

/** Known spatial exclusion is a terminal user-visible state, distinct from missing data. */
export class OutsideSpatialExtentError extends Error {
    constructor() { super("Outside spatial extent"); this.name = "OutsideSpatialExtentError"; }
}
