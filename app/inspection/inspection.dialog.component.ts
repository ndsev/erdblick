import {Component, OnDestroy, Renderer2, ViewChild, effect, input} from "@angular/core";
import {Popover} from "primeng/popover";
import {MapInfoService} from "../mapdata/map-info.service";
import {InspectionSelectionService} from "./inspection-selection.service";
import {AppStateService, InspectionComparisonOption, InspectionPanelModel} from "../shared/appstate.service";
import {FeatureWrapper} from "../mapdata/features.model";
import {coreLib} from "../integrations/wasm";
import {DialogStackService} from "../shared/dialog-stack.service";
import {FeaturePanelComponent} from "./feature.panel.component";
import {SourceDataPanelComponent} from "./sourcedata.panel.component";
import {AppDialogComponent} from "../shared/app-dialog.component";
import type {AppSurfaceHeaderAction, AppSurfaceHeaderActionCommandEvent} from "../shared/app-surface-header.component";

@Component({
    selector: 'inspection-panel-dialog',
    template: `
        <app-dialog #dialog class="inspection-dialog" [modal]="false" [closable]="false" [visible]="true"
                  [style]="dialogStyle" [persistLayout]="true" [layoutId]="layoutId"
                  (onShow)="onDialogShow()" (onDragEnd)="onDialogDragEnd()" (onResizeEnd)="onDialogResizeEnd()"
                  (pointerdown)="focusPanel()" (focusin)="focusPanel()">
            <ng-template #header>
                @if (panel()) {
                    <app-surface-header [title]="title"
                                        [lockable]="true"
                                        [locked]="panel().locked"
                                        [featureTitle]="panel().sourceData === undefined"
                                        [focusable]="true"
                                        [focused]="panel().focused === true"
                                        [hasColorPicker]="panel().sourceData === undefined && panel().features.length > 0"
                                        [color]="panel().color"
                                        dockMode="dock"
                                        [sizeToggleVisible]="false"
                                        [dragEnabled]="true"
                                        [extraActions]="featureHeaderActions()"
                                        (colorChange)="onPanelColorChange($event)"
                                        (titleClick)="toggleLockedState($event)"
                                        (dockRequest)="dock($event)"
                                        (closeRequest)="unsetPanel()"
                                        (focusRequest)="focusPanel()"
                                        (dragPointerDown)="beginDrag()">
                        @if (isMetadata) {
                            <p-tag surfaceHeaderIndicator severity="info" value="META" [rounded]="true" />
                        } @else if (panel().sourceData !== undefined) {
                            <p-tag surfaceHeaderIndicator severity="success" value="DATA" [rounded]="true" />
                        }
                        @if (panel().sourceData !== undefined) {
                            <p-select surfaceHeaderAfterTitle class="source-layer-dropdown" [options]="layerMenuItems"
                                      [(ngModel)]="selectedLayerItem"
                                      (click)="onDropdownClick($event)" (mousedown)="onDropdownClick($event)"
                                      scrollHeight="20em" (ngModelChange)="onSelectedLayerItem()"
                                      optionLabel="label"
                                      optionDisabled="disabled"/>
                        }
                    </app-surface-header>
                }
            </ng-template>

            <ng-template #content>
                @if (panel()) {
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
                }
            </ng-template>
        </app-dialog>
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
    styles: [`
        .inspection-focus-indicator {
            align-items: center;
            border: 2px solid transparent;
            border-radius: 999px;
            display: inline-flex;
            justify-content: center;
            padding: 2px;
        }

        .inspection-focus-indicator-active {
            border-color: var(--p-primary-color, #2196f3);
        }
    `],
    standalone: false
})
/**
 * Hosts one undocked inspection panel dialog, including dock-drop cues, comparison actions,
 * and source-data layer switching.
 */
export class InspectionPanelDialogComponent implements OnDestroy {
    panel = input.required<InspectionPanelModel<FeatureWrapper>>();
    dialogIndex = input.required<number>();
    title = "";
    errorMessage: string = "";
    layoutId = '';
    dialogStyle: { [key: string]: string } = {};
    layerMenuItems: { label: string, disabled: boolean, command: () => void }[] = [];
    selectedLayerItem?: { label: string, disabled: boolean, command: () => void };
    compareOptions: InspectionComparisonOption[] = [];
    selectedCompareIds: number[] = [];
    isMetadata: boolean = false;

    @ViewChild('dialog') dialog?: AppDialogComponent;
    @ViewChild('comparePopover') comparePopover!: Popover;
    @ViewChild(FeaturePanelComponent) featurePanel?: FeaturePanelComponent;
    @ViewChild(SourceDataPanelComponent) sourceDataPanel?: SourceDataPanelComponent;

    private detachHeaderDownListener?: () => void;
    private detachDragMoveListener?: () => void;
    private detachDragUpListener?: () => void;
    private detachPointerUpListener?: () => void;
    private dockElement?: HTMLElement;

    /** Wires dialog state to the active inspection panel and floating-dialog helpers. */
    constructor(private mapService: MapInfoService,
                private inspectionSelection: InspectionSelectionService,
                public stateService: AppStateService,
                private renderer: Renderer2,
                private dialogStack: DialogStackService) {
        effect(() => {
            const panel = this.panel();
            this.errorMessage = "";
            this.updateHeaderFor(panel);
            this.layoutId = `inspection:${panel.id}`;
            this.dialogStyle = this.buildDialogStyle(panel);
        });
    }

    /** Rebuilds the dialog title and source-data layer selector for the active panel content. */
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

    /** Returns from a nested selection back to the panel's top-level feature selection. */
    protected onGoBack(event: MouseEvent) {
        event.stopPropagation();
        const p = this.panel();
        if (p.features.length) {
            this.title = p.features.length > 1 ? `Selected ${p.features.length} features` : p.features[0].featureId;
        }
        this.errorMessage = "";
        this.stateService.setSelection(p.features, p.id);
    }

    /** Applies the currently selected source-data layer menu entry. */
    protected onSelectedLayerItem() {
        if (this.selectedLayerItem && !this.selectedLayerItem.disabled) {
            this.selectedLayerItem.command();
        }
    }

    /** Stops header click handling when interacting with the layer dropdown. */
    protected onDropdownClick(event: MouseEvent) {
        event.stopPropagation();
    }

    /** Displays source-data rendering errors in the dialog body. */
    protected onSourceDataError(errorMessage: string) {
        this.errorMessage = errorMessage;
        console.error("Error while processing SourceData tree:", errorMessage);
    }

    /** Toggles whether the panel survives global deselection. */
    protected toggleLockedState(event: MouseEvent) {
        event.stopPropagation();
        const p = this.panel();
        this.stateService.setInspectionPanelLockedState(p.id, !p.locked);
    }

    /** Marks this floating dialog as the active target for inspection shortcuts. */
    protected focusPanel() {
        this.stateService.setFocusedInspectionPanel(this.panel().id);
    }

    /** Persists the highlight color selected from the shared surface header. */
    protected onPanelColorChange(color: string) {
        const panel = this.panel();
        panel.color = color;
        this.stateService.setInspectionPanelColor(panel.id, color);
    }

    /** Closes and removes the inspection panel entirely. */
    protected unsetPanel() {
        this.stateService.unsetPanel(this.panel().id);
    }

    /** Zooms the map to the primary feature represented by the panel. */
    private focusOnFeature(event?: MouseEvent) {
        event?.stopPropagation();
        const panel = this.panel();
        if (!panel.features.length) {
            return;
        }
        this.inspectionSelection.zoomToFeature(undefined, panel.features[0]);
    }

    /** Menu/header action wrapper for focusing the primary feature. */
    protected focusOnFeatureAction(event: MouseEvent) {
        this.focusOnFeature(event);
    }

    /** Opens the panel's GeoJSON export in a new browser tab. */
    protected openGeoJsonInNewTabAction(event: MouseEvent) {
        event.stopPropagation();
        this.featurePanel?.openGeoJsonInNewTab();
    }

    /** Downloads the panel's GeoJSON export. */
    protected downloadGeoJsonAction(event: MouseEvent) {
        event.stopPropagation();
        this.featurePanel?.downloadGeoJson();
    }

    /** Copies the panel's GeoJSON export to the clipboard. */
    protected copyGeoJsonAction(event: MouseEvent) {
        event.stopPropagation();
        this.featurePanel?.copyGeoJson();
    }

    /** Extra feature actions rendered and collapsed by the shared surface header. */
    protected featureHeaderActions(): AppSurfaceHeaderAction[] {
        const panel = this.panel();
        if (panel.sourceData !== undefined || panel.features.length === 0) {
            return [];
        }
        return [
            {
                label: 'Focus on feature',
                tooltip: 'Focus on feature',
                materialIcon: 'my_location',
                menuIcon: 'pi pi-bullseye',
                command: event => this.focusOnFeatureAction(event.originalEvent)
            },
            {
                label: 'Open GeoJSON in new tab',
                tooltip: 'Open GeoJSON in new tab',
                materialIcon: 'open_in_new',
                menuIcon: 'pi pi-external-link',
                command: event => this.openGeoJsonInNewTabAction(event.originalEvent)
            },
            {
                label: 'Download GeoJSON',
                tooltip: 'Download GeoJSON',
                materialIcon: 'download',
                menuIcon: 'pi pi-download',
                command: event => this.downloadGeoJsonAction(event.originalEvent)
            },
            {
                label: 'Copy GeoJSON',
                tooltip: 'Copy GeoJSON',
                materialIcon: 'content_copy',
                menuIcon: 'pi pi-copy',
                command: event => this.copyGeoJsonAction(event.originalEvent)
            },
            {
                label: 'Compare',
                tooltip: 'Compare',
                materialIcon: 'compare_arrows',
                menuIcon: 'pi pi-arrow-right-arrow-left',
                command: event => this.openCompareAction(event)
            }
        ];
    }

    /** Re-docks the floating inspection panel into the dock area. */
    protected dock(event: MouseEvent) {
        event.stopPropagation();
        this.stateService.setInspectionPanelUndockedState(this.panel().id, false);
    }

    /** Opens the compare popover from either an inline action or the collapsed action menu. */
    private openCompareAction(actionEvent: AppSurfaceHeaderActionCommandEvent) {
        this.refreshCompareOptions();
        if (actionEvent.source === 'menu') {
            this.comparePopover.show(actionEvent.originalEvent, actionEvent.anchor);
            return;
        }
        this.comparePopover.toggle(actionEvent.originalEvent);
    }

    /** Rebuilds valid comparison targets for the current selection context. */
    protected refreshCompareOptions() {
        this.compareOptions = this.stateService.buildCompareOptions(this.inspectionSelection.selectionTopic.getValue(), this.panel().id);
        this.selectedCompareIds = this.selectedCompareIds.filter(id =>
            this.compareOptions.some(option => option.value === id)
        );
    }

    /** Opens the comparison dialog for the currently checked comparison targets. */
    protected applyComparison(event: MouseEvent) {
        event.stopPropagation();
        if (!this.selectedCompareIds.length) {
            return;
        }
        const model = this.stateService.createComparisonModel(
            this.panel().id,
            this.selectedCompareIds,
            this.inspectionSelection.selectionTopic.getValue()
        );
        if (!model) {
            return;
        }
        this.stateService.openInspectionComparison(model);
        this.selectedCompareIds = [];
        this.comparePopover.hide();
    }

    /** Restores persisted layout state and wires dock-drag cues when the dialog opens. */
    protected onDialogShow() {
        this.focusPanel();
        this.dockElement = document.querySelector('.collapsible-dock') as HTMLElement | null ?? undefined;
        this.dialogStack.bringToFront(this.dialog);
        this.bindDockDragCue();
        const panel = this.panel();
        const layout = this.stateService.ensureInspectionDialogLayout(
            panel.id,
            this.dialogIndex(),
            () => {
                const container = this.getDialogContainer();
                if (!container) {
                    const baseFontSize = this.stateService.baseFontSize;
                    return {
                        position: {left: 0, top: 0},
                        size: {
                            width: Math.round(panel.size[0] * baseFontSize),
                            height: Math.round(panel.size[1] * baseFontSize)
                        }
                    };
                }
                const rect = container.getBoundingClientRect();
                return {
                    position: {left: Math.round(rect.left), top: Math.round(rect.top)},
                    size: {width: Math.round(rect.width), height: Math.round(rect.height)}
                };
            }
        );
        const baseFontSize = this.stateService.baseFontSize;
        if (baseFontSize) {
            const widthEm = layout.size.width / baseFontSize;
            const heightEm = layout.size.height / baseFontSize;
            panel.size[0] = widthEm;
            panel.size[1] = heightEm;
            this.dialogStyle = this.buildDialogStyle(panel);
            this.stateService.setInspectionPanelSize(panel.id, [widthEm, heightEm]);
        }
        setTimeout(() => this.featurePanel?.refresh(), 0);
    }

    /** Finalizes floating drag state and docks when the dialog overlaps the dock area enough. */
    protected onDialogDragEnd() {
        this.endDrag();
        if (this.shouldDock()) {
            this.stateService.setInspectionPanelUndockedState(this.panel().id, false);
        }
        this.clearDockCue();
        this.dialogStack.bringToFront(this.dialog);
    }

    /** Persists the dialog size after user-driven resize. */
    protected onDialogResizeEnd() {
        const panel = this.panel();
        const container = this.getDialogContainer();
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

    /** Converts panel size in em units into the dialog style object expected by PrimeNG. */
    private buildDialogStyle(panel: InspectionPanelModel<FeatureWrapper>): { [key: string]: string } {
        return {
            width: `${panel.size[0]}em`,
            height: `${panel.size[1]}em`
        };
    }

    /** Tears down drag listeners and temporary dock cues owned by the dialog. */
    ngOnDestroy() {
        this.endDrag();
        this.detachHeaderDownListener?.();
        this.detachDragMoveListener?.();
        this.detachDragUpListener?.();
        this.clearDockCue();
    }

    /** Freezes expensive inspection trees while the floating dialog is being dragged. */
    protected beginDrag(): void {
        this.focusPanel();
        this.featurePanel?.freezeTree();
        this.sourceDataPanel?.freezeTree();
        this.detachPointerUpListener?.();
        this.detachPointerUpListener = this.renderer.listen('window', 'pointerup', () => {
            this.endDrag();
        });
    }

    /** Unfreezes inspection trees and clears transient pointer listeners after dragging. */
    protected endDrag(): void {
        this.detachPointerUpListener?.();
        this.detachPointerUpListener = undefined;
        this.featurePanel?.unfreezeTree();
        this.sourceDataPanel?.unfreezeTree();
    }

    /** Attaches mouse listeners that highlight the dock when the dialog can be dropped there. */
    private bindDockDragCue() {
        const container = this.getDialogContainer();
        if (!container) {
            return;
        }
        const header = container.querySelector('.p-dialog-header');
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

    /** Returns whether the current floating dialog position should snap back into the dock. */
    private shouldDock(): boolean {
        if (!this.getDialogContainer() || !this.dockElement) {
            return false;
        }
        const overlap = this.getDockOverlap();
        if (!overlap) {
            return false;
        }
        const threshold = this.stateService.baseFontSize * 2;
        return overlap.width >= threshold && overlap.height > 0;
    }

    /** Updates the dock highlight based on the current drag overlap. */
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

    /** Computes the overlap area between the floating dialog and the dock container. */
    private getDockOverlap(): {width: number, height: number} | undefined {
        const container = this.getDialogContainer();
        if (!container || !this.dockElement) {
            return;
        }
        const dialogRect = container.getBoundingClientRect();
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

    /** Adds or removes the CSS cue that marks the dock as a drag target. */
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

    /** Clears any active dock highlight cue. */
    private clearDockCue() {
        this.setDockCue(false);
    }

    /** Returns the rendered PrimeNG dialog container, if present. */
    private getDialogContainer(): HTMLElement | undefined {
        return this.dialog?.container() ?? undefined;
    }
}
