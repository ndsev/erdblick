import "@angular/compiler";
import {TestBed} from "@angular/core/testing";
import {ownerTestInjector} from "../../test/owner-test-injector";
import {AppStore} from "../shared/app.store";
import {AppStateService} from "../shared/appstate.service";
import {ClipboardService} from "../shared/clipboard.service";
import {InfoMessageService} from "../shared/info.service";
import {JumpTargetService} from "../search/jump.service";
import {FeatureSearchService} from "../search/feature.search.service";
import {InspectionSelectionService} from "./inspection-selection.service";
import {describe, expect, it, vi} from "vitest";
import type {TreeTableNode} from "primeng/api";
import {inspectionSearchNumberLiteral} from "./inspection-search.util";
import {expandPathToFirstHighlightedRow} from "./inspection-tree-highlight";
import {InspectionTreeComponent} from "./inspection.tree.component";

describe("inspectionSearchNumberLiteral", () => {
    it("keeps BigInt inspection integers as unquoted Simfil numeric literals", () => {
        expect(inspectionSearchNumberLiteral(50n)).toBe("50");
    });

    it("accepts finite numbers and strict numeric strings", () => {
        expect(inspectionSearchNumberLiteral(42)).toBe("42");
        expect(inspectionSearchNumberLiteral(" 1.25e+2 ")).toBe("1.25e+2");
    });

    it("rejects non-numeric strings instead of creating partial numeric literals", () => {
        expect(inspectionSearchNumberLiteral("50 km/h")).toBeUndefined();
        expect(inspectionSearchNumberLiteral("50n")).toBeUndefined();
    });
});

describe("expandPathToFirstHighlightedRow", () => {
    it("reopens a restored collapsed path and returns the resulting visible index", () => {
        const highlighted: TreeTableNode = {
            data: {key: "target", styleClass: "source-data-field highlight"}
        };
        const branch: TreeTableNode = {
            data: {key: "branch"},
            expanded: false,
            children: [{data: {key: "before"}}, highlighted]
        };
        const root: TreeTableNode = {
            data: {key: "root"},
            expanded: false,
            children: [branch]
        };
        const nodes: TreeTableNode[] = [{data: {key: "other"}}, root];

        expect(expandPathToFirstHighlightedRow(nodes)).toBe(4);
        expect(root.expanded).toBe(true);
        expect(branch.expanded).toBe(true);
    });

    it("leaves expansion untouched when no explicit highlight exists", () => {
        const nodes: TreeTableNode[] = [{
            data: {key: "root"},
            expanded: false,
            children: [{data: {key: "child"}}]
        }];

        expect(expandPathToFirstHighlightedRow(nodes)).toBeUndefined();
        expect(nodes[0].expanded).toBe(false);
    });
});

describe("inspection map-hover ownership", () => {
    it("reports a rejected FeatureId jump through the ordinary inspection UI", async () => {
        const component = Object.create(InspectionTreeComponent.prototype) as any;
        component.jumpService = {highlightByJumpTargetFilter: vi.fn().mockRejectedValue(new Error("Locate failed"))};
        component.messageService = {showError: vi.fn()};

        component.onValueClick({stopPropagation: vi.fn()}, {mapId: "Map", value: "Road.1"});
        await Promise.resolve();

        expect(component.jumpService.highlightByJumpTargetFilter).toHaveBeenCalledWith("Map", "Road.1");
        expect(component.messageService.showError).toHaveBeenCalledWith("Locate failed");
    });

    it("does not let a delayed leave clear a re-entered target", async () => {
        const component = Object.create(InspectionTreeComponent.prototype) as any;
        component.destroyed = false;
        component.mapHoverEpoch = 0;
        component.cdr = {markForCheck: vi.fn()};
        const transition = vi.fn();

        component.claimMapHover("row:X");
        component.deferMapHoverTransition("row:X", transition);
        component.claimMapHover("row:X");
        await Promise.resolve();

        expect(transition).not.toHaveBeenCalled();
        expect(component.activeMapHoverOwner).toBe("row:X");
    });
});

