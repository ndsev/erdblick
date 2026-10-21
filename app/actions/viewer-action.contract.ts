import {z} from "zod";
import {DiagnosticsFacadeService} from "../diagnostics/diagnostics.facade.service";
import {InspectionSelectionService} from "../inspection/inspection-selection.service";
import {InspectionStateService} from "../inspection/inspection-state.service";
import {MapInfoService} from "../mapdata/map-info.service";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {MapViewService} from "../mapview/map-view.service";
import {FeatureSearchService} from "../search/feature.search.service";
import {AppConfigService} from "../shared/app-config.service";
import {AppUrlStateService} from "../shared/app-url-state.service";
import {StyleService} from "../styledata/style.service";
import {createControlActions} from "./control-actions";
import {ViewerUiService} from "./viewer-ui.service";

export {VIEWER_ACTION_INVOCATION_BYTES, VIEWER_ACTION_RESULT_BYTES, VIEWER_ACTION_TARGET_LIMIT} from "./action-limits";

/** Collect exact owner declarations without constructing services or touching browser state. */
export const controlDeclarations = [
    ...Object.values(MapViewService.controls),
    ...Object.values(MapViewStateService.controls),
    ...Object.values(MapInfoService.controls),
    ...Object.values(FeatureSearchService.controls),
    ...Object.values(InspectionSelectionService.controls),
    ...Object.values(InspectionStateService.controls)
] as const;
export const controlActions = createControlActions(controlDeclarations);
export const actionDeclarations = [
    ...Object.values(controlActions),
    ...Object.values(MapViewService.actions),
    ...Object.values(MapInfoService.actions),
    ...Object.values(FeatureSearchService.actions),
    ...Object.values(InspectionSelectionService.actions),
    ...Object.values(InspectionStateService.actions),
    ...Object.values(StyleService.actions),
    ...Object.values(AppUrlStateService.actions),
    ...Object.values(DiagnosticsFacadeService.actions),
    ...Object.values(ViewerUiService.actions),
    ...Object.values(AppConfigService.actions)
] as const;
if (
    new Set(actionDeclarations.map((action) => action.name)).size !== actionDeclarations.length ||
    new Set(controlDeclarations.map((control) => control.name)).size !== controlDeclarations.length
) {
    throw new Error("Duplicate public declaration in owner catalog");
}
export const viewerActions = Object.fromEntries(actionDeclarations.map((action) => [action.name, action])) as {
    [Declaration in (typeof actionDeclarations)[number] as Declaration["name"]]: Declaration;
};
export type ViewerActionName = keyof typeof viewerActions;
export type ViewerActionInput<Name extends ViewerActionName> = z.infer<(typeof viewerActions)[Name]["inputSchema"]>;
export type ViewerActionOutput<Name extends ViewerActionName> = z.infer<(typeof viewerActions)[Name]["outputSchema"]>;

export function viewerJsonSchema(schema: z.ZodType): Record<string, unknown> {
    return z.toJSONSchema(schema, {target: "draft-07", io: "input", reused: "inline", cycles: "throw"});
}

/** Permissions come from mutation; no owner can promote a browser tool to native privileges. */
export function viewerActionCatalog() {
    return {
        formatVersion: 1 as const,
        actions: actionDeclarations.map((action) => ({
            name: action.name,
            description: action.description,
            mutation: action.mutation,
            permission: action.mutation ? "viewer-control" : "viewer-read",
            inputSchema: viewerJsonSchema(action.inputSchema),
            outputSchema: viewerJsonSchema(action.outputSchema)
        })),
        // formatVersion 1 calls this manifest field channels. Runtime APIs call them controls.
        channels: controlDeclarations.map((control) => ({
            ...control,
            selectorSchema: viewerJsonSchema(control.selectorSchema),
            valueSchema: viewerJsonSchema(control.valueSchema)
        }))
    };
}

/** Canonical contract bytes: sorted object keys, ordered arrays, ECMAScript JSON scalars. */
export function canonicalViewerContractJson(value: unknown): string {
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
    ) {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalViewerContractJson).join(",")}]`;
    }
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        return `{${Object.keys(value)
            .sort()
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${canonicalViewerContractJson((value as Record<string, unknown>)[key])}`
            )
            .join(",")}}`;
    }
    throw new TypeError("Viewer contracts must contain only finite JSON values.");
}
