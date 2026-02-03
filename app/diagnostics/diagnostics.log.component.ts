import {Component, OnDestroy, ViewChild} from '@angular/core';
import {combineLatest, map, Subscription} from 'rxjs';
import {DiagnosticsFacadeService, DiagnosticsLogFilter} from './diagnostics.facade.service';
import {Dialog} from 'primeng/dialog';
import {DialogStackService} from '../shared/dialog-stack.service';

@Component({
    selector: 'diagnostics-log-dialog',
    template: `
        <p-dialog #dialog header="Diagnostics Log" class="diagnostics-log-dialog" [(visible)]="diagnostics.logDialogVisible"
                  [modal]="false" (onShow)="onDialogShow()">
            <div class="diagnostics-log-controls">
                <div class="diagnostics-log-filters">
                    <p-checkbox inputId="diag-log-info" [(ngModel)]="logFilter.info" [binary]="true" (ngModelChange)="updateFilter()"></p-checkbox>
                    <label for="diag-log-info">Info</label>
                    <p-checkbox inputId="diag-log-warn" [(ngModel)]="logFilter.warn" [binary]="true" (ngModelChange)="updateFilter()"></p-checkbox>
                    <label for="diag-log-warn">Warnings</label>
                    <p-checkbox inputId="diag-log-error" [(ngModel)]="logFilter.error" [binary]="true" (ngModelChange)="updateFilter()"></p-checkbox>
                    <label for="diag-log-error">Errors</label>
                </div>
                <div class="diagnostics-log-actions">
                    <p-button size="small" label="Only errors" (click)="setErrorsOnly()" />
                    <p-button size="small" label="Export" (click)="openExport()" />
                </div>
            </div>

            <div class="diagnostics-log-table">
                @if (filteredLogs$ | async; as logs) {
                    <table>
                        <thead>
                            <tr>
                                <th>Time</th>
                                <th>Level</th>
                                <th>Message</th>
                            </tr>
                        </thead>
                        <tbody>
                            @for (entry of logs; track entry.at) {
                                <tr [ngClass]="'diagnostics-log-' + entry.level">
                                    <td>{{ entry.at | date: 'mediumTime' }}</td>
                                    <td>{{ entry.level }}</td>
                                    <td>{{ entry.message }}</td>
                                </tr>
                            }
                        </tbody>
                    </table>
                    @if (logs.length === 0) {
                        <div class="diagnostics-empty">No log entries for selected levels.</div>
                    }
                }
            </div>
        </p-dialog>
    `,
    styles: [``],
    standalone: false
})
export class DiagnosticsLogDialogComponent implements OnDestroy {
    @ViewChild('dialog') dialog?: Dialog;
    readonly filteredLogs$ = combineLatest([
        this.diagnostics.logs$,
        this.diagnostics.logFilter$
    ]).pipe(
        map(([logs, filter]) => this.diagnostics.filterLogs(logs, filter))
    );

    logFilter: DiagnosticsLogFilter = {
        info: true,
        warn: true,
        error: true
    };

    private readonly subscriptions: Subscription[] = [];

    constructor(public readonly diagnostics: DiagnosticsFacadeService,
                private readonly dialogStack: DialogStackService) {
        this.subscriptions.push(
            this.diagnostics.logFilter$.subscribe(filter => {
                this.logFilter = {...filter};
            })
        );
    }

    ngOnDestroy() {
        this.subscriptions.forEach(sub => sub.unsubscribe());
    }

    onDialogShow() {
        this.dialogStack.bringToFront(this.dialog);
    }

    updateFilter() {
        this.diagnostics.setLogFilter({...this.logFilter});
    }

    setErrorsOnly() {
        this.diagnostics.setLogFilter({info: false, warn: false, error: true});
    }

    openExport() {
        this.diagnostics.openExportDialog({
            includeProgress: false,
            includePerformance: false,
            includeLogs: true,
            logFilter: {...this.logFilter}
        });
    }
}
