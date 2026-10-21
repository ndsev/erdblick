import { z } from "zod";

/** CoordinatesService exposes marker position and visibility as one coherent assignment. */
export const coordinateControls = {
    marker: {
        name: "app.marker",
        description: "Coordinate marker visibility and WGS84 position.",
        selectorSchema: z.strictObject({}),
        valueSchema: z.strictObject({
            enabled: z.boolean(),
            position: z.strictObject({
                lon: z.number().min(-180).max(180),
                lat: z.number().min(-90).max(90),
                alt: z.number()
            }).nullable()
        }),
        readable: true,
        writable: true,
        synchronization: "none",
        persistence: "url-and-local-storage"
    }
} as const;
