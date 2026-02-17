import {Component, OnDestroy, ViewChild} from '@angular/core';
import {Subscription} from 'rxjs';
import {DiagnosticsFacadeService} from './diagnostics.facade.service';
import {Dialog} from 'primeng/dialog';
import {DialogStackService} from '../shared/dialog-stack.service';
import {TreeTableNode} from 'primeng/api';
import {MapDataService} from '../mapdata/map.service';
import {PerfStat} from './diagnostics.model';
import {buildAggregatedPerfStats} from './diagnostics.datasource';

interface LayerOption {
    label: string;
}

interface PerfTreeRowData {
    key: string;
    pathKey: string;
    peak?: number;
    average?: number;
    unit?: string;
    displayPeak?: string;
    displayAverage?: string;
    basePeakTooltip?: string;
    baseAverageTooltip?: string;
    peakTileIds?: string;
    rowClass?: string;
}

type SupportedUnit = 'ms' | 'count';

interface ParentAggregate {
    hasNumeric: boolean;
    eligible: boolean;
    unit?: SupportedUnit;
    peak?: number;
    average?: number;
}

const unitSuffixes: Array<{suffix: string; unit: string}> = [
    {suffix: '#ms', unit: 'ms'},
    {suffix: '-ms', unit: 'ms'},
    {suffix: '#kb', unit: 'KB'},
    {suffix: '-kb', unit: 'KB'},
    {suffix: '#mb', unit: 'MB'},
    {suffix: '-mb', unit: 'MB'},
    {suffix: '#pct', unit: '%'},
    {suffix: '-pct', unit: '%'},
    {suffix: '#%', unit: '%'},
    {suffix: '-%', unit: '%'},
    {suffix: '#count', unit: 'count'},
    {suffix: '-count', unit: 'count'},
];
const countKeyPattern = /(count|num|feature|features|tile|tiles)/i;

@Component({
    selector: 'diagnostics-performance-dialog',
    template: `
        <p-dialog #dialog header="Performance Statistics" class="diagnostics-performance-dialog" [(visible)]="diagnostics.performanceDialogVisible"
                  [modal]="false" (onShow)="onDialogShow()">
            @if (diagnostics.snapshot$ | async; as snapshot) {
                <div class="diagnostics-perf-progress">
                    <diagnostics-progress [progress]="snapshot.progress"></diagnostics-progress>
                </div>
            }

            <div class="diagnostics-perf-filter">
                <p-multiSelect
                    [options]="availableMapLayers"
                    [(ngModel)]="selectedMapLayers"
                    (ngModelChange)="onLayerSelectionChange()"
                    optionLabel="label"
                    placeholder="Select Map Layers"
                    [showHeader]="false"
                    [style]="{'width': '100%'}">
                </p-multiSelect>
            </div>

            <p-treeTable [value]="treeNodes"
                         [scrollable]="true"
                         scrollHeight="flex"
                         class="diagnostics-perf-table"
                         [tableStyle]="{'table-layout': 'fixed', 'width': '100%'}"
                         [resizableColumns]="true"
                         columnResizeMode="expand"
                         [rowTrackBy]="trackNodeByPath"
                         [rowHover]="true"
                         (onNodeExpand)="onNodeExpand($event.node)"
                         (onNodeCollapse)="onNodeCollapse($event.node)">
                <ng-template pTemplate="header">
                    <tr>
                        <th ttResizableColumn style="width: 58%;">Key</th>
                        <th ttResizableColumn style="width: 14%;">Peak</th>
                        <th ttResizableColumn style="width: 14%;">Average</th>
                        <th ttResizableColumn style="width: 14%;">Peak Tile IDs</th>
                    </tr>
                </ng-template>
                <ng-template pTemplate="colgroup">
                    <colgroup>
                        <col style="width: 50%;">
                        <col style="width: 15%;">
                        <col style="width: 15%;">
                        <col style="width: 20%;">
                    </colgroup>
                </ng-template>
                <ng-template pTemplate="body" let-rowNode let-rowData="rowData">
                    <tr [ttRow]="rowNode" [ngClass]="rowData.rowClass">
                        <td class="diagnostics-cell" style="width: 58%;">
                            <div class="diagnostics-key-cell diagnostics-ellipsis">
                                <p-treeTableToggler [rowNode]="rowNode"></p-treeTableToggler>
                                <span class="diagnostics-key-text"
                                      [pTooltip]="rowData.key"
                                      tooltipPosition="top"
                                      [tooltipDisabled]="!rowData.key">
                                    {{ rowData.key }}
                                </span>
                            </div>
                        </td>
                        <td class="diagnostics-cell diagnostics-ellipsis"
                            style="width: 14%;"
                            [pTooltip]="rowData.basePeakTooltip"
                            tooltipPosition="top"
                            [tooltipDisabled]="!rowData.basePeakTooltip">
                            {{ rowData.displayPeak ?? '' }}
                        </td>
                        <td class="diagnostics-cell diagnostics-ellipsis"
                            style="width: 14%;"
                            [pTooltip]="rowData.baseAverageTooltip"
                            tooltipPosition="top"
                            [tooltipDisabled]="!rowData.baseAverageTooltip">
                            {{ rowData.displayAverage ?? '' }}
                        </td>
                        <td class="diagnostics-cell diagnostics-ellipsis"
                            style="width: 14%;"
                            [pTooltip]="rowData.peakTileIds ?? ''"
                            tooltipPosition="left"
                            [tooltipDisabled]="!rowData.peakTileIds">
                            {{ rowData.peakTileIds ?? '' }}
                        </td>
                    </tr>
                </ng-template>
                <ng-template pTemplate="emptymessage">
                    <tr>
                        <td colspan="4">No performance statistics available.</td>
                    </tr>
                </ng-template>
            </p-treeTable>
            <div class="diagnostics-dialog-actions">
                <p-button label="Export" (click)="openExport()" />
            </div>
        </p-dialog>
    `,
    styles: [``],
    standalone: false
})
export class DiagnosticsPerformanceDialogComponent implements OnDestroy {
    @ViewChild('dialog') dialog?: Dialog;
    availableMapLayers: LayerOption[] = [];
    selectedMapLayers: LayerOption[] = [];
    treeNodes: TreeTableNode[] = [];
    private readonly expansionStateByPath = new Map<string, boolean>();
    private readonly subscriptions: Subscription[] = [];

