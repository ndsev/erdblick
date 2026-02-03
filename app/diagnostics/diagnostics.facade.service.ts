import {Inject, Injectable} from '@angular/core';
import {BehaviorSubject} from 'rxjs';
import {AppStateService} from '../shared/appstate.service';
import {DIAGNOSTICS_DATA_SOURCE, DiagnosticsDataSource} from './diagnostics.datasource';
import {DiagnosticsExportBundle, DiagnosticsSnapshot, LogEntry, PerfStat} from './diagnostics.model';

export interface DiagnosticsLogFilter {
    info: boolean;
    warn: boolean;
    error: boolean;
}

export interface DiagnosticsExportOptions {
    includeProgress: boolean;
    includePerformance: boolean;
    includeLogs: boolean;
    logFilter: DiagnosticsLogFilter;
}

@Injectable({providedIn: 'root'})
export class DiagnosticsFacadeService {
    readonly snapshot$ = this.dataSource.snapshot$;
    readonly perfStats$ = this.dataSource.perfStats$;
    readonly logs$ = this.dataSource.logs$;

    progressDialogVisible = false;
    performanceDialogVisible = false;
    logDialogVisible = false;
    exportDialogVisible = false;

    private readonly logFilterState = new BehaviorSubject<DiagnosticsLogFilter>({
        info: true,
        warn: true,
        error: true
    });

    private readonly exportOptionsState = new BehaviorSubject<DiagnosticsExportOptions>(this.defaultExportOptions());

    private latestSnapshot?: DiagnosticsSnapshot;
    private latestPerfStats: PerfStat[] = [];
    private latestLogs: LogEntry[] = [];

    constructor(@Inject(DIAGNOSTICS_DATA_SOURCE) private readonly dataSource: DiagnosticsDataSource,
                private readonly stateService: AppStateService) {
        this.snapshot$.subscribe(snapshot => {
            this.latestSnapshot = snapshot;
        });
        this.perfStats$.subscribe(stats => {
            this.latestPerfStats = stats;
        });
        this.logs$.subscribe(logs => {
            this.latestLogs = logs;
        });
    }

    get logFilter() {
        return this.logFilterState.getValue();
    }

    setLogFilter(filter: DiagnosticsLogFilter) {
        this.logFilterState.next({...filter});
    }

    get logFilter$() {
        return this.logFilterState.asObservable();
    }

    get exportOptions() {
        return this.exportOptionsState.getValue();
    }

    setExportOptions(options: DiagnosticsExportOptions) {
        this.exportOptionsState.next({
            ...options,
            logFilter: {...options.logFilter}
        });
    }

    get exportOptions$() {
        return this.exportOptionsState.asObservable();
    }

    openProgressDialog() {
        this.progressDialogVisible = true;
    }

    openPerformanceDialog() {
        this.performanceDialogVisible = true;
    }

    openLogDialog(errorsOnly: boolean = false) {
        this.logDialogVisible = true;
        if (errorsOnly) {
            this.setLogFilter({info: false, warn: false, error: true});
        }
    }

    openExportDialog(options?: Partial<DiagnosticsExportOptions>) {
        const base = this.defaultExportOptions();
        this.setExportOptions({
            ...base,
            ...options,
            logFilter: {...(options?.logFilter ?? base.logFilter)}
        });
        this.exportDialogVisible = true;
    }

    createExportBundle(options: DiagnosticsExportOptions): DiagnosticsExportBundle {
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

        if (options.includeProgress && this.latestSnapshot) {
            bundle.progress = this.latestSnapshot;
        }

        if (options.includePerformance) {
            bundle.performance = {
                stats: this.latestPerfStats,
                raw: undefined
            };
        }

        if (options.includeLogs) {
            bundle.logs = this.filterLogs(this.latestLogs, options.logFilter);
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

    private defaultExportOptions(): DiagnosticsExportOptions {
        return {
            includeProgress: true,
            includePerformance: true,
            includeLogs: true,
            logFilter: {
                info: true,
                warn: true,
                error: true
            }
        };
    }
}
