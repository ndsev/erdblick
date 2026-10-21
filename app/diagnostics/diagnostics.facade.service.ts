import { Injectable, NgZone, OnDestroy } from "@angular/core";
import { BehaviorSubject } from "rxjs";
import { z } from "zod";
import type { ActionInput, ActionOutput } from "../actions/app-action";
import { boundedCollection, rejectAction } from "../actions/app-action";
import { AppActionService } from "../actions/app-action.service";
import { MapInfoService } from "../mapdata/map-info.service";
import { MapTileStreamService } from '../mapdata/map-tile-stream.service';
import { TileSubsetLayerRenderService } from '../mapview/deck/tile-subset-layer-render.service';
import { MapViewStateService } from "../mapview/map-view-state.service";
import { ViewLayerDiagnosticsService } from '../mapview/view-layer-diagnostics.service';
import { FeatureSearchService } from "../search/feature.search.service";
import { AppConfigService } from "../shared/app-config.service";
import {
    DIAGNOSTICS_EXPORT_DIALOG_LAYOUT_ID,
    DIAGNOSTICS_LOG_DIALOG_LAYOUT_ID,
    DIAGNOSTICS_PERFORMANCE_DIALOG_LAYOUT_ID
} from "../shared/app-layout.model";
import { AppLayoutService } from "../shared/app-layout.service";
import { Boolish } from "../shared/app-state";
import { AppStateService } from "../shared/appstate.service";
import { unicodePrefix } from "../shared/unicode-string";
import { StyleValidationReportService } from '../styledata/style-validation-report.service';
import { DiagnosticsDatasource } from './diagnostics.datasource';
import { diagnosticActions } from "./diagnostics.facade.service.declarations";
import type { DiagnosticsExportOptions, DiagnosticsLogFilter } from "./diagnostics.model";
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

