import { Injectable, NgZone, OnDestroy } from "@angular/core";
import { BehaviorSubject } from "rxjs";
import { z } from "zod";

import { boundedCollection, identifierSchema, rejectAction } from "../action/action.model";
import { AppActionContributor, AppActionRegistration } from "../action/action-contributor.model";
import {
    DIAGNOSTICS_EXPORT_DIALOG_LAYOUT_ID,
    DIAGNOSTICS_LOG_DIALOG_LAYOUT_ID,
    DIAGNOSTICS_PERFORMANCE_DIALOG_LAYOUT_ID
} from "../layout/layout.model";
import { LayoutService } from "../layout/layout.service";
import { MapDataService } from "../mapdata/mapdata.service";
import { MapTileStreamService } from '../mapdata/map-tile-stream.service';
import { TileSubsetLayerRenderService } from '../mapview/deck/tile-subset-layer-render.service';
import { viewIdSchema } from "../mapview/mapview.model";
import { MapViewState } from "../mapview/mapview.state";
import { ViewLayerDiagnosticsService } from '../mapview/view-layer-diagnostics.service';
import { SearchService } from "../search/search.service";
import { boundedUnicodeString, unicodePrefix } from "../utils/unicode-string.util";
import { AppStateService } from "../appstate/appstate.service";
import { StyleValidationReportService } from '../mapstyle/style-validation-report.service';
import { DiagnosticsDatasource } from './diagnostics.datasource';
import type { DiagnosticsExportOptions, DiagnosticsLogFilter } from "./diagnostics.model";
import {
    DiagnosticsExportBundle,
    LogEntry,
    PerformanceDiagnosticsScope,
    TileSizeDistribution
} from './diagnostics.model';
import { DiagnosticsState } from "./diagnostics.state";

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
export class DiagnosticsFacadeService extends DiagnosticsDatasource implements OnDestroy, AppActionContributor {

    readonly performanceScope$ = new BehaviorSubject<PerformanceDiagnosticsScope | null>(null);
    private nextPerformanceScopeRequestId = 1;

