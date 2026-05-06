import {Injectable, OnDestroy} from '@angular/core';
import {
    AppStateService,
    DIAGNOSTICS_EXPORT_DIALOG_LAYOUT_ID,
    DIAGNOSTICS_LOG_DIALOG_LAYOUT_ID,
    DIAGNOSTICS_PERFORMANCE_DIALOG_LAYOUT_ID
} from '../shared/appstate.service';
import {MapDataService} from '../mapdata/map.service';
import {DiagnosticsDatasource} from './diagnostics.datasource';
import {
    DiagnosticsExportBundle,
    DiagnosticsExportOptions,
    DiagnosticsLogFilter,
    LogEntry,
    TileSizeDistribution
} from './diagnostics.model';
import {StyleValidationReportService} from '../styledata/style-validation-report.service';

interface MapgetStatusDataResponse {
    timestampMs?: unknown;
    service?: {
        datasources?: unknown;
        'active-requests'?: unknown;
        'cached-feature-tile-size-distribution'?: unknown;
    };
    cache?: unknown;
    tilesWebsocket?: unknown;
}

@Injectable({providedIn: 'root'})
/**
 * High-level diagnostics service used by the UI.
 *
 * It extends the datasource with dialog-opening helpers and export bundling.
 */
export class DiagnosticsFacadeService extends DiagnosticsDatasource implements OnDestroy {

    constructor(mapService: MapDataService,
                private readonly stateService: AppStateService,
                styleValidationReportService: StyleValidationReportService) {
        super(mapService, stateService, styleValidationReportService);
    }

    /** Opens the performance dialog after refreshing the current aggregated stats. */
    openPerformanceDialog() {
        this.refreshPerfStats();
        this.stateService.openDialog(DIAGNOSTICS_PERFORMANCE_DIALOG_LAYOUT_ID);
    }

    /** Opens the log dialog and optionally prefilters it to errors only. */
    openLogDialog(errorsOnly: boolean = false) {
        this.refreshLogs();
        this.stateService.openDialog(DIAGNOSTICS_LOG_DIALOG_LAYOUT_ID);
        if (errorsOnly) {
            this.stateService.diagnosticsLogFilter = {info: false, warn: false, error: true};
        }
    }

    /** Opens the export dialog with optional preselected export options. */
    openExportDialog(options?: Partial<DiagnosticsExportOptions>) {
        this.refreshPerfStats();
        this.refreshLogs();
        const base = this.stateService.diagnosticsExportOptionsState.defaultValue;
        this.stateService.diagnosticsExportOptions = {
            ...base,
            ...options,
            logFilter: {...(options?.logFilter ?? base.logFilter)}
        };
        this.stateService.openDialog(DIAGNOSTICS_EXPORT_DIALOG_LAYOUT_ID);
    }

    /** Builds the export bundle from the currently cached diagnostics data. */
    createExportBundle(options: DiagnosticsExportOptions): DiagnosticsExportBundle {
        const snapshot = this.snapshot$.getValue();
        const perfStats = this.perfStats$.getValue();
        const logs = this.logs$.getValue();
        const metadata = {
            erdblickVersion: this.stateService.erdblickVersion.getValue() || undefined,
            distributionVersions: this.stateService.distributionVersions.getValue() || undefined,
            userAgent: navigator.userAgent,
            url: window.location.href
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

    /** Downloads a diagnostics export bundle, enriching it with backend status when available. */
    async downloadExportBundle(options: DiagnosticsExportOptions, filename: string = 'diagnostics-export.json'): Promise<void> {
        const bundle = this.createExportBundle(options);
        await this.enrichBundleWithMapgetStatus(bundle);
        const blob = new Blob([JSON.stringify(bundle, null, 2)], {type: 'application/json'});
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        window.URL.revokeObjectURL(url);
    }

    /** Applies the active log-level filter to a log entry list. */
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

    /** Fetches `/status-data` and attaches the relevant parts to the export bundle. */
    private async enrichBundleWithMapgetStatus(bundle: DiagnosticsExportBundle): Promise<void> {
        const statusQuery = '/status-data?includeTileSizeDistribution=1&includeCachedFeatureTreeBytes=0';

        try {
            const response = await fetch(statusQuery, {cache: 'no-store'});
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText || 'Failed to fetch /status-data'}`);
            }

            const statusData = (await response.json()) as MapgetStatusDataResponse;
            const serviceData = statusData.service;
            const timestampMs = typeof statusData.timestampMs === 'number' ? statusData.timestampMs : undefined;
            const tileSizeDistribution = this.getTileSizeDistribution(serviceData?.['cached-feature-tile-size-distribution']);

            bundle.backendStatus = {
                timestampMs,
                service: serviceData ? {
                    datasources: serviceData.datasources,
                    'active-requests': serviceData['active-requests']
                } : undefined,
                cache: statusData.cache,
                tilesWebsocket: statusData.tilesWebsocket
            };

            if (tileSizeDistribution) {
                bundle.backendStatus.tileSizeDistribution = tileSizeDistribution;
            }
        } catch (error) {
            bundle.metadata.backendStatusFetchError = this.stringifyError(error);
        }
    }

    /** Returns the cached tile-size distribution payload when it has the expected shape. */
    private getTileSizeDistribution(value: unknown): TileSizeDistribution | undefined {
        if (!value || typeof value !== 'object') {
            return undefined;
        }

        return value as TileSizeDistribution;
    }

    /** Formats fetch/enrichment errors for inclusion in the export bundle metadata. */
    private stringifyError(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }

    /** Narrows visibility only to expose the inherited destroy hook for Angular. */
    override ngOnDestroy(): void {
        super.ngOnDestroy();
    }
}