@Injectable({ providedIn: 'root' })
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

    get diagnosticsLogFilter() { return this.diagnosticsLogFilterState.getValue(); }

    set diagnosticsLogFilter(val: DiagnosticsLogFilter) {
        this.diagnosticsLogFilterState.next({ ...val });
    }

    get diagnosticsExportOptions() { return this.diagnosticsExportOptionsState.getValue(); }

    set diagnosticsExportOptions(val: DiagnosticsExportOptions) {
        this.diagnosticsExportOptionsState.next({
            ...val,
            logFilter: { ...val.logFilter }
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
        public readonly configService: AppConfigService,
        private readonly maps: MapInfoService,
        private readonly searches: FeatureSearchService,
        private readonly viewSettings: MapViewStateService) {
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
            this.diagnosticsLogFilter = { info: false, warn: false, error: true };
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
            logFilter: { ...(options?.logFilter ?? base.logFilter) }
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
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
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
            const response = await fetch(statusQuery, { cache: 'no-store' });
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

    registerActions(actions: AppActionService): void {
        actions.registerAction(diagnosticActions.getDiagnostics, input => this.getDiagnostics(input));
    }

    /** Samples fixed-size counters and existing caches only, never the per-tile diagnostics/export path. */
    getDiagnostics(input: ActionInput<typeof diagnosticActions.getDiagnostics>): ActionOutput<typeof diagnosticActions.getDiagnostics> {
        const viewIndex = input.viewId === undefined ? undefined : this.viewSettings.viewIds.indexOf(input.viewId);
        if (viewIndex !== undefined && viewIndex < 0) rejectAction("The requested view is unavailable");
        if (input.layerId && !input.mapId) rejectAction("layerId requires mapId", "invalid_arguments");
        if (input.mapId && !this.maps.maps.maps.has(input.mapId)) rejectAction("The requested map is unavailable");
        if (input.mapId && input.layerId) this.maps.requireLayer(input.mapId, input.layerId);
        const sections = input.sections ?? ["transport", "workers", "loading", "gpu", "errors"];
        const metrics: ActionOutput<typeof diagnosticActions.getDiagnostics>["metrics"] = [];
        const unavailable: string[] = [];
        const add = (section: string, values: Record<string, number | boolean | null>, cached = false) => {
            for (const [name, value] of Object.entries(values)) metrics.push({ section, name, value: typeof value === "number" && !Number.isFinite(value) ? null : value, scope: "tab", cached });
        };
        if (sections.includes("transport")) add("transport", {
            connected: this.mapService.isTileStreamConnected(), paused: this.mapService.tilePipelinePaused,
            parseQueue: this.mapService.getPendingFrameQueueSize(), downstreamBytesPerSecond: this.mapService.getDownstreamBytesPerSecond(),
            ...this.mapService.getTileStreamTransportCompressionStats()
        });
        if (sections.includes("workers")) {
            const { latestNativeMs, ...browserWorkers } = this.renderService.queueSummary();
            add("workers", { ...browserWorkers, latestWasmMs: latestNativeMs });
        }
        if (sections.includes("loading")) {
            if (viewIndex !== undefined || input.mapId) unavailable.push("Scoped loading counters are unavailable without a tile scan; tab-wide cached counters are returned.");
            const snapshot = this.snapshot$.value;
            add("loading", {
                expected: snapshot.tiles.expected, loaded: snapshot.tiles.loaded, errors: snapshot.tiles.errors,
                rendered: snapshot.progress.rendered.done, renderTotal: snapshot.progress.rendered.total,
                sampleAgeMs: Math.max(0, Date.now() - snapshot.at)
            }, true);
        }
        if (sections.includes("gpu")) {
            metrics.push({
                section: "gpu", name: "frameIntervalP90Ms", value: this.renderService.currentFrameTimeMs(viewIndex) || null,
                scope: viewIndex === undefined ? "tab" : "view", ...(viewIndex === undefined ? {} : { viewId: input.viewId })
            });
            if (viewIndex !== undefined || input.mapId) unavailable.push("Scoped GPU allocation is unavailable; no scene readback or scan was performed.");
            else {
                let found = false;
                for (const stat of this.perfStats$.value) {
                    if (stat.scope === "view" && stat.path[1] === "GPU Scene" && metrics.length < 100) {
                        add("gpu", { [stat.key]: stat.average ?? stat.peak }, true);
                        found = true;
                    }
                }
                if (!found) unavailable.push("GPU allocation metrics have not been sampled by the performance diagnostics UI.");
            }
        }
        const errorItems = function* (this: DiagnosticsFacadeService) {
            for (const issue of this.styleValidationReportService.reports$.value) {
                if (input.mapId && issue.runtimeContext?.mapName !== input.mapId) continue;
                if (input.layerId && issue.runtimeContext?.layerName !== input.layerId) continue;
                if (issue.severity !== "info") yield {
                    source: unicodePrefix(issue.source.styleName ?? "style", 4096),
                    message: unicodePrefix(issue.message, 4096), severity: issue.severity, phase: issue.phase,
                    property: issue.property === undefined ? undefined : unicodePrefix(issue.property, 4096),
                    expression: issue.expression === undefined ? undefined : unicodePrefix(issue.expression, 4096),
                    rulePath: issue.rulePath === undefined ? undefined : unicodePrefix(issue.rulePath, 4096),
                    mapId: issue.runtimeContext?.mapName === undefined ? undefined : unicodePrefix(issue.runtimeContext.mapName, 4096),
                    layerId: issue.runtimeContext?.layerName === undefined ? undefined : unicodePrefix(issue.runtimeContext.layerName, 4096),
                    featureId: issue.runtimeContext?.featureId === undefined ? undefined : unicodePrefix(issue.runtimeContext.featureId, 4096)
                };
            }
            for (const session of this.searches.getSessions()) {
                if (viewIndex !== undefined && !session.definition.selectedViewIndices.includes(viewIndex)) continue;
                if (input.mapId && !session.definition.selectedMapLayers.some(layer => layer.mapId === input.mapId && (!input.layerId || layer.layerId === input.layerId))) continue;
                for (const error of session.errors) yield { source: session.id, message: unicodePrefix(error, 4096) };
            }
        }.bind(this);
        const errors = boundedCollection(sections.includes("errors") ? errorItems() : [], input.limit, 64000);
        if (sections.includes("errors") && viewIndex !== undefined) unavailable.push("Style errors have no per-view attribution; map/layer-filtered style issues and view-filtered search errors are returned.");
        return {
            observedAt: new Date().toISOString(), executionContext: "browser",
            interpretation: "All metrics describe this browser tab. Workers execute browser WASM rendering, not native backend jobs. " +
                "Frame intervals measure observed rendering cadence, not GPU execution time, and can include idle periods. " +
                "This snapshot alone cannot identify a panning bottleneck. Backend queues, CPU and memory were not sampled.",
            metrics, errors: errors.items, unavailable, complete: errors.complete, reason: errors.reason
        };
    }

}
