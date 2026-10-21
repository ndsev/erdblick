import {z} from "zod";

export const connectionControls = {
    compression: {
        name: "app.preferences.connection", description: "Browser tile-stream transport compression preference.",
        selectorSchema: z.strictObject({}), valueSchema: z.strictObject({tilePullCompression: z.boolean()}),
        readable: true, writable: true, persistence: "local-storage", synchronization: "none"
    }
} as const;
