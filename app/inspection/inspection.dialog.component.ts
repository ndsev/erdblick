import {Component, OnDestroy, Renderer2, ViewChild, effect, input} from "@angular/core";
import {Dialog} from "primeng/dialog";
import {Popover} from "primeng/popover";
import {MapDataService} from "../mapdata/map.service";
import {AppStateService, InspectionPanelModel} from "../shared/appstate.service";
import {FeatureWrapper} from "../mapdata/features.model";
import {coreLib} from "../integrations/wasm";
import {DialogStackService} from "../shared/dialog-stack.service";
import {InspectionDialogLayoutService} from "./inspection-dialog-layout.service";
import {InspectionComparisonOption, InspectionComparisonService} from "./inspection-comparison.service";
import {InspectionTreeComponent} from "./inspection.tree.component";

@Component({
    selector: 'inspection-panel-dialog',
    template: `
        <p-dialog #dialog class="inspection-dialog" [modal]="false" [closable]="false" [visible]="true"
                  (onShow)="onDialogShow()" (onDragEnd)="onDialogDragEnd()">
            @if (panel()) {
                <ng-template #header>
                    <div class="inspector-title" (pointerdown)="beginDrag()">
                        <span>
                            @if (panel().sourceData === undefined && panel().features.length > 0) {
                                <p-colorpicker [(ngModel)]="panel().color" (click)="$event.stopPropagation()"
                                               (mousedown)="$event.stopPropagation()"
                                               (ngModelChange)="stateService.setInspectionPanelColor(panel().id, panel().color)">
                                </p-colorpicker>
                            } @else if (!panel().pinned) {
                                <!-- TODO: Render only if the panel was opened in the unpinned inspection dialog -->
                                <p-button icon="pi pi-chevron-left" (click)="onGoBack($event)"
                                          (mousedown)="$event.stopPropagation()"/>
                            }
                            <span class="title" [pTooltip]="title" tooltipPosition="bottom">{{ title }}</span>
                            @if (panel().sourceData !== undefined) {
                                <p-select class="source-layer-dropdown" [options]="layerMenuItems"
                                          [(ngModel)]="selectedLayerItem"
                                          (click)="onDropdownClick($event)" (mousedown)="onDropdownClick($event)"
                                          scrollHeight="20em" (ngModelChange)="onSelectedLayerItem()"
                                          optionLabel="label"
                                          optionDisabled="disabled"/>
                            }
                        </span>
                        <span>
                            <p-button icon="" (click)="dock($event)" (mousedown)="$event.stopPropagation()">
                                <span class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">move_to_inbox</span>
                            </p-button>
                            @if (panel().sourceData === undefined) {
                                <p-button icon="" (click)="togglePinnedState($event)"
                                          [styleClass]="panel().pinned ? 'p-button-success' : 'p-button-primary'"
                                          (mousedown)="$event.stopPropagation()">
                                    @if (panel().pinned) {
                                        <span class="material-symbols-outlined"
                                              style="font-size: 1.2em; margin: 0 auto;">keep</span>
                                    } @else {
                                        <span class="material-symbols-outlined"
                                              style="font-size: 1.2em; margin: 0 auto;">keep_off</span>
                                    }
                                </p-button>
                            }
                            @if (panel().sourceData === undefined && panel().features.length > 0) {
                                <p-button icon="" (click)="focusOnFeature($event)"
                                          (mousedown)="$event.stopPropagation()"
                                          pTooltip="Focus on feature" tooltipPosition="bottom">
                                    <span class="material-symbols-outlined"
                                          style="font-size: 1.2em; margin: 0 auto;">center_focus_strong</span>
                                </p-button>
                                <p-button icon="" (click)="openGeoJsonMenu($event)"
                                          (mousedown)="$event.stopPropagation()"
                                          pTooltip="GeoJSON actions" tooltipPosition="bottom">
                                    <span class="material-symbols-outlined"
                                          style="font-size: 1.2em; margin: 0 auto;">download</span>
                                </p-button>
                                <p-button icon="" (click)="openComparePopover($event)"
                                          (mousedown)="$event.stopPropagation()"
                                          pTooltip="Compare" tooltipPosition="bottom">
                                    <span class="material-symbols-outlined"
                                          style="font-size: 1.2em; margin: 0 auto;">compare_arrows</span>
                                </p-button>
                            }
                            <p-button icon="pi pi-times" styleClass="p-button-danger" (click)="unsetPanel()"
                                      (mousedown)="$event.stopPropagation()"/>
                        </span>
                    </div>
                </ng-template>

                <ng-template #content>
                    <div class="resizable-container">
                        <div style="width: 100%; height: 100%">
                            @if (errorMessage) {
                                <div>
                                    <strong>Error</strong><br>{{ errorMessage }}
                                </div>
                            } @else if (panel().sourceData) {
                                <sourcedata-panel [panel]="panel()" (errorOccurred)="onSourceDataError($event)"></sourcedata-panel>
                            } @else {
                                <feature-panel [panel]="panel()"></feature-panel>
                            }
                        </div>
                    </div>
                </ng-template>
            }
        </p-dialog>
        <p-popover #comparePopover [baseZIndex]="30000">
            <div style="display: flex; flex-direction: row; align-content: center; gap: 0.25em">
                <div class="comparison-popover">
                    <p-multiSelect [options]="compareOptions"
                                   [(ngModel)]="selectedCompareIds"
                                   (onPanelShow)="refreshCompareOptions()"
                                   optionLabel="label"
                                   optionValue="value"
                                   [showClear]="true"
                                   [selectionLimit]="3"
                                   placeholder="Compare with..."
                                   [overlayOptions]="{ autoZIndex: true, baseZIndex: 30010 }"/>
                    @if (selectedCompareIds.length > 0) {
                        <div class="comparison-popover-actions">
                            <p-button icon="pi pi-check" label="" (click)="applyComparison($event)"/>
                        </div>
                    }
                </div>
            </div>
        </p-popover>
    `,
    styles: [``],
    standalone: false
})
export class InspectionPanelDialogComponent implements OnDestroy {
    panel = input.required<InspectionPanelModel<FeatureWrapper>>();
    dialogIndex = input.required<number>();
    title = "";
    errorMessage: string = "";
    layerMenuItems: { label: string, disabled: boolean, command: () => void }[] = [];
    selectedLayerItem?: { label: string, disabled: boolean, command: () => void };
    compareOptions: InspectionComparisonOption[] = [];
    selectedCompareIds: number[] = [];

