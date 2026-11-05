import type { Parameters } from "@luma.gl/core";

/** Geographic UI overlays must not write or compete with feature depth. */
export const DECK_OVERLAY_PARAMETERS: Parameters = {
    depthWriteEnabled: false,
    depthCompare: "always",
    cullMode: "none"
};

/** Dimensions and identity of the existing location/search marker atlas. */
export const LOCATION_MARKER_ICON_NAME = "marker";
export const LOCATION_MARKER_ICON_SIZE_PX = 48;
