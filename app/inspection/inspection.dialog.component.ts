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
                        <span class="title-container" [class.feature]="panel().sourceData === undefined">
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
                                 tooltipPosition="bottom"
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
                                <span class="inspection-feature-tools-inline">
                                    <p-button icon="" (click)="focusOnFeatureAction($event)"
                                              (mousedown)="$event.stopPropagation()"
                                              pTooltip="Focus on feature" tooltipPosition="bottom">
                                        <span class="material-symbols-outlined"
                                              style="font-size: 1.2em; margin: 0 auto;">my_location</span>
                                    </p-button>
                                    <p-button icon="" (click)="openGeoJsonInNewTabAction($event)"
                                              (mousedown)="$event.stopPropagation()"
                                              pTooltip="Open GeoJSON in new tab" tooltipPosition="bottom">
                                        <span class="material-symbols-outlined"
                                              style="font-size: 1.2em; margin: 0 auto;">open_in_new</span>
                                    </p-button>
                                    <p-button icon="" (click)="downloadGeoJsonAction($event)"
                                              (mousedown)="$event.stopPropagation()"
                                              pTooltip="Download GeoJSON" tooltipPosition="bottom">
                                        <span class="material-symbols-outlined"
                                              style="font-size: 1.2em; margin: 0 auto;">download</span>
                                    </p-button>
                                    <p-button icon="" (click)="copyGeoJsonAction($event)"
                                              (mousedown)="$event.stopPropagation()"
                                              pTooltip="Copy GeoJSON" tooltipPosition="bottom">
                                        <span class="material-symbols-outlined"
                                              style="font-size: 1.2em; margin: 0 auto;">content_copy</span>
                                    </p-button>
                                    <p-button icon="" (click)="openComparePopover($event)"
                                              (mousedown)="$event.stopPropagation()"
                                              pTooltip="Compare" tooltipPosition="bottom">
                                        <span class="material-symbols-outlined"
                                              style="font-size: 1.2em; margin: 0 auto;">compare_arrows</span>
                                    </p-button>
                                </span>
                                <p-button class="inspection-feature-tools-menu" icon="" (click)="openExtraMenu($event)"
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
/** Floating dialog wrapper for one undocked inspection panel. */
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
            this.errorMessage = "";
            this.updateHeaderFor(panel);
            this.dialogStyle = this.buildDialogStyle(panel);
        });
    }

    /** Derives the title and source-data layer switcher state from the current panel payload. */
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

    /** Returns from source-data inspection to the panel's feature selection. */
    protected onGoBack(event: MouseEvent) {
        event.stopPropagation();
        const p = this.panel();
        if (p.features.length) {
            this.title = p.features.length > 1 ? `Selected ${p.features.length} features` : p.features[0].featureId;
        }
        this.errorMessage = "";
        this.stateService.setSelection(p.features, p.id);
    }

    /** Applies the currently chosen source-data layer switch. */
    protected onSelectedLayerItem() {
        if (this.selectedLayerItem && !this.selectedLayerItem.disabled) {
            this.selectedLayerItem.command();
        }
    }

    /** Stops header click propagation so opening the dropdown does not trigger drag or accordion actions. */
    protected onDropdownClick(event: MouseEvent) {
        event.stopPropagation();
    }

    /** Surfaces source-data loading failures in the dialog body. */
    protected onSourceDataError(errorMessage: string) {
        this.errorMessage = errorMessage;
        console.error("Error while processing SourceData tree:", errorMessage);
    }

    /** Toggles whether this inspection panel is pinned against selection replacement. */
    protected toggleLockedState(event: MouseEvent) {
        event.stopPropagation();
        const p = this.panel();
        this.stateService.setInspectionPanelLockedState(p.id, !p.locked);
    }

    /** Closes the floating inspection panel. */
    protected unsetPanel() {
        this.stateService.unsetPanel(this.panel().id);
    }

    /** Moves the camera to the first feature represented by this dialog. */
    private focusOnFeature(event?: MouseEvent) {
        event?.stopPropagation();
        const panel = this.panel();
        if (!panel.features.length) {
            return;
        }
        this.mapService.zoomToFeature(undefined, panel.features[0]);
    }

    /** UI wrapper around the focus action for toolbar buttons and menus. */
    protected focusOnFeatureAction(event: MouseEvent) {
        this.focusOnFeature(event);
    }

    /** Opens the selected feature GeoJSON in a separate browser tab. */
    protected openGeoJsonInNewTabAction(event: MouseEvent) {
        event.stopPropagation();
        this.featurePanel?.openGeoJsonInNewTab();
    }

    /** Starts a GeoJSON download for the feature panel content. */
    protected downloadGeoJsonAction(event: MouseEvent) {
        event.stopPropagation();
        this.featurePanel?.downloadGeoJson();
    }

    /** Copies the current feature GeoJSON to the clipboard. */
    protected copyGeoJsonAction(event: MouseEvent) {
        event.stopPropagation();
        this.featurePanel?.copyGeoJson();
    }

    /** Opens the compare popover anchored to the toolbar button. */
    protected openComparePopover(event: MouseEvent) {
        event.stopPropagation();
        this.refreshCompareOptions();
        this.comparePopover.toggle(event);
    }

    /** Moves the floating dialog back into the docked inspection area. */
    protected dock(event: MouseEvent) {
        event.stopPropagation();
        this.stateService.setInspectionPanelUndockedState(this.panel().id, false);
    }

    /** Opens the overflow menu used on compact dialog widths. */
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

    /** Reanchors the compare popover when it is launched from the overflow menu. */
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

    /** Refreshes compare candidates and removes selections that are no longer valid. */
    protected refreshCompareOptions() {
        this.compareOptions = this.stateService.buildCompareOptions(this.mapService.selectionTopic.getValue(), this.panel().id);
        this.selectedCompareIds = this.selectedCompareIds.filter(id =>
            this.compareOptions.some(option => option.value === id)
        );
    }

    /** Opens the comparison dialog with this panel as the base column. */
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

    /** Initializes z-order, docking cues, and first-render layout once PrimeNG shows the dialog. */
    protected onDialogShow() {
        this.dockElement = document.querySelector('.collapsible-dock') as HTMLElement | null ?? undefined;
        this.dialogStack.bringToFront(this.dialog);
        this.bindDockDragCue();
        this.applyInitialPosition();
        setTimeout(() => this.featurePanel?.refresh(), 0);
    }

    /** Stores the final dialog position and docks automatically when released over the dock. */
    protected onDialogDragEnd() {
        this.endDrag();
        if (this.shouldDock()) {
            this.stateService.setInspectionPanelUndockedState(this.panel().id, false);
        }
        this.storeDialogPosition();
        this.clearDockCue();
        this.dialogStack.bringToFront(this.dialog);
    }

    /** Persists the dialog size back into app state in em units. */
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

    /** Rebuilds the PrimeNG dialog style map while preserving any already-applied runtime position. */
    private buildDialogStyle(panel: InspectionPanelModel<FeatureWrapper>): { [key: string]: string } {
        const nextStyle: { [key: string]: string } = {
            width: `${panel.size[0]}em`,
            height: `${panel.size[1]}em`
        };
        const containerStyle = this.getDialogContainer()?.style;
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

    /** Removes transient drag listeners and dock highlight state. */
    ngOnDestroy() {
        this.endDrag();
        this.detachHeaderDownListener?.();
        this.detachDragMoveListener?.();
        this.detachDragUpListener?.();
        this.clearDockCue();
    }

    /** Freezes heavy tree components while the dialog is being dragged. */
    protected beginDrag(): void {
        this.featurePanel?.freezeTree();
        this.sourceDataPanel?.freezeTree();
        this.detachPointerUpListener?.();
        this.detachPointerUpListener = this.renderer.listen('window', 'pointerup', () => {
            this.endDrag();
        });
    }

    /** Clears drag listeners and unfreezes the embedded inspection tree. */
    protected endDrag(): void {
        this.detachPointerUpListener?.();
        this.detachPointerUpListener = undefined;
        this.featurePanel?.unfreezeTree();
        this.sourceDataPanel?.unfreezeTree();
    }

    /** Hooks PrimeNG drag events so the dock can be highlighted while the dialog overlaps it. */
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

    /** Restores the persisted dialog position or assigns the next cascade slot for a fresh dialog. */
    private applyInitialPosition() {
        const container = this.getDialogContainer();
        if (!container) {
            return;
        }
        const index = this.dialogIndex();
        const panelId = this.panel().id;
        const stored = this.panel().inspectionDialogLayoutEntry?.position
            ?? this.stateService.getInspectionDialogLayoutEntry(panelId)?.position;
        if (stored) {
            if (!container.style.left || !container.style.top) {
                this.setDialogPosition(stored.left, stored.top);
            }
            return;
        }
        const slotIndex = this.stateService.ensureInspectionDialogSlot(panelId, index);
        const rect = container.getBoundingClientRect();
        const offsetPx = this.stateService.baseFontSize;
        const offsetMultiplier = slotIndex + 1;
        const left = rect.left + offsetPx * offsetMultiplier;
        const top = rect.top + offsetPx * offsetMultiplier;
        this.setDialogPosition(left, top);
        this.stateService.setInspectionDialogPosition(panelId, {left, top}, index);
    }

    /** Persists the dialog's current viewport position in app state. */
    private storeDialogPosition() {
        const container = this.getDialogContainer();
        if (!container) {
            return;
        }
        const rect = container.getBoundingClientRect();
        this.stateService.setInspectionDialogPosition(this.panel().id, {left: rect.left, top: rect.top}, this.dialogIndex());
    }

    /** Writes an absolute fixed-position placement directly to the rendered dialog container. */
    private setDialogPosition(left: number, top: number) {
        const container = this.getDialogContainer();
        if (!container) {
            return;
        }
        container.style.position = 'fixed';
        container.style.left = `${Math.round(left)}px`;
        container.style.top = `${Math.round(top)}px`;
        container.style.margin = '0';
    }

    /** Returns whether the dialog overlaps the dock enough to trigger auto-docking on drop. */
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

    /** Updates the dock highlight while PrimeNG is dragging the dialog. */
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

    /** Computes the current rectangle overlap between the dialog and the dock. */
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

    /** Applies or clears the CSS class used to visualize a dock target. */
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

    /** Removes any active dock target highlight. */
    private clearDockCue() {
        this.setDockCue(false);
    }

    /** Returns the actual PrimeNG dialog container element when it has been created. */
    private getDialogContainer(): HTMLElement | undefined {
        return this.dialog?.container() ?? undefined;
    }
}