    @ViewChild('dialog') dialog?: Dialog;
    @ViewChild('comparePopover') comparePopover!: Popover;
    @ViewChild(InspectionTreeComponent) inspectionTree?: InspectionTreeComponent;

    private detachFocusListener?: () => void;
    private detachHeaderDownListener?: () => void;
    private detachDragMoveListener?: () => void;
    private detachDragUpListener?: () => void;
    private detachPointerUpListener?: () => void;
    private dockElement?: HTMLElement;

    constructor(private mapService: MapDataService,
                public stateService: AppStateService,
                private renderer: Renderer2,
                private comparisonService: InspectionComparisonService,
                private dialogStack: DialogStackService,
                private dialogLayout: InspectionDialogLayoutService) {
        effect(() => {
            this.updateHeaderFor(this.panel());
        });
    }

    private updateHeaderFor(panel: InspectionPanelModel<FeatureWrapper>) {
        if (panel.sourceData !== undefined) {
            const selection = panel.sourceData!;
            const [mapId, layerId, tileId] = coreLib.parseMapTileKey(selection.mapTileKey);
            this.title = tileId === 0n ? `Metadata for ${mapId}: ` : `${tileId}.`;
            const map = this.mapService.maps.maps.get(mapId);
            if (map) {
                this.layerMenuItems = Array.from(map.layers.values())
                    .filter(item => item.type === "SourceData")
                    .filter(item => (item.id.startsWith("SourceData") && tileId !== 0n) || (item.id.startsWith("Metadata") && tileId === 0n))
                    .map(item => {
                        return {
                            label: this.mapService.layerNameForSourceDataLayerId(item.id, item.id.startsWith("Metadata")),
                            disabled: item.id === layerId,
                            command: () => {
                                const sourceData = { ...selection };
                                sourceData.mapTileKey = coreLib.getSourceDataLayerKey(mapId, item.id, tileId);
                                sourceData.address = undefined;
                                this.stateService.setSelection(sourceData, panel.id);
                            }
                        }
                    }).sort((a, b) => a.label.localeCompare(b.label));
                this.selectedLayerItem = this.layerMenuItems.filter(item => item.disabled).pop();
            } else {
                this.layerMenuItems = [];
                this.title = "";
                this.selectedLayerItem = undefined;
            }
        } else {
            this.title = panel.features.length > 1 ? `Selected ${panel.features.length} features` : panel.features[0].featureId;
            this.layerMenuItems = [];
            this.selectedLayerItem = undefined;
        }
    }

