import {Component, OnDestroy, ViewChild} from '@angular/core';
import {BehaviorSubject, combineLatest, map, Subscription} from 'rxjs';
import {DiagnosticsFacadeService} from './diagnostics.facade.service';
import type {DiagnosticsLogFilter} from './diagnostics.model';
import {Dialog} from 'primeng/dialog';
import {DialogStackService} from '../shared/dialog-stack.service';
import {AppStateService} from '../shared/appstate.service';

@Component({
    selector: 'diagnostics-log-dialog',
    template: `
        <p-dialog #dialog header="Diagnostics Log" class="diagnostics-log-dialog"
                  [(visible)]="stateService.diagnosticsLogDialogVisible"
                  [modal]="false"
                  [style]="dialogStyle"
                  (onShow)="onDialogShow()">
            <div class="diagnostics-log-controls">
                <div class="diagnostics-log-filters">
                    <p-checkbox inputId="diag-log-info" [(ngModel)]="logFilter.info" [binary]="true"
                                (ngModelChange)="updateFilter()"></p-checkbox>
                    <label for="diag-log-info">Info</label>
                    <p-checkbox inputId="diag-log-warn" [(ngModel)]="logFilter.warn" [binary]="true"
                                (ngModelChange)="updateFilter()"></p-checkbox>
                    <label for="diag-log-warn">Warnings</label>
                    <p-checkbox inputId="diag-log-error" [(ngModel)]="logFilter.error" [binary]="true"
                                (ngModelChange)="updateFilter()"></p-checkbox>
                    <label for="diag-log-error">Errors</label>
                </div>
                <div class="diagnostics-log-actions">
                    @if (stateService.diagnosticsLogFilterState | async; as filterState) {
                        @if (filterState.error && !filterState.warn && !filterState.info) {
                            <p-button size="small" label="Show all" (click)="unsetAllFilter()"/>
                        } @else {
                            <p-button size="small" label="Only errors" (click)="setErrorsOnly()"/>
                        }
                    }
                    <div class="diagnostics-log-sort">
                        <p-selectbutton [options]="sortOrderOptions"
                                        optionLabel="label"
                                        optionValue="value"
                                        [(ngModel)]="sortOrder"
                                        (ngModelChange)="setSortOrder($event)"></p-selectbutton>
                    </div>
                </div>
            </div>

            <div class="diagnostics-log-table">
                @if (filteredLogs$ | async; as logs) {
                    <p-table #dt2
                             [value]="logs"
                             [globalFilterFields]="['at', 'level', 'message']"
                             [scrollable]="true"
                             scrollHeight="flex"
                             [rowTrackBy]="trackByLogRow">
                        <ng-template pTemplate="caption">
                            <div class="diagnostics-log-caption">
                                <p-iconfield iconPosition="left" class="diagnostics-log-caption-search">
                                    <p-inputicon>
                                        <i class="pi pi-filter"></i>
                                    </p-inputicon>
                                    <input #globalFilterInput
                                           pInputText
                                           type="text"
                                           (input)="dt2.filterGlobal(globalFilterInput.value, 'contains')"
                                           placeholder="Filter">
                                </p-iconfield>
                            </div>
                        </ng-template>
                        <ng-template pTemplate="header">
                            <tr>
                                <th>Timestamp</th>
                                <th>Level</th>
                                <th>Message</th>
                            </tr>
                        </ng-template>
                        <ng-template pTemplate="body" let-entry>
                            <tr [ngClass]="'diagnostics-log-' + entry.level">
                                <td>{{ entry.at }}</td>
                                <td>{{ entry.level }}</td>
                                <td>{{ entry.message }}</td>
                            </tr>
                        </ng-template>
                        <ng-template pTemplate="emptymessage">
                            <tr>
                                <td colspan="3">
                                    <div class="diagnostics-empty">No log entries for selected levels.</div>
                                </td>
                            </tr>
                        </ng-template>
                    </p-table>
                }
            </div>

            <div class="diagnostics-log-footer">
                <p-button size="small" label="Export" (click)="openExport()"/>
            </div>
        </p-dialog>
    `,
    styles: [``],
    standalone: false
})
export class DiagnosticsLogDialogComponent implements OnDestroy {
    @ViewChild('dialog') dialog?: Dialog;
    readonly dialogStyle: {[key: string]: string} = {
        height: '75vh'
    };
    sortOrder: 'asc' | 'desc' = 'desc';
    readonly sortOrderOptions: Array<{label: string; value: 'desc' | 'asc'}> = [
        {label: 'Newest first', value: 'desc'},
        {label: 'Newest last', value: 'asc'}
    ];
    private readonly sortOrder$ = new BehaviorSubject<'asc' | 'desc'>(this.sortOrder);
    readonly filteredLogs$ = combineLatest([
        this.diagnostics.logs$,
        this.stateService.diagnosticsLogFilterState,
        this.sortOrder$
    ]).pipe(
        map(([logs, filter, sortOrder]) => {
            const filtered = this.diagnostics.filterLogs(logs, filter);
            return [...filtered].sort((a, b) => sortOrder === 'desc' ? b.at - a.at : a.at - b.at);
        })
    );

    logFilter: DiagnosticsLogFilter = {
        info: true,
        warn: true,
        error: true
    };

    private readonly subscriptions: Subscription[] = [];

    constructor(public readonly diagnostics: DiagnosticsFacadeService,
                public readonly stateService: AppStateService,
                private readonly dialogStack: DialogStackService) {
        this.subscriptions.push(
            this.stateService.diagnosticsLogFilterState.subscribe(filter => {
                this.logFilter = {...filter};
            })
        );
    }

    ngOnDestroy() {
        this.subscriptions.forEach(sub => sub.unsubscribe());
    }

    onDialogShow() {
        this.diagnostics.refreshLogs();
        this.dialogStack.bringToFront(this.dialog);
    }

    updateFilter() {
        this.stateService.diagnosticsLogFilter = {...this.logFilter};
    }

    setSortOrder(order: 'asc' | 'desc') {
        this.sortOrder = order;
        this.sortOrder$.next(order);
    }

    trackByLogRow = (index: number, entry: {at: number; level: string; message: string}): string => {
        return `${entry.at}:${entry.level}:${entry.message}:${index}`;
    };

    setErrorsOnly() {
        this.stateService.diagnosticsLogFilter = {info: false, warn: false, error: true};
    }

    openExport() {
        this.diagnostics.openExportDialog({
            includeProgress: false,
            includePerformance: false,
            includeLogs: true,
            logFilter: {...this.logFilter}
        });
    }

    unsetAllFilter() {
        this.stateService.diagnosticsLogFilter = {info: true, warn: true, error: true};
    }
}
