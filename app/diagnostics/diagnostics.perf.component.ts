import {Component, OnDestroy, ViewChild} from '@angular/core';
import {Subscription} from 'rxjs';
import {DiagnosticsFacadeService} from './diagnostics.facade.service';
import {Dialog} from 'primeng/dialog';
import {DialogStackService} from '../shared/dialog-stack.service';
import {TreeTableNode} from 'primeng/api';

const unitSuffixes: Array<{suffix: string; unit: string}> = [
    {suffix: '#ms', unit: 'ms'},
    {suffix: '#kb', unit: 'KB'},
    {suffix: '#mb', unit: 'MB'},
    {suffix: '#pct', unit: '%'},
    {suffix: '#%', unit: '%'},
    {suffix: '#count', unit: 'count'},
];

@Component({
    selector: 'diagnostics-performance-dialog',
    template: `
        <p-dialog #dialog header="Performance Statistics" class="diagnostics-performance-dialog" [(visible)]="diagnostics.performanceDialogVisible"
                  [modal]="false" (onShow)="onDialogShow()">
            <p-treeTable [value]="treeNodes" [scrollable]="true" scrollHeight="flex" class="diagnostics-perf-table"
                         [rowTrackBy]="trackNodeByPath"
                         (onNodeExpand)="onNodeExpand($event.node)"
                         (onNodeCollapse)="onNodeCollapse($event.node)">
                <ng-template pTemplate="header">
                    <tr>
                        <th>Key</th>
                        <th>Peak</th>
                        <th>Average</th>
                        <th>Peak Tile IDs</th>
                    </tr>
                </ng-template>
                <ng-template pTemplate="body" let-rowNode let-rowData="rowData">
                    <tr [ttRow]="rowNode">
                        <td>
                            <div class="diagnostics-key-cell">
                                <p-treeTableToggler [rowNode]="rowNode"></p-treeTableToggler>
                                <span>{{ rowData.key }}</span>
                            </div>
                        </td>
                        <td [pTooltip]="rowData.basePeakTooltip" tooltipPosition="top" [tooltipDisabled]="!rowData.basePeakTooltip">
                            {{ rowData.displayPeak ?? '' }}
                        </td>
                        <td [pTooltip]="rowData.baseAverageTooltip" tooltipPosition="top" [tooltipDisabled]="!rowData.baseAverageTooltip">
                            {{ rowData.displayAverage ?? '' }}
                        </td>
                        <td class="diagnostics-ellipsis" pTooltip="{{ rowData.peakTileIds ?? '' }}" tooltipPosition="left">
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
    treeNodes: TreeTableNode[] = [];
    private readonly expansionStateByPath = new Map<string, boolean>();
    private readonly subscriptions: Subscription[] = [];

    constructor(public readonly diagnostics: DiagnosticsFacadeService,
                private readonly dialogStack: DialogStackService) {
        this.subscriptions.push(
            this.diagnostics.perfStats$.subscribe(stats => {
                const nextTreeNodes = this.buildPerfTreeNodes(stats);
                this.treeNodes = nextTreeNodes;
            })
        );
    }

    ngOnDestroy() {
        this.subscriptions.forEach(sub => sub.unsubscribe());
    }

    onDialogShow() {
        this.diagnostics.refreshPerfStats();
        this.dialogStack.bringToFront(this.dialog);
    }

    openExport() {
        this.diagnostics.openExportDialog({
            includeProgress: false,
            includePerformance: true,
            includeLogs: true
        });
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

    private buildPerfTreeNodes(stats: any[]): TreeTableNode[] {
        const rootNodes: TreeTableNode[] = [];
        const nodeLookup = new Map<string, TreeTableNode>();
        const activePathKeys = new Set<string>();

        const ensureNode = (pathKey: string, label: string, parent?: TreeTableNode): TreeTableNode => {
            activePathKeys.add(pathKey);
            const existing = nodeLookup.get(pathKey);
            if (existing) {
                existing.key = pathKey;
                existing.data = {
                    key: label,
                    pathKey
                };
                existing.children = existing.children ?? [];
                return existing;
            }
            const node: TreeTableNode = {
                key: pathKey,
                data: {
                    key: label,
                    pathKey
                },
                expanded: this.expansionStateByPath.get(pathKey) ?? false,
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
                    const unit = stat.unit ?? this.parsePerfUnit(stat.key);
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
        for (const pathKey of Array.from(this.expansionStateByPath.keys())) {
            if (!activePathKeys.has(pathKey)) {
                this.expansionStateByPath.delete(pathKey);
            }
        }
        return rootNodes;
    }

    private formatValueWithUnit(value: number | undefined, unit?: string): string | undefined {
        if (value === undefined || value === null) {
            return undefined;
        }
        if (unit === 'count') {
            const intValue = Math.round(value);
            return intValue.toString();
        }
        if (unit === 'KB' || unit === 'MB') {
            const bytes = unit === 'KB' ? value * 1024 : value * 1024 * 1024;
            return this.formatBytes(bytes);
        }
        if (unit === 'ms') {
            return this.formatDurationMs(value);
        }
        const formatted = typeof value === 'number' ? value.toFixed(2) : String(value);
        return unit ? `${formatted} ${unit}` : formatted;
    }

    private formatBaseTooltip(value: number | undefined, unit?: string): string | undefined {
        if (value === undefined || value === null) {
            return undefined;
        }
        if (unit === 'count') {
            return `${Math.round(value)} count`;
        }
        if (unit) {
            const formatted = typeof value === 'number' ? value.toFixed(2) : String(value);
            return `${formatted} ${unit}`;
        }
        return typeof value === 'number' ? value.toFixed(2) : String(value);
    }

    private formatBytes(bytes: number): string {
        if (bytes < 1024) {
            return `${Math.round(bytes)} B`;
        }
        const kb = Math.floor(bytes / 1024);
        const remB = Math.round(bytes - kb * 1024);
        if (bytes < 1024 * 1024) {
            return remB > 0 ? `${kb} KB ${remB} B` : `${kb} KB`;
        }
        const mb = Math.floor(bytes / (1024 * 1024));
        const remKB = Math.floor((bytes - mb * 1024 * 1024) / 1024);
        if (bytes < 1024 * 1024 * 1024) {
            return remKB > 0 ? `${mb} MB ${remKB} KB` : `${mb} MB`;
        }
        const gb = Math.floor(bytes / (1024 * 1024 * 1024));
        const remMB = Math.floor((bytes - gb * 1024 * 1024 * 1024) / (1024 * 1024));
        return remMB > 0 ? `${gb} GB ${remMB} MB` : `${gb} GB`;
    }

    private formatDurationMs(ms: number): string {
        if (ms < 1000) {
            return `${Math.round(ms)} ms`;
        }
        const seconds = Math.floor(ms / 1000);
        const remMs = Math.round(ms - seconds * 1000);
        if (ms < 60_000) {
            return remMs > 0 ? `${seconds} s ${remMs} ms` : `${seconds} s`;
        }
        const minutes = Math.floor(seconds / 60);
        const remSec = seconds - minutes * 60;
        if (ms < 3_600_000) {
            return remSec > 0 ? `${minutes} m ${remSec} s` : `${minutes} m`;
        }
        const hours = Math.floor(minutes / 60);
        const remMin = minutes - hours * 60;
        return remMin > 0 ? `${hours} h ${remMin} m` : `${hours} h`;
    }
}
