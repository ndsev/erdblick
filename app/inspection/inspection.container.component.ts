import {Component, ElementRef, OnDestroy, Renderer2, ViewChild} from "@angular/core";
import {MapDataService} from "../mapdata/map.service";
import {AppStateService, InspectionComparisonModel, InspectionPanelModel} from "../shared/appstate.service";
import {FeatureWrapper} from "../mapdata/features.model";

@Component({
    selector: 'inspection-container',
    template: `
        <div #dockContainer class="inspection-container" data-testid="inspection-container"
             [ngClass]="{'reordering': isReordering, 'single-panel': dockedPanels.length === 1, 'multi-panel': dockedPanels.length > 1}">
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
                    <p-button class="close-dock-button" icon="pi pi-times" severity="secondary" (click)="closeDock()"
                              (mousedown)="$event.stopPropagation()"/>
                </div>
            } @else {
                <div class="dock-empty">
                    <p-button class="close-dock-button" icon="pi pi-times" severity="secondary" (click)="closeDock()"
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
                                      [dockedPanelCount]="dockedPanels.length"
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
        @if (comparison) {
            <inspection-comparison-dialog [comparison]="comparison"></inspection-comparison-dialog>
        }
    `,
    styles: [``],
    standalone: false
})
export class InspectionContainerComponent implements OnDestroy {
    dockedPanels: InspectionPanelModel<FeatureWrapper>[] = [];
    undockedPanels: InspectionPanelModel<FeatureWrapper>[] = [];
    comparison: InspectionComparisonModel | null = null;
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
    private dragPreviewElement?: HTMLDivElement;
    private dragPreviewOffset = {x: 0, y: 0};

    constructor(private stateService: AppStateService,
                private mapService: MapDataService,
                private renderer: Renderer2) {
        this.mapService.selectionTopic.subscribe(panels => {
            const allPanels = panels.slice();
            this.undockedPanels = allPanels.filter(panel => panel.undocked);
            this.dockedPanels = allPanels.filter(panel => !panel.undocked).toReversed();
            const hasDockedPanels = this.dockedPanels.length > 0;
            this.stateService.isDockOpen = this.stateService.isDockOpen &&
                (!this.stateService.isDockAutoCollapsible || hasDockedPanels);
        });
        this.stateService.inspectionComparisonState.subscribe(comparison => {
            this.comparison = comparison;
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
        this.clearDragPreview();
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
        this.ensureDragPreview(event);
        this.positionDragPreview(event.clientX, event.clientY);
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
        const fallbackOffset = this.stateService.baseFontSize;
        const offsetX = this.dragPreviewElement ? this.dragPreviewOffset.x : fallbackOffset;
        const offsetY = this.dragPreviewElement ? this.dragPreviewOffset.y : fallbackOffset;
        const left = Math.max(0, Math.round(event.clientX - offsetX));
        const top = Math.max(0, Math.round(event.clientY - offsetY));
        this.stateService.setInspectionDialogPosition(panelId, {left, top});
        this.stateService.setInspectionPanelUndockedState(panelId, true);
    }

    private isPointInDock(x: number, y: number): boolean {
        const rect = this.dockContainerRef?.nativeElement.getBoundingClientRect();
        if (!rect) {
            return false;
        }
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }

    private ensureDragPreview(event: PointerEvent) {
        if (this.dragPreviewElement || !this.dockContainerRef || this.dragPanelId === undefined) {
            return;
        }
        const panelElement = this.dockContainerRef.nativeElement
            .querySelector<HTMLElement>(`inspection-panel[data-panel-id="${this.dragPanelId}"]`);
        if (!panelElement) {
            return;
        }
        const panelRect = panelElement.getBoundingClientRect();
        const pointerStartX = this.dragStart?.x ?? event.clientX;
        const pointerStartY = this.dragStart?.y ?? event.clientY;
        this.dragPreviewOffset = {
            x: Math.min(Math.max(pointerStartX - panelRect.left, 0), panelRect.width),
            y: Math.min(Math.max(pointerStartY - panelRect.top, 0), panelRect.height)
        };

        const previewElement = this.renderer.createElement('div') as HTMLDivElement;
        this.renderer.addClass(previewElement, 'inspection-drag-preview');
        this.renderer.setStyle(previewElement, 'width', `${Math.round(panelRect.width)}px`);
        this.renderer.setStyle(previewElement, 'height', `${Math.round(panelRect.height)}px`);

        const headerElement = panelElement.querySelector<HTMLElement>('.p-accordionheader');
        if (headerElement) {
            const headerClone = headerElement.cloneNode(true) as HTMLElement;
            this.renderer.addClass(headerClone, 'inspection-drag-preview-header');
            this.renderer.appendChild(previewElement, headerClone);
        }
        const fillElement = this.renderer.createElement('div') as HTMLDivElement;
        this.renderer.addClass(fillElement, 'inspection-drag-preview-fill');
        this.renderer.appendChild(previewElement, fillElement);

        this.renderer.appendChild(document.body, previewElement);
        this.dragPreviewElement = previewElement;
    }

    private positionDragPreview(clientX: number, clientY: number) {
        if (!this.dragPreviewElement) {
            return;
        }
        this.renderer.setStyle(this.dragPreviewElement, 'left', `${Math.round(clientX - this.dragPreviewOffset.x)}px`);
        this.renderer.setStyle(this.dragPreviewElement, 'top', `${Math.round(clientY - this.dragPreviewOffset.y)}px`);
    }

    private clearDragPreview() {
        if (!this.dragPreviewElement) {
            return;
        }
        this.dragPreviewElement.remove();
        this.dragPreviewElement = undefined;
        this.dragPreviewOffset = {x: 0, y: 0};
    }

    private resetDockDrag() {
        this.detachMove?.();
        this.detachUp?.();
        this.detachMove = undefined;
        this.detachUp = undefined;
        this.clearDragPreview();
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
