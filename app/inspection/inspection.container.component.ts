import {Component, ElementRef, OnDestroy, Renderer2, ViewChild} from "@angular/core";
import {MapDataService} from "../mapdata/map.service";
import {AppStateService, InspectionPanelModel} from "../shared/appstate.service";
import {FeatureWrapper} from "../mapdata/features.model";
import {InspectionComparisonModel, InspectionComparisonService} from "./inspection-comparison.service";
import {InspectionDialogLayoutService} from "./inspection-dialog-layout.service";

@Component({
    selector: 'inspection-container',
    template: `
        <div #dockContainer class="inspection-container" [ngClass]="{'reordering': isReordering}">
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
                    <p-button class="close-dock-button" icon="pi pi-times" styleClass="p-button-danger" (click)="closeDock()"
                              (mousedown)="$event.stopPropagation()"/>
                </div>
            } @else {
                <div class="dock-empty">
                    <p-button class="close-dock-button" icon="pi pi-times" styleClass="p-button-danger" (click)="closeDock()"
                              (mousedown)="$event.stopPropagation()"/>
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
                                      [ngClass]="{'dragging': dragPanelId === panel.id,
                                                  'drop-before': dropBeforeId === panel.id,
                                                  'drop-after': dropAfterId === panel.id}"
                                      [attr.data-panel-id]="panel.id"
                                      [(filterText)]="dockFilterText"
                                      (ejectedPanel)="onEject($event)"
                                      (panelDragRequest)="onPanelDragRequest($event)">
                    </inspection-panel>
                }
            }
        </div>
        @for (panel of undockedPanels; track panel.id; let i = $index) {
            @if (panel.features.length > 0 || panel.sourceData !== undefined) {
                <inspection-panel-dialog [panel]="panel" [dialogIndex]="i"></inspection-panel-dialog>
            }
        }
        @for (comparison of comparisons; track comparison.id) {
            <inspection-comparison-dialog [comparison]="comparison"></inspection-comparison-dialog>
        }
    `,
    styles: [``],
    standalone: false
})
export class InspectionContainerComponent implements OnDestroy {
    dockedPanels: InspectionPanelModel<FeatureWrapper>[] = [];
    undockedPanels: InspectionPanelModel<FeatureWrapper>[] = [];
    comparisons: InspectionComparisonModel[] = [];
    isReordering = false;
    dockFilterText = '';
    dragPanelId?: number;
    dropBeforeId?: number;
    dropAfterId?: number;

    @ViewChild('dockContainer') private dockContainerRef?: ElementRef<HTMLDivElement>;

    private dragStart?: {x: number, y: number};
    private dragPointerId?: number;
    private dragMode?: 'reorder' | 'undock';
    private dragActive = false;
    private dropIndex?: number;
    private detachMove?: () => void;
    private detachUp?: () => void;

    constructor(private stateService: AppStateService,
                private mapService: MapDataService,
                private comparisonService: InspectionComparisonService,
                private dialogLayout: InspectionDialogLayoutService,
                private renderer: Renderer2) {
        this.mapService.selectionTopic.subscribe(panels => {
            const allPanels = panels.slice();
            this.dialogLayout.syncPanels(allPanels.map(panel => panel.id));
            this.undockedPanels = allPanels.filter(panel => panel.undocked);
            this.dockedPanels = allPanels.filter(panel => !panel.undocked).toReversed();
            this.stateService.isDockOpen = this.stateService.isDockOpen && !this.stateService.isDockAutoCollapsible || allPanels.length > 0;
        });
        this.comparisonService.comparisons.subscribe(comparisons => {
            this.comparisons = comparisons;
        });
    }

    ngOnDestroy() {
        this.resetDockDrag();
    }

    onEject(panel: InspectionPanelModel<FeatureWrapper>) {
        this.stateService.setInspectionPanelUndockedState(panel.id, true);
    }

    onPanelDragRequest(payload: {panel: InspectionPanelModel<FeatureWrapper>, event: PointerEvent}) {
        if (this.dragActive) {
            return;
        }
        const event = payload.event;
        if (event.button !== 0) {
            return;
        }
        this.dragPanelId = payload.panel.id;
        this.dragPointerId = event.pointerId;
        this.dragStart = {x: event.clientX, y: event.clientY};
        this.dragMode = undefined;
        this.dragActive = false;
        this.dropIndex = undefined;
        this.dropBeforeId = undefined;
        this.dropAfterId = undefined;
        this.detachMove?.();
        this.detachUp?.();
        this.detachMove = this.renderer.listen('window', 'pointermove', (ev: PointerEvent) => this.onDockDragMove(ev));
        this.detachUp = this.renderer.listen('window', 'pointerup', (ev: PointerEvent) => this.onDockDragEnd(ev));
    }

