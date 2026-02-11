import {Component, OnDestroy, QueryList, Renderer2, ViewChild, ViewChildren, effect, input} from '@angular/core';
import {Dialog} from 'primeng/dialog';
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
import {InspectionTreeComponent} from './inspection.tree.component';

interface ComparisonColumn {
    entry: InspectionComparisonEntry;
    panel: InspectionPanelModel<FeatureWrapper>;
    loading: boolean;
    localId: number;
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
                                       placeholder="Compared features"
                                       appendTo="body"
                                       [overlayOptions]="{ autoZIndex: true, baseZIndex: 30010 }"/>
                    </div>
                    <div class="comparison-grid">
                        @for (column of columns; track column.localId) {
                            <div class="comparison-column">
                                <div class="comparison-column-title"
                                     [pTooltip]="column.entry.label"
                                     tooltipPosition="bottom">
                                    {{ column.entry.label }}
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
                                                           [(filterText)]="comparisonFilter"
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
    heightEm = DEFAULT_EM_HEIGHT;
    comparisonFilter = '';

    @ViewChild('dialog') dialog?: Dialog;
    @ViewChildren(InspectionTreeComponent) inspectionTrees!: QueryList<InspectionTreeComponent>;

    private detachPointerUpListener?: () => void;

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
    }

    ngOnDestroy() {
        this.endDrag();
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

    refreshCompareOptions() {
        const options = this.stateService.buildCompareOptions(this.mapService.selectionTopic.getValue());
        this.compareOptions = options;
        this.selectedCompareIds = this.selectedCompareIds.filter(id =>
            options.some(option => option.value === id)
        );
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
        this.inspectionTrees?.forEach(tree => tree.freeze());
    }

    private unfreezeTrees(): void {
        this.inspectionTrees?.forEach(tree => tree.unfreeze());
    }

    private buildColumns(model: InspectionComparisonModel) {
        const entries = [model.base, ...model.others];
        const columns = entries.map((entry, index) => {
            const localId = this.localPanelId(index);
            return {
                entry,
                panel: this.buildPanel([], localId),
                loading: true,
                localId
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
        const container = this.dialog?.container;
        if (!container) {
            return;
        }
        const grid = container.querySelector('.comparison-grid') as HTMLElement | null;
        const column = container.querySelector('.comparison-column') as HTMLElement | null;
        const title = container.querySelector('.comparison-column-title') as HTMLElement | null;
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
