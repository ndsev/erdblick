import {Component, effect, input, OnDestroy, QueryList, Renderer2, ViewChild, ViewChildren} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {ContextMenu} from 'primeng/contextmenu';
import {MenuItem} from 'primeng/api';
import {Subscription} from 'rxjs';
import {MapDataService} from '../mapdata/map.service';
import {
    AppStateService,
    DEFAULT_EM_HEIGHT,
    DEFAULT_EM_WIDTH,
    InspectionComparisonEntry,
    InspectionComparisonModel,
    InspectionComparisonOption,
    InspectionPanelModel
} from '../shared/appstate.service';
import {FeatureWrapper} from '../mapdata/features.model';
import {DialogStackService} from '../shared/dialog-stack.service';
import {FeaturePanelComponent} from './feature.panel.component';

interface ComparisonColumn {
    entry: InspectionComparisonEntry;
    panel: InspectionPanelModel<FeatureWrapper>;
    loading: boolean;
    localId: number;
    selectionColor: string;
}

@Component({
    selector: 'inspection-comparison-dialog',
    template: `
        <p-dialog #dialog class="inspection-comparison-dialog"
                  [modal]="false" [closable]="true" [(visible)]="visible"
                  (onShow)="onDialogShow()" (onHide)="onDialogHide()" (onDragEnd)="onDialogDragEnd()"
                  (onResizeEnd)="onDialogResizeEnd()">
            <ng-template #header>
                <div class="title" (pointerdown)="beginDrag()">Inspection Comparison</div>
            </ng-template>
            <ng-template #content>
                <div class="comparison-content">
                    <div class="comparison-controls">
                        <p-multiSelect [options]="compareOptions"
                                       [(ngModel)]="selectedCompareIds"
                                       (ngModelChange)="onCompareSelectionChange($event)"
                                       (onPanelShow)="refreshCompareOptions()"
                                       optionLabel="label"
                                       optionValue="value"
                                       [showClear]="true"
                                       [selectionLimit]="4"
                                       [maxSelectedLabels]="4"
                                       placeholder="Compared features"
                                       appendTo="body"
                                       [overlayOptions]="{ autoZIndex: true, baseZIndex: 30010 }"/>
                        <p-iconfield class="input-container comparison-filter-input">
                            <p-inputicon class="pi pi-filter"/>
                            <input class="filter-input" type="text" pInputText placeholder="Filter compared inspections"
                                   [(ngModel)]="comparisonFilter"/>
                            @if (comparisonFilter) {
                                <i (click)="comparisonFilter = ''" class="pi pi-times clear-icon"></i>
                            }
                        </p-iconfield>
                    </div>
                    <div class="comparison-grid">
                        @for (column of columns; track column.localId) {
                            <div class="comparison-column">
                                <div class="comparison-column-header">
                                    <span class="comparison-column-header-left">
                                        <p-colorpicker [(ngModel)]="column.selectionColor"
                                                       (ngModelChange)="onSelectionColorChange(column, $event)"></p-colorpicker>
                                        <div class="comparison-column-title"
                                             [pTooltip]="column.entry.label"
                                             tooltipPosition="bottom">
                                            <span>{{ column.entry.mapId }}:</span>
                                            <span>{{ column.entry.featureIds[0].featureId }}</span>
                                        </div>
                                    </span>
                                    <span class="comparison-column-header-right">
                                        <p-button icon="" (click)="openColumnMenu($event, column)"
                                                  pTooltip="More actions" tooltipPosition="bottom">
                                            <span class="material-symbols-outlined"
                                                  style="font-size: 1.2em; margin: 0 auto;">more_vert</span>
                                        </p-button>
                                        <p-button icon="pi pi-times"
                                                  severity="secondary"
                                                  pTooltip="Remove from comparison"
                                                  tooltipPosition="bottom"
                                                  (click)="removeFromComparison(column.entry.panelId)">
                                        </p-button>
                                    </span>
                                </div>
                                <div class="resizable-container comparison-resizable"
                                     [style.height.em]="heightEm"
                                     (mouseup)="onResize($event)">
                                    <div style="width: 100%; height: 100%">
                                        @if (column.loading) {
                                            <div class="comparison-loading">
                                                <p-progressSpinner ariaLabel="loading"/>
                                            </div>
                                        } @else {
                                            <feature-panel [panel]="column.panel"
                                                           [filterText]="comparisonFilter"
                                                           [showFilter]="false"
                                                           [enableSourceDataNavigation]="false">
                                            </feature-panel>
                                        }
                                    </div>
                                </div>
                            </div>
                        }
                    </div>
                </div>
            </ng-template>
        </p-dialog>
        <p-contextMenu #columnMenu [model]="columnMenuItems" [baseZIndex]="30000" appendTo="body"
                       [style]="{'font-size': '0.9em'}"></p-contextMenu>
    `,
    styles: [``],
    standalone: false
})
export class InspectionComparisonDialogComponent implements OnDestroy {
    comparison = input.required<InspectionComparisonModel>();
    visible = true;
    compareOptions: InspectionComparisonOption[] = [];
    selectedCompareIds: number[] = [];
    columns: ComparisonColumn[] = [];
    columnMenuItems: MenuItem[] = [];
    heightEm = DEFAULT_EM_HEIGHT;
    comparisonFilter = '';

