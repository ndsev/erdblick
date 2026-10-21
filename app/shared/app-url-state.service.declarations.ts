import {z} from "zod";
import {boundedUnicodeString} from "./unicode-string.js";
import {identifierSchema, indexSchema, colorSchema} from "../actions/app-action.js";
import {viewIdSchema} from "../mapview/map-view-state.service.declarations.js";


export const urlActions = {
    getShareLink: {name: "viewer_get_share_link", 
        description: "Return a link for the current URL-backed cameras, layers, style options and selections using the viewer's normal URL codec. Does not copy unknown/authentication URL parameters, modify the tab, publish anything or contact another person. Browser-local search overlays and YAML styles are not embedded; localSearchIds and localStyleIds identify dependencies the recipient would also need. Export searches separately with viewer_export_search and styles with viewer_get_style. localOnly means the hostname is loopback: recipients need an accessible address for the same configured viewer.",
        mutation: false,
        inputSchema: z.strictObject({}),
        outputSchema: z.strictObject({...{observedAt: z.string()}, ...{complete: z.boolean(), reason: z.enum(["item_limit", "byte_limit", "text_limit", "loading"]).optional()}, url: boundedUnicodeString(48000, true),
            localOnly: z.boolean(), localStyleIds: z.array(identifierSchema).max(100), localSearchIds: z.array(identifierSchema).max(100)})
    }
} as const;
