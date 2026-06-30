import {Component, input, output, ViewChild, effect} from "@angular/core";
import {Popover} from "primeng/popover";
import {
    AppStateService,
    InspectionComparisonOption,
    InspectionPanelModel
} from "../shared/appstate.service";
import {MapInfoService} from "../mapdata/map-info.service";
import {InspectionSelectionService} from "./inspection-selection.service";
import {FeatureWrapper} from "../mapdata/features.model";
import {coreLib} from "../integrations/wasm";
import {FeaturePanelComponent} from "./feature.panel.component";
import {SourceDataPanelComponent} from "./sourcedata.panel.component";
import type {AppSurfaceHeaderAction, AppSurfaceHeaderActionCommandEvent} from "../shared/app-surface-header.component";
import {displayFeatureId} from "../shared/tile-feature-id";
import {AppPanelComponent} from "../shared/app-panel.component";

/** Select option for switching between source-data layers within one inspected tile. */
interface SourceLayerMenuItem {
    label: string,
    disabled: boolean,
    command: () => void
}

/** Shared surface implemented by feature and source-data panel bodies for dock sizing logic. */
interface InspectionPanelContentAdapter {
    measurePreferredHeightEm: () => number | undefined;
    refreshLayout: () => void;
}

@Component({
    selector: 'inspection-panel',
    template: `
        <app-panel class="inspect-panel" styleClass="inspect-panel" data-testid="inspection-panel"
                   #inspectionAppPanel
                   [layoutId]="inspectionPanelLayoutId()"
                   [persistLayout]="true"
                   [collapsed]="accordionValue !== '0'"
                   (collapsedChange)="accordionValue = $event ? null : '0'"
                   [dockedPanelCount]="dockedPanelCount()"
                   [expanded]="isExpanded"
                   (expandedChange)="isExpanded = $event"
                   [preferredBodyHeightEm]="measurePreferredPanelHeightEm"
                   [transitionOptions]="accordionTransitionOptions"
                   (bodySizeChange)="refreshPanelContentLayout()"
                   (focusRequest)="focusPanel()">
            <ng-template #header>
                    <app-surface-header [title]="title"
                                        [lockable]="true"
                                        [locked]="panel().locked"
                                        [featureTitle]="panel().sourceData === undefined"
                                        [focusable]="true"
                                        [focused]="panel().focused === true"
                                        [hasSmartControl]="panel().sourceData === undefined && panel().features.length > 0"
                                        dockMode="undock"
                                        [expanded]="isExpanded"
                                        [sizeToggleVisible]="true"
                                        [sizeToggleDisabled]="!showDockAutoSizeToggle()"
                                        [dragEnabled]="true"
                                        [extraActions]="featureHeaderActions()"
                                        (titleClick)="toggleLockedState($event)"
                                        (dockRequest)="undock($event)"
                                        (sizeToggleRequest)="toggleDockAutoSize($event)"
                                        (closeRequest)="unsetPanel()"
                                        (focusRequest)="focusPanel()"
                                        (dragPointerDown)="onHeaderPointerDown($event)">
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
                                      appendTo="body"
                                      [overlayOptions]="sourceLayerDropdownOverlayOptions"
                                      optionLabel="label"
                                      optionDisabled="disabled"/>
                        } @else if (panel().features.length > 0) {
                            <p-colorpicker surfaceHeaderSmartControl
                                           [ngModel]="panel().color"
                                           appendTo="body"
                                           [overlayOptions]="{autoZIndex: true, baseZIndex: 9500}"
                                           (click)="$event.stopPropagation()"
                                           (mousedown)="$event.stopPropagation()"
                                           (ngModelChange)="onPanelColorChange($event)">
                            </p-colorpicker>
                        }
                    </app-surface-header>
            </ng-template>

            <ng-template #content>
                    <div class="resizable-container">
                        @if (errorMessage) {
                            <div>
                                <strong>Error</strong><br>{{ errorMessage }}
                            </div>
                        } @else if (panel().sourceData) {
                            <sourcedata-panel [panel]="panel()"
                                              [showFilter]="false"
                                              [filterText]="filterText()"
                                              (filterTextChange)="filterTextChange.emit($event)"
                                              (errorOccurred)="onSourceDataError($event)"></sourcedata-panel>
                        } @else {
                            <feature-panel [panel]="panel()"
                                           [showFilter]="false"
                                           [filterText]="filterText()"
                                           (filterTextChange)="filterTextChange.emit($event)">
                            </feature-panel>
                        }
                    </div>
            </ng-template>
        </app-panel>
        <p-popover #comparePopover [baseZIndex]="30000">
            <div class="comparison-popover">
                <div style="display: flex; flex-direction: row; align-content: center; gap: 0.25em">
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
    standalone: false
})
/** Docked accordion variant of an inspection panel. */
export class InspectionPanelComponent {
    title = "";
    isExpanded: boolean = false;
    errorMessage: string = "";

    layerMenuItems: SourceLayerMenuItem[] = [];
    selectedLayerItem?: SourceLayerMenuItem;
    compareOptions: InspectionComparisonOption[] = [];
    selectedCompareIds: number[] = [];
    protected readonly sourceLayerDropdownOverlayOptions = {autoZIndex: true, baseZIndex: 30000};

    panel = input.required<InspectionPanelModel<FeatureWrapper>>();
    dockedPanelCount = input<number>(0);
    filterText = input<string | undefined>();
    filterTextChange = output<string>();
    ejectedPanel = output<InspectionPanelModel<FeatureWrapper>>();
    panelDragRequest = output<{panel: InspectionPanelModel<FeatureWrapper>, event: PointerEvent}>();
    accordionValue: string | null = '0';
    readonly accordionTransitionOptions = '320ms cubic-bezier(0.22, 1, 0.36, 1)';

    @ViewChild('inspectionAppPanel') inspectionAppPanel?: AppPanelComponent;
    @ViewChild('comparePopover') comparePopover!: Popover;
    @ViewChild(FeaturePanelComponent) featurePanel?: FeaturePanelComponent;
    @ViewChild(SourceDataPanelComponent) sourceDataPanel?: SourceDataPanelComponent;
    isMetadata: boolean = false;
    protected readonly measurePreferredPanelHeightEm = () => this.getPanelContentAdapter()?.measurePreferredHeightEm();

    constructor(private mapService: MapInfoService,
                private inspectionSelection: InspectionSelectionService,
                public stateService: AppStateService) {
        effect(() => {
            this.title = "";
            this.errorMessage = "";
            const panel = this.panel();
            if (panel.sourceData !== undefined) {
                const selection = panel.sourceData!;
                const [mapId, layerId, tileId] = coreLib.parseMapTileKey(selection.mapTileKey);
                this.isMetadata = tileId === 0n;
                this.title = this.isMetadata ? `${mapId}:` : `${tileId}.`;
                const map = this.mapService.maps.maps.get(mapId);
                if (map) {
                    this.layerMenuItems = Array.from(map.layers.values())
                        .filter(item => item.type === "SourceData")
                        .filter(item => {
                            return (item.id.startsWith("SourceData") && !this.isMetadata) ||
                                (item.id.startsWith("Metadata") && this.isMetadata);
                        })
                        .map(item => {
                            return {
                                label: this.mapService.layerNameForSourceDataLayerId(
                                    item.id,
                                    item.id.startsWith("Metadata")
                                ),
                                disabled: item.id === layerId,
                                command: () => {
                                    let sourceData = {...selection};
                                    sourceData.mapTileKey = coreLib.getSourceDataLayerKey(mapId, item.id, tileId);
                                    sourceData.address = undefined;
                                    this.stateService.setSelection(sourceData, this.panel().id);
                                },
                            } as SourceLayerMenuItem;
                        }).sort((a, b) => a.label.localeCompare(b.label));
                    this.selectedLayerItem = this.layerMenuItems.filter(item => item.disabled).pop();
                } else {
                    this.layerMenuItems = [];
                    this.title = "";
                    this.selectedLayerItem = undefined;
                }
            } else {
                this.title = panel.features.length > 1 ?
                    `Selected ${panel.features.length} features` :
                    displayFeatureId(panel.features[0].featureId);
                this.layerMenuItems = [];
                this.selectedLayerItem = undefined;
            }
        });
    }

    /** Applies the currently selected source-data layer switch. */
    protected onSelectedLayerItem() {
        if (this.selectedLayerItem && !this.selectedLayerItem.disabled) {
            this.selectedLayerItem.command();
        }
    }

    /** Stops header interaction propagation while using the source-data layer dropdown. */
    protected onDropdownClick(event: MouseEvent) {
        event.stopPropagation();
    }

    /** Surfaces source-data loading failures inline inside the docked panel. */
    protected onSourceDataError(errorMessage: string) {
        this.errorMessage = errorMessage;
        console.error("Error while processing SourceData tree:", errorMessage);
    }

    /** Toggles whether the panel can be replaced by future selection changes. */
    protected toggleLockedState(event: MouseEvent) {
        event.stopPropagation();
        const p = this.panel();
        this.stateService.setInspectionPanelLockedState(p.id, !p.locked);
    }

    /** Marks this docked panel as the active target for inspection shortcuts. */
    protected focusPanel() {
        this.stateService.setFocusedInspectionPanel(this.panel().id);
    }

    /** Persists the highlight color selected from the shared surface header. */
    protected onPanelColorChange(color: string) {
        const panel = this.panel();
        panel.color = color;
        this.stateService.setInspectionPanelColor(panel.id, color);
    }

    /** Removes this docked inspection panel from the selection set. */
    protected unsetPanel() {
        this.stateService.unsetPanel(this.panel().id);
    }

    /** Moves the panel into a floating dialog. */
    protected undock(event: MouseEvent) {
        event.stopPropagation();
        this.ejectedPanel.emit(this.panel());
    }

    protected showDockAutoSizeToggle(): boolean {
        const panel = this.panel();
        return !panel.undocked && this.dockedPanelCount() > 1;
    }

    /** Switches between default dock height and content-fit height for this panel. */
    protected toggleDockAutoSize(event: MouseEvent) {
        event.stopPropagation();
        if (!this.showDockAutoSizeToggle()) {
            return;
        }
        this.inspectionAppPanel?.toggleExpanded();
    }

    /** Moves the camera to the first feature represented by this panel. */
    private focusOnFeature(event?: MouseEvent) {
        event?.stopPropagation();
        const panel = this.panel();
        if (!panel.features.length) {
            return;
        }
        this.inspectionSelection.zoomToFeature(this.stateService.focusedView, panel.features[0]);
    }

    /** UI wrapper around the focus action for toolbar buttons and menus. */
    protected focusOnFeatureAction(event: MouseEvent) {
        this.focusOnFeature(event);
    }

    /** Opens the feature GeoJSON in a separate browser tab. */
    protected openGeoJsonInNewTabAction(event: MouseEvent) {
        event.stopPropagation();
        this.featurePanel?.openGeoJsonInNewTab();
    }

    /** Starts a GeoJSON download for the current feature selection. */
    protected downloadGeoJsonAction(event: MouseEvent) {
        event.stopPropagation();
        this.featurePanel?.downloadGeoJson();
    }

    /** Copies the current feature GeoJSON to the clipboard. */
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

    /** Starts a dock drag request when the user drags the panel header. */
    protected onHeaderPointerDown(event: PointerEvent) {
        this.focusPanel();
        if (event.button !== 0) {
            return;
        }
        const target = event.target as HTMLElement | null;
        if (this.isInteractiveTarget(target)) {
            return;
        }
        this.panelDragRequest.emit({panel: this.panel(), event});
    }

    /** Checks whether an event target should keep its own pointer behavior. */
    private isInteractiveTarget(target: HTMLElement | null): boolean {
        if (!target) {
            return false;
        }
        if (target.closest('.app-surface-header-title')) {
            return false;
        }
        return !!target.closest(
            'button, .p-button, .p-colorpicker, .p-select, .p-dropdown, .p-multiselect, input, textarea, select, option, a'
        );
    }

    /** Refreshes whichever content component is currently mounted inside the panel body. */
    protected refreshPanelContentLayout() {
        const refresh = () => this.getPanelContentAdapter()?.refreshLayout();
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => refresh());
        });
    }

    private getPanelContentAdapter(): InspectionPanelContentAdapter | undefined {
        return this.panel().sourceData !== undefined ? this.sourceDataPanel : this.featurePanel;
    }

    protected inspectionPanelLayoutId(): string {
        return `inspection:${this.panel().id}`;
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

    /** Refreshes compare candidates and drops ids that are no longer valid. */
    protected refreshCompareOptions() {
        this.compareOptions = this.stateService.buildCompareOptions(this.inspectionSelection.selectionTopic.getValue(), this.panel().id);
        this.selectedCompareIds = this.selectedCompareIds.filter(id =>
            this.compareOptions.some(option => option.value === id)
        );
    }

    /** Opens the comparison dialog with this docked panel as the base entry. */
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

}
