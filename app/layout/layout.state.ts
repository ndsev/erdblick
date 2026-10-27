/**
 * Saved layout of the dock, inspection tabs and dialogs. Components can observe
 * these AppStates without constructing LayoutService, which coordinates
 * opening, closing, focus and the inspection panel lifecycle.
 */
import { Injectable } from "@angular/core";
import { z } from "zod";
import { InspectionDialogLayout } from "../inspection/inspection.model";
import { Boolish } from "../appstate/appstate";
import { AppStateService } from "../appstate/appstate.service";
import { AppDialogLayout, INSPECTION_DOCK_TAB_ID } from "./layout.model";

@Injectable({ providedIn: "root" })
export class LayoutState {
    constructor(private readonly persistence: AppStateService) {}

    readonly mapsOpenState = this.persistence.registerState<boolean>({
        name: "mapsOpenState",
        defaultValue: false,
        schema: Boolish
    });

    readonly dockOpenState = this.persistence.registerState<boolean>({
        name: "dockOpenState",
        defaultValue: false,
        schema: Boolish
    });

    /** Local layout preferences; deliberately absent from shareable map URLs. */
    readonly dockWidthState = this.persistence.registerState<number | null>({
        name: "dockWidth",
        defaultValue: null,
        schema: z.number().min(0).max(32768).nullable()
    });

    readonly viewPanelSizesState = this.persistence.registerState<number[]>({
        name: "viewPanelSizes",
        defaultValue: [],
        schema: z.array(z.number().min(0).max(100)).max(2)
    });

    readonly dockActiveTabState = this.persistence.registerState<string>({
        name: "dockActiveTabState",
        defaultValue: INSPECTION_DOCK_TAB_ID,
        schema: z.string()
    });

    readonly dockAutoCollapse = this.persistence.registerState<boolean>({
        name: "dockAutoCollapse",
        defaultValue: true,
        schema: Boolish
    });

    readonly dialogLayoutsState = this.persistence.registerState<
        Record<string, AppDialogLayout | InspectionDialogLayout>
    >({
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
    });

    get isDockOpen() {
        return this.dockOpenState.getValue();
    }

    set isDockOpen(val: boolean) {
        this.dockOpenState.next(val);
    }

    get dockActiveTab() {
        return this.dockActiveTabState.getValue();
    }

    set dockActiveTab(val: string) {
        this.dockActiveTabState.next(val || INSPECTION_DOCK_TAB_ID);
    }

    get isDockAutoCollapsible() {
        return this.dockAutoCollapse.getValue();
    }

    set isDockAutoCollapsible(val: boolean) {
        this.dockAutoCollapse.next(val);
    }
}
