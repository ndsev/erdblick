import {AfterViewInit, Component, ElementRef, input, OnDestroy, output, Renderer2, ViewChild, effect} from "@angular/core";
import {Popover} from "primeng/popover";
import {
    AppStateService,
    DEFAULT_DOCKED_EM_HEIGHT,
    DEFAULT_EM_WIDTH,
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
                   [collapsed]="accordionValue !== '0'"
                   (collapsedChange)="accordionValue = $event ? null : '0'"
                   [dockedPanelCount]="dockedPanelCount()"
                   [expanded]="isExpanded"
                   [transitionOptions]="accordionTransitionOptions"
                   (focusRequest)="focusPanel()">
            <ng-template #header>
                    <app-surface-header [title]="title"
                                        [lockable]="true"
                                        [locked]="panel().locked"
                                        [featureTitle]="panel().sourceData === undefined"
                                        [focusable]="true"
                                        [focused]="panel().focused === true"
                                        [hasColorPicker]="panel().sourceData === undefined && panel().features.length > 0"
                                        [color]="panel().color"
                                        dockMode="undock"
                                        [expanded]="isExpanded"
                                        [sizeToggleVisible]="true"
                                        [sizeToggleDisabled]="!showDockAutoSizeToggle()"
                                        [dragEnabled]="true"
                                        [extraActions]="featureHeaderActions()"
                                        (colorChange)="onPanelColorChange($event)"
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
                                      optionLabel="label"
                                      optionDisabled="disabled"/>
                        }
                    </app-surface-header>
            </ng-template>

            <ng-template #content>
                    <div class="resizable-container" #resizeableContainer
                         [style.width.%]="100"
                         [style.height.em]="panel().size[1]"
                         (mouseup)="onInspectionContainerResize($event, panel())"
                         [ngClass]="{'resizable-container-expanded': isExpanded}">
                        <!--                        <div class="resize-handle" (click)="isExpanded = !isExpanded">-->
                        <!--                            <i *ngIf="!isExpanded" class="pi pi-chevron-up"></i>-->
                        <!--                            <i *ngIf="isExpanded" class="pi pi-chevron-down"></i>-->
                        <!--                        </div>-->
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
    styles: [`
        @media only screen and (max-width: 56em) {
            .resizable-container-expanded {
                height: calc(100vh - 3em);
            }
        }

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
/** Docked accordion variant of an inspection panel. */
export class InspectionPanelComponent implements AfterViewInit, OnDestroy {
    title = "";
    isExpanded: boolean = false;
    errorMessage: string = "";

    layerMenuItems: SourceLayerMenuItem[] = [];
    selectedLayerItem?: SourceLayerMenuItem;
    compareOptions: InspectionComparisonOption[] = [];
    selectedCompareIds: number[] = [];

    panel = input.required<InspectionPanelModel<FeatureWrapper>>();
    dockedPanelCount = input<number>(0);
    filterText = input<string | undefined>();
    filterTextChange = output<string>();
    ejectedPanel = output<InspectionPanelModel<FeatureWrapper>>();
    panelDragRequest = output<{panel: InspectionPanelModel<FeatureWrapper>, event: PointerEvent}>();
    accordionValue: string | null = '0';
    readonly accordionTransitionOptions = '320ms cubic-bezier(0.22, 1, 0.36, 1)';

    @ViewChild('resizeableContainer') resizeableContainer!: ElementRef;
    @ViewChild('comparePopover') comparePopover!: Popover;
    @ViewChild(FeaturePanelComponent) featurePanel?: FeaturePanelComponent;
    @ViewChild(SourceDataPanelComponent) sourceDataPanel?: SourceDataPanelComponent;
    private autoExpandRafFirst?: number;
    private autoExpandRafSecond?: number;
    isMetadata: boolean = false;

    constructor(private mapService: MapInfoService,
                private inspectionSelection: InspectionSelectionService,
                public stateService: AppStateService,
                private renderer: Renderer2) {
        effect(() => {
            this.title = "";
            this.errorMessage = "";
            const panel = this.panel();
            this.isExpanded = this.isPanelHeightExpanded(panel.size[1]);
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
                    panel.features[0].featureId;
                this.layerMenuItems = [];
                this.selectedLayerItem = undefined;
            }
        });
    }

    /** Performs the first layout sync after the docked panel has a rendered body. */
    ngAfterViewInit() {
        this.detectSafari();
        this.scheduleAutoExpand();
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

    protected onInspectionContainerResize(event: MouseEvent, panel: InspectionPanelModel<FeatureWrapper> | undefined): void {
        if (!panel) {
            return;
        }
        const element = event.target as HTMLElement;
        if (!element.classList.contains("resizable-container") || !element.offsetWidth || !element.offsetHeight) {
            return;
        }

        const currentEmWidth = element.offsetWidth / this.stateService.baseFontSize;
        const currentEmHeight = element.offsetHeight / this.stateService.baseFontSize;
        panel.size[0] = currentEmWidth < DEFAULT_EM_WIDTH ? DEFAULT_EM_WIDTH : currentEmWidth;
        panel.size[1] = currentEmHeight;
        this.isExpanded = this.isPanelHeightExpanded(currentEmHeight);
        this.stateService.setInspectionPanelSize(panel.id, [currentEmWidth, currentEmHeight]);
    }

    /** Detects Safari because its resize/accordion behavior needs different animation defaults. */
    private detectSafari() {
        const isSafari = /Safari/i.test(navigator.userAgent);
        if (isSafari) {
            this.renderer.addClass(this.resizeableContainer.nativeElement, 'safari');
        }
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
        const panel = this.panel();
        const nextHeight = this.isExpanded ?
            DEFAULT_DOCKED_EM_HEIGHT :
            this.computeExpandedHeightEm(panel);
        this.applyPanelHeight(panel, nextHeight);
        this.isExpanded = this.isPanelHeightExpanded(nextHeight);
        this.refreshPanelContentLayout();
    }

    /** Moves the camera to the first feature represented by this panel. */
    private focusOnFeature(event?: MouseEvent) {
        event?.stopPropagation();
        const panel = this.panel();
        if (!panel.features.length) {
            return;
        }
        this.inspectionSelection.zoomToFeature(undefined, panel.features[0]);
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
        return !!target.closest(
            'button, .p-button, .p-colorpicker, .p-select, .p-dropdown, .p-multiselect, input, textarea, select, option, a'
        );
    }

    private computeExpandedHeightEm(panel: InspectionPanelModel<FeatureWrapper>): number {
        const contentHeight = this.getPanelContentAdapter()?.measurePreferredHeightEm();
        if (contentHeight === undefined || !Number.isFinite(contentHeight)) {
            return Math.max(panel.size[1], DEFAULT_DOCKED_EM_HEIGHT);
        }
        return Math.max(contentHeight, panel.size[1], DEFAULT_DOCKED_EM_HEIGHT);
    }

    /** Persists the current body height in both local state and shared app state. */
    private applyPanelHeight(panel: InspectionPanelModel<FeatureWrapper>, heightEm: number) {
        if (!Number.isFinite(heightEm) || heightEm <= 0) {
            return;
        }
        panel.size[1] = heightEm;
        this.stateService.setInspectionPanelSize(panel.id, [panel.size[0], heightEm]);
    }

    /** Refreshes whichever content component is currently mounted inside the panel body. */
    private refreshPanelContentLayout() {
        const refresh = () => this.getPanelContentAdapter()?.refreshLayout();
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => refresh());
        });
    }

    private getPanelContentAdapter(): InspectionPanelContentAdapter | undefined {
        return this.panel().sourceData !== undefined ? this.sourceDataPanel : this.featurePanel;
    }

    private isPanelHeightExpanded(heightEm: number): boolean {
        return heightEm > DEFAULT_DOCKED_EM_HEIGHT + 0.1;
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

    /** Clears pending auto-expand work when the docked panel is destroyed. */
    ngOnDestroy() {
        this.clearScheduledAutoExpand();
    }

    /** Defers content-fit height measurement until after the accordion body is laid out. */
    private scheduleAutoExpand() {
        this.clearScheduledAutoExpand();
        this.autoExpandRafFirst = window.requestAnimationFrame(() => {
            this.autoExpandRafFirst = undefined;
            this.autoExpandRafSecond = window.requestAnimationFrame(() => {
                this.autoExpandRafSecond = undefined;
                this.accordionValue = '0';
            });
        });
    }

    /** Cancels any deferred auto-expand measurement. */
    private clearScheduledAutoExpand() {
        if (this.autoExpandRafFirst !== undefined) {
            window.cancelAnimationFrame(this.autoExpandRafFirst);
            this.autoExpandRafFirst = undefined;
        }
        if (this.autoExpandRafSecond !== undefined) {
            window.cancelAnimationFrame(this.autoExpandRafSecond);
            this.autoExpandRafSecond = undefined;
        }
    }
}