describe("lazy geometry export", () => {
    it("opens the export menu without serializing geometry, then resolves the current payload on copy", () => {
        const component = Object.create(InspectionTreeComponent.prototype) as any;
        const serialize = vi.fn(() => '{"type":"FeatureCollection","features":[]}');
        component.geoJson = () => serialize;
        component.geoJsonMenu = {toggle: vi.fn()};
        component.copyToClipboard = vi.fn();
        component.showGeoJsonMenu({stopPropagation: vi.fn()} as unknown as MouseEvent);
        expect(serialize).not.toHaveBeenCalled();
        component.copyGeoJson();
        expect(serialize).toHaveBeenCalledTimes(1);
        expect(component.copyToClipboard).toHaveBeenCalledWith(serialize.mock.results[0].value);
    });

    it("continues to export eager payloads from other inspection panels", () => {
        const component = Object.create(InspectionTreeComponent.prototype) as any;
        component.geoJson = () => '{"type":"FeatureCollection","features":[]}';
        component.copyToClipboard = vi.fn();
        component.copyGeoJson();
        expect(component.copyToClipboard).toHaveBeenCalledWith(component.geoJson());
    });
});

describe("incoming relation actions", () => {
    it("opens a source relation that is outside the selected target panel", () => {
        const component = Object.create(InspectionTreeComponent.prototype) as any;
        component.inspectionMenu = {toggle: vi.fn()};
        component.store = ownerTestInjector().get(AppStore);
        const panelId = component.store.setSelection([{mapTileKey: "surface", featureId: "Surface.1"}]);
        component.panelId = () => panelId;
        vi.spyOn(component.store, "setSelection");
        vi.spyOn(component.store, "toggleInspectionFeatureHighlight");
        component.shouldShowScalarRowActions = () => false;
        component.onRowActionsClick({stopPropagation: vi.fn()}, {}, {
            key: 'visible', value: '', mapTileKey: 'lane', hoverId: 'Lane.7:relation#1'
        });
        const action = component.inspectionMenuItems.find((item: any) => item.label === 'Inspect source relation');
        expect(action).toBeDefined();
        action.command();
        expect(component.store.setSelection).toHaveBeenCalledWith([
            {mapTileKey: 'lane', featureId: 'Lane.7:relation#1'}
        ]);
        expect(component.store.toggleInspectionFeatureHighlight).not.toHaveBeenCalled();
    });
});


describe("inspection input effect ownership", () => {
    it("does not rebuild and re-save tree expansion for unrelated inspection preferences", async () => {
        const injector = ownerTestInjector();
        const store = injector.get(AppStore);
        const panelId = store.setSelection([{mapTileKey: "Features:Map:Layer:42", featureId: "Way.7"}])!;
        await TestBed.configureTestingModule({
            declarations: [InspectionTreeComponent],
            providers: [
                {provide: AppStore, useValue: store},
                {provide: AppStateService, useValue: injector.get(AppStateService)},
                {provide: ClipboardService, useValue: {}},
                {provide: InfoMessageService, useValue: {}},
                {provide: JumpTargetService, useValue: {}},
                {provide: FeatureSearchService, useValue: {}},
                {provide: InspectionSelectionService, useValue: {}}
            ]
        }).overrideComponent(InspectionTreeComponent, {set: {template: ""}}).compileComponents();
        const fixture = TestBed.createComponent(InspectionTreeComponent);
        const saveExpansion = vi.spyOn(fixture.componentInstance as any, "savePanelExpansionState");
        try {
            fixture.componentRef.setInput("panelId", panelId);
            fixture.componentRef.setInput("columns", []);
            fixture.componentRef.setInput("treeData", [{data: {key: "first"}, children: [{data: {key: "value"}}]}]);
            fixture.detectChanges();
            fixture.componentRef.setInput("treeData", [{data: {key: "next"}, children: [{data: {key: "value"}}]}]);
            fixture.detectChanges();
            expect(saveExpansion).toHaveBeenCalled();
            saveExpansion.mockClear();
            store.setHoverLabelsEnabled(!store.inspection.hoverLabelsEnabled());
            fixture.detectChanges();
            expect(saveExpansion).not.toHaveBeenCalled();
        } finally {
            fixture.destroy();
            TestBed.resetTestingModule();
        }
    });
});