    constructor(mapService: MapTileStreamService,
        renderService: TileSubsetLayerRenderService,
        viewDiagnostics: ViewLayerDiagnosticsService,
        private readonly stateService: AppStateService,
        styleValidationReportService: StyleValidationReportService,
        ngZone: NgZone,
        public override readonly layout: LayoutService,
        private readonly maps: MapDataService,
        private readonly searches: SearchService,
        private readonly viewSettings: MapViewState,
        public readonly state: DiagnosticsState) {
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
            this.state.diagnosticsLogFilter = { info: false, warn: false, error: true };
        }
    }

    /** Opens the export dialog with optional preselected export options. */
    openExportDialog(options?: Partial<DiagnosticsExportOptions>) {
        this.refreshPerfStats();
        this.refreshLogs();
        const base = this.state.diagnosticsExportOptionsState.defaultValue;
        this.state.diagnosticsExportOptions = {
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
            erdblickVersion: this.state.versions.erdblickVersion || undefined,
            distributionVersions: this.state.versions.distributionVersions || undefined,
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
    /** Registers semantic operations and their live omnibar candidates. */
    registerActions(actions: AppActionRegistration): void {
        const text = boundedUnicodeString(4096);

        actions.registerAction(
            {
                name: "viewer_get_diagnostics",
                description:
                    "Read BROWSER transport, render-worker queues, frame-time metrics, cached loading, GPU " +
                    "allocation and style/search errors without resetting the view. Native BACKEND " +
                    "workers/cache/memory require the separately privileged mapget_get_diagnostics tool. Call it " +
                    "only when it appears in your tool catalog; otherwise explain the permission limit. Browser " +
                    "workers and observed transport latency are not backend queue statistics. No scene/tile scan or " +
                    "GPU readback. Cached and unavailable metrics are explicit.",
                mutation: false,
                inputSchema: z.strictObject({
                    viewId: viewIdSchema.optional(),
                    mapId: identifierSchema.optional(),
                    layerId: identifierSchema.optional(),
                    sections: z
                        .array(z.enum(["transport", "workers", "loading", "gpu", "errors"]))
                        .max(5)
                        .optional(),
                    limit: z.number().int().min(1).max(100).optional()
                }),
                outputSchema: z.strictObject({
                    observedAt: z.string(),
                    complete: z.boolean(),
                    reason: z.enum(["item_limit", "byte_limit", "text_limit", "loading"]).optional(),
                    executionContext: z.literal("browser"),
                    interpretation: text,
                    metrics: z
                        .array(
                            z.strictObject({
                                section: text,
                                name: text,
                                value: z.union([z.number(), z.boolean(), z.null()]),
                                scope: z.enum(["tab", "view"]),
                                viewId: viewIdSchema.optional(),
                                cached: z.boolean().optional()
                            })
                        )
                        .max(100),
                    errors: z
                        .array(
                            z.strictObject({
                                source: text,
                                message: text,
                                severity: z.enum(["warning", "error"]).optional(),
                                phase: text.optional(),
                                property: text.optional(),
                                expression: text.optional(),
                                rulePath: text.optional(),
                                mapId: identifierSchema.optional(),
                                layerId: identifierSchema.optional(),
                                featureId: identifierSchema.optional()
                            })
                        )
                        .max(100),
                    unavailable: z.array(text).max(20)
                })
            },
            (input) => this.getDiagnostics(input)
        );
    }


    /** Samples fixed-size counters and existing caches only, never the per-tile diagnostics/export path. */
    getDiagnostics(input: {
        viewId?: string;
        mapId?: string;
        layerId?: string;
        sections?: ("errors" | "loading" | "transport" | "workers" | "gpu")[];
        limit?: number;
    }) {
        const viewIndex =
            input.viewId === undefined ? undefined : this.viewSettings.viewIds.indexOf(input.viewId);
        if (viewIndex !== undefined && viewIndex < 0) rejectAction("The requested view is unavailable");
        if (input.layerId && !input.mapId) rejectAction("layerId requires mapId", "invalid_arguments");
        if (input.mapId && !this.maps.maps.maps.has(input.mapId))
            rejectAction("The requested map is unavailable");
        if (input.mapId && input.layerId) this.maps.requireLayer(input.mapId, input.layerId);
        const sections = input.sections ?? ["transport", "workers", "loading", "gpu", "errors"];
        const metrics: Array<{
            section: string;
            name: string;
            value: number | boolean | null;
            scope: "tab" | "view";
            viewId?: string;
            cached?: boolean;
        }> = [];
        const unavailable: string[] = [];
        const add = (section: string, values: Record<string, number | boolean | null>, cached = false) => {
            for (const [name, value] of Object.entries(values))
                metrics.push({
                    section,
                    name,
                    value: typeof value === "number" && !Number.isFinite(value) ? null : value,
                    scope: "tab",
                    cached
                });
        };
        if (sections.includes("transport"))
            add("transport", {
                connected: this.mapService.isTileStreamConnected(),
                paused: this.mapService.tilePipelinePaused,
                parseQueue: this.mapService.getPendingFrameQueueSize(),
                downstreamBytesPerSecond: this.mapService.getDownstreamBytesPerSecond(),
                ...this.mapService.getTileStreamTransportCompressionStats()
            });
        if (sections.includes("workers")) {
            const { latestNativeMs, ...browserWorkers } = this.renderService.queueSummary();
            add("workers", { ...browserWorkers, latestWasmMs: latestNativeMs });
        }
        if (sections.includes("loading")) {
            if (viewIndex !== undefined || input.mapId)
                unavailable.push(
                    "Scoped loading counters are unavailable without a tile scan; tab-wide cached counters are returned."
                );
            const snapshot = this.snapshot$.value;
            add(
                "loading",
                {
                    expected: snapshot.tiles.expected,
                    loaded: snapshot.tiles.loaded,
                    errors: snapshot.tiles.errors,
                    rendered: snapshot.progress.rendered.done,
                    renderTotal: snapshot.progress.rendered.total,
                    sampleAgeMs: Math.max(0, Date.now() - snapshot.at)
                },
                true
            );
        }
        if (sections.includes("gpu")) {
            metrics.push({
                section: "gpu",
                name: "frameIntervalP90Ms",
                value: this.renderService.currentFrameTimeMs(viewIndex) || null,
                scope: viewIndex === undefined ? "tab" : "view",
                ...(viewIndex === undefined ? {} : { viewId: input.viewId })
            });
            if (viewIndex !== undefined || input.mapId)
                unavailable.push(
                    "Scoped GPU allocation is unavailable; no scene readback or scan was performed."
                );
            else {
                let found = false;
                for (const stat of this.perfStats$.value) {
                    if (stat.scope === "view" && stat.path[1] === "GPU Scene" && metrics.length < 100) {
                        add("gpu", { [stat.key]: stat.average ?? stat.peak }, true);
                        found = true;
                    }
                }
                if (!found)
                    unavailable.push(
                        "GPU allocation metrics have not been sampled by the performance diagnostics UI."
                    );
            }
        }
        const errorItems = function* (this: DiagnosticsFacadeService) {
            for (const issue of this.styleValidationReportService.reports$.value) {
                if (input.mapId && issue.runtimeContext?.mapName !== input.mapId) continue;
                if (input.layerId && issue.runtimeContext?.layerName !== input.layerId) continue;
                if (issue.severity !== "info")
                    yield {
                        source: unicodePrefix(issue.source.styleName ?? "style", 4096),
                        message: unicodePrefix(issue.message, 4096),
                        severity: issue.severity,
                        phase: issue.phase,
                        property:
                            issue.property === undefined ? undefined : unicodePrefix(issue.property, 4096),
                        expression:
                            issue.expression === undefined
                                ? undefined
                                : unicodePrefix(issue.expression, 4096),
                        rulePath:
                            issue.rulePath === undefined ? undefined : unicodePrefix(issue.rulePath, 4096),
                        mapId:
                            issue.runtimeContext?.mapName === undefined
                                ? undefined
                                : unicodePrefix(issue.runtimeContext.mapName, 4096),
                        layerId:
                            issue.runtimeContext?.layerName === undefined
                                ? undefined
                                : unicodePrefix(issue.runtimeContext.layerName, 4096),
                        featureId:
                            issue.runtimeContext?.featureId === undefined
                                ? undefined
                                : unicodePrefix(issue.runtimeContext.featureId, 4096)
                    };
            }
            for (const session of this.searches.getSessions()) {
                if (viewIndex !== undefined && !session.definition.selectedViewIndices.includes(viewIndex))
                    continue;
                if (
                    input.mapId &&
                    !session.definition.selectedMapLayers.some(
                        (layer) =>
                            layer.mapId === input.mapId && (!input.layerId || layer.layerId === input.layerId)
                    )
                )
                    continue;
                for (const error of session.errors)
                    yield { source: session.id, message: unicodePrefix(error, 4096) };
            }
        }.bind(this);
        const errors = boundedCollection(sections.includes("errors") ? errorItems() : [], input.limit, 64000);
        if (sections.includes("errors") && viewIndex !== undefined)
            unavailable.push(
                "Style errors have no per-view attribution; map/layer-filtered style issues and view-filtered search errors are returned."
            );
        return {
            observedAt: new Date().toISOString(),
            executionContext: "browser" as const,
            interpretation:
                "All metrics describe this browser tab. Workers execute browser WASM rendering, not native backend jobs. " +
                "Frame intervals measure observed rendering cadence, not GPU execution time, and can include idle periods. " +
                "This snapshot alone cannot identify a panning bottleneck. Backend queues, CPU and memory were not sampled.",
            metrics,
            errors: errors.items,
            unavailable,
            complete: errors.complete,
            reason: errors.reason
        };
    }

}
