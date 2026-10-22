import "@angular/compiler";
/** Typed test inventory. Production discovers registrations through Angular DI. */
import { z } from "zod";
import { composeDeclarations } from "../app/actions/app-action";
import { createControlActions, describeControls, viewerJsonSchema } from "../app/actions/control-actions";
import { captureActions, viewerUiActions } from "../app/actions/ui-automation.service";
import { configActions } from "../app/config/app-config.service";
import { diagnosticActions } from "../app/diagnostics/diagnostics.facade.service";
import { inspectionStateActions } from "../app/inspection/inspection-panel.service";
import { inspectionActions } from "../app/inspection/inspection-selection.service";
import { mapActions } from "../app/mapdata/map-info.service";
import { mapViewActions } from "../app/mapview/map-view.service";
import { externalViewerActions } from "../app/navigation/external-viewer.service";
import { jumpActions } from "../app/navigation/jump.service";
import { locationActions, navigationActions } from "../app/navigation/location-navigation.service";
import { searchActions, searchInputActions } from "../app/search/feature.search.service";
import { urlActions } from "../app/state/app-url-state.service";
import { styleActions, styleDiscoveryActions } from "../app/styledata/style.service";
import { applicationControls } from "./control-contract";

const controlActions = createControlActions(Object.values(applicationControls).sort((left, right) => left.name.localeCompare(right.name, "en")));

export { VIEWER_ACTION_INVOCATION_BYTES, VIEWER_ACTION_RESULT_BYTES, VIEWER_ACTION_TARGET_LIMIT } from "../app/actions/app-action";
export { viewerJsonSchema } from "../app/actions/control-actions";

/** Typed expectations for contract and browser tests; never imported by the application. */
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
        channels: describeControls(Object.values(applicationControls))
    };
}

export { canonicalViewerContractJson } from "../app/actions/viewer-action.contract";
