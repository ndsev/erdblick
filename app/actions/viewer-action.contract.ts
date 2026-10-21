import { z } from "zod";
import { diagnosticActions } from "../diagnostics/diagnostics.facade.service.declarations.js";
import { inspectionActions } from "../inspection/inspection-selection.service.declarations.js";
import { inspectionStateActions } from "../inspection/inspection-state.service.declarations.js";
import { mapActions } from "../mapdata/map-info.service.declarations.js";
import { mapViewActions } from "../mapview/map-view.service.declarations.js";
import { externalViewerActions } from "../search/external-viewer.service.declarations.js";
import { searchActions, searchInputActions } from "../search/feature.search.service.declarations.js";
import { jumpActions } from "../search/jump.service.declarations.js";
import { locationActions, navigationActions } from "../search/location-navigation.service.declarations.js";
import { configActions } from "../shared/app-config.service.declarations.js";
import { urlActions } from "../shared/app-url-state.service.declarations.js";
import { styleActions, styleDiscoveryActions } from "../styledata/style.service.declarations.js";
import { composeDeclarations } from "./app-action.js";
import { controlActions, describeControls, viewerJsonSchema } from "./app-action.service.declarations.js";
import { captureActions, viewerUiActions } from "./viewer-ui.service.declarations.js";

export { VIEWER_ACTION_INVOCATION_BYTES, VIEWER_ACTION_RESULT_BYTES, VIEWER_ACTION_TARGET_LIMIT } from "./app-action.js";
export { viewerJsonSchema } from "./app-action.service.declarations.js";

/** Build/startup composition. Definitions remain in the named owners' declaration files. */
export const viewerActions = composeDeclarations(
    controlActions, mapViewActions, mapActions, configActions, inspectionActions,
    inspectionStateActions, navigationActions, searchActions, urlActions, styleActions,
    styleDiscoveryActions, diagnosticActions, captureActions, viewerUiActions
);

/** Local-only producers share registration and dispatch while remaining absent from MCP discovery. */
export const applicationActions = composeDeclarations(viewerActions, jumpActions, externalViewerActions, locationActions, searchInputActions);

export type ViewerActionName = keyof typeof viewerActions;
export type ViewerActionInput<Name extends ViewerActionName> = z.infer<typeof viewerActions[Name]["inputSchema"]>;
export type ViewerActionOutput<Name extends ViewerActionName> = z.infer<typeof viewerActions[Name]["outputSchema"]>;

/** The native v1 envelope retains channels; public tools call them controls. */
export function viewerActionCatalog() {
    return {
        formatVersion: 1 as const,
        actions: Object.values(viewerActions).map(action => ({
            ...action,
            permission: action.mutation ? "viewer-control" : "viewer-read",
            inputSchema: viewerJsonSchema(action.inputSchema), outputSchema: viewerJsonSchema(action.outputSchema)
        })),
        channels: describeControls()
    };
}

/** Canonical contract bytes: sorted object keys, ordered arrays, ECMAScript JSON scalars. */
export function canonicalViewerContractJson(value: unknown): string {
    if (value === null || typeof value === "string" || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalViewerContractJson).join(",")}]`;
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonicalViewerContractJson((value as Record<string, unknown>)[key])}`
        ).join(",")}}`;
    }
    throw new TypeError("Viewer contracts must contain only finite JSON values.");
}
