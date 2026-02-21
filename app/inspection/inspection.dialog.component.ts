import {Component, OnDestroy, Renderer2, ViewChild, effect, input} from "@angular/core";
import {Dialog} from "primeng/dialog";
import {Popover} from "primeng/popover";
import {ContextMenu} from "primeng/contextmenu";
import {MapDataService} from "../mapdata/map.service";
import {AppStateService, InspectionComparisonOption, InspectionPanelModel} from "../shared/appstate.service";
import {FeatureWrapper} from "../mapdata/features.model";
import {coreLib} from "../integrations/wasm";
import {DialogStackService} from "../shared/dialog-stack.service";
import {FeaturePanelComponent} from "./feature.panel.component";
import {SourceDataPanelComponent} from "./sourcedata.panel.component";
import {MenuItem, MenuItemCommandEvent} from "primeng/api";

@Component({
    selector: 'inspection-panel-dialog',
    template: `
        <p-dialog #dialog class="inspection-dialog" [modal]="false" [closable]="false" [visible]="true"
                  [style]="dialogStyle"
                  (onShow)="onDialogShow()" (onDragEnd)="onDialogDragEnd()" (onResizeEnd)="onDialogResizeEnd()">
            @if (panel()) {
                <ng-template #header>
                    <div class="inspector-title" (pointerdown)="beginDrag()">
                        <span class="title-container">
                            @if (panel().sourceData === undefined && panel().features.length > 0) {
                                <p-colorpicker [(ngModel)]="panel().color" (click)="$event.stopPropagation()"
                                               (mousedown)="$event.stopPropagation()"
                                               (ngModelChange)="stateService.setInspectionPanelColor(panel().id, panel().color)">
                                </p-colorpicker>
                            } @else if (isMetadata) {
                                <p-tag severity="info" value="META" [rounded]="true" />
                            } @else if (panel().sourceData !== undefined) {
                                <p-tag severity="success" value="DATA" [rounded]="true" />
                            }
                            <div class="title" [pTooltip]="panel().locked ? 'Unlock ' + title : 'Lock ' + title" 
                                 tooltipPosition="bottom" (mousedown)="$event.stopPropagation()"
                                 (click)="toggleLockedState($event)">
                                <span class="material-symbols-outlined">
                                    @if (panel().locked) {
                                        lock
                                    } @else {
                                        lock_open_right
                                    }
                                </span>
                                <span class="title-span">
                                    {{ title }}
                                </span>
                            </div>
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
                            @if (panel().sourceData === undefined && panel().features.length > 0) {
                                <p-button icon="" (click)="openExtraMenu($event)"
                                          (mousedown)="$event.stopPropagation()"
                                          pTooltip="More actions" tooltipPosition="bottom">
                                    <span class="material-symbols-outlined"
                                          style="font-size: 1.2em; margin: 0 auto;">more_vert</span>
                                </p-button>
                            }
                            <p-button icon="" (click)="dock($event)" (mousedown)="$event.stopPropagation()"
                                      pTooltip="Dock" tooltipPosition="bottom">
                                <span class="material-symbols-outlined" style="font-size: 1.2em; margin: 0 auto;">move_to_inbox</span>
                            </p-button>
                            <p-button icon="pi pi-times" severity="secondary" (click)="unsetPanel()"
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
                                <sourcedata-panel [panel]="panel()"
                                                  (errorOccurred)="onSourceDataError($event)"></sourcedata-panel>
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
        <p-contextMenu #extraMenu [model]="extraMenuItems" [baseZIndex]="30000" appendTo="body"
                       [style]="{'font-size': '0.9em'}"></p-contextMenu>
    `,
    styles: [``],
    standalone: false
})
export class InspectionPanelDialogComponent implements OnDestroy {
    panel = input.required<InspectionPanelModel<FeatureWrapper>>();
    dialogIndex = input.required<number>();
    title = "";
    errorMessage: string = "";
    dialogStyle: { [key: string]: string } = {};
    layerMenuItems: { label: string, disabled: boolean, command: () => void }[] = [];
    selectedLayerItem?: { label: string, disabled: boolean, command: () => void };
    compareOptions: InspectionComparisonOption[] = [];
    selectedCompareIds: number[] = [];
    extraMenuItems: MenuItem[] = [];
    private lastExtraMenuTarget?: HTMLElement;
    isMetadata: boolean = false;

    @ViewChild('dialog') dialog?: Dialog;
    @ViewChild('comparePopover') comparePopover!: Popover;
    @ViewChild('extraMenu') extraMenu!: ContextMenu;
    @ViewChild(FeaturePanelComponent) featurePanel?: FeaturePanelComponent;
    @ViewChild(SourceDataPanelComponent) sourceDataPanel?: SourceDataPanelComponent;

    private detachFocusListener?: () => void;
    private detachHeaderDownListener?: () => void;
    private detachDragMoveListener?: () => void;
    private detachDragUpListener?: () => void;
    private detachPointerUpListener?: () => void;
    private dockElement?: HTMLElement;

