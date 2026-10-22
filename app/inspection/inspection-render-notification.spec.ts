import {runInInjectionContext} from "@angular/core";
import {ownerTestInjector} from "../../test/owner-test-injector";
import {AppStore} from "../shared/app.store";
import {AppStateService} from "../shared/appstate.service";
import {TestBed} from "@angular/core/testing";
import {Component, Input} from "@angular/core";
import "@angular/compiler";
import {ChangeDetectorRef, Renderer2} from "@angular/core";
import {BehaviorSubject} from "rxjs";
import {describe, expect, it, vi} from "vitest";

import {FeatureWrapper} from "../mapdata/feature-inspection.model";
import {InspectionSelectionService} from "./inspection-selection.service";
import {InspectionComparisonModel, InspectionPanelModel, TileFeatureId} from "./inspection-state.model";
import {InspectionContainerComponent} from "./inspection.container.component";
import {InspectionDialogsComponent} from "./inspection.dialogs.component";

@Component({selector: "inspection-panel-dialog", template: ""})
class TestInspectionDialog {
    @Input() panel: unknown;
    @Input() dialogIndex: unknown;
}

@Component({selector: "inspection-comparison-dialog", template: `<span class="comparison-base">{{comparison?.base?.panelId}}</span>`})
class TestComparisonDialog {
    @Input() comparison: InspectionComparisonModel | null = null;
}

const loadingPanel = (
    undocked: boolean
): InspectionPanelModel<FeatureWrapper> => ({
    id: 7,
    features: [],
    loading: true,
    locked: false,
    focused: true,
    size: [30, 20],
    color: "#fff",
    undocked
});

const changeDetector = () => ({
    markForCheck: vi.fn()
}) as unknown as ChangeDetectorRef;

describe("inspection host render notifications", () => {
    it("marks the dock host dirty when an async loading shell arrives", () => {
        const selectionTopic = new BehaviorSubject<InspectionPanelModel<FeatureWrapper>[]>([]);
        const selectionIdsTopic = new BehaviorSubject<InspectionPanelModel<TileFeatureId>[]>([]);
        const mapService = {
            selectionTopic,
            selectionIdsTopic
        } as unknown as InspectionSelectionService;
        const stateService = {
            baseFontSize: 16,
            isDockOpen: true,
            isDockAutoCollapsible: true,
            hasDockedSurface: () => false,
            reorderInspectionPanels: vi.fn()
        };
        const cdr = changeDetector();
        const injector = ownerTestInjector();
        const component = runInInjectionContext(injector, () => new InspectionContainerComponent(
            (stateService) as never,
            mapService,
            {} as Renderer2,
            cdr
        ));
        vi.mocked(cdr.markForCheck).mockClear();

        selectionTopic.next([loadingPanel(false)]);

        expect(component.dockedPanels).toHaveLength(1);
        expect(component.dockedPanels[0].loading).toBe(true);
        expect(cdr.markForCheck).toHaveBeenCalledOnce();
        component.ngOnDestroy();
    });

    it("marks the floating inspection host dirty on async shell emissions", () => {
        const selectionTopic = new BehaviorSubject<InspectionPanelModel<FeatureWrapper>[]>([]);
        const mapService = {selectionTopic} as unknown as InspectionSelectionService;
        const stateService = {};
        const cdr = changeDetector();
        const injector = ownerTestInjector();
        const component = runInInjectionContext(injector, () =>
            new InspectionDialogsComponent(mapService, stateService as never, cdr));
        vi.mocked(cdr.markForCheck).mockClear();

        selectionTopic.next([loadingPanel(true)]);

        expect(component.undockedPanels).toHaveLength(1);
        expect(component.undockedPanels[0].loading).toBe(true);
        expect(cdr.markForCheck).toHaveBeenCalledOnce();

        component.ngOnDestroy();
    });

    it("renders comparison changes directly from the native signal without a resource emission", async () => {
        const selectionTopic = new BehaviorSubject<InspectionPanelModel<FeatureWrapper>[]>([]);
        const injector = ownerTestInjector();
        const store = injector.get(AppStore);
        const panelId = store.setSelection([{mapTileKey: "Features:Map:Layer:42", featureId: "Way.7"}])!;
        await TestBed.configureTestingModule({
            declarations: [InspectionDialogsComponent],
            imports: [TestInspectionDialog, TestComparisonDialog],
            providers: [
                {provide: AppStore, useValue: store},
                {provide: AppStateService, useValue: injector.get(AppStateService)},
                {provide: InspectionSelectionService, useValue: {selectionTopic}}
            ]
        }).compileComponents();
        const fixture = TestBed.createComponent(InspectionDialogsComponent);
        try {
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector(".comparison-base")).toBeNull();
            store.setInspectionComparison({base: {panelId, mapId: "Map", label: "Feature 7", featureIds: []}, others: []});
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector(".comparison-base")?.textContent).toBe(String(panelId));
            store.setInspectionComparison(null);
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector(".comparison-base")).toBeNull();
        } finally {
            fixture.destroy();
            TestBed.resetTestingModule();
        }
    });
});