    onGoBack(event: MouseEvent) {
        event.stopPropagation();
        const p = this.panel();
        if (p.features.length) {
            this.title = p.features.length > 1 ? `Selected ${p.features.length} features` : p.features[0].featureId;
        }
        this.errorMessage = "";
        this.stateService.setSelection(p.features, p.id);
    }

    onSelectedLayerItem() {
        if (this.selectedLayerItem && !this.selectedLayerItem.disabled) {
            this.selectedLayerItem.command();
        }
    }

    onDropdownClick(event: MouseEvent) {
        event.stopPropagation();
    }

    onSourceDataError(errorMessage: string) {
        this.errorMessage = errorMessage;
        console.error("Error while processing SourceData tree:", errorMessage);
    }

    togglePinnedState(event: MouseEvent) {
        event.stopPropagation();
        const p = this.panel();
        this.stateService.setInspectionPanelPinnedState(p.id, !p.pinned);
    }

    unsetPanel() {
        this.stateService.unsetPanel(this.panel().id);
    }

    focusOnFeature(event: MouseEvent) {
        event.stopPropagation();
        const panel = this.panel();
        if (!panel.features.length) {
            return;
        }
        this.mapService.zoomToFeature(undefined, panel.features[0]);
    }

    openGeoJsonMenu(event: MouseEvent) {
        event.stopPropagation();
        this.inspectionTree?.showGeoJsonMenu(event);
    }

    dock(event: MouseEvent) {
        event.stopPropagation();
        this.stateService.setInspectionPanelUndockedState(this.panel().id, false);
    }

    openComparePopover(event: MouseEvent) {
        event.stopPropagation();
        this.refreshCompareOptions();
        this.comparePopover.toggle(event);
    }

    refreshCompareOptions() {
        this.compareOptions = this.comparisonService.buildCompareOptions(this.panel().id);
        this.selectedCompareIds = this.selectedCompareIds.filter(id =>
            this.compareOptions.some(option => option.value === id)
        );
    }

    applyComparison(event: MouseEvent) {
        event.stopPropagation();
        if (!this.selectedCompareIds.length) {
            return;
        }
        this.comparisonService.openComparison(this.panel().id, this.selectedCompareIds);
        this.selectedCompareIds = [];
        this.comparePopover.hide();
    }

    onDialogShow() {
        this.dockElement = document.querySelector('.collapsible-dock') as HTMLElement | null ?? undefined;
        this.dialogStack.bringToFront(this.dialog);
        this.bindDialogFocus();
        this.bindDockDragCue();
        this.applyInitialPosition();
    }

    onDialogDragEnd() {
        this.endDrag();
        if (this.shouldDock()) {
            this.stateService.setInspectionPanelUndockedState(this.panel().id, false);
        }
        this.storeDialogPosition();
        this.clearDockCue();
        this.dialogStack.bringToFront(this.dialog);
    }

    ngOnDestroy() {
        this.endDrag();
        this.detachFocusListener?.();
        this.detachHeaderDownListener?.();
        this.detachDragMoveListener?.();
        this.detachDragUpListener?.();
        this.clearDockCue();
    }

    beginDrag(): void {
        this.inspectionTree?.freeze();
        this.detachPointerUpListener?.();
        this.detachPointerUpListener = this.renderer.listen('window', 'pointerup', () => {
            this.endDrag();
        });
    }

    endDrag(): void {
        this.detachPointerUpListener?.();
        this.detachPointerUpListener = undefined;
        this.inspectionTree?.unfreeze();
    }