    private onDockDragMove(event: PointerEvent) {
        if (!this.dragStart || event.pointerId !== this.dragPointerId) {
            return;
        }
        const dx = event.clientX - this.dragStart.x;
        const dy = event.clientY - this.dragStart.y;
        const threshold = this.stateService.baseFontSize * 0.5;
        const distance = Math.hypot(dx, dy);
        if (!this.dragActive && distance < threshold) {
            return;
        }
        if (!this.dragActive) {
            this.dragActive = true;
            document.body.classList.add('dialog-dragging');
        }
        if (!this.dragMode) {
            this.dragMode = this.isPointInDock(event.clientX, event.clientY) ? 'reorder' : 'undock';
            if (this.dragMode === 'reorder') {
                this.isReordering = true;
            }
        }
        if (this.dragMode === 'reorder') {
            if (this.isPointInDock(event.clientX, event.clientY)) {
                this.updateDropTarget(event.clientY);
            } else {
                this.dropIndex = undefined;
                this.dropBeforeId = undefined;
                this.dropAfterId = undefined;
            }
        }
    }

    private onDockDragEnd(event: PointerEvent) {
        if (event.pointerId !== this.dragPointerId) {
            return;
        }
        const panelId = this.dragPanelId;
        const dragActive = this.dragActive;
        const dragMode = this.dragMode;
        const inDock = this.isPointInDock(event.clientX, event.clientY);

        if (dragActive && panelId !== undefined) {
            if (!inDock) {
                this.queueUndock(panelId, event);
            } else if (dragMode === 'reorder') {
                this.updateDropTarget(event.clientY);
                this.applyReorder(panelId);
            }
        }

        this.resetDockDrag();
    }

    private applyReorder(panelId: number) {
        const displayOrder = this.dockedPanels.map(panel => panel.id);
        if (displayOrder.length < 2) {
            return;
        }
        const filtered = displayOrder.filter(id => id !== panelId);
        const dropIndex = this.dropIndex ?? filtered.length;
        const clampedIndex = Math.min(Math.max(dropIndex, 0), filtered.length);
        const nextDisplayOrder = filtered.slice();
        nextDisplayOrder.splice(clampedIndex, 0, panelId);
        if (!this.ordersEqual(displayOrder, nextDisplayOrder)) {
            this.stateService.reorderInspectionPanels(nextDisplayOrder);
        }
    }

    private ordersEqual(a: number[], b: number[]): boolean {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        return true;
    }

    private updateDropTarget(clientY: number) {
        if (!this.dockContainerRef || this.dragPanelId === undefined) {
            return;
        }
        const elements = Array.from(this.dockContainerRef.nativeElement.querySelectorAll<HTMLElement>('inspection-panel'))
            .map(el => ({el, id: Number(el.dataset['panelId'])}))
            .filter(entry => !Number.isNaN(entry.id) && entry.id !== this.dragPanelId);
        if (!elements.length) {
            this.dropIndex = 0;
            this.dropBeforeId = undefined;
            this.dropAfterId = undefined;
            return;
        }
        let dropIndex = elements.length;
        for (let i = 0; i < elements.length; i++) {
            const rect = elements[i].el.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;
            if (clientY < mid) {
                dropIndex = i;
                break;
            }
        }
        this.dropIndex = dropIndex;
        this.dropBeforeId = dropIndex < elements.length ? elements[dropIndex].id : undefined;
        this.dropAfterId = dropIndex >= elements.length ? elements[elements.length - 1].id : undefined;
    }

    private queueUndock(panelId: number, event: PointerEvent) {
        const offset = this.stateService.baseFontSize;
        const left = Math.max(0, event.clientX - offset);
        const top = Math.max(0, event.clientY - offset);
        this.dialogLayout.setPendingPosition(panelId, {left, top});
        this.stateService.setInspectionPanelUndockedState(panelId, true);
    }

    private isPointInDock(x: number, y: number): boolean {
        const rect = this.dockContainerRef?.nativeElement.getBoundingClientRect();
        if (!rect) {
            return false;
        }
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }

    private resetDockDrag() {
        this.detachMove?.();
        this.detachUp?.();
        this.detachMove = undefined;
        this.detachUp = undefined;
        this.dragStart = undefined;
        this.dragPointerId = undefined;
        this.dragMode = undefined;
        this.dragActive = false;
        this.dragPanelId = undefined;
        this.dropIndex = undefined;
        this.dropBeforeId = undefined;
        this.dropAfterId = undefined;
        this.isReordering = false;
        document.body.classList.remove('dialog-dragging');
    }

    protected closeDock() {
        this.stateService.isDockOpen = false;
    }
}
