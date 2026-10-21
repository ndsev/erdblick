import { z } from "zod";

/** IDs address persisted records; Object.prototype names are deliberately reserved. */
export const viewIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
    .refine(id => !Object.hasOwn(Object.prototype, id), "This view ID is reserved.")
    .meta({ not: { enum: Object.getOwnPropertyNames(Object.prototype) } });

/** MapViewStateService owns logical focus, synchronization policy and navigation preferences. */
export const viewSettingsControls = {
    focus: {
        name: "app.focusedView",
        description: "Focused source view, addressed by its current logical view ID.",
        selectorSchema: z.strictObject({}),
        valueSchema: viewIdSchema,
        readable: true,
        writable: true,
        synchronization: "none",
        persistence: "url-and-local-storage"
    },
    sync: {
        name: "app.viewSync",
        description: "Cross-view synchronization: pos keeps camera positions equal; mov synchronizes relative camera movement; choose at most one of pos and mov. proj synchronizes projection; lay synchronizes layers. Omit lay to keep different map layers in each view.",
        selectorSchema: z.strictObject({}),
        valueSchema: z.array(z.enum(["pos", "mov", "proj", "lay"])).max(4),
        readable: true,
        writable: true,
        synchronization: "none",
        persistence: "url-and-local-storage"
    },
    navigation: {
        name: "app.preferences.navigation",
        description: "Zoom step and feature-fit clearance in metres.",
        selectorSchema: z.strictObject({}),
        valueSchema: z.strictObject({
            zoomStep: z.number().min(0.001).max(1),
            featureZoomClearance: z.number().min(0).max(100)
        }),
        readable: true,
        writable: true,
        synchronization: "none",
        persistence: "local-storage"
    }
} as const;
