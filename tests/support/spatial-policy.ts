import type {SpatialRequestContext} from "../../app/mapdata/spatial-extent.model";

/** Default ready catalog context for tests unrelated to coverage geometry. */
export function spatialPolicyHarness() {
    const context: SpatialRequestContext = {viewId: "0", policy: {defaultLimit: true, maps: {}}, revision: "coverage:0"};
    return {spatialRequestContext: () => context, spatialRequestContextForViewId: () => context,
        permitsSpatialTile: () => true};
}
