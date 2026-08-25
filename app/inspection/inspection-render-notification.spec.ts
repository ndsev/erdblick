import "@angular/compiler";
import {ChangeDetectorRef, Renderer2} from "@angular/core";
import {BehaviorSubject} from "rxjs";
import {describe, expect, it, vi} from "vitest";

import {FeatureWrapper} from "../mapdata/feature-inspection.model";
import {
    AppStateService,
    InspectionComparisonModel,
    InspectionPanelModel,
    TileFeatureId
} from "../shared/appstate.service";
import {InspectionSelectionService} from "./inspection-selection.service";
import {InspectionContainerComponent} from "./inspection.container.component";
import {InspectionDialogsComponent} from "./inspection.dialogs.component";

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
        } as unknown as AppStateService;
        const cdr = changeDetector();
        const component = new InspectionContainerComponent(
            stateService,
            mapService,
            {} as Renderer2,
            cdr
        );
        vi.mocked(cdr.markForCheck).mockClear();

        selectionTopic.next([loadingPanel(false)]);

        expect(component.dockedPanels).toHaveLength(1);
        expect(component.dockedPanels[0].loading).toBe(true);
        expect(cdr.markForCheck).toHaveBeenCalledOnce();
        component.ngOnDestroy();
    });

    it("marks floating inspection and comparison hosts dirty on subject emissions", () => {
        const selectionTopic = new BehaviorSubject<InspectionPanelModel<FeatureWrapper>[]>([]);
        const inspectionComparisonState = new BehaviorSubject<InspectionComparisonModel | null>(null);
        const mapService = {selectionTopic} as unknown as InspectionSelectionService;
        const stateService = {inspectionComparisonState} as unknown as AppStateService;
        const cdr = changeDetector();
        const component = new InspectionDialogsComponent(mapService, stateService, cdr);
        vi.mocked(cdr.markForCheck).mockClear();

        selectionTopic.next([loadingPanel(true)]);

        expect(component.undockedPanels).toHaveLength(1);
        expect(component.undockedPanels[0].loading).toBe(true);
        expect(cdr.markForCheck).toHaveBeenCalledOnce();

        inspectionComparisonState.next({
            base: {panelId: 7, mapId: "Map", label: "Feature 7", featureIds: []},
            others: []
        });
        expect(component.comparison?.base.panelId).toBe(7);
        expect(cdr.markForCheck).toHaveBeenCalledTimes(2);
        component.ngOnDestroy();
    });
});