    @ViewChild('dialog') dialog?: Dialog;
    @ViewChild('columnMenu') columnMenu!: ContextMenu;
    @ViewChildren(FeaturePanelComponent) featurePanels!: QueryList<FeaturePanelComponent>;

    private detachPointerUpListener?: () => void;
    private selectionTopicSubscription: Subscription;

    constructor(private mapService: MapDataService,
                private stateService: AppStateService,
                private dialogStack: DialogStackService,
                private renderer: Renderer2) {
        effect(() => {
            const model = this.comparison();
            this.selectedCompareIds = [model.base.panelId, ...model.others.map(entry => entry.panelId)];
            this.refreshCompareOptions();
            this.buildColumns(model);
        });
        this.selectionTopicSubscription = this.mapService.selectionTopic.subscribe(() => {
            this.refreshCompareOptions();
            this.refreshColumnSelectionColors();
        });
    }

    ngOnDestroy() {
        this.endDrag();
        this.selectionTopicSubscription.unsubscribe();
        this.columns = [];
    }

    onDialogShow() {
        this.dialogStack.bringToFront(this.dialog);
        this.queueHeightSync();
    }

    onDialogHide() {
        this.stateService.closeInspectionComparison();
    }

    onDialogDragEnd() {
        this.endDrag();
    }

    onDialogResizeEnd() {
        this.queueHeightSync();
    }

    beginDrag(): void {
        this.freezeTrees();
        this.detachPointerUpListener?.();
        this.detachPointerUpListener = this.renderer.listen('window', 'pointerup', () => {
            this.endDrag();
        });
    }

    endDrag(): void {
        this.detachPointerUpListener?.();
        this.detachPointerUpListener = undefined;
        this.unfreezeTrees();
    }

    onCompareSelectionChange(selected: number[]) {
        const model = this.comparison();
        let normalized = Array.from(new Set(selected));
        if (normalized.length === 0) {
            normalized = [model.base.panelId];
        }
        if (normalized.length > 4) {
            normalized = normalized.slice(0, 4);
        }
        const nextBasePanelId = normalized.includes(model.base.panelId)
            ? model.base.panelId
            : normalized[0];
        const nextOtherPanelIds = normalized.filter(panelId => panelId !== nextBasePanelId);
        const nextModel = this.stateService.createComparisonModel(
            nextBasePanelId,
            nextOtherPanelIds,
            this.mapService.selectionTopic.getValue()
        );
        if (!nextModel) {
            this.stateService.closeInspectionComparison();
            return;
        }
        this.selectedCompareIds = [nextModel.base.panelId, ...nextModel.others.map(entry => entry.panelId)];
        this.stateService.inspectionComparison = nextModel;
    }

    removeFromComparison(panelId: number): void {
        const model = this.comparison();
        const remainingEntries = [model.base, ...model.others].filter(entry => entry.panelId !== panelId);
        if (!remainingEntries.length) {
            this.stateService.closeInspectionComparison();
            return;
        }
        this.stateService.inspectionComparison = {
            base: remainingEntries[0],
            others: remainingEntries.slice(1)
        };
    }

    onSelectionColorChange(column: ComparisonColumn, color: string): void {
        column.selectionColor = color;
        this.stateService.setInspectionPanelColor(column.entry.panelId, color);
    }

    openColumnMenu(event: MouseEvent, column: ComparisonColumn): void {
        event.stopPropagation();
        this.columnMenuItems = this.buildColumnMenuItems(column);
        this.columnMenu.toggle(event);
    }

    refreshCompareOptions() {
        const options = this.stateService.buildCompareOptions(this.mapService.selectionTopic.getValue());
        this.compareOptions = options;
        const model = this.stateService.inspectionComparison;
        if (!model) {
            return;
        }
        const modelPanelIds = [model.base.panelId, ...model.others.map(entry => entry.panelId)];
        if (options.length === 0) {
            this.selectedCompareIds = modelPanelIds;
            return;
        }

        const availablePanelIds = new Set(options.map(option => option.value));
        const normalizedPanelIds = modelPanelIds.filter(panelId => availablePanelIds.has(panelId));

        if (!normalizedPanelIds.length) {
            this.stateService.closeInspectionComparison();
            return;
        }

        if (!this.panelIdOrderEquals(modelPanelIds, normalizedPanelIds)) {
            const nextModel = this.stateService.createComparisonModel(
                normalizedPanelIds[0],
                normalizedPanelIds.slice(1),
                this.mapService.selectionTopic.getValue()
            );
            if (!nextModel) {
                this.stateService.closeInspectionComparison();
                return;
            }
            this.stateService.inspectionComparison = nextModel;
            this.selectedCompareIds = [nextModel.base.panelId, ...nextModel.others.map(entry => entry.panelId)];
            return;
        }

        this.selectedCompareIds = normalizedPanelIds;
    }

