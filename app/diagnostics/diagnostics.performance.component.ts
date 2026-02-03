import {Component, ViewChild} from '@angular/core';
import {map} from 'rxjs';
import {DiagnosticsFacadeService} from './diagnostics.facade.service';
import {buildPerfTreeNodes} from './diagnostics.utils';
import {Dialog} from 'primeng/dialog';
import {DialogStackService} from '../shared/dialog-stack.service';

@Component({
    selector: 'diagnostics-performance-dialog',
    template: `
        <p-dialog #dialog header="Performance Statistics" class="diagnostics-performance-dialog" [(visible)]="diagnostics.performanceDialogVisible"
                  [modal]="false" (onShow)="onDialogShow()">
            @if (treeNodes$ | async; as treeNodes) {
                <p-treeTable [value]="treeNodes" [scrollable]="true" scrollHeight="flex" class="diagnostics-perf-table">
                    <ng-template pTemplate="header">
                        <tr>
                            <th>Key</th>
                            <th>Peak</th>
                            <th>Average</th>
                            <th>Unit</th>
                            <th>Peak Tile IDs</th>
                        </tr>
                    </ng-template>
                    <ng-template pTemplate="body" let-rowNode let-rowData="rowData">
                        <tr [ttRow]="rowNode" [ngClass]="rowData.suspicious ? 'diagnostics-suspicious-' + rowData.suspicious : ''">
                            <td>
                                <div class="diagnostics-key-cell">
                                    <p-treeTableToggler [rowNode]="rowNode"></p-treeTableToggler>
                                    <span>{{ rowData.key }}</span>
                                    @if (rowData.suspicious === 'warn') {
                                        <span class="material-symbols-outlined diagnostics-warn">warning</span>
                                    }
                                    @if (rowData.suspicious === 'bad') {
                                        <span class="material-symbols-outlined diagnostics-bad">error</span>
                                    }
                                </div>
                            </td>
                            <td>
                                @if (rowData.peak !== undefined) {
                                    {{ rowData.peak | number: '1.0-2' }}
                                }
                            </td>
                            <td>
                                @if (rowData.average !== undefined) {
                                    {{ rowData.average | number: '1.0-2' }}
                                }
                            </td>
                            <td>{{ rowData.unit ?? '' }}</td>
                            <td class="diagnostics-ellipsis" pTooltip="{{ rowData.peakTileIds ?? '' }}" tooltipPosition="left">
                                {{ rowData.peakTileIds ?? '' }}
                            </td>
                        </tr>
                    </ng-template>
                    <ng-template pTemplate="emptymessage">
                        <tr>
                            <td colspan="5">No performance statistics available.</td>
                        </tr>
                    </ng-template>
                </p-treeTable>
            }
            <div class="diagnostics-dialog-actions">
                <p-button label="Export" (click)="openExport()" />
            </div>
        </p-dialog>
    `,
    styles: [``],
    standalone: false
})
export class DiagnosticsPerformanceDialogComponent {
    @ViewChild('dialog') dialog?: Dialog;
    readonly treeNodes$ = this.diagnostics.perfStats$.pipe(
        map(stats => buildPerfTreeNodes(stats))
    );

    constructor(public readonly diagnostics: DiagnosticsFacadeService,
                private readonly dialogStack: DialogStackService) {}

    onDialogShow() {
        this.dialogStack.bringToFront(this.dialog);
    }

    openExport() {
        this.diagnostics.openExportDialog({
            includeProgress: false,
            includePerformance: true,
            includeLogs: true
        });
    }
}