    constructor(public readonly diagnostics: DiagnosticsFacadeService,
                private readonly dialogStack: DialogStackService,
                private readonly mapService: MapDataService) {
        this.subscriptions.push(
            this.diagnostics.perfStats$.subscribe(() => {
                this.refreshAvailableMapLayers();
                this.rebuildTreeNodes();
            })
        );
    }

    ngOnDestroy() {
        this.subscriptions.forEach(sub => sub.unsubscribe());
    }

    onDialogShow() {
        this.diagnostics.refreshPerfStats();
        this.refreshAvailableMapLayers();
        this.rebuildTreeNodes();
        this.dialogStack.bringToFront(this.dialog);
    }

    openExport() {
        this.diagnostics.openExportDialog({
            includeProgress: false,
            includePerformance: true,
            includeLogs: true
        });
    }

    onLayerSelectionChange() {
        this.rebuildTreeNodes();
    }

    trackNodeByPath = (index: number, row: TreeTableNode): string | number => {
        return row?.key ?? row?.data?.pathKey ?? index;
    };

    onNodeExpand(node: TreeTableNode) {
        const pathKey = this.getNodePathKey(node);
        if (pathKey) {
            this.expansionStateByPath.set(pathKey, true);
        }
    }

    onNodeCollapse(node: TreeTableNode) {
        const pathKey = this.getNodePathKey(node);
        if (pathKey) {
            this.expansionStateByPath.set(pathKey, false);
        }
    }

    private getNodePathKey(node: TreeTableNode | undefined): string | undefined {
        if (!node) {
            return undefined;
        }
        if (typeof node.key === 'string' && node.key.length) {
            return node.key;
        }
        const dataPathKey = node.data?.pathKey;
        if (typeof dataPathKey === 'string' && dataPathKey.length) {
            return dataPathKey;
        }
        return undefined;
    }

