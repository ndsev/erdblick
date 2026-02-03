import {Component, OnDestroy, ViewChild} from '@angular/core';
import {Subscription} from 'rxjs';
import {DiagnosticsExportOptions, DiagnosticsFacadeService} from './diagnostics.facade.service';
import {Dialog} from 'primeng/dialog';
import {DialogStackService} from '../shared/dialog-stack.service';

@Component({
    selector: 'diagnostics-export-dialog',
    template: `
        <p-dialog #dialog header="Export Diagnostics Data" class="diagnostics-export-dialog" [(visible)]="diagnostics.exportDialogVisible"
                  [modal]="false" (onShow)="onDialogShow()">
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
                    <p-button label="Export JSON" [disabled]="!canExport" (click)="export()" />
                </div>
            </div>
        </p-dialog>
    `,
    styles: [``],
    standalone: false
})
export class DiagnosticsExportDialogComponent implements OnDestroy {
    @ViewChild('dialog') dialog?: Dialog;
    exportOptions: DiagnosticsExportOptions = this.diagnostics.exportOptions;

    private readonly subscriptions: Subscription[] = [];

    constructor(public readonly diagnostics: DiagnosticsFacadeService,
                private readonly dialogStack: DialogStackService) {
        this.subscriptions.push(
            this.diagnostics.exportOptions$.subscribe(options => {
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
        this.diagnostics.setExportOptions({
            ...this.exportOptions,
            logFilter: {...this.exportOptions.logFilter}
        });
    }

    export() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `diagnostics-${timestamp}.json`;
        this.diagnostics.downloadExportBundle(this.exportOptions, filename);
    }
}
