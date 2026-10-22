import {inject, Injector} from "@angular/core";
import {signalStoreFeature, withMethods} from "@ngrx/signals";
import {z} from "zod";
import {action} from "../actions/action";
import {bounded, identifierSchema, observed, pageInput, pageOutput, text} from "../actions/action-schema";
import {AppConfigService} from "./app-config.service";
import {AppUrlStateService} from "./app-url-state.service";
import {boundedUnicodeString} from "./unicode-string";

/** App configuration and share-link projections use the same contracts as their resources. */
export const appActions = {
    listBackgrounds: {
        name: "viewer_list_backgrounds",
        mutation: false,
        description: "List configured background identities and labels without exposing URLs or credentials.",
        inputSchema: z.strictObject({...pageInput}),
        outputSchema: z.strictObject({
            ...pageOutput,
            items: z.array(z.strictObject({id: identifierSchema, name: text, kind: text})).max(100)
        })
    },
    getShareLink: {
        name: "viewer_get_share_link",
        description:
            "Return a link for the current URL-backed cameras, layers, style options and selections using the viewer's normal URL codec. Does not copy unknown/authentication URL parameters, modify the tab, publish anything or contact another person. Browser-local search overlays and YAML styles are not embedded; localSearchIds and localStyleIds identify dependencies the recipient would also need. Export searches separately with viewer_export_search and styles with viewer_get_style. localOnly means the hostname is loopback: recipients need an accessible address for the same configured viewer.",
        mutation: false,
        inputSchema: z.strictObject({}),
        outputSchema: z.strictObject({
            ...observed,
            ...bounded,
            url: boundedUnicodeString(48000, true),
            localOnly: z.boolean(),
            localStyleIds: z.array(identifierSchema).max(100),
            localSearchIds: z.array(identifierSchema).max(100)
        })
    }
} as const;

/**
 * Expose app-level queries without constructing the config loader or URL adapter
 * during build discovery. Runtime invocation uses the already initialized owners
 * and the same URL encoding that ordinary share links use.
 */
export function withAppActions() {
    return signalStoreFeature(withMethods((_, injector = inject(Injector)) => ({
        listBackgrounds: action(
            appActions.listBackgrounds,
            (input): z.output<typeof appActions.listBackgrounds.outputSchema> =>
                injector.get(AppConfigService).listBackgrounds(input)
        ),
        getShareLink: action(
            appActions.getShareLink,
            (): z.output<typeof appActions.getShareLink.outputSchema> =>
                injector.get(AppUrlStateService).getShareLink()
        )
    })));
}
