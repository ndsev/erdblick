import {z} from "zod";
import {boundedUnicodeString} from "./unicode-string.js";
import {discoveryPageShape, discoveryResult, identifierSchema} from "../actions/app-action.js";

export const configActions = {
    listBackgrounds: {
        name: "viewer_list_backgrounds", mutation: false,
        description: "List configured background identities, display names and types without disclosing source URLs or request headers.",
        inputSchema: z.strictObject({...discoveryPageShape}),
        outputSchema: discoveryResult(z.strictObject({id: identifierSchema, name: boundedUnicodeString(4096), kind: boundedUnicodeString(128)}))
    }
} as const;