    constructor(private mapService: MapDataService,
                public stateService: AppStateService,
                private renderer: Renderer2,
                private dialogStack: DialogStackService) {
        effect(() => {
            const panel = this.panel();
            this.updateHeaderFor(panel);
            this.dialogStyle = this.buildDialogStyle(panel);
        });
    }

    private updateHeaderFor(panel: InspectionPanelModel<FeatureWrapper>) {
        if (panel.sourceData !== undefined) {
            const selection = panel.sourceData!;
            const [mapId, layerId, tileId] = coreLib.parseMapTileKey(selection.mapTileKey);
            this.isMetadata = tileId === 0n;
            this.title = this.isMetadata ? `${mapId}:` : `${tileId}.`;
            const map = this.mapService.maps.maps.get(mapId);
            if (map) {
                this.layerMenuItems = Array.from(map.layers.values())
                    .filter(item => item.type === "SourceData")
                    .filter(item => (item.id.startsWith("SourceData") && !this.isMetadata) ||
                        (item.id.startsWith("Metadata") && this.isMetadata))
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

    protected onGoBack(event: MouseEvent) {
        event.stopPropagation();
        const p = this.panel();
        if (p.features.length) {
            this.title = p.features.length > 1 ? `Selected ${p.features.length} features` : p.features[0].featureId;
        }
        this.errorMessage = "";
        this.stateService.setSelection(p.features, p.id);
    }

    protected onSelectedLayerItem() {
        if (this.selectedLayerItem && !this.selectedLayerItem.disabled) {
            this.selectedLayerItem.command();
        }
    }

    protected onDropdownClick(event: MouseEvent) {
        event.stopPropagation();
    }

    protected onSourceDataError(errorMessage: string) {
        this.errorMessage = errorMessage;
        console.error("Error while processing SourceData tree:", errorMessage);
    }

    protected toggleLockedState(event: MouseEvent) {
        event.stopPropagation();
        const p = this.panel();
        this.stateService.setInspectionPanelLockedState(p.id, !p.locked);
    }

    protected unsetPanel() {
        this.stateService.unsetPanel(this.panel().id);
    }

    private focusOnFeature(event?: MouseEvent) {
        event?.stopPropagation();
        const panel = this.panel();
        if (!panel.features.length) {
            return;
        }
        this.mapService.zoomToFeature(undefined, panel.features[0]);
    }

    protected dock(event: MouseEvent) {
        event.stopPropagation();
        this.stateService.setInspectionPanelUndockedState(this.panel().id, false);
    }

    protected openExtraMenu(event: MouseEvent) {
        event.stopPropagation();
        this.lastExtraMenuTarget = (event.currentTarget || event.target) as HTMLElement | undefined;
        this.extraMenuItems = [
            {
                label: 'Focus on feature',
                icon: 'pi pi-bullseye',
                command: () => this.focusOnFeature()
            },
            {
                label: 'GeoJSON Actions',
                icon: 'pi pi-download',
                items: [
                    {
                        label: 'Open in new tab',
                        icon: 'pi pi-external-link',
                        command: () => this.featurePanel?.openGeoJsonInNewTab()
                    },
                    {
                        label: 'Download (.geojson)',
                        icon: 'pi pi-download',
                        command: () => this.featurePanel?.downloadGeoJson()
                    },
                    {
                        label: 'Copy to clipboard',
                        icon: 'pi pi-copy',
                        command: () => this.featurePanel?.copyGeoJson()
                    }
                ]
            },
            {
                label: 'Compare',
                icon: 'pi pi-arrow-right-arrow-left',
                command: (menuEvent) => this.openCompareFromMenu(menuEvent)
            }
        ];
        this.extraMenu.toggle(event);
    }

    private openCompareFromMenu(menuEvent: MenuItemCommandEvent) {
        this.refreshCompareOptions();
        const originalEvent = menuEvent.originalEvent as MouseEvent | undefined;
        const target = this.lastExtraMenuTarget;
        if (target) {
            this.comparePopover.show(originalEvent ?? null, target);
        } else if (originalEvent) {
            originalEvent.stopPropagation();
            this.refreshCompareOptions();
            this.comparePopover.toggle(originalEvent);
        }
    }

    protected refreshCompareOptions() {
        this.compareOptions = this.stateService.buildCompareOptions(this.mapService.selectionTopic.getValue(), this.panel().id);
        this.selectedCompareIds = this.selectedCompareIds.filter(id =>
            this.compareOptions.some(option => option.value === id)
        );
    }

    protected applyComparison(event: MouseEvent) {
        event.stopPropagation();
        if (!this.selectedCompareIds.length) {
            return;
        }
        const model = this.stateService.createComparisonModel(
            this.panel().id,
            this.selectedCompareIds,
            this.mapService.selectionTopic.getValue()
        );
        if (!model) {
            return;
        }
        this.stateService.openInspectionComparison(model);
        this.selectedCompareIds = [];
        this.comparePopover.hide();
    }

    protected onDialogShow() {
        this.dockElement = document.querySelector('.collapsible-dock') as HTMLElement | null ?? undefined;
        this.dialogStack.bringToFront(this.dialog);
        this.bindDialogFocus();
        this.bindDockDragCue();
        this.applyInitialPosition();
    }

    protected onDialogDragEnd() {
        this.endDrag();
        if (this.shouldDock()) {
            this.stateService.setInspectionPanelUndockedState(this.panel().id, false);
        }
        this.storeDialogPosition();
        this.clearDockCue();
        this.dialogStack.bringToFront(this.dialog);
    }

    protected onDialogResizeEnd() {
        const panel = this.panel();
        const container = this.dialog?.container;
        if (!panel || !container || !container.offsetWidth || !container.offsetHeight) {
            return;
        }
        const baseFontSize = this.stateService.baseFontSize;
        if (!baseFontSize) {
            return;
        }
        const currentEmWidth = container.offsetWidth / baseFontSize;
        const currentEmHeight = container.offsetHeight / baseFontSize;
        panel.size[0] = currentEmWidth;
        panel.size[1] = currentEmHeight;
        this.dialogStyle = this.buildDialogStyle(panel);
        this.stateService.setInspectionPanelSize(panel.id, [currentEmWidth, currentEmHeight]);
    }

    private buildDialogStyle(panel: InspectionPanelModel<FeatureWrapper>): { [key: string]: string } {
        const nextStyle: { [key: string]: string } = {
            width: `${panel.size[0]}em`,
            height: `${panel.size[1]}em`
        };
        const containerStyle = this.dialog?.container?.style;
        const currentLeft = containerStyle?.left || this.dialogStyle['left'];
        const currentTop = containerStyle?.top || this.dialogStyle['top'];
        const currentPosition = containerStyle?.position || this.dialogStyle['position'];
        const currentMargin = containerStyle?.margin || this.dialogStyle['margin'];
        if (currentLeft) {
            nextStyle['left'] = currentLeft;
        }
        if (currentTop) {
            nextStyle['top'] = currentTop;
        }
        if (currentPosition) {
            nextStyle['position'] = currentPosition;
        }
        if (currentMargin) {
            nextStyle['margin'] = currentMargin;
        }
        if (!nextStyle['left'] || !nextStyle['top']) {
            const stored = panel.inspectionDialogLayoutEntry?.position
                ?? this.stateService.getInspectionDialogLayoutEntry(panel.id)?.position;
            if (stored) {
                if (!nextStyle['left']) {
                    nextStyle['left'] = `${Math.round(stored.left)}px`;
                }
                if (!nextStyle['top']) {
                    nextStyle['top'] = `${Math.round(stored.top)}px`;
                }
                nextStyle['position'] = nextStyle['position'] ?? 'fixed';
                nextStyle['margin'] = nextStyle['margin'] ?? '0';
            }
        }
        return nextStyle;
    }

    ngOnDestroy() {
        this.endDrag();
        this.detachFocusListener?.();
        this.detachHeaderDownListener?.();
        this.detachDragMoveListener?.();
        this.detachDragUpListener?.();
        this.clearDockCue();
    }

    protected beginDrag(): void {
        this.featurePanel?.freezeTree();
        this.sourceDataPanel?.freezeTree();
        this.detachPointerUpListener?.();
        this.detachPointerUpListener = this.renderer.listen('window', 'pointerup', () => {
            this.endDrag();
        });
    }

    protected endDrag(): void {
        this.detachPointerUpListener?.();
        this.detachPointerUpListener = undefined;
        this.featurePanel?.unfreezeTree();
        this.sourceDataPanel?.unfreezeTree();
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
        const stored = this.panel().inspectionDialogLayoutEntry?.position
            ?? this.stateService.getInspectionDialogLayoutEntry(panelId)?.position;
        if (stored) {
            if (!this.dialog.container.style.left || !this.dialog.container.style.top) {
                this.setDialogPosition(stored.left, stored.top);
            }
            return;
        }
        const slotIndex = this.stateService.ensureInspectionDialogSlot(panelId, index);
        const rect = this.dialog.container.getBoundingClientRect();
        const offsetPx = this.stateService.baseFontSize;
        const offsetMultiplier = slotIndex + 1;
        const left = rect.left + offsetPx * offsetMultiplier;
        const top = rect.top + offsetPx * offsetMultiplier;
        this.setDialogPosition(left, top);
        this.stateService.setInspectionDialogPosition(panelId, {left, top}, index);
    }

    private storeDialogPosition() {
        if (!this.dialog?.container) {
            return;
        }
        const rect = this.dialog.container.getBoundingClientRect();
        this.stateService.setInspectionDialogPosition(this.panel().id, {left: rect.left, top: rect.top}, this.dialogIndex());
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
