import {signalStoreFeature, withMethods} from "@ngrx/signals";
import {z} from "zod";
import type {InspectionDialogLayout} from "../inspection/inspection-state.model";
import {
    AppDialogLayout,
    AppDialogPosition,
    AppDialogSize,
    DEFAULT_EM_HEIGHT,
    DEFAULT_EM_WIDTH,
    INSPECTION_DOCK_TAB_ID
} from "./app-layout.model";
import {patchAppState, StateField, transient, withPersistedState} from "./persisted-state";
import {Boolish, deepEquals} from "./state-value";

/** Dock preferences and dialog geometry owned by the application layout feature. */
export interface AppLayoutValues {
    dockOpen: boolean;
    dockWidth: number | null;
    viewPanelSizes: number[];
    dockActiveTab: string;
    dockAutoCollapse: boolean;
    dialogLayouts: Record<string, AppDialogLayout | InspectionDialogLayout>;
    pendingOpenDialogs: string[];
}

const dialogLayoutSchema = z.object({
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
    panelSize: z.object({
        width: z.coerce.number().positive(),
        height: z.coerce.number().positive()
    }).optional(),
    panelCollapsed: Boolish.optional(),
    panelExpanded: Boolish.optional()
});

/** The deployed storage keys remain local preferences and never enter shareable map URLs. */
const layoutFields = {
    dockOpen: {
        name: "dockOpenState",
        defaultValue: false,
        schema: Boolish
    },
    dockWidth: {
        name: "dockWidth",
        defaultValue: null,
        schema: z.number().min(0).max(32768).nullable()
    },
    viewPanelSizes: {
        name: "viewPanelSizes",
        defaultValue: [],
        schema: z.array(z.number().min(0).max(100)).max(32)
    },
    dockActiveTab: {
        name: "dockActiveTabState",
        defaultValue: INSPECTION_DOCK_TAB_ID,
        schema: z.string()
    },
    dockAutoCollapse: {
        name: "dockAutoCollapse",
        defaultValue: true,
        schema: Boolish
    },
    dialogLayouts: {
        name: "dialogLayouts",
        defaultValue: {},
        schema: z.record(z.string(), dialogLayoutSchema)
    },
    pendingOpenDialogs: transient<string[]>([])
} satisfies {[Key in keyof AppLayoutValues]: StateField<AppLayoutValues[Key]>};

/**
 * Adds dock and dialog state directly to AppStore. A signal is a read function:
 * `store.layout.dockOpen()` returns whether the dock is visible, and Angular tracks
 * that read when rendering a template. Callers change it through the methods below.
 *
 * Docking prepares the dialog, selected tab, and dock visibility before one native
 * SignalStore patch. Observers therefore see a complete layout change. Geometry is
 * supplied in pixels by the component that measures it; this feature needs no DOM.
 */
