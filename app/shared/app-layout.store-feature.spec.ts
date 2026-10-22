import {Injector} from "@angular/core";
import {getState, signalStore, watchState} from "@ngrx/signals";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import type {InspectionDialogLayout} from "../inspection/inspection-state.model";
import {AppLayoutValues, withAppLayout} from "./app-layout.store-feature";
import {persistenceDescriptors, persistenceFeatures} from "./persisted-state";

const LayoutStore = signalStore(withAppLayout());

describe("native layout feature", () => {
    let store: InstanceType<typeof LayoutStore>;
    let injector: ReturnType<typeof Injector.create>;

    beforeEach(() => {
        store = new LayoutStore();
        injector = Injector.create({providers: []});
    });

    afterEach(() => injector.destroy());

    it("preserves all six deployed storage keys and keeps pending dialogs out of persistence", () => {
        const descriptors = persistenceDescriptors(store);
        expect(Object.fromEntries(descriptors.map((entry) => [entry.name, entry.codec.defaultValue]))).toEqual({
            dockOpenState: false,
            dockWidth: null,
            viewPanelSizes: [],
            dockActiveTabState: "inspection",
            dockAutoCollapse: true,
            dialogLayouts: {}
        });
        expect(descriptors.every((entry) => !entry.codec.isUrlState())).toBe(true);
        expect(descriptors.every((entry) => entry.codec.snapshotPersist && entry.codec.configDefault)).toBe(true);
        expect(persistenceFeatures(store)[0].transientKeys).toEqual(["pendingOpenDialogs"]);

        const dialogs = descriptors.find((entry) => entry.name === "dialogLayouts")!;
        expect(dialogs.codec.validateSnapshotValue({
            inspection: {
                position: {left: "12", top: "24"},
                size: {width: "500", height: "400"},
                open: "1",
                docked: "false",
                panelId: "7",
                slot: "2",
                panelCollapsed: 0
            }
        }, {})).toEqual({
            inspection: {
                position: {left: 12, top: 24},
                size: {width: 500, height: 400},
                open: true,
                docked: false,
                panelId: 7,
                slot: 2,
                panelCollapsed: false
            }
        });
    });

    it("publishes docking, selected tab, visibility, and order in one complete change", () => {
        store.storeDialogLayout("older-search", {
            position: {left: 10, top: 20},
            size: {width: 400, height: 300},
            docked: true,
            dockTab: "search",
            dockOrder: 4
        });
        const seen: AppLayoutValues[] = [];
        watchState(store, (state) => seen.push(state.layout), {injector});

        store.setSurfaceDocked("new-search", true, "search", {width: 600, height: 450});

        expect(seen).toHaveLength(2);
        expect(seen[1]).toMatchObject({
            dockOpen: true,
            dockActiveTab: "search",
            dialogLayouts: {
                "new-search": {
                    position: {left: 0, top: 0},
                    size: {width: 600, height: 450},
                    docked: true,
                    dockTab: "search",
                    dockOrder: 5
                }
            }
        });
    });

    it("rejects invalid geometry before changing any dock or dialog state", () => {
        const before = store.layout();
        const seen: AppLayoutValues[] = [];
        watchState(store, (state) => seen.push(state.layout), {injector});

        expect(() => store.setSurfaceDocked("search", true, "search", {width: 0, height: 400})).toThrow();
        expect(() => store.setDockWidth(-1)).toThrow();
        expect(() => store.setViewPanelSizes([20, 101])).toThrow();

        expect(store.layout()).toBe(before);
        expect(seen).toEqual([before]);
    });

    it("reactively opens unmeasured dialogs and consumes their pending marker with the first measurement", () => {
        const seen: Array<[boolean, boolean, number]> = [];
        watchState(store, () => seen.push([
            store.isDialogOpen("preferences"),
            !!store.getDialogLayout("preferences"),
            store.layout.pendingOpenDialogs().length
        ]), {injector});

        store.setDialogOpen("preferences", true);
        store.setDialogOpen("preferences", true);
        store.ensureDialogLayout("preferences", () => ({
            position: {left: 12, top: 24},
            size: {width: 500, height: 400},
            open: true
        }));
        store.setDialogOpen("preferences", false);

        expect(seen).toEqual([
            [false, false, 0],
            [true, false, 1],
            [true, true, 0],
            [false, true, 0]
        ]);
        store.setDialogOpen("about", true);
        store.resetPendingOpenDialogs();
        expect(store.isDialogOpen("about")).toBe(false);
        expect(store.getDialogLayout("preferences")).toBeDefined();
    });

    it("retains inspection metadata and copies measured geometry before later layout operations", () => {
        const measured: InspectionDialogLayout = {
            position: {left: 12, top: 24},
            size: {width: 500, height: 400},
            panelSize: {width: 460, height: 200},
            panelCollapsed: true,
            panelId: 7,
            slot: 2,
            open: true
        };
        store.storeDialogLayout("inspection", measured);
        measured.position.left = 999;
        measured.size.width = 999;
        measured.panelSize!.height = 999;

        store.setSurfaceDocked("inspection", true);
        store.setDialogPosition("inspection", {left: 50, top: 60});
        store.setPanelLayout("inspection", {panelCollapsed: false});

        expect(store.getDialogLayout("inspection")).toMatchObject({
            position: {left: 50, top: 60},
            size: {width: 500, height: 400},
            panelSize: {width: 460, height: 200},
            panelCollapsed: false,
            panelId: 7,
            slot: 2,
            open: true,
            docked: true
        });
    });

    it("reorders only the requested dock tab and gives repeated ids one position", () => {
        store.setSurfaceDocked("one", true, "search");
        store.setSurfaceDocked("two", true, "search");
        store.setSurfaceDocked("other", true, "inspection");
        const other = store.getDialogLayout("other");
        const seen: AppLayoutValues[] = [];
        watchState(store, (state) => seen.push(state.layout), {injector});

        store.reorderDockedSurfaces("search", ["two", "other", "two", "missing"]);

        expect(seen).toHaveLength(2);
        expect(store.getDialogLayout("two")?.dockOrder).toBe(0);
        expect(store.getDialogLayout("one")?.dockOrder).toBe(1);
        expect(store.getDialogLayout("other")).toBe(other);
    });

    it("removes pending and persisted surfaces without leaving an open marker", () => {
        store.setDialogOpen("unmeasured", true);
        store.setSurfaceDocked("measured", true);

        store.removeDialogLayout("unmeasured");
        store.removeDialogLayout("measured");

        expect(store.isDialogOpen("unmeasured")).toBe(false);
        expect(store.hasDockedSurface()).toBe(false);
        expect(getState(store).layout.dialogLayouts).toEqual({});
        expect(store.layout.pendingOpenDialogs()).toEqual([]);
    });
});
