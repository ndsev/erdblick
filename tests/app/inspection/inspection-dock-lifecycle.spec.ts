import "@angular/compiler";
import { ChangeDetectorRef, ElementRef, Renderer2 } from "@angular/core";
import { Subject } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stateOwners, testPersistence } from "../../support/state-owners";
import { DockableLayoutComponent } from "../../../app/layout/dockable-layout.component";
import { FeatureWrapper } from "../../../app/mapdata/feature-inspection";
import { InspectionSelectionService } from "../../../app/inspection/inspection-selection.service";
import { TileFeatureId } from "../../../app/inspection/inspection.model";
import { InspectionContainerComponent } from "../../../app/inspection/inspection-container.component";

const target: TileFeatureId = { mapTileKey: "Features:Map:Road:42", featureId: "Way.0" };
const wrapper = {
    ...target,
    featureTile: { mapTileKey: target.mapTileKey, partitionKey: "42", expiresAtMs: null },
    key: () => target
} as FeatureWrapper;

const cleanup: Array<() => void> = [];
afterEach(() => {
    cleanup.splice(0).reverse().forEach(destroy => destroy());
    vi.restoreAllMocks();
});

/** Real owners and selection conversion; only network completion and DOM rendering are controlled. */
function createDock(bridgeFirst: boolean) {
    const persistence = testPersistence();
    const owners = stateOwners(persistence);
    let resolveLoad!: (features: FeatureWrapper[]) => void;
    let rejectLoad!: (error: Error) => void;
    const loaded = new Promise<FeatureWrapper[]>((resolve, reject) => {
        resolveLoad = resolve;
        rejectLoad = reject;
    });
    const bridge = new InspectionSelectionService(
        persistence,
        { loadFeatures: () => loaded } as never,
        {} as never,
        { registerShortcut: vi.fn() } as never,
        { showWarning: vi.fn() } as never,
        { run: (callback: () => unknown) => callback() } as never,
        owners.inspectionState,
        owners.viewSettings
    );
    if (bridgeFirst) bridge.initialize();

    let container: InspectionContainerComponent | undefined;
    let viewerWidth = 1600;
    const rendered: Array<{ open: boolean; selected: number[]; runtime: number[] }> = [];
    const cdr = {
        markForCheck: vi.fn(),
        detectChanges: () => {
            // The layout's @if creates the inspection host synchronously when
            // detectChanges first sees the newly selected durable panel.
            if (owners.inspectionState.state.selection.length && !container) {
                container = new InspectionContainerComponent(
                    persistence, bridge, {} as Renderer2,
                    { markForCheck: vi.fn() } as unknown as ChangeDetectorRef,
                    owners.layout, owners.inspectionState
                );
            }
            rendered.push({
                open: owners.layout.state.isDockOpen,
                selected: owners.inspectionState.state.selection.map(panel => panel.id),
                runtime: bridge.selectionTopic.value.map(panel => panel.id)
            });
            viewerWidth = owners.layout.state.isDockOpen ? 1000 : 1600;
        }
    } as unknown as ChangeDetectorRef;
    const component = new DockableLayoutComponent(
        persistence, owners.coordinatePolicy, {} as Renderer2,
        owners.searchService, cdr, {} as never,
        { legalInformationPerMap: new Map(), legalInformationUpdated: new Subject() } as never,
        owners.layout, owners.inspectionState.state
    );
    const viewer = document.createElement("div");
    viewer.getBoundingClientRect = () => ({ width: viewerWidth }) as DOMRect;
    component["viewerLayoutRef"] = new ElementRef(viewer);
    if (!bridgeFirst) bridge.initialize();
    cleanup.push(() => {
        container?.ngOnDestroy();
        component.ngOnDestroy();
    });
    return {
        ...owners, bridge, component, rendered,
        container: () => container!,
        resolveLoad, rejectLoad
    };
}

const flushLoads = () => new Promise(resolve => setTimeout(resolve, 0));

describe("inspection dock lifetime", () => {
    it.each([true, false])("renders a complete selection before opening, bridge subscribed first: %s", async bridgeFirst => {
        const dock = createDock(bridgeFirst);

        const id = dock.inspectionState.setSelection([target])!;

        expect(dock.layout.state.isDockOpen).toBe(true);
        expect(dock.rendered).toEqual([{ open: true, selected: [id], runtime: [id] }]);
        expect(dock.container().dockedPanels[0].loading).toBe(true);
        dock.resolveLoad([wrapper]);
        await flushLoads();
        expect(dock.layout.state.isDockOpen).toBe(true);
        expect(dock.container().dockedPanels[0].features).toEqual([wrapper]);

        dock.inspectionState.setInspectionPanelLockedState(id, true);
        expect(dock.layout.state.isDockOpen).toBe(true);
        expect(dock.container().dockedPanels[0].locked).toBe(true);
    });

    it.each(["empty", "failed"])("collapses a terminal %s load while retaining durable selection", async outcome => {
        const dock = createDock(true);
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        dock.inspectionState.setSelection([target]);
        expect(dock.layout.state.isDockOpen).toBe(true);

        if (outcome === "failed") dock.rejectLoad(new Error("Feature unavailable"));
        else dock.resolveLoad([]);
        await flushLoads();

        expect(dock.inspectionState.state.selection).toHaveLength(1);
        expect(dock.bridge.selectionIdsTopic.value).toEqual([]);
        expect(dock.container().dockedPanels).toEqual([]);
        expect(dock.layout.state.isDockOpen).toBe(false);
        expect(errors).toHaveBeenCalledTimes(outcome === "failed" ? 1 : 0);
    });

    it("keeps a manually closed dock closed when the pending selection resolves", async () => {
        const dock = createDock(true);
        dock.inspectionState.setSelection([target]);
        expect(dock.layout.state.isDockOpen).toBe(true);
        dock.component["closeDock"]();
        dock.resolveLoad([wrapper]);
        await flushLoads();

        expect(dock.layout.state.isDockOpen).toBe(false);
        expect(dock.container().dockedPanels[0].features).toEqual([wrapper]);
        dock.component["toggleDock"]();
        expect(dock.layout.state.isDockOpen).toBe(true);
    });

    it("collapses when selection clears and never revives a removed panel from a late load", async () => {
        const dock = createDock(true);
        const id = dock.inspectionState.setSelection([target])!;
        expect(dock.layout.state.isDockOpen).toBe(true);

        dock.inspectionState.unsetPanel(id);
        expect(dock.layout.state.isDockOpen).toBe(false);
        expect(dock.inspectionState.state.selection).toEqual([]);
        dock.resolveLoad([wrapper]);
        await flushLoads();

        expect(dock.layout.state.isDockOpen).toBe(false);
        expect(dock.container().dockedPanels).toEqual([]);
        expect(dock.bridge.selectionIdsTopic.value).toEqual([]);
    });
});