export function withAppLayout() {
    return signalStoreFeature(
        withPersistedState<"layout", AppLayoutValues>("layout", layoutFields),
        withMethods((store) => ({
            setDockOpen(open: boolean): void {
                if (store.layout.dockOpen() === open) return;
                patchAppState(store, {layout: {...store.layout(), dockOpen: open}});
            },

            setDockWidth(width: number | null): void {
                const dockWidth = layoutFields.dockWidth.schema.parse(width);
                if (store.layout.dockWidth() === dockWidth) return;
                patchAppState(store, {layout: {...store.layout(), dockWidth}});
            },

            setViewPanelSizes(sizes: readonly number[]): void {
                const viewPanelSizes = layoutFields.viewPanelSizes.schema.parse(sizes);
                if (deepEquals(store.layout.viewPanelSizes(), viewPanelSizes)) return;
                patchAppState(store, {layout: {...store.layout(), viewPanelSizes}});
            },

            setDockActiveTab(tab: string): void {
                const dockActiveTab = tab || INSPECTION_DOCK_TAB_ID;
                if (store.layout.dockActiveTab() === dockActiveTab) return;
                patchAppState(store, {layout: {...store.layout(), dockActiveTab}});
            },

            setDockAutoCollapse(autoCollapse: boolean): void {
                if (store.layout.dockAutoCollapse() === autoCollapse) return;
                patchAppState(store, {layout: {...store.layout(), dockAutoCollapse: autoCollapse}});
            },

            /** Returns the measured layout for one persisted dialog. */
            getDialogLayout(id: string): AppDialogLayout | InspectionDialogLayout | undefined {
                return store.layout.dialogLayouts()[id];
            },

            /** Includes a newly opened dialog whose component has not measured its first layout yet. */
            isDialogOpen(id: string): boolean {
                const current = store.layout.dialogLayouts()[id];
                return current ? current.open ?? false : store.layout.pendingOpenDialogs().includes(id);
            },

            /**
             * Opens or closes a dialog before or after its first measurement. The pending
             * ids are transient signals so the first open also mounts the dialog. A full
             * snapshot replacement resets them; they never become stored preferences.
             */
            setDialogOpen(id: string, open: boolean): void {
                const layout = store.layout();
                const current = layout.dialogLayouts[id];
                if (!current && layout.pendingOpenDialogs.includes(id) === open) return;
                const pendingOpenDialogs = layout.pendingOpenDialogs.filter((pendingId) => pendingId !== id);
                if (!current && open) pendingOpenDialogs.push(id);
                const changedOpen = current && (current.open ?? false) !== open;
                if (!changedOpen && deepEquals(pendingOpenDialogs, layout.pendingOpenDialogs)) return;
                patchAppState(store, {
                    layout: {
                        ...layout,
                        dialogLayouts: changedOpen ? {...layout.dialogLayouts, [id]: {...current, open}} : layout.dialogLayouts,
                        pendingOpenDialogs
                    }
                });
            },

            /** Reports whether a surface currently belongs to the dock. */
            isSurfaceDocked(id: string): boolean {
                return store.layout.dialogLayouts()[id]?.docked ?? false;
            },

            /** Moves a surface between floating and docked hosts, opening its dock tab in the same patch. */
            setSurfaceDocked(
                id: string,
                docked: boolean,
                dockTab: string = INSPECTION_DOCK_TAB_ID,
                fallbackSize: AppDialogSize = {width: DEFAULT_EM_WIDTH * 16, height: DEFAULT_EM_HEIGHT * 16}
            ): void {
                const layout = store.layout();
                const current = layout.dialogLayouts[id];
                let dockOrder = current?.dockOrder;
                if (dockOrder === undefined && docked) {
                    const orders = Object.values(layout.dialogLayouts)
                        .filter((entry) => entry.docked && entry.dockTab === dockTab)
                        .map((entry) => entry.dockOrder)
                        .filter((order): order is number => typeof order === "number" && Number.isFinite(order));
                    dockOrder = orders.length ? Math.max(...orders) + 1 : 0;
                }
                const next = dialogLayoutSchema.parse({
                    ...current,
                    position: current?.position ?? {left: 0, top: 0},
                    size: current?.size ?? fallbackSize,
                    open: current?.open ?? false,
                    docked,
                    dockTab,
                    ...(dockOrder !== undefined ? {dockOrder} : {})
                });
                patchAppState(store, {
                    layout: {
                        ...layout,
                        dialogLayouts: {...layout.dialogLayouts, [id]: next},
                        pendingOpenDialogs: layout.pendingOpenDialogs.filter((pendingId) => pendingId !== id),
                        dockActiveTab: docked ? dockTab || INSPECTION_DOCK_TAB_ID : layout.dockActiveTab,
                        dockOpen: docked || layout.dockOpen
                    }
                });
            },

            /** Stores docked-panel size and collapse state while retaining floating geometry. */
            setPanelLayout(
                id: string,
                panel: Partial<Pick<AppDialogLayout, "panelSize" | "panelCollapsed" | "panelExpanded" | "dockOrder">>,
                fallbackSize: AppDialogSize = {width: DEFAULT_EM_WIDTH * 16, height: DEFAULT_EM_HEIGHT * 16}
            ): void {
                const layout = store.layout();
                const current = layout.dialogLayouts[id];
                const next = dialogLayoutSchema.parse({
                    ...current,
                    position: current?.position ?? {left: 0, top: 0},
                    size: current?.size ?? fallbackSize,
                    ...panel
                });
                patchAppState(store, {
                    layout: {
                        ...layout,
                        dialogLayouts: {...layout.dialogLayouts, [id]: next},
                        pendingOpenDialogs: layout.pendingOpenDialogs.filter((pendingId) => pendingId !== id)
                    }
                });
            },

            /** Reports whether any surface occupies the dock, optionally within one tab. */
            hasDockedSurface(tabId?: string): boolean {
                return Object.values(store.layout.dialogLayouts()).some(
                    (layout) => layout.docked && (tabId === undefined || layout.dockTab === tabId)
                );
            },

            /** Reorders one tab while retaining omitted surfaces and ignoring unrelated or repeated ids. */
            reorderDockedSurfaces(tabId: string, displayOrder: readonly string[]): void {
                const layout = store.layout();
                const dockedIds = Object.entries(layout.dialogLayouts)
                    .filter(([, entry]) => entry.docked && entry.dockTab === tabId)
                    .map(([id]) => id);
                if (dockedIds.length < 2) return;
                const dockedIdSet = new Set(dockedIds);
                const order = [...new Set([...displayOrder.filter((id) => dockedIdSet.has(id)), ...dockedIds])];
                const dialogLayouts = {...layout.dialogLayouts};
                let changed = false;
                order.forEach((id, dockOrder) => {
                    const current = layout.dialogLayouts[id];
                    if (current.dockOrder === dockOrder) return;
                    dialogLayouts[id] = {...current, dockOrder};
                    changed = true;
                });
                if (changed) patchAppState(store, {layout: {...layout, dialogLayouts}});
            },

            /** Stores floating position without changing the surface's size or docked-panel metadata. */
            setDialogPosition(
                id: string,
                position: AppDialogPosition,
                fallbackSize: AppDialogSize = {width: DEFAULT_EM_WIDTH * 16, height: DEFAULT_EM_HEIGHT * 16}
            ): void {
                const layout = store.layout();
                const current = layout.dialogLayouts[id];
                const next = dialogLayoutSchema.parse({
                    ...current,
                    position,
                    size: current?.size ?? fallbackSize,
                    open: current?.open ?? false
                });
                patchAppState(store, {
                    layout: {
                        ...layout,
                        dialogLayouts: {...layout.dialogLayouts, [id]: next},
                        pendingOpenDialogs: layout.pendingOpenDialogs.filter((pendingId) => pendingId !== id)
                    }
                });
            },

            /** Creates a dialog's first measured record only when no persisted geometry exists. */
            ensureDialogLayout(id: string, fallbackFactory: () => AppDialogLayout): AppDialogLayout | InspectionDialogLayout {
                const layout = store.layout();
                const current = layout.dialogLayouts[id];
                if (current) return current;
                const next = dialogLayoutSchema.parse(fallbackFactory());
                patchAppState(store, {
                    layout: {
                        ...layout,
                        dialogLayouts: {...layout.dialogLayouts, [id]: next},
                        pendingOpenDialogs: layout.pendingOpenDialogs.filter((pendingId) => pendingId !== id)
                    }
                });
                return next;
            },

            /** Merges a measured dialog record and retires its pending-open marker atomically. */
            storeDialogLayout(id: string, value: AppDialogLayout | InspectionDialogLayout): void {
                const layout = store.layout();
                const current = layout.dialogLayouts[id];
                const next = dialogLayoutSchema.parse({
                    ...current,
                    ...value,
                    position: {...current?.position, ...value.position},
                    size: {...current?.size, ...value.size}
                });
                patchAppState(store, {
                    layout: {
                        ...layout,
                        dialogLayouts: {...layout.dialogLayouts, [id]: next},
                        pendingOpenDialogs: layout.pendingOpenDialogs.filter((pendingId) => pendingId !== id)
                    }
                });
            },

            /** Updates mounted-dialog visibility only if its measured layout is already known. */
            setDialogLayoutOpen(id: string, open: boolean): void {
                const layout = store.layout();
                const current = layout.dialogLayouts[id];
                if (!current || (current.open ?? false) === open) return;
                patchAppState(store, {
                    layout: {
                        ...layout,
                        dialogLayouts: {...layout.dialogLayouts, [id]: {...current, open}},
                        pendingOpenDialogs: layout.pendingOpenDialogs.filter((pendingId) => pendingId !== id)
                    }
                });
            },

            /** Forgets a removed surface's geometry and any pending request to mount it. */
            removeDialogLayout(id: string): void {
                const layout = store.layout();
                if (!(id in layout.dialogLayouts) && !layout.pendingOpenDialogs.includes(id)) return;
                const dialogLayouts = {...layout.dialogLayouts};
                delete dialogLayouts[id];
                patchAppState(store, {
                    layout: {
                        ...layout,
                        dialogLayouts,
                        pendingOpenDialogs: layout.pendingOpenDialogs.filter((pendingId) => pendingId !== id)
                    }
                });
            },

            /** Discards unmeasured open requests when the current workspace layout is abandoned. */
            resetPendingOpenDialogs(): void {
                if (!store.layout.pendingOpenDialogs().length) return;
                patchAppState(store, {layout: {...store.layout(), pendingOpenDialogs: []}});
            }
        }))
    );
}