    onResize(event: MouseEvent) {
        const target = event.target as HTMLElement | null;
        const container = target?.closest('.comparison-resizable') as HTMLElement | null;
        if (!container || !container.offsetHeight) {
            return;
        }
        this.heightEm = container.offsetHeight / this.stateService.baseFontSize;
    }

    private freezeTrees(): void {
        this.featurePanels?.forEach(panel => panel.freezeTree());
    }

    private unfreezeTrees(): void {
        this.featurePanels?.forEach(panel => panel.unfreezeTree());
    }

    private buildColumns(model: InspectionComparisonModel) {
        const entries = [model.base, ...model.others];
        const columns = entries.map((entry, index) => {
            const localId = this.localPanelId(index);
            return {
                entry,
                panel: this.buildPanel([], localId),
                loading: true,
                localId,
                selectionColor: this.selectionColorForPanel(entry.panelId)
            };
        });
        this.columns = columns;
        this.queueHeightSync();
        entries.forEach((entry, index) => {
            this.resolveFeatures(entry).then(features => {
                const localId = columns[index].localId;
                const updated = {
                    ...columns[index],
                    panel: this.buildPanel(features, localId),
                    loading: false
                };
                const nextColumns = this.columns.slice();
                nextColumns[index] = updated;
                this.columns = nextColumns;
            });
        });
    }

    private queueHeightSync() {
        setTimeout(() => this.syncComparisonHeight(), 0);
    }

    private syncComparisonHeight() {
        const container = this.dialog?.container() ?? undefined;
        if (!container) {
            return;
        }
        const grid = container.querySelector('.comparison-grid') as HTMLElement | null;
        const column = container.querySelector('.comparison-column') as HTMLElement | null;
        const title = container.querySelector('.comparison-column-header') as HTMLElement | null;
        if (!grid || !column || !title) {
            return;
        }
        const baseFontSize = this.stateService.baseFontSize;
        if (!baseFontSize) {
            return;
        }
        const computedStyle = getComputedStyle(column);
        const gapValue = parseFloat(computedStyle.rowGap || '0');
        const gap = Number.isFinite(gapValue) ? gapValue : 0;
        const availableHeight = grid.clientHeight - title.offsetHeight - gap;
        if (availableHeight <= 0) {
            return;
        }
        this.heightEm = availableHeight / baseFontSize;
    }

    private async resolveFeatures(entry: InspectionComparisonEntry): Promise<FeatureWrapper[]> {
        return await this.mapService.loadFeatures(entry.featureIds);
    }

    private buildColumnMenuItems(column: ComparisonColumn): MenuItem[] {
        const focusFeature = column.panel.features[0];
        const featurePanel = this.featurePanelForColumn(column.localId);
        const disableGeoJsonActions = featurePanel === undefined;
        return [
            {
                label: 'Focus on feature',
                icon: 'pi pi-bullseye',
                disabled: !focusFeature,
                command: () => {
                    if (!focusFeature) {
                        return;
                    }
                    this.mapService.zoomToFeature(undefined, focusFeature);
                }
            },
            {
                label: 'GeoJSON Actions',
                icon: 'pi pi-download',
                items: [
                    {
                        label: 'Open in new tab',
                        icon: 'pi pi-external-link',
                        disabled: disableGeoJsonActions,
                        command: () => featurePanel?.openGeoJsonInNewTab()
                    },
                    {
                        label: 'Download (.geojson)',
                        icon: 'pi pi-download',
                        disabled: disableGeoJsonActions,
                        command: () => featurePanel?.downloadGeoJson()
                    },
                    {
                        label: 'Copy to clipboard',
                        icon: 'pi pi-copy',
                        disabled: disableGeoJsonActions,
                        command: () => featurePanel?.copyGeoJson()
                    }
                ]
            }
        ];
    }

    private featurePanelForColumn(localId: number): FeaturePanelComponent | undefined {
        return this.featurePanels?.toArray().find(panel => panel.panel().id === localId);
    }

    private selectionColorForPanel(panelId: number): string {
        return this.mapService.selectionTopic.getValue().find(panel => panel.id === panelId)?.color ?? '#ffffff';
    }

    private panelIdOrderEquals(a: number[], b: number[]): boolean {
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

    private refreshColumnSelectionColors(): void {
        if (!this.columns.length) {
            return;
        }
        let changed = false;
        const nextColumns = this.columns.map(column => {
            const nextColor = this.selectionColorForPanel(column.entry.panelId);
            if (nextColor === column.selectionColor) {
                return column;
            }
            changed = true;
            return {
                ...column,
                selectionColor: nextColor
            };
        });
        if (changed) {
            this.columns = nextColumns;
        }
    }

    private buildPanel(features: FeatureWrapper[], localId: number): InspectionPanelModel<FeatureWrapper> {
        return {
            id: localId,
            features: features,
            locked: true,
            size: [DEFAULT_EM_WIDTH, this.heightEm],
            color: '#ffffff',
            undocked: true
        };
    }

    private localPanelId(index: number): number {
        return -(index + 1);
    }
}
