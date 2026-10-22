import {AppStore} from "./shared/app.store";
import {ElementRef, runInInjectionContext} from "@angular/core";
import {ownerTestInjector} from "../test/owner-test-injector";
import {InspectionSelectionService} from "./inspection/inspection-selection.service";
import {InspectionContainerComponent} from "./inspection/inspection.container.component";
import {ViewLayerDiagnosticsService} from "./mapview/view-layer-diagnostics.service";
import {AppStateService} from "./shared/appstate.service";
import type {FeatureWrapper} from "./mapdata/feature-inspection.model";
import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {Subject} from "rxjs";
import {DockableLayoutComponent} from "./app.dockable.layout.component";

describe("Map attribution", () => {
    it.each([false, true])("keeps the full first notice, including notices loaded before the layout: %s", alreadyLoaded => {
        const notice = "Derived from Swiss survey data; copyright and additional licensing terms";
        const mapInfo = {
            legalInformationPerMap: new Map<string, Set<string>>(),
            legalInformationUpdated: new Subject<boolean>()
        };
        if (alreadyLoaded) mapInfo.legalInformationPerMap.set("Example map", new Set([notice]));
        const injector = ownerTestInjector([{provide: InspectionSelectionService, useValue: {reconcileSelection() {}}}]);
        const layout = runInInjectionContext(injector, () => new DockableLayoutComponent(
            injector.get(AppStateService),
            {} as never,
            {} as never,
            {sessionsChanged: new Subject<void>()} as never,
            {markForCheck: vi.fn()} as never,
            {} as never,
            mapInfo as never
        ));
        const values: string[] = [];
        const subscription = layout["copyright$"].subscribe(value => values.push(value));
        try {
            expect(values).toEqual([alreadyLoaded ? `© ${notice}` : ""]);
            mapInfo.legalInformationPerMap.set("Example map", new Set([notice, "Additional notice"]));
            mapInfo.legalInformationUpdated.next(true);
            expect(values.at(-1)).toBe(`© ${notice}`);
        } finally {
            subscription.unsubscribe();
            layout.ngOnDestroy();
        }
    });
});

describe("inspection dock publication", () => {
    it.each(["empty", "failed", "cleared"])("mounts pending inspection content coherently and collapses after %s loading", async outcome => {
        let bridge!: InspectionSelectionService;
        const injector = ownerTestInjector([
            {provide: InspectionSelectionService, useFactory: () => bridge},
            {provide: ViewLayerDiagnosticsService, useValue: {}}
        ]);
        const persistence = injector.get(AppStateService);
        const inspections = injector.get(AppStore);
        const layoutState = injector.get(AppStore);
        layoutState.setDockAutoCollapse(true);
        let resolveLoad!: (features: FeatureWrapper[]) => void;
        let rejectLoad!: (error: Error) => void;
        const load = new Promise<FeatureWrapper[]>((resolve, reject) => {
            resolveLoad = resolve;
            rejectLoad = reject;
        });
        bridge = runInInjectionContext(injector, () => new InspectionSelectionService(
            {loadFeatures: () => load} as never, {} as never,
            {registerShortcut() {}} as never, {showWarning() {}} as never,
            {run: (operation: () => unknown) => operation()} as never
        ));
        let container: InspectionContainerComponent | undefined;
        const mountedWithLoadingShell: boolean[] = [];
        const cdr = {
            markForCheck: vi.fn(),
            detectChanges: () => {
                if (layoutState.layout.dockOpen() && !container) {
                    mountedWithLoadingShell.push(bridge.selectionTopic.getValue().some(panel => panel.loading));
                    container = runInInjectionContext(injector, () => new InspectionContainerComponent(
                        persistence, bridge, {} as never, {markForCheck() {}} as never
                    ));
                } else if (!layoutState.layout.dockOpen()) {
                    container?.ngOnDestroy();
                    container = undefined;
                }
            }
        };
        // Register the layout listener before the bridge, as can happen when a host is recreated.
        const layout = runInInjectionContext(injector, () => new DockableLayoutComponent(
            persistence, {} as never, {} as never, {sessionsChanged: new Subject<void>()} as never,
            cdr as never, {} as never,
            {legalInformationUpdated: new Subject(), legalInformationPerMap: new Map()} as never
        ));
        const viewerElement = document.createElement("div");
        vi.spyOn(viewerElement, "getBoundingClientRect").mockReturnValue({width: 1000} as DOMRect);
        layout["viewerLayoutRef"] = new ElementRef(viewerElement);
        bridge.initialize();
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const panelId = inspections.setSelection([{mapTileKey: "Features:Map:Layer:42", featureId: "Way.0"}])!;
            expect(mountedWithLoadingShell).toEqual([true]);
            expect(layoutState.layout.dockOpen()).toBe(true);
            expect(container?.dockedPanels).toEqual([expect.objectContaining({id: panelId, loading: true})]);

            if (outcome === "cleared") inspections.unsetPanel(panelId);
            if (outcome === "failed") rejectLoad(new Error("restricted load failed"));
            else resolveLoad([]);
            await vi.waitFor(() => expect(bridge.selectionTopic.getValue()).toEqual([]));
            expect(layoutState.layout.dockOpen()).toBe(false);
            expect(bridge.selectionIdsTopic.getValue()).toEqual([]);
            expect(inspections.inspection.selection()).toHaveLength(outcome === "cleared" ? 0 : 1);
            expect(errors).toHaveBeenCalledTimes(outcome === "failed" ? 1 : 0);
        } finally {
            resolveLoad([]);
            container?.ngOnDestroy();
            layout.ngOnDestroy();
            errors.mockRestore();
        }
    });
});
