import {inject, Injector} from "@angular/core";
import {signalStoreFeature, withMethods, withProps} from "@ngrx/signals";
import {z} from "zod";
import {action, ActionDeclaration} from "../actions/action";
import {omnibarProvider} from "../actions/omnibar";
import {viewIdentitySchema} from "../mapview/view-id";
import {CoordinateJumpService} from "./coordinate-jump.service";
import {ExternalViewerService} from "./external-viewer.service";
import {JumpTargetService} from "./jump.service";
import {LocationNavigationService} from "./location-navigation.service";

/** Stable coordinate interpretation ids also identify the six omnibar choices. */
export const coordinateParserSchema = z.enum([
    "j:packed-tile-id",
    "j:nds-x-y",
    "j:nds-y-x",
    "j:morton-code",
    "j:wgs84-lon-lat",
    "j:wgs84-lat-lon"
]);

/** Local navigation operations retain their existing identities and stay outside the MCP manifest. */
export const navigationActions = {
    jumpCoordinates: {
        name: "omnibar_coordinates",
        description: "Navigate using one of the six coordinate or packed-tile interpretations.",
        mutation: true,
        exposure: "omnibar",
        inputSchema: z.strictObject({
            parser: coordinateParserSchema,
            query: z.string().min(1).max(8192),
            target: viewIdentitySchema
        }),
        outputSchema: z.void()
    },
    openExternalViewer: {
        name: "omnibar_external_viewer",
        description: "Open a currently configured external viewer at a validated location.",
        mutation: true,
        exposure: "omnibar",
        inputSchema: z.strictObject({
            providerId: z.string().min(1),
            location: z.strictObject({
                lat: z.number().min(-90).max(90),
                lon: z.number().min(-180).max(180)
            })
        }),
        outputSchema: z.void()
    },
    navigateToLocation: {
        name: "omnibar_location",
        description: "Resolve a current or saved location through its provider and navigate once.",
        mutation: true,
        exposure: "omnibar",
        inputSchema: z.strictObject({
            actionId: z.string().startsWith("loc:").max(2048),
            payload: z.unknown().optional(),
            target: viewIdentitySchema
        }),
        outputSchema: z.void()
    },
    inspectSourceFromOmnibar: {
        name: "omnibar_source_data",
        description: "Inspect a packed tile's source data using the current map catalog.",
        mutation: true,
        exposure: "omnibar",
        inputSchema: z.strictObject({query: z.string().min(1).max(8192)}),
        outputSchema: z.void()
    },
    jumpToFeature: {
        name: "omnibar_feature_jump",
        description: "Locate a current feature composition and navigate to the captured view.",
        mutation: true,
        exposure: "omnibar",
        inputSchema: z.strictObject({
            compositionId: z.string().min(1),
            query: z.string().min(1).max(8192),
            target: viewIdentitySchema
        }),
        outputSchema: z.void()
    },
    runJumpPlugin: {
        name: "omnibar_jump_plugin",
        description: "Run a currently configured jump provider after revalidating its input and view.",
        mutation: true,
        exposure: "omnibar",
        inputSchema: z.strictObject({
            pluginId: z.string().min(1),
            query: z.string().max(8192),
            payload: z.unknown().optional(),
            target: viewIdentitySchema
        }),
        outputSchema: z.void()
    }
} as const satisfies Record<string, ActionDeclaration>;

export type NavigationActionInput<Name extends keyof typeof navigationActions> = z.infer<
    (typeof navigationActions)[Name]["inputSchema"]
>;

/**
 * Coordinates, locations, feature lookup, and configured plugins are runtime work.
 * Store creation captures only their injector. Calling a typed operation resolves
 * its owner; asking for omnibar candidates resolves the corresponding provider.
 * Reading the catalog invokes neither path and therefore starts no map or request.
 */
export function withNavigationActions() {
    return signalStoreFeature(
        withMethods(() => {
            const injector = inject(Injector);
            const coordinates = () => injector.get(CoordinateJumpService);
            const externalViewers = () => injector.get(ExternalViewerService);
            const locations = () => injector.get(LocationNavigationService);
            const jumps = () => injector.get(JumpTargetService);
            return {
                jumpCoordinates: action(navigationActions.jumpCoordinates, (input): void =>
                    coordinates().jumpCoordinates(input)),
                openExternalViewer: action(navigationActions.openExternalViewer, (input): void =>
                    externalViewers().openExternalViewer(input)),
                navigateToLocation: action(navigationActions.navigateToLocation, (input): void =>
                    locations().navigate(input.actionId, input.payload, input.target)),
                inspectSourceFromOmnibar: action(navigationActions.inspectSourceFromOmnibar, (input): void =>
                    jumps().inspectSourceFromOmnibar(input)),
                jumpToFeature: action(navigationActions.jumpToFeature, (input): Promise<void> =>
                    jumps().jumpToFeature(input)),
                runJumpPlugin: action(navigationActions.runJumpPlugin, (input): Promise<void> =>
                    jumps().runJumpPlugin(input))
            };
        }),
        withProps(() => {
            const injector = inject(Injector);
            return {
                coordinateOmnibarProvider: omnibarProvider({
                    name: "coordinates",
                    order: 30,
                    suggest: (query) => injector.get(CoordinateJumpService).targets(query)
                }),
                externalViewerOmnibarProvider: omnibarProvider({
                    name: "external-viewers",
                    order: 40,
                    suggest: (query) => injector.get(ExternalViewerService).targets(query)
                }),
                locationOmnibarProvider: omnibarProvider({
                    name: "locations",
                    order: 0,
                    search: (query) => injector.get(LocationNavigationService).searchTargets(query)
                }),
                jumpOmnibarProvider: omnibarProvider({
                    name: "feature-and-plugin-jumps",
                    order: 10,
                    suggest: (query) => injector.get(JumpTargetService).getJumpTargetsForValue(query)
                })
            };
        })
    );
}