    private parsePerfUnit(key: string): string | undefined {
        const lower = key.toLowerCase();
        for (const entry of unitSuffixes) {
            if (lower.endsWith(entry.suffix)) {
                return entry.unit;
            }
        }
        return undefined;
    }

    private inferCountUnitFromKey(key: string): string | undefined {
        return countKeyPattern.test(this.stripPerfUnitSuffix(key)) ? 'count' : undefined;
    }

    private stripPerfUnitSuffix(key: string): string {
        const lower = key.toLowerCase();
        for (const entry of unitSuffixes) {
            if (lower.endsWith(entry.suffix)) {
                return key.slice(0, key.length - entry.suffix.length);
            }
        }
        return key;
    }

    private splitPerfPath(key: string): string[] {
        const cleaned = this.stripPerfUnitSuffix(key);
        const segments = cleaned.split('/').map(segment => segment.trim()).filter(Boolean);
        return segments.length ? segments : [cleaned];
    }

    private refreshAvailableMapLayers() {
        const mapLayersSet: Set<string> = new Set();
        for (const tile of this.mapService.loadedTileLayers.values()) {
            mapLayersSet.add(`${tile.mapName} - ${tile.layerName}`);
        }

        const nextLayers = Array.from(mapLayersSet)
            .sort((a, b) => a.localeCompare(b))
            .map(label => ({label}));
        if (this.isSameLayerList(nextLayers, this.availableMapLayers)) {
            return;
        }

        this.availableMapLayers = nextLayers;
        if (!this.selectedMapLayers.length) {
            this.selectedMapLayers = [...nextLayers];
            return;
        }

        const validSelection = this.selectedMapLayers.filter(selection =>
            nextLayers.some(layer => layer.label === selection.label));
        this.selectedMapLayers = validSelection;
    }

    private isSameLayerList(left: LayerOption[], right: LayerOption[]): boolean {
        if (left.length !== right.length) {
            return false;
        }
        for (let index = 0; index < left.length; index += 1) {
            if (left[index].label !== right[index].label) {
                return false;
            }
        }
        return true;
    }

    private rebuildTreeNodes() {
        const nextTreeNodes = this.buildPerfTreeNodes(this.computeFilteredPerfStats());
        this.treeNodes = nextTreeNodes;
    }

    private computeFilteredPerfStats(): PerfStat[] {
        const selectedLabels = new Set(this.selectedMapLayers.map(selection => selection.label));
        if (!selectedLabels.size) {
            return [];
        }

        const filteredTiles = Array.from(this.mapService.loadedTileLayers.values()).filter(tile =>
            selectedLabels.has(`${tile.mapName} - ${tile.layerName}`));
        return buildAggregatedPerfStats(filteredTiles);
    }

