import {Component, ElementRef, OnDestroy, Renderer2, ViewChild} from "@angular/core";
import {InspectionSelectionService} from "./inspection-selection.service";
import {AppStateService, InspectionPanelModel} from "../shared/appstate.service";
import {FeatureWrapper} from "../mapdata/feature-inspection.model";
import {Subscription} from "rxjs";
import {DockedPanelDragController, DockedPanelDragOffset} from "../shared/docked-panel-drag.controller";

@Component({
    selector: 'inspection-container',
    template: `
        <div #dockContainer class="inspection-container" data-testid="inspection-container"
             [ngClass]="{'reordering': dockDrag.state.isReordering, 'single-panel': dockedPanels.length === 1, 'multi-panel': dockedPanels.length > 1}">
            @if (dockedPanels.length > 0) {
                <div class="dock-filter">
                    <p-iconfield class="input-container">
                        <p-inputicon class="pi pi-filter"/>
                        <input class="filter-input" type="text" pInputText placeholder="Filter docked inspections"
                               [(ngModel)]="dockFilterText"/>
                        @if (dockFilterText) {
                            <i (click)="dockFilterText = ''" class="pi pi-times clear-icon"></i>
                        }
                    </p-iconfield>
                </div>
            } @else {
                <div class="dock-empty">
                    <span class="material-symbols-outlined dock-empty-icon" aria-hidden="true">subtitles_off</span>
                    <div class="dock-empty-title">No docked inspections</div>
                    <div class="dock-empty-text">
                        Select a feature, or drag a floating inspection here to dock it.
                    </div>
                </div>
            }
            @for (panel of dockedPanels; track panel.id) {
                @if (panel.features.length > 0 || panel.sourceData !== undefined) {
                    <inspection-panel [panel]="panel"
                                      [dockedPanelCount]="dockedPanels.length"
                                      [ngClass]="{'dragging': dockDrag.state.draggedId === panel.id,
                                                  'drop-before': dockDrag.state.dropBeforeId === panel.id,
                                                  'drop-after': dockDrag.state.dropAfterId === panel.id}"
                                      [attr.data-panel-id]="panel.id"
                                      [(filterText)]="dockFilterText"
                                      (ejectedPanel)="onEject($event)"
                                      (panelDragRequest)="onPanelDragRequest($event)">
                    </inspection-panel>
                }
            }
        </div>
    `,
    standalone: false
})
/** Hosts docked inspection panels and manages drag-based docking/reordering. */
export class InspectionContainerComponent implements OnDestroy {
    dockedPanels: InspectionPanelModel<FeatureWrapper>[] = [];
    dockFilterText = '';
    protected readonly dockDrag: DockedPanelDragController<number>;

    @ViewChild('dockContainer') private dockContainerRef?: ElementRef<HTMLDivElement>;

    private readonly subscriptions = new Subscription();

    constructor(private stateService: AppStateService,
                private mapService: InspectionSelectionService,
                private renderer: Renderer2) {
        this.dockDrag = new DockedPanelDragController<number>({
            renderer: this.renderer,
            baseFontSize: () => this.stateService.baseFontSize,
            container: () => this.dockContainerRef?.nativeElement,
            itemSelector: 'inspection-panel',
            readId: element => {
                const id = Number(element.dataset['panelId']);
                return Number.isNaN(id) ? undefined : id;
            },
            previewClass: 'inspection-drag-preview',
            previewHeaderClass: 'inspection-drag-preview-header',
            previewFillClass: 'inspection-drag-preview-fill',
            applyReorder: nextDisplayOrder => this.stateService.reorderInspectionPanels(nextDisplayOrder),
            undock: (panelId, event, offset) => this.queueUndock(panelId, event, offset)
        });
        this.subscriptions.add(this.mapService.selectionTopic.subscribe(panels => {
            const allPanels = panels.slice();
            this.dockedPanels = allPanels.filter(panel => !panel.undocked).toReversed();
            // Restricted feature loading is asynchronous. Keep the dock open
            // while a docked id selection is waiting for its FeatureWrapper;
            // otherwise the selectionTopic's initial empty value immediately
            // auto-collapses the dock opened by setSelection().
            const hasPendingDockedPanels = this.mapService.selectionIdsTopic.getValue()
                .some(panel => !panel.undocked);
            const hasDockedPanels = this.dockedPanels.length > 0 ||
                hasPendingDockedPanels ||
                this.stateService.hasDockedSurface();
            this.stateService.isDockOpen = this.stateService.isDockOpen &&
                (!this.stateService.isDockAutoCollapsible || hasDockedPanels);
        }));
    }

    /** Clears transient drag state when the container is destroyed. */
    ngOnDestroy() {
        this.subscriptions.unsubscribe();
        this.dockDrag.destroy();
    }

    /** Turns a docked panel into a floating dialog. */
    onEject(panel: InspectionPanelModel<FeatureWrapper>) {
        this.stateService.setInspectionPanelUndockedState(panel.id, true);
    }

    /** Starts dock drag tracking for a docked inspection header. */
    onPanelDragRequest(payload: {panel: InspectionPanelModel<FeatureWrapper>, event: PointerEvent}) {
        this.dockDrag.start(payload.panel.id, payload.event);
    }

    /** Defers undocking until after pointerup so PrimeNG dialog drag startup sees a clean event stream. */
    private queueUndock(panelId: number, event: PointerEvent, offset: DockedPanelDragOffset) {
        const left = Math.max(0, Math.round(event.clientX - offset.x));
        const top = Math.max(0, Math.round(event.clientY - offset.y));
        this.stateService.setInspectionDialogPosition(panelId, {left, top});
        this.stateService.setInspectionPanelUndockedState(panelId, true);
    }

}
