import {ownerState} from "./app-layout.service.state";

import {Injectable} from "@angular/core";
import {InspectionDialogLayout} from "../inspection/inspection-state.model";
import {AppStateService} from "../shared/appstate.service";
import {
    AppDialogLayout,
    AppDialogPosition,
    DEFAULT_EM_HEIGHT,
    DEFAULT_EM_WIDTH,
    INSPECTION_DOCK_TAB_ID
} from "./app-layout.model";

/** Owns layout values, validation, and user operations. */
@Injectable({providedIn: "root"})
export class AppLayoutService {
    // Base UI metrics
    /** Returns the configured base font size. */
    get baseFontSize(): number {
        return parseFloat(window.getComputedStyle(document.documentElement).fontSize);
    }

    readonly dockOpenState = this.stateService.register(ownerState.dockOpen, "layout", "dockOpen");

    /** Local layout preferences; deliberately absent from shareable map URLs. */
    readonly dockWidthState = this.stateService.register(ownerState.dockWidth, "layout", "dockWidth");

    readonly viewPanelSizesState = this.stateService.register(ownerState.viewPanelSizes, "layout", "viewPanelSizes");

    readonly dockActiveTabState = this.stateService.register(ownerState.dockActiveTab, "layout", "dockActiveTab");

    readonly dockAutoCollapse = this.stateService.register(ownerState.dockAutoCollapse, "layout", "dockAutoCollapse");

    readonly dialogLayoutsState = this.stateService.register(ownerState.dialogLayouts, "layout", "dialogLayouts");

    private readonly pendingOpenDialogs = new Set<string>();

    get isDockOpen() {
        return this.dockOpenState.getValue();
    }

    set isDockOpen(val: boolean) {
        this.stateService.transaction(() => {
            this.dockOpenState.next(val);
        });
    }

    get dockActiveTab() {
        return this.dockActiveTabState.getValue();
    }

    set dockActiveTab(val: string) {
        this.stateService.transaction(() => {
            this.dockActiveTabState.next(val || INSPECTION_DOCK_TAB_ID);
        });
    }

    get isDockAutoCollapsible() {
        return this.dockAutoCollapse.getValue();
    }

    set isDockAutoCollapsible(val: boolean) {
        this.stateService.transaction(() => {
            this.dockAutoCollapse.next(val);
        });
    }

    /** Returns the persisted layout for a dialog if one exists. */
    getDialogLayout(id: string): AppDialogLayout | InspectionDialogLayout | undefined {
        return this.dialogLayoutsState.getValue()[id];
    }

    /** Returns whether the persisted layout marks the dialog as open. */
    getDialogLayoutOpen(id: string): boolean {
        return this.getDialogLayout(id)?.open ?? false;
    }

    /** Returns whether a persisted dialog should currently be mounted and visible. */
    isDialogOpen(id: string): boolean {
        const layout = this.getDialogLayout(id);
        if (layout) {
            return layout.open ?? false;
        }
        return this.pendingOpenDialogs.has(id);
    }

    /** Marks a persisted dialog as open or closed, even before its first measured layout exists. */
    setDialogOpen(id: string, open: boolean): void {
        return this.stateService.transaction(() => {
            const current = this.getDialogLayout(id);
            if (current) {
                this.pendingOpenDialogs.delete(id);
                this.setDialogLayoutOpen(id, open);
                return;
            }
            if (open) {
                this.pendingOpenDialogs.add(id);
                return;
            }
            this.pendingOpenDialogs.delete(id);
        });
    }

    /** Convenience helper that opens one persisted dialog. */
    openDialog(id: string): void {
        return this.stateService.transaction(() => {
            this.setDialogOpen(id, true);
        });
    }

    /** Convenience helper that closes one persisted dialog. */
    closeDialog(id: string): void {
        return this.stateService.transaction(() => {
            this.setDialogOpen(id, false);
        });
    }

    /** Returns whether a persisted surface is currently represented in the dock. */
    isSurfaceDocked(id: string): boolean {
        return this.getDialogLayout(id)?.docked ?? false;
    }

    /** Switches a generic surface between docked and floating representations. */
    setSurfaceDocked(id: string, docked: boolean, dockTab: string = INSPECTION_DOCK_TAB_ID): void {
        const current = this.getDialogLayout(id);
        const fallbackSize = {
            width: Math.round(DEFAULT_EM_WIDTH * this.baseFontSize),
            height: Math.round(DEFAULT_EM_HEIGHT * this.baseFontSize)
        };
        const nextDockOrder = current?.dockOrder ?? (docked ? this.nextSurfaceDockOrder(dockTab) : undefined);
        this.upsertDialogLayout(id, {
            position: current?.position ?? {left: 0, top: 0},
            size: current?.size ?? fallbackSize,
            open: current?.open ?? false,
            docked,
            dockTab,
            ...(nextDockOrder !== undefined ? {dockOrder: nextDockOrder} : {})
        });
        if (docked) {
            this.dockActiveTab = dockTab;
            this.isDockOpen = true;
        }
    }

    /** Toggles the docked representation for a generic surface. */
    toggleSurfaceDocked(id: string, dockTab: string = INSPECTION_DOCK_TAB_ID): void {
        return this.stateService.transaction(() => {
            this.setSurfaceDocked(id, !this.isSurfaceDocked(id), dockTab);
        });
    }

