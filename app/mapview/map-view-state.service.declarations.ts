import {z} from "zod";
import {viewIdSchema} from "../mapview/view-id";

const tabSelectorSchema = z.strictObject({});
const syncSchema = z.array(z.enum(["pos", "mov", "proj", "lay"])).max(4);
const markerSchema = z.strictObject({
    enabled: z.boolean(),
    position: z
        .strictObject({
            lon: z.number().min(-180).max(180),
            lat: z.number().min(-90).max(90),
            alt: z.number()
        })
        .nullable()
});
const navigationPreferencesSchema = z.strictObject({
    zoomStep: z.number().min(0.001).max(1),
    featureZoomClearance: z.number().min(0).max(100)
});

export const viewStateControls = {
    focusedView: {
        name: "app.focusedView",
        description: "Focused source view; identified by its stable view ID.",
        selectorSchema: tabSelectorSchema,
        valueSchema: viewIdSchema,
        readable: true,
        writable: true,
        persistence: "url-and-local-storage",
        synchronization: "none"
    },
    viewSync: {
        name: "app.viewSync",
        description:
            "Cross-view synchronization: pos keeps camera positions equal; mov synchronizes relative camera movement; choose at most one of pos and mov. proj synchronizes projection; lay synchronizes layers. Omit lay to keep different map layers in each view.",
        selectorSchema: tabSelectorSchema,
        valueSchema: syncSchema,
        readable: true,
        writable: true,
        persistence: "url-and-local-storage",
        synchronization: "none"
    },
    marker: {
        name: "app.marker",
        description: "Coordinate marker visibility and WGS84 position.",
        selectorSchema: tabSelectorSchema,
        valueSchema: markerSchema,
        readable: true,
        writable: true,
        persistence: "url-and-local-storage",
        synchronization: "none"
    },
    navigation: {
        name: "app.preferences.navigation",
        description: "Zoom step and feature-fit clearance in metres.",
        selectorSchema: tabSelectorSchema,
        valueSchema: navigationPreferencesSchema,
        readable: true,
        writable: true,
        persistence: "local-storage",
        synchronization: "none"
    }
} as const;