    private buildPerfTreeNodes(stats: PerfStat[]): TreeTableNode[] {
        const rootNodes: TreeTableNode[] = [];
        const nodeLookup = new Map<string, TreeTableNode>();
        const activePathKeys = new Set<string>();

        const ensureNode = (pathKey: string, label: string, parent?: TreeTableNode): TreeTableNode => {
            activePathKeys.add(pathKey);
            const existing = nodeLookup.get(pathKey);
            if (existing) {
                existing.key = pathKey;
                existing.parent = parent;
                const existingData = this.getRowData(existing);
                existingData.key = label;
                existingData.pathKey = pathKey;
                existing.children = existing.children ?? [];
                return existing;
            }
            const node: TreeTableNode = {
                key: pathKey,
                data: {
                    key: label,
                    pathKey
                },
                parent,
                expanded: this.expansionStateByPath.get(pathKey) ?? true,
                children: []
            };
            nodeLookup.set(pathKey, node);
            if (parent) {
                parent.children = parent.children ?? [];
                parent.children.push(node);
            } else {
                rootNodes.push(node);
            }
            return node;
        };

        stats.forEach(stat => {
            const path = stat.path && stat.path.length ? stat.path : this.splitPerfPath(stat.key);
            if (!path.length) {
                return;
            }

            let parent: TreeTableNode | undefined;
            let currentPath = '';
            path.forEach((segment: string, index: number) => {
                currentPath = currentPath ? `${currentPath}/${segment}` : segment;
                const node = ensureNode(currentPath, segment, parent);
                if (index === path.length - 1) {
                    const unit = stat.unit
                        ?? this.parsePerfUnit(stat.key)
                        ?? this.inferCountUnitFromKey(stat.key)
                        ?? this.inferCountUnitFromKey(currentPath);
                    const peakNumber = stat.peak;
                    const averageNumber = stat.average;
                    node.data = {
                        key: segment,
                        pathKey: currentPath,
                        peak: peakNumber,
                        average: averageNumber,
                        unit,
                        displayPeak: this.formatValueWithUnit(peakNumber, unit, 'peak'),
                        displayAverage: this.formatValueWithUnit(averageNumber, unit, 'average'),
                        basePeakTooltip: this.formatBaseTooltip(peakNumber, unit, 'peak'),
                        baseAverageTooltip: this.formatBaseTooltip(averageNumber, unit, 'average'),
                        peakTileIds: stat.peakTileIds?.join(', ')
                    };
                }
                parent = node;
            });
        });

        const sortNodes = (nodes: TreeTableNode[]) => {
            nodes.sort((a, b) => String(a.data?.key ?? '').localeCompare(String(b.data?.key ?? '')));
            nodes.forEach(node => {
                if (node.children && node.children.length) {
                    sortNodes(node.children);
                }
            });
        };

        sortNodes(rootNodes);
        this.propagateParentStats(rootNodes);
        this.assignRowClasses(rootNodes);
        for (const pathKey of Array.from(this.expansionStateByPath.keys())) {
            if (!activePathKeys.has(pathKey)) {
                this.expansionStateByPath.delete(pathKey);
            }
        }
        return rootNodes;
    }

    private getRowData(node: TreeTableNode): PerfTreeRowData {
        return node.data as PerfTreeRowData;
    }

    private assignRowClasses(nodes: TreeTableNode[]) {
        let stripeIndex = 0;
        const visit = (items: TreeTableNode[], depth: number) => {
            for (const node of items) {
                const rowData = this.getRowData(node);
                const hasChildren = !!node.children?.length;
                const isRootParent = depth === 0 && hasChildren;
                const classes: string[] = [];
                if (hasChildren) {
                    classes.push('diagnostics-perf-parent');
                }
                if (isRootParent) {
                    classes.push('diagnostics-perf-root');
                }
                rowData.rowClass = classes.join(' ');

                if (hasChildren) {
                    visit(node.children!, depth + 1);
                }
            }
        };
        visit(nodes, 0);
    }

    private propagateParentStats(nodes: TreeTableNode[]) {
        nodes.forEach(node => this.buildParentAggregate(node));
    }

    private buildParentAggregate(node: TreeTableNode): ParentAggregate {
        const rowData = this.getRowData(node);
        const hasChildren = !!node.children?.length;
        const selfAggregate = this.extractNodeAggregate(rowData);

        if (!hasChildren) {
            return selfAggregate;
        }

        const childAggregates = node.children!.map(child => this.buildParentAggregate(child));
        const aggregatesForCalculation: ParentAggregate[] = [];
        let hasNumericDescendants = false;

        if (selfAggregate.hasNumeric) {
            hasNumericDescendants = true;
            if (selfAggregate.eligible) {
                aggregatesForCalculation.push(selfAggregate);
            }
        }

        for (const aggregate of childAggregates) {
            if (aggregate.hasNumeric) {
                hasNumericDescendants = true;
            }
            if (aggregate.eligible) {
                aggregatesForCalculation.push(aggregate);
            }
        }

        if (!hasNumericDescendants || !aggregatesForCalculation.length) {
            return {
                hasNumeric: hasNumericDescendants,
                eligible: false
            };
        }

        const unit = aggregatesForCalculation[0].unit;
        if (!unit || aggregatesForCalculation.some(aggregate => aggregate.unit !== unit)) {
            return {
                hasNumeric: true,
                eligible: false
            };
        }

        const peakValues = aggregatesForCalculation
            .map(aggregate => aggregate.peak)
            .filter((value): value is number => this.isFiniteNumber(value));
        const averageValues = aggregatesForCalculation
            .map(aggregate => aggregate.average)
            .filter((value): value is number => this.isFiniteNumber(value));

        if (!peakValues.length || !averageValues.length) {
            return {
                hasNumeric: true,
                eligible: false
            };
        }

        const peak = Math.max(...peakValues);
        const average = averageValues.reduce((sum, value) => sum + value, 0) / averageValues.length;
        rowData.unit = unit;
        rowData.peak = peak;
        rowData.average = average;
        rowData.displayPeak = this.formatValueWithUnit(peak, unit, 'peak');
        rowData.displayAverage = this.formatValueWithUnit(average, unit, 'average');
        rowData.basePeakTooltip = this.formatBaseTooltip(peak, unit, 'peak');
        rowData.baseAverageTooltip = this.formatBaseTooltip(average, unit, 'average');
        if (hasChildren) {
            rowData.peakTileIds = undefined;
        }

        return {
            hasNumeric: true,
            eligible: true,
            unit,
            peak,
            average
        };
    }