    private bindDialogFocus() {
        if (!this.dialog?.container) {
            return;
        }
        this.detachFocusListener?.();
        const handler = () => this.dialogStack.bringToFront(this.dialog);
        this.dialog.container.addEventListener('mousedown', handler, true);
        this.detachFocusListener = () => {
            this.dialog?.container?.removeEventListener('mousedown', handler, true);
        };
    }

    private bindDockDragCue() {
        if (!this.dialog?.container) {
            return;
        }
        const header = this.dialog.container.querySelector('.p-dialog-header');
        if (!header) {
            return;
        }
        this.detachHeaderDownListener?.();
        this.detachHeaderDownListener = this.renderer.listen(header, 'mousedown', () => {
            this.detachDragMoveListener?.();
            this.detachDragUpListener?.();
            this.detachDragMoveListener = this.renderer.listen('window', 'mousemove', () => {
                this.updateDockCue();
            });
            this.detachDragUpListener = this.renderer.listen('window', 'mouseup', () => {
                this.clearDockCue();
                this.detachDragMoveListener?.();
                this.detachDragUpListener?.();
                this.detachDragMoveListener = undefined;
                this.detachDragUpListener = undefined;
            });
        });
    }

    private applyInitialPosition() {
        if (!this.dialog?.container) {
            return;
        }
        const index = this.dialogIndex();
        const panelId = this.panel().id;
        const slotIndex = this.dialogLayout.getSlotIndex(index);
        const pending = this.dialogLayout.consumePendingPosition(panelId);
        const stored = pending ?? this.dialogLayout.getPosition(index, panelId);
        const rect = this.dialog.container.getBoundingClientRect();
        const offsetPx = this.stateService.baseFontSize;
        const offsetMultiplier = slotIndex + 1;
        const left = stored?.left ?? rect.left + offsetPx * offsetMultiplier;
        const top = stored?.top ?? rect.top + offsetPx * offsetMultiplier;
        this.setDialogPosition(left, top);
        if (!stored || pending) {
            this.dialogLayout.setPosition(index, panelId, {left, top});
        }
    }

    private storeDialogPosition() {
        if (!this.dialog?.container) {
            return;
        }
        const rect = this.dialog.container.getBoundingClientRect();
        this.dialogLayout.setPosition(this.dialogIndex(), this.panel().id, {left: rect.left, top: rect.top});
    }

    private setDialogPosition(left: number, top: number) {
        if (!this.dialog?.container) {
            return;
        }
        this.dialog.container.style.position = 'fixed';
        this.dialog.container.style.left = `${Math.round(left)}px`;
        this.dialog.container.style.top = `${Math.round(top)}px`;
        this.dialog.container.style.margin = '0';
    }

    private shouldDock(): boolean {
        if (!this.dialog?.container || !this.dockElement) {
            return false;
        }
        const overlap = this.getDockOverlap();
        if (!overlap) {
            return false;
        }
        const threshold = this.stateService.baseFontSize * 2;
        return overlap.width >= threshold && overlap.height > 0;
    }

    private updateDockCue() {
        if (!this.dialog?.dragging) {
            this.clearDockCue();
            return;
        }
        if (this.shouldDock()) {
            this.setDockCue(true);
        } else {
            this.setDockCue(false);
        }
    }

    private getDockOverlap(): {width: number, height: number} | undefined {
        if (!this.dialog?.container || !this.dockElement) {
            return;
        }
        const dialogRect = this.dialog.container.getBoundingClientRect();
        const dockRect = this.dockElement.getBoundingClientRect();
        const left = Math.max(dialogRect.left, dockRect.left);
        const right = Math.min(dialogRect.right, dockRect.right);
        const top = Math.max(dialogRect.top, dockRect.top);
        const bottom = Math.min(dialogRect.bottom, dockRect.bottom);
        const width = Math.max(0, right - left);
        const height = Math.max(0, bottom - top);
        if (!width || !height) {
            return;
        }
        return {width, height};
    }

    private setDockCue(active: boolean) {
        if (!this.dockElement) {
            return;
        }
        if (active) {
            this.renderer.addClass(this.dockElement, 'dock-drop-active');
        } else {
            this.renderer.removeClass(this.dockElement, 'dock-drop-active');
        }
    }

    private clearDockCue() {
        this.setDockCue(false);
    }
}