    /** Persists generic docked-panel metadata without changing floating dialog geometry. */
    setPanelLayout(
        id: string,
        layout: Partial<Pick<AppDialogLayout, "panelSize" | "panelCollapsed" | "panelExpanded" | "dockOrder">>
    ): void {
        const current = this.getDialogLayout(id);
        if (!current) {
            this.upsertDialogLayout(id, {
                position: {left: 0, top: 0},
                size: {
                    width: Math.round(DEFAULT_EM_WIDTH * this.baseFontSize),
                    height: Math.round(DEFAULT_EM_HEIGHT * this.baseFontSize)
                },
                ...layout
            });
            return;
        }
        this.upsertDialogLayout(id, {
            ...current,
            ...layout
        });
    }

    /** Returns whether any generic surface is docked, optionally filtered by tab id. */
    hasDockedSurface(tabId?: string): boolean {
        return Object.values(this.dialogLayoutsState.getValue()).some(
            (layout) => (layout.docked ?? false) && (tabId === undefined || layout.dockTab === tabId)
        );
    }

    /** Reorders generic docked surfaces within one dock tab. */
    reorderDockedSurfaces(tabId: string, displayOrder: string[]): void {
        return this.stateService.transaction(() => {
            const currentLayouts = this.dialogLayoutsState.getValue();
            const dockedIds = Object.entries(currentLayouts)
                .filter(([, layout]) => (layout.docked ?? false) && layout.dockTab === tabId)
                .map(([id]) => id);
            if (dockedIds.length < 2) {
                return;
            }
            const dockedIdSet = new Set(dockedIds);
            const normalizedOrder = displayOrder.filter((id) => dockedIdSet.has(id));
            for (const id of dockedIds) {
                if (!normalizedOrder.includes(id)) {
                    normalizedOrder.push(id);
                }
            }
            let changed = false;
            const nextLayouts = {...currentLayouts};
            normalizedOrder.forEach((id, index) => {
                const layout = currentLayouts[id];
                if (!layout || layout.dockOrder === index) {
                    return;
                }
                nextLayouts[id] = {
                    ...layout,
                    dockOrder: index
                };
                changed = true;
            });
            if (changed) {
                this.dialogLayoutsState.next(nextLayouts);
            }
        });
    }

    /** Stores the next floating position for a generic surface. */
    setDialogPosition(id: string, position: AppDialogPosition): void {
        const current = this.getDialogLayout(id);
        const fallbackSize = {
            width: Math.round(DEFAULT_EM_WIDTH * this.baseFontSize),
            height: Math.round(DEFAULT_EM_HEIGHT * this.baseFontSize)
        };
        this.upsertDialogLayout(id, {
            position,
            size: current?.size ?? fallbackSize,
            open: current?.open ?? false,
            docked: current?.docked,
            dockTab: current?.dockTab,
            ...(current?.dockOrder !== undefined ? {dockOrder: current.dockOrder} : {})
        });
    }

    /** Append a newly docked surface after existing siblings in the same tab. */
    private nextSurfaceDockOrder(dockTab: string): number {
        const orders = Object.values(this.dialogLayoutsState.getValue())
            .filter((layout) => (layout.docked ?? false) && layout.dockTab === dockTab)
            .map((layout) => layout.dockOrder)
            .filter((order): order is number => typeof order === "number" && Number.isFinite(order));
        return orders.length ? Math.max(...orders) + 1 : 0;
    }

    /** Returns or creates the persisted layout record for a dialog. */
    ensureDialogLayout(id: string, fallbackFactory: () => AppDialogLayout): AppDialogLayout | InspectionDialogLayout {
        const existing = this.getDialogLayout(id);
        if (existing) {
            return existing;
        }
        const layout = fallbackFactory();
        this.upsertDialogLayout(id, layout);
        return layout;
    }

    /** Inserts or updates one persisted dialog layout record. */
    upsertDialogLayout(id: string, layout: AppDialogLayout | InspectionDialogLayout): void {
        return this.stateService.transaction(() => {
            const currentLayouts = this.dialogLayoutsState.getValue();
            const existing = currentLayouts[id];
            const nextLayout: AppDialogLayout | InspectionDialogLayout = existing
                ? {
                      ...existing,
                      ...layout,
                      position: {
                          ...existing.position,
                          ...layout.position
                      },
                      size: {
                          ...existing.size,
                          ...layout.size
                      }
                  }
                : {
                      ...layout,
                      position: {...layout.position},
                      size: {...layout.size}
                  };
            this.dialogLayoutsState.next({
                ...currentLayouts,
                [id]: nextLayout
            });
            this.pendingOpenDialogs.delete(id);
        });
    }

    /** Persists the open/closed state for an existing dialog layout. */
    setDialogLayoutOpen(id: string, open: boolean): void {
        const current = this.getDialogLayout(id);
        if (!current) {
            return;
        }
        if ((current.open ?? false) === open) {
            return;
        }
        this.upsertDialogLayout(id, {
            ...current,
            open
        });
    }

    /** Removes one persisted generic dialog layout and any pending open marker for it. */
    removeDialogLayout(id: string): void {
        return this.stateService.transaction(() => {
            const currentLayouts = this.dialogLayoutsState.getValue();
            if (!(id in currentLayouts)) {
                this.pendingOpenDialogs.delete(id);
                return;
            }
            const nextLayouts = {...currentLayouts};
            delete nextLayouts[id];
            this.dialogLayoutsState.next(nextLayouts);
            this.pendingOpenDialogs.delete(id);
        });
    }
    constructor(private readonly stateService: AppStateService) {
        this.stateService.importedSnapshot.subscribe(() => this.pendingOpenDialogs.clear());
    }
}