    private extractNodeAggregate(rowData: PerfTreeRowData): ParentAggregate {
        const hasNumeric = this.isFiniteNumber(rowData.peak) || this.isFiniteNumber(rowData.average);
        if (!hasNumeric) {
            return {
                hasNumeric: false,
                eligible: false
            };
        }

        const unit = this.toSupportedUnit(rowData.unit);
        if (!unit || !this.isFiniteNumber(rowData.peak) || !this.isFiniteNumber(rowData.average)) {
            return {
                hasNumeric: true,
                eligible: false
            };
        }

        return {
            hasNumeric: true,
            eligible: true,
            unit,
            peak: rowData.peak,
            average: rowData.average
        };
    }

    private toSupportedUnit(unit?: string): SupportedUnit | undefined {
        return unit === 'ms' || unit === 'count' ? unit : undefined;
    }

    private isFiniteNumber(value: number | undefined): value is number {
        return typeof value === 'number' && Number.isFinite(value);
    }

    private formatValueWithUnit(value: number | undefined, unit: string | undefined, mode: 'peak' | 'average'): string | undefined {
        if (value === undefined || value === null) {
            return undefined;
        }
        if (unit === 'count') {
            return Math.round(value).toString();
        }
        if (unit === 'KB' || unit === 'MB') {
            const bytes = unit === 'KB' ? value * 1024 : value * 1024 * 1024;
            return this.formatBytes(bytes);
        }
        if (unit === 'ms') {
            return this.formatDurationMs(value);
        }
        const formatted = this.formatDecimal(value, 2);
        return unit ? `${formatted} ${unit}` : formatted;
    }

    private formatBaseTooltip(value: number | undefined, unit: string | undefined, mode: 'peak' | 'average'): string | undefined {
        if (value === undefined || value === null) {
            return undefined;
        }
        if (unit === 'count') {
            return `${Math.round(value)} count`;
        }
        if (unit) {
            const formatted = this.formatDecimal(value, 2);
            return `${formatted} ${unit}`;
        }
        return this.formatDecimal(value, 2);
    }

    private formatBytes(bytes: number): string {
        const abs = Math.abs(bytes);
        if (abs < 1024) {
            return `${this.formatDecimal(bytes, 1)} B`;
        }
        if (abs < 1024 * 1024) {
            return `${this.formatDecimal(bytes / 1024, 1)} KB`;
        }
        if (abs < 1024 * 1024 * 1024) {
            return `${this.formatDecimal(bytes / (1024 * 1024), 1)} MB`;
        }
        return `${this.formatDecimal(bytes / (1024 * 1024 * 1024), 1)} GB`;
    }

    private formatDurationMs(ms: number): string {
        const abs = Math.abs(ms);
        if (abs < 1000) {
            return `${this.formatDecimal(ms, 1)} ms`;
        }
        if (abs < 60_000) {
            return `${this.formatDecimal(ms / 1000, 1)} s`;
        }
        if (abs < 3_600_000) {
            return `${this.formatDecimal(ms / 60_000, 1)} m`;
        }
        return `${this.formatDecimal(ms / 3_600_000, 1)} h`;
    }

    private formatDecimal(value: number, decimals: number): string {
        return value.toFixed(decimals);
    }
}
