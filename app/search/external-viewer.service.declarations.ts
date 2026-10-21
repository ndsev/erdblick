import { z } from "zod";
import { boundedUnicodeString } from "../shared/unicode-string.js";

/** Provider URLs stay in runtime configuration and are absent from the build catalog. */
export const externalViewerActions = {
    open: {
        name: "open_external_viewer",
        exposure: "omnibar",
        mutation: true,
        description: "Open a configured external viewer at input coordinates, the marker or focused map centre.",
        inputSchema: z.strictObject({ providerId: boundedUnicodeString(4096, true), text: boundedUnicodeString(4096) }),
        outputSchema: z.strictObject({ status: z.literal("applied"), changed: z.boolean() })
    }
} as const;
