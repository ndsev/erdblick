import {Injectable, OnDestroy} from '@angular/core';
import {AppStateService} from '../shared/appstate.service';
import {MapDataService} from '../mapdata/map.service';
import {DiagnosticsDatasource} from './diagnostics.datasource';
import {DiagnosticsExportBundle, DiagnosticsExportOptions, DiagnosticsLogFilter, LogEntry} from './diagnostics.model';

@Injectable({providedIn: 'root'})
export class DiagnosticsFacadeService extends DiagnosticsDatasource implements OnDestroy {

    constructor(mapService: MapDataService,
                private readonly stateService: AppStateService) {
        super(mapService);
    }

    openPerformanceDialog() {
        this.refreshPerfStats();
        this.stateService.diagnosticsPerformanceDialogVisible = true;
    }

    openLogDialog(errorsOnly: boolean = false) {
        this.refreshLogs();
        this.stateService.diagnosticsLogDialogVisible = true;
        if (errorsOnly) {
            this.stateService.diagnosticsLogFilter = {info: false, warn: false, error: true};
        }
    }

    openExportDialog(options?: Partial<DiagnosticsExportOptions>) {
        this.refreshPerfStats();
        this.refreshLogs();
        const base = this.stateService.diagnosticsExportOptionsState.defaultValue;
        this.stateService.diagnosticsExportOptions = {
            ...base,
            ...options,
            logFilter: {...(options?.logFilter ?? base.logFilter)}
        };
        this.stateService.diagnosticsExportDialogVisible = true;
    }

    createExportBundle(options: DiagnosticsExportOptions): DiagnosticsExportBundle {
        const snapshot = this.snapshot$.getValue();
        const perfStats = this.perfStats$.getValue();
        const logs = this.logs$.getValue();
        const metadata = {
            erdblickVersion: this.stateService.erdblickVersion.getValue() || undefined,
            distributionVersions: this.stateService.distributionVersions.getValue() || undefined,
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
            url: typeof window !== 'undefined' ? window.location.href : undefined
        };

        const bundle: DiagnosticsExportBundle = {
            exportedAt: new Date().toISOString(),
            metadata
        };

        if (options.includeProgress) {
            bundle.progress = snapshot;
        }

        if (options.includePerformance) {
            bundle.performance = {
                stats: perfStats,
                raw: undefined
            };
        }

        if (options.includeLogs) {
            bundle.logs = this.filterLogs(logs, options.logFilter);
        }

        return bundle;
    }

    downloadExportBundle(options: DiagnosticsExportOptions, filename: string = 'diagnostics-export.json') {
        const bundle = this.createExportBundle(options);
        const blob = new Blob([JSON.stringify(bundle, null, 2)], {type: 'application/json'});
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        window.URL.revokeObjectURL(url);
    }

    filterLogs(logs: LogEntry[], filter: DiagnosticsLogFilter): LogEntry[] {
        return logs.filter(entry => {
            if (entry.level === 'info') {
                return filter.info;
            }
            if (entry.level === 'warn') {
                return filter.warn;
            }
            return filter.error;
        });
    }

    override ngOnDestroy(): void {
        super.ngOnDestroy();
    }
}
