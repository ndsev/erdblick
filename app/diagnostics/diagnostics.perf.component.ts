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

interface TileIdOption {
    label: string;
    tileId: string;
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
    peakClass?: string;
    averageClass?: string;
    rowClass?: string;
}

type SupportedUnit = 'ms' | 'count';
type DurationDisplayUnit = 'ms' | 's' | 'm' | 'h';
type BytesDisplayUnit = 'B' | 'KB' | 'MB' | 'GB';

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
const DISPLAY_DECIMALS = 3;

@Component({
    selector: 'diagnostics-performance-dialog',
    template: `
        <p-dialog #dialog header="Performance Statistics" class="diagnostics-performance-dialog" [(visible)]="diagnostics.performanceDialogVisible"
                  [modal]="false"
                  [style]="dialogStyle"
                  (onShow)="onDialogShow()">
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
                    [selectionLimit]="20"
                    [maxSelectedLabels]="20"
                    [showHeader]="false"
                    [style]="{'width': '100%'}">
                </p-multiSelect>
                <p-multiSelect
                    [options]="availableTileIds"
                    [(ngModel)]="selectedTileIds"
                    (ngModelChange)="onTileIdSelectionChange()"
                    optionLabel="label"
                    placeholder="Select Tile IDs"
                    [selectionLimit]="20"
                    [maxSelectedLabels]="20"
                    [style]="{'width': '100%', 'margin-top': '0.25em'}">
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
                        <th ttResizableColumn style="width: 50%;">Key</th>
                        <th ttResizableColumn style="width: 15%;" class="diagnostics-perf-value">Peak</th>
                        <th ttResizableColumn style="width: 15%;" class="diagnostics-perf-value">Average</th>
                        <th ttResizableColumn style="width: 20%;" class="diagnostics-perf-value">Peak Tile IDs</th>
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
                        <td class="diagnostics-cell" style="width: 50%;">
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
                        <td class="diagnostics-cell diagnostics-ellipsis diagnostics-perf-value"
                            [ngClass]="rowData.peakClass"
                            style="width: 15%;"
                            [pTooltip]="rowData.basePeakTooltip"
                            tooltipPosition="top"
                            [tooltipDisabled]="!rowData.basePeakTooltip">
                            {{ rowData.displayPeak ?? '' }}
                        </td>
                        <td class="diagnostics-cell diagnostics-ellipsis diagnostics-perf-value"
                            [ngClass]="rowData.averageClass"
                            style="width: 15%;"
                            [pTooltip]="rowData.baseAverageTooltip"
                            tooltipPosition="top"
                            [tooltipDisabled]="!rowData.baseAverageTooltip">
                            {{ rowData.displayAverage ?? '' }}
                        </td>
                        <td class="diagnostics-cell diagnostics-ellipsis diagnostics-perf-value"
                            style="width: 20%;"
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
    readonly dialogStyle: {[key: string]: string} = {
        height: '75vh'
    };
    availableMapLayers: LayerOption[] = [];
    selectedMapLayers: LayerOption[] = [];
    availableTileIds: TileIdOption[] = [];
    selectedTileIds: TileIdOption[] = [];
    treeNodes: TreeTableNode[] = [];
    private durationDisplayUnit: DurationDisplayUnit = 'ms';
    private bytesDisplayUnit: BytesDisplayUnit = 'B';
    private readonly expansionStateByPath = new Map<string, boolean>();
    private readonly subscriptions: Subscription[] = [];

    constructor(public readonly diagnostics: DiagnosticsFacadeService,
                private readonly dialogStack: DialogStackService,
                private readonly mapService: MapDataService) {
        this.subscriptions.push(
            this.diagnostics.perfStats$.subscribe(() => {
                this.refreshAvailableMapLayers();
                this.refreshAvailableTileIds();
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
        this.refreshAvailableTileIds();
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
        this.refreshAvailableTileIds();
        this.rebuildTreeNodes();
    }

    onTileIdSelectionChange() {
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

    private refreshAvailableTileIds() {
        const selectedLabels = new Set(this.selectedMapLayers.map(selection => selection.label));
        if (!selectedLabels.size) {
            this.availableTileIds = [];
            this.selectedTileIds = [];
            return;
        }

        const tileIdSet = new Set<string>();
        for (const tile of this.mapService.loadedTileLayers.values()) {
            if (!selectedLabels.has(`${tile.mapName} - ${tile.layerName}`)) {
                continue;
            }
            if (!tile.hasData() || tile.numFeatures <= 0) {
                continue;
            }
            tileIdSet.add(tile.tileId.toString());
        }

        const nextTileIds = Array.from(tileIdSet)
            .sort((left, right) => this.compareTileIdStrings(left, right))
            .map(tileId => ({label: tileId, tileId}));

        const hasSameOptions = this.isSameTileIdList(nextTileIds, this.availableTileIds);
        if (!hasSameOptions) {
            this.availableTileIds = nextTileIds;
        }

        const selectedTileIdSet = new Set(this.selectedTileIds.map(option => option.tileId));
        const validSelectedTileIds = nextTileIds.filter(option => selectedTileIdSet.has(option.tileId));
        if (!this.isSameTileIdList(validSelectedTileIds, this.selectedTileIds)) {
            this.selectedTileIds = validSelectedTileIds;
        }
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

    private isSameTileIdList(left: TileIdOption[], right: TileIdOption[]): boolean {
        if (left.length !== right.length) {
            return false;
        }
        for (let index = 0; index < left.length; index += 1) {
            if (left[index].tileId !== right[index].tileId) {
                return false;
            }
        }
        return true;
    }

    private compareTileIdStrings(left: string, right: string): number {
        try {
            const leftValue = BigInt(left);
            const rightValue = BigInt(right);
            if (leftValue < rightValue) {
                return -1;
            }
            if (leftValue > rightValue) {
                return 1;
            }
            return 0;
        } catch (_err) {
            return left.localeCompare(right);
        }
    }

    private rebuildTreeNodes() {
        const filteredStats = this.computeFilteredPerfStats();
        this.computeDisplayUnits(filteredStats);
        const nextTreeNodes = this.buildPerfTreeNodes(filteredStats);
        this.treeNodes = nextTreeNodes;
    }

    private computeFilteredPerfStats(): PerfStat[] {
        const selectedLabels = new Set(this.selectedMapLayers.map(selection => selection.label));
        if (!selectedLabels.size) {
            return [];
        }

        const selectedTileIdSet = new Set(this.selectedTileIds.map(selection => selection.tileId));
        const hasTileIdSelection = selectedTileIdSet.size > 0;

        const filteredTiles = Array.from(this.mapService.loadedTileLayers.values()).filter(tile => {
            if (!selectedLabels.has(`${tile.mapName} - ${tile.layerName}`)) {
                return false;
            }
            if (!tile.hasData() || tile.numFeatures <= 0) {
                return false;
            }
            if (!hasTileIdSelection) {
                return true;
            }
            return selectedTileIdSet.has(tile.tileId.toString());
        });
        return buildAggregatedPerfStats(filteredTiles);
    }

    private computeDisplayUnits(stats: PerfStat[]) {
        let maxAbsDurationMs = 0;
        let maxAbsBytes = 0;

        for (const stat of stats) {
            const unit = stat.unit ?? this.parsePerfUnit(stat.key) ?? this.inferCountUnitFromKey(stat.key);
            if (unit === 'ms') {
                if (this.isFiniteNumber(stat.peak)) {
                    maxAbsDurationMs = Math.max(maxAbsDurationMs, Math.abs(stat.peak));
                }
                if (this.isFiniteNumber(stat.average)) {
                    maxAbsDurationMs = Math.max(maxAbsDurationMs, Math.abs(stat.average));
                }
            }
            if (unit === 'KB' || unit === 'MB') {
                if (this.isFiniteNumber(stat.peak)) {
                    maxAbsBytes = Math.max(maxAbsBytes, Math.abs(this.toBytes(stat.peak, unit)));
                }
                if (this.isFiniteNumber(stat.average)) {
                    maxAbsBytes = Math.max(maxAbsBytes, Math.abs(this.toBytes(stat.average, unit)));
                }
            }
        }

        this.durationDisplayUnit = this.resolveDurationDisplayUnit(maxAbsDurationMs);
        this.bytesDisplayUnit = this.resolveBytesDisplayUnit(maxAbsBytes);
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
                        displayPeak: this.formatValueWithUnit(peakNumber, unit),
                        displayAverage: this.formatValueWithUnit(averageNumber, unit),
                        basePeakTooltip: this.formatBaseTooltip(peakNumber, unit),
                        baseAverageTooltip: this.formatBaseTooltip(averageNumber, unit),
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
        this.assignTimeHighlightClasses(rootNodes);
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
        rowData.displayPeak = this.formatValueWithUnit(peak, unit);
        rowData.displayAverage = this.formatValueWithUnit(average, unit);
        rowData.basePeakTooltip = this.formatBaseTooltip(peak, unit);
        rowData.baseAverageTooltip = this.formatBaseTooltip(average, unit);
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

    private assignTimeHighlightClasses(nodes: TreeTableNode[]) {
        const leafValues: number[] = [];
        const parentValuesByDepth = new Map<number, number[]>();

        const collect = (items: TreeTableNode[], depth: number) => {
            for (const node of items) {
                const rowData = this.getRowData(node);
                rowData.peakClass = undefined;
                rowData.averageClass = undefined;
                const hasChildren = !!node.children?.length;
                if (rowData.unit === 'ms') {
                    const target = hasChildren
                        ? parentValuesByDepth.get(depth) ?? []
                        : leafValues;
                    if (hasChildren && !parentValuesByDepth.has(depth)) {
                        parentValuesByDepth.set(depth, target);
                    }
                    this.collectPositiveFiniteValue(target, rowData.peak);
                    this.collectPositiveFiniteValue(target, rowData.average);
                }
                if (hasChildren) {
                    collect(node.children!, depth + 1);
                }
            }
        };
        collect(nodes, 0);

        const leafMedian = this.computeMedian(leafValues);
        const parentMediansByDepth = new Map<number, number>();
        parentValuesByDepth.forEach((values, depth) => {
            const median = this.computeMedian(values);
            if (this.isFiniteNumber(median)) {
                parentMediansByDepth.set(depth, median);
            }
        });

        const apply = (items: TreeTableNode[], depth: number) => {
            for (const node of items) {
                const rowData = this.getRowData(node);
                const hasChildren = !!node.children?.length;
                if (rowData.unit === 'ms') {
                    const median = hasChildren ? parentMediansByDepth.get(depth) : leafMedian;
                    rowData.peakClass = this.resolveSuspiciousClass(rowData.peak, median);
                    rowData.averageClass = this.resolveSuspiciousClass(rowData.average, median);
                }
                if (hasChildren) {
                    apply(node.children!, depth + 1);
                }
            }
        };
        apply(nodes, 0);
    }

    private collectPositiveFiniteValue(target: number[], value: number | undefined) {
        if (!this.isFiniteNumber(value) || value <= 0) {
            return;
        }
        target.push(value);
    }

    private computeMedian(values: number[]): number | undefined {
        if (!values.length) {
            return undefined;
        }
        const sortedValues = [...values].sort((left, right) => left - right);
        const midpoint = Math.floor(sortedValues.length / 2);
        if (sortedValues.length % 2 === 1) {
            return sortedValues[midpoint];
        }
        return (sortedValues[midpoint - 1] + sortedValues[midpoint]) / 2;
    }

    private resolveSuspiciousClass(value: number | undefined, median: number | undefined): string | undefined {
        if (!this.isFiniteNumber(value) || !this.isFiniteNumber(median) || median <= 0) {
            return undefined;
        }
        if (value >= median * 3) {
            return 'diagnostics-suspicious-bad';
        }
        if (value >= median * 2) {
            return 'diagnostics-suspicious-warn';
        }
        return undefined;
    }

    private resolveDurationDisplayUnit(maxAbsDurationMs: number): DurationDisplayUnit {
        if (maxAbsDurationMs >= 3_600_000) {
            return 'h';
        }
        if (maxAbsDurationMs >= 60_000) {
            return 'm';
        }
        if (maxAbsDurationMs >= 1_000) {
            return 's';
        }
        return 'ms';
    }

    private resolveBytesDisplayUnit(maxAbsBytes: number): BytesDisplayUnit {
        if (maxAbsBytes >= 1024 * 1024 * 1024) {
            return 'GB';
        }
        if (maxAbsBytes >= 1024 * 1024) {
            return 'MB';
        }
        if (maxAbsBytes >= 1024) {
            return 'KB';
        }
        return 'B';
    }

    private toBytes(value: number, unit: 'KB' | 'MB'): number {
        return unit === 'KB' ? value * 1024 : value * 1024 * 1024;
    }

    private fromBytesToDisplayUnit(bytes: number, unit: BytesDisplayUnit): number {
        switch (unit) {
            case 'B':
                return bytes;
            case 'KB':
                return bytes / 1024;
            case 'MB':
                return bytes / (1024 * 1024);
            case 'GB':
                return bytes / (1024 * 1024 * 1024);
        }
    }

    private fromMsToDisplayUnit(ms: number, unit: DurationDisplayUnit): number {
        switch (unit) {
            case 'ms':
                return ms;
            case 's':
                return ms / 1000;
            case 'm':
                return ms / 60_000;
            case 'h':
                return ms / 3_600_000;
        }
    }

    private formatValueWithUnit(value: number | undefined, unit: string | undefined): string | undefined {
        if (value === undefined || value === null) {
            return undefined;
        }
        if (unit === 'count') {
            return Math.round(value).toLocaleString();
        }
        if (unit === 'KB' || unit === 'MB') {
            const bytes = this.toBytes(value, unit);
            const converted = this.fromBytesToDisplayUnit(bytes, this.bytesDisplayUnit);
            return `${this.formatDecimal(converted, DISPLAY_DECIMALS)} ${this.bytesDisplayUnit}`;
        }
        if (unit === 'ms') {
            const converted = this.fromMsToDisplayUnit(value, this.durationDisplayUnit);
            return `${this.formatDecimal(converted, DISPLAY_DECIMALS)} ${this.durationDisplayUnit}`;
        }
        const formatted = this.formatDecimal(value, DISPLAY_DECIMALS);
        return unit ? `${formatted} ${unit}` : formatted;
    }

    private formatBaseTooltip(value: number | undefined, unit: string | undefined): string | undefined {
        if (value === undefined || value === null) {
            return undefined;
        }
        if (unit === 'count') {
            return `${Math.round(value).toLocaleString()} count`;
        }
        if (unit === 'KB' || unit === 'MB') {
            const bytes = this.toBytes(value, unit);
            const converted = this.fromBytesToDisplayUnit(bytes, this.bytesDisplayUnit);
            return `${this.formatDecimal(converted, DISPLAY_DECIMALS)} ${this.bytesDisplayUnit}`;
        }
        if (unit === 'ms') {
            const converted = this.fromMsToDisplayUnit(value, this.durationDisplayUnit);
            return `${this.formatDecimal(converted, DISPLAY_DECIMALS)} ${this.durationDisplayUnit}`;
        }
        if (unit) {
            const formatted = this.formatDecimal(value, DISPLAY_DECIMALS);
            return `${formatted} ${unit}`;
        }
        return this.formatDecimal(value, DISPLAY_DECIMALS);
    }

    private formatDecimal(value: number, decimals: number): string {
        return value.toFixed(decimals);
    }
}
