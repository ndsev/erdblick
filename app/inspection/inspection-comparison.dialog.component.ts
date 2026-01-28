import {Component, OnDestroy, QueryList, Renderer2, ViewChild, ViewChildren, effect, input} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {MapDataService} from '../mapdata/map.service';
import {AppStateService, DEFAULT_EM_HEIGHT, DEFAULT_EM_WIDTH, InspectionPanelModel} from '../shared/appstate.service';
import {FeatureWrapper} from '../mapdata/features.model';
import {DialogStackService} from '../shared/dialog-stack.service';
import {
    InspectionComparisonEntry,
    InspectionComparisonModel,
    InspectionComparisonOption,
    InspectionComparisonService
} from './inspection-comparison.service';
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
                  [modal]="false" [closable]="true" [(visible)]="comparisonService.isComparisonVisible"
                  (onShow)="onDialogShow()" (onHide)="onDialogHide()" (onDragEnd)="onDialogDragEnd()">
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
                public comparisonService: InspectionComparisonService,
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
    }

    onDialogHide() {
        this.comparisonService.closeComparison();
    }

    onDialogDragEnd() {
        this.endDrag();
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
        this.selectedCompareIds = normalized;
        this.comparisonService.updateComparisonPanels(model.id, normalized);
    }

    refreshCompareOptions() {
        const model = this.comparison();
        const options = this.comparisonService.buildCompareOptions();
        const optionMap = new Map(options.map(option => [option.value, option]));
        const ensureOption = (entry: InspectionComparisonEntry) => {
            if (!optionMap.has(entry.panelId)) {
                options.push({
                    label: entry.label,
                    value: entry.panelId
                });
            }
        };
        ensureOption(model.base);
        model.others.forEach(entry => ensureOption(entry));
        this.compareOptions = options;
        this.selectedCompareIds = [model.base.panelId, ...model.others.map(entry => entry.panelId)];
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
            const localId = this.localPanelId(model.id, index);
            return {
                entry,
                panel: this.buildPanel([], localId),
                loading: true,
                localId
            };
        });
        this.columns = columns;
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

    private async resolveFeatures(entry: InspectionComparisonEntry): Promise<FeatureWrapper[]> {
        if (entry.featureWrappers && entry.featureWrappers.length) {
            return entry.featureWrappers;
        }
        return await this.mapService.loadFeatures(entry.featureIds);
    }

    private buildPanel(features: FeatureWrapper[], localId: number): InspectionPanelModel<FeatureWrapper> {
        return {
            id: localId,
            features: features,
            pinned: true,
            size: [DEFAULT_EM_WIDTH, this.heightEm],
            color: '#ffffff',
            undocked: true
        };
    }

    private localPanelId(comparisonId: number, index: number): number {
        return -((comparisonId * 10) + index + 1);
    }
}
