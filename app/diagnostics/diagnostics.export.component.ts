import {Component, OnDestroy, ViewChild} from '@angular/core';
import {Subscription} from 'rxjs';
import {DiagnosticsFacadeService} from './diagnostics.facade.service';
import type {DiagnosticsExportOptions} from './diagnostics.model';
import {DialogStackService} from '../shared/dialog-stack.service';
import {AppStateService} from '../shared/appstate.service';
import {AppDialogComponent} from '../shared/app-dialog.component';

@Component({
    selector: 'diagnostics-export-dialog',
    template: `
        <app-dialog #dialog header="Export Diagnostics Data" class="diagnostics-export-dialog" [(visible)]="stateService.diagnosticsExportDialogVisible"
                  [modal]="false" [persistLayout]="true" [layoutId]="layoutId" (onShow)="onDialogShow()">
            <div class="diagnostics-export-content">
                <div class="diagnostics-export-section">
                    <div class="diagnostics-label">Include</div>
                    <div class="diagnostics-export-options">
                        <p-checkbox inputId="diag-export-progress" [(ngModel)]="exportOptions.includeProgress" [binary]="true" (ngModelChange)="updateOptions()"></p-checkbox>
                        <label for="diag-export-progress">Progress</label>
                        <p-checkbox inputId="diag-export-performance" [(ngModel)]="exportOptions.includePerformance" [binary]="true" (ngModelChange)="updateOptions()"></p-checkbox>
                        <label for="diag-export-performance">Performance</label>
                        <p-checkbox inputId="diag-export-logs" [(ngModel)]="exportOptions.includeLogs" [binary]="true" (ngModelChange)="updateOptions()"></p-checkbox>
                        <label for="diag-export-logs">Logs</label>
                    </div>
                </div>

                <div class="diagnostics-export-section" [class.hidden]="!exportOptions.includeLogs">
                    <div class="diagnostics-label">Log levels</div>
                    <div class="diagnostics-export-options">
                        <p-checkbox inputId="diag-export-info" [(ngModel)]="exportOptions.logFilter.info" [binary]="true" (ngModelChange)="updateOptions()"></p-checkbox>
                        <label for="diag-export-info">Info</label>
                        <p-checkbox inputId="diag-export-warn" [(ngModel)]="exportOptions.logFilter.warn" [binary]="true" (ngModelChange)="updateOptions()"></p-checkbox>
                        <label for="diag-export-warn">Warnings</label>
                        <p-checkbox inputId="diag-export-error" [(ngModel)]="exportOptions.logFilter.error" [binary]="true" (ngModelChange)="updateOptions()"></p-checkbox>
                        <label for="diag-export-error">Errors</label>
                    </div>
                </div>

                <div class="diagnostics-dialog-actions">
                    <p-button label="Export JSON" [disabled]="!canExport || exporting" (click)="export()" />
                </div>
            </div>
        </app-dialog>
    `,
    styles: [``],
    standalone: false
})
export class DiagnosticsExportDialogComponent implements OnDestroy {
    readonly layoutId = 'diagnostics-export';
    @ViewChild('dialog') dialog?: AppDialogComponent;
    exporting = false;
    exportOptions: DiagnosticsExportOptions = {
        includeProgress: true,
        includePerformance: true,
        includeLogs: true,
        logFilter: {
            info: true,
            warn: true,
            error: true
        }
    };

    private readonly subscriptions: Subscription[] = [];

    constructor(public readonly diagnostics: DiagnosticsFacadeService,
                public readonly stateService: AppStateService,
                private readonly dialogStack: DialogStackService) {
        const options = this.stateService.diagnosticsExportOptions;
        this.exportOptions = {
            ...options,
            logFilter: {...options.logFilter}
        };
        this.subscriptions.push(
            this.stateService.diagnosticsExportOptionsState.subscribe(options => {
                this.exportOptions = {
                    ...options,
                    logFilter: {...options.logFilter}
                };
            })
        );
    }

    ngOnDestroy() {
        this.subscriptions.forEach(sub => sub.unsubscribe());
    }

    onDialogShow() {
        this.dialogStack.bringToFront(this.dialog);
    }

    get canExport(): boolean {
        return this.exportOptions.includeProgress || this.exportOptions.includePerformance || this.exportOptions.includeLogs;
    }

    updateOptions() {
        this.stateService.diagnosticsExportOptions = {
            ...this.exportOptions,
            logFilter: {...this.exportOptions.logFilter}
        };
    }

    async export() {
        if (this.exporting) {
            return;
        }

        this.exporting = true;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `diagnostics-${timestamp}.json`;
        try {
            await this.diagnostics.downloadExportBundle(this.exportOptions, filename);
        } finally {
            this.exporting = false;
        }
    }
}
