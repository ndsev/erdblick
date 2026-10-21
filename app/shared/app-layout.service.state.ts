import {signalStoreFeature, withState} from "@ngrx/signals";
import {z} from "zod";
import {InspectionDialogLayout} from "../inspection/inspection-state.model";
import {Boolish} from "../shared/app-state";
import {AppDialogLayout, INSPECTION_DOCK_TAB_ID} from "./app-layout.model";
import {AppStateOptions, deepCopy} from "./state-value";

export interface AppLayoutServiceValues {
    dockOpen: boolean;
    dockWidth: number | null;
    viewPanelSizes: number[];
    dockActiveTab: string;
    dockAutoCollapse: boolean;
    dialogLayouts: Record<string, AppDialogLayout | InspectionDialogLayout>;
}

/** Named codec declarations are also the single source of SignalStore defaults. */
export const ownerState = {
    dockOpen: {
        name: "dockOpenState",
        defaultValue: false,
        schema: Boolish
    } satisfies AppStateOptions<AppLayoutServiceValues["dockOpen"]>,

    dockWidth: {
        name: "dockWidth",
        defaultValue: null,
        schema: z.number().min(0).max(32768).nullable()
    } satisfies AppStateOptions<AppLayoutServiceValues["dockWidth"]>,

    viewPanelSizes: {
        name: "viewPanelSizes",
        defaultValue: [],
        schema: z.array(z.number().min(0).max(100)).max(2)
    } satisfies AppStateOptions<AppLayoutServiceValues["viewPanelSizes"]>,

    dockActiveTab: {
        name: "dockActiveTabState",
        defaultValue: INSPECTION_DOCK_TAB_ID,
        schema: z.string()
    } satisfies AppStateOptions<AppLayoutServiceValues["dockActiveTab"]>,

    dockAutoCollapse: {
        name: "dockAutoCollapse",
        defaultValue: true,
        schema: Boolish
    } satisfies AppStateOptions<AppLayoutServiceValues["dockAutoCollapse"]>,

    dialogLayouts: {
        name: "dialogLayouts",
        defaultValue: {},
        schema: z.record(
            z.string(),
            z.object({
                position: z.object({
                    left: z.coerce.number(),
                    top: z.coerce.number()
                }),
                size: z.object({
                    width: z.coerce.number().positive(),
                    height: z.coerce.number().positive()
                }),
                open: Boolish.optional(),
                panelId: z.coerce.number().optional(),
                slot: z.coerce.number().optional(),
                docked: Boolish.optional(),
                dockTab: z.string().optional(),
                dockOrder: z.coerce.number().optional(),
                panelSize: z
                    .object({
                        width: z.coerce.number().positive(),
                        height: z.coerce.number().positive()
                    })
                    .optional(),
                panelCollapsed: Boolish.optional(),
                panelExpanded: Boolish.optional()
            })
        )
    } satisfies AppStateOptions<AppLayoutServiceValues["dialogLayouts"]>
};

/** The application composes this feature; its owner binds codecs to these same declarations. */
export function withAppLayout() {
    return signalStoreFeature(
        withState(() => {
            const initial: AppLayoutServiceValues = {
                dockOpen: deepCopy(ownerState.dockOpen.defaultValue),
                dockWidth: deepCopy(ownerState.dockWidth.defaultValue),
                viewPanelSizes: deepCopy(ownerState.viewPanelSizes.defaultValue),
                dockActiveTab: deepCopy(ownerState.dockActiveTab.defaultValue),
                dockAutoCollapse: deepCopy(ownerState.dockAutoCollapse.defaultValue),
                dialogLayouts: deepCopy(ownerState.dialogLayouts.defaultValue)
            };
            return {layout: initial};
        })
    );
}
