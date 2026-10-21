import { Injectable,NgZone,OnDestroy } from "@angular/core";
import { BehaviorSubject } from "rxjs";
import { z } from "zod";
import { MapTileStreamService } from '../mapdata/map-tile-stream.service';
import { TileSubsetLayerRenderService } from '../mapview/deck/tile-subset-layer-render.service';
import { ViewLayerDiagnosticsService } from '../mapview/view-layer-diagnostics.service';
import { AppConfigService } from "../shared/app-config.service";
import { AppLayoutService } from "../shared/app-layout.service";
import { Boolish } from "../shared/app-state";
import { DIAGNOSTICS_EXPORT_DIALOG_LAYOUT_ID,DIAGNOSTICS_LOG_DIALOG_LAYOUT_ID,DIAGNOSTICS_PERFORMANCE_DIALOG_LAYOUT_ID } from "../shared/app-state.model";
import { AppStateService } from "../shared/appstate.service";
import { StyleValidationReportService } from '../styledata/style-validation-report.service';
import { DiagnosticsDatasource } from './diagnostics.datasource';
import type { DiagnosticsExportOptions,DiagnosticsLogFilter } from "./diagnostics.model";
import {
DiagnosticsExportBundle,
LogEntry,
PerformanceDiagnosticsScope,
TileSizeDistribution
} from './diagnostics.model';

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

    readonly diagnosticsLogFilterState = this.stateService.registerState<DiagnosticsLogFilter>({
        name: 'diagnosticsLogFilter',
        defaultValue: {
            info: true,
            warn: true,
            error: true
        },
        schema: z.object({
            info: Boolish,
            warn: Boolish,
            error: Boolish
        })
    });


    readonly diagnosticsExportOptionsState = this.stateService.registerState<DiagnosticsExportOptions>({
        name: 'diagnosticsExportOptions',
        defaultValue: {
            includeProgress: true,
            includePerformance: true,
            includeLogs: true,
            logFilter: {
                info: true,
                warn: true,
                error: true
            }
        },
        schema: z.object({
            includeProgress: Boolish,
            includePerformance: Boolish,
            includeLogs: Boolish,
            logFilter: z.object({
                info: Boolish,
                warn: Boolish,
                error: Boolish
            })
        })
    });

    get diagnosticsLogFilter() {return this.diagnosticsLogFilterState.getValue();}

    set diagnosticsLogFilter(val: DiagnosticsLogFilter) {
        this.diagnosticsLogFilterState.next({...val});
    }

    get diagnosticsExportOptions() {return this.diagnosticsExportOptionsState.getValue();}

    set diagnosticsExportOptions(val: DiagnosticsExportOptions) {
        this.diagnosticsExportOptionsState.next({
            ...val,
            logFilter: {...val.logFilter}
        });
    }

    readonly performanceScope$ = new BehaviorSubject<PerformanceDiagnosticsScope | null>(null);
    private nextPerformanceScopeRequestId = 1;

    constructor(mapService: MapTileStreamService,
                renderService: TileSubsetLayerRenderService,
                viewDiagnostics: ViewLayerDiagnosticsService,
                private readonly stateService: AppStateService,
                styleValidationReportService: StyleValidationReportService,
                ngZone: NgZone,
        public override readonly layout: AppLayoutService,
        public readonly configService: AppConfigService) {
        super(mapService, renderService, viewDiagnostics, stateService,
            styleValidationReportService, ngZone, layout);
    }

    /** Opens the performance dialog after refreshing the current aggregated stats. */
    openPerformanceDialog(scope?: PerformanceDiagnosticsScope) {
        this.performanceScope$.next(scope ? {
            ...scope,
            requestId: this.nextPerformanceScopeRequestId++
        } : null);
        this.refreshPerfStats();
        this.layout.openDialog(DIAGNOSTICS_PERFORMANCE_DIALOG_LAYOUT_ID);
    }

    /** Opens the log dialog and optionally prefilters it to errors only. */
    openLogDialog(errorsOnly: boolean = false) {
        this.refreshLogs();
        this.layout.openDialog(DIAGNOSTICS_LOG_DIALOG_LAYOUT_ID);
        if (errorsOnly) {
            this.diagnosticsLogFilter = {info: false, warn: false, error: true};
        }
    }

    /** Opens the export dialog with optional preselected export options. */
    openExportDialog(options?: Partial<DiagnosticsExportOptions>) {
        this.refreshPerfStats();
        this.refreshLogs();
        const base = this.diagnosticsExportOptionsState.defaultValue;
        this.diagnosticsExportOptions = {
            ...base,
            ...options,
            logFilter: {...(options?.logFilter ?? base.logFilter)}
        };
        this.layout.openDialog(DIAGNOSTICS_EXPORT_DIALOG_LAYOUT_ID);
    }

    /** Builds the export bundle from the currently cached diagnostics data. */
    createExportBundle(options: DiagnosticsExportOptions): DiagnosticsExportBundle {
        const snapshot = this.snapshot$.getValue();
        const perfStats = this.perfStats$.getValue();
        const logs = this.logs$.getValue();
        const metadata = {
            erdblickVersion: this.configService.erdblickVersion.getValue() || undefined,
            distributionVersions: this.configService.distributionVersions.getValue() || undefined,
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
