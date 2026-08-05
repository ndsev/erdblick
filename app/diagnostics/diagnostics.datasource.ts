import {Injectable, NgZone, OnDestroy} from "@angular/core";
import {auditTime, BehaviorSubject, interval, Subscription} from "rxjs";
import {MapTileStreamService} from "../mapdata/map-tile-stream.service";
import {
    TileSubsetLayerRenderService
} from "../mapview/deck/tile-subset-layer-render.service";
import {
    type SubsetDiagnosticsError,
    ViewLayerDiagnosticsService
} from "../mapview/view-layer-diagnostics.service";
import {
    AppStateService,
    DIAGNOSTICS_PERFORMANCE_DIALOG_LAYOUT_ID
} from "../shared/appstate.service";
import {
    DiagnosticsSnapshot,
    LogEntry,
    LogLevel,
    PerfStat,
    TilePipelineProgress,
    TileStateCounts
} from "./diagnostics.model";
import {
    LOG_INTERVAL_MS,
    MAX_LOGS,
    PEAK_TILE_LIMIT,
    PERF_INTERVAL_MS,
    SNAPSHOT_INTERVAL_MS
} from "./diagnostics.constants";
import {buildAggregatedPerfStats} from "./diagnostics.perf-aggregation";
import {
    StyleValidationReportService
} from "../styledata/style-validation-report.service";
import type {StyleValidationIssue} from "../styledata/style-validation.model";

const UPDATE_EVENT_DEBOUNCE_MS = 250;

/**
 * Current-generation diagnostics assembled from live StyledMapgetLayers.
 *
 * There is deliberately no tile history or diagnostic tile cache here.
 */
@Injectable()
export class DiagnosticsDatasource implements OnDestroy {
    readonly snapshot$ = new BehaviorSubject<DiagnosticsSnapshot>(
        this.buildSnapshot()
    );
    readonly perfStats$ = new BehaviorSubject<PerfStat[]>([]);
    readonly logs$ = new BehaviorSubject<LogEntry[]>([]);

    private static consolePatched = false;
    private static consoleLogHandler?: (
        level: LogLevel,
        args: unknown[]
    ) => void;

    private readonly subscriptions: Subscription[] = [];
    private readonly errorTileKeys = new Set<string>();
    private readonly loggedStyleIssueIds = new Set<string>();
    private lastBackendConnected = this.mapService.isTileStreamConnected();

    constructor(
        private readonly mapService: MapTileStreamService,
        private readonly renderService: TileSubsetLayerRenderService,
        private readonly viewDiagnostics: ViewLayerDiagnosticsService,
        private readonly appStateService: AppStateService,
        private readonly styleValidationReportService:
            StyleValidationReportService,
        private readonly ngZone: NgZone
    ) {
        this.patchConsoleLogging();
        let wasPaused = this.mapService.tilePipelinePaused;
        const timerSubscriptions = this.ngZone.runOutsideAngular(() => [
            interval(SNAPSHOT_INTERVAL_MS).subscribe(() =>
                this.refreshSnapshot()
            ),
            interval(PERF_INTERVAL_MS).subscribe(() =>
                this.refreshPerfStatsIfVisible()),
            interval(LOG_INTERVAL_MS).subscribe(() => this.refreshLogs())
        ]);
        this.subscriptions.push(
            ...timerSubscriptions,
            this.mapService.tilePipelinePaused$.subscribe(paused => {
                if (wasPaused && !paused) {
                    this.refreshSnapshot();
                    this.refreshPerfStatsIfVisible();
                }
                wasPaused = paused;
            }),
            this.viewDiagnostics.changed
                .pipe(auditTime(UPDATE_EVENT_DEBOUNCE_MS))
                .subscribe(() => {
                    this.refreshSnapshot();
                    this.refreshPerfStatsIfVisible();
                    this.refreshLogs();
                }),
            this.viewDiagnostics.tileError.subscribe(error =>
                this.appendTileError(error)
            ),
            this.styleValidationReportService.reports$.subscribe(issues =>
                this.appendStyleValidationLogs(issues)
            )
        );
        this.refreshPerfStatsIfVisible();
        this.refreshLogs();
    }

    /** Publishes progress only when the pipeline is live. */
    private refreshSnapshot(): void {
        if (!this.mapService.tilePipelinePaused) {
            this.snapshot$.next(this.buildSnapshot());
        }
    }

    ngOnDestroy(): void {
        this.subscriptions.forEach(subscription => subscription.unsubscribe());
    }

    refreshPerfStats(): void {
        if (!this.mapService.tilePipelinePaused) {
            const stats = buildAggregatedPerfStats(
                this.viewDiagnostics.currentTiles(),
                PEAK_TILE_LIMIT
            );
            const deckFrameTimeMs =
                this.renderService.currentFrameTimeMs();
            const presentation =
                this.renderService.currentDeckPresentationDiagnostics();
            const addLiveStat = (
                path: string[],
                value: number,
                unit: string,
                peak = value
            ) => stats.push({
                key: path.join("/"),
                path,
                scope: "view",
                unit,
                peak,
                average: value,
                min: value
            });
            addLiveStat(
                ["Rendering", "Deck.gl", "Frame Time (p90)"],
                deckFrameTimeMs,
                "ms"
            );
            addLiveStat(
                ["Rendering", "Deck.gl", "Frame Rate (from p90)"],
                deckFrameTimeMs > 0 ? 1000 / deckFrameTimeMs : 0,
                "fps"
            );
            addLiveStat(
                ["Rendering", "Deck.gl", "Logical Layers"],
                presentation.layers,
                "count"
            );
            addLiveStat(
                ["Rendering", "Buffer Arena", "Compatibility Groups"],
                presentation.groups,
                "count"
            );
            addLiveStat(
                ["Rendering", "Buffer Arena", "Active Pages"],
                presentation.pages,
                "count"
            );
            addLiveStat(
                ["Rendering", "Buffer Arena", "Reusable Empty Pages"],
                presentation.reusablePages,
                "count"
            );
            addLiveStat(
                ["Rendering", "Buffer Arena", "Block Contributions"],
                presentation.contributions,
                "count"
            );
            addLiveStat(
                ["Rendering", "Buffer Arena", "Vertices Used"],
                presentation.usedVertices,
                "count"
            );
            addLiveStat(
                ["Rendering", "Buffer Arena", "Vertex Capacity"],
                presentation.capacityVertices,
                "count"
            );
            addLiveStat(
                ["Rendering", "Buffer Arena", "Page Fill"],
                presentation.capacityVertices > 0
                    ? presentation.usedVertices /
                        presentation.capacityVertices * 100
                    : 0,
                "%"
            );
            addLiveStat(
                ["Rendering", "Buffer Arena", "Blocks per Page"],
                presentation.pages > 0
                    ? presentation.contributions / presentation.pages
                    : 0,
                "count",
                presentation.maxContributionsPerPage
            );
            // The polling timer deliberately runs outside Angular. Re-enter
            // only for the single observable publication so an open
            // performance dialog visibly refreshes its live frame cadence.
            this.ngZone.run(() => this.perfStats$.next(stats));
        }
    }

    refreshPerfStatsIfVisible(): void {
        if (this.appStateService.isDialogOpen(
            DIAGNOSTICS_PERFORMANCE_DIALOG_LAYOUT_ID
        )) {
            this.refreshPerfStats();
        }
    }

    refreshLogs(): void {
        const now = Date.now();
        const connected = this.mapService.isTileStreamConnected();
        const entries: LogEntry[] = [];
        if (connected !== this.lastBackendConnected) {
            entries.push({
                at: now,
                level: connected ? "info" : "error",
                message: connected
                    ? "Backend connected"
                    : "Backend disconnected"
            });
            this.lastBackendConnected = connected;
        }
        this.appendLogEntries(entries);
    }

    private buildSnapshot(): DiagnosticsSnapshot {
        const summary = this.viewDiagnostics.currentSummary();
        const expected = summary.expected;
        const loaded = summary.ready;
        const errors = summary.errors;
        const compression = this.mapService
            .getTileStreamTransportCompressionStats();
        const backend = this.mapService.getBackendRequestProgress();
        const parseQueueSize = this.mapService.getPendingFrameQueueSize();
        const renderQueueSize = this.renderService.visualizationQueueLength();
        if (backend.allDone &&
            loaded === expected &&
            parseQueueSize === 0 &&
            renderQueueSize === 0) {
            this.mapService.markCurrentViewportRendered();
        }
        const progress: TilePipelineProgress = {
            backend: {done: backend.done, total: backend.total},
            rendered: {done: loaded, total: expected},
            bubbles: {
                downstreamBytesPerSecond:
                    this.mapService.getDownstreamBytesPerSecond(),
                pullResponses: compression.totalPullResponses,
                pullGzipResponses: compression.totalPullGzipResponses,
                pullUncompressedBytes: compression.totalUncompressedBytes,
                pullCompressedBytesKnown: compression.knownCompressedBytes,
                pullCompressionRatioPct: compression.compressionRatioPct,
                pullCompressionCoveragePct:
                    compression.knownCompressedCoveragePct,
                features: summary.sourceFeatures,
                vertices: summary.vertices,
                parseQueueSize,
                renderQueueSize,
                frameTimeMs: this.renderService.currentFrameTimeMs(),
                renderSeconds: this.mapService.currentViewportRenderSeconds()
            }
        };
        const tileCounts: TileStateCounts = {
            expected,
            loaded,
            cached: 0,
            errors
        };
        return {
            at: Date.now(),
            tiles: tileCounts,
            progress,
            backend: {connected: this.mapService.isTileStreamConnected()}
        };
    }

    private appendTileError(error: SubsetDiagnosticsError): void {
        const key = `${error.ownerId}|${error.mapTileKey}`;
        if (this.errorTileKeys.has(key)) {
            return;
        }
        this.errorTileKeys.add(key);
        this.appendLogEntries([{
            at: Date.now(),
            level: "error",
            message: `Subset error: ${error.message}`,
            data: {
                tileId: error.mapTileKey,
                mapName: error.mapName,
                layerName: error.layerName,
                presentation: error.presentationKind
            }
        }]);
    }

    private appendStyleValidationLogs(issues: StyleValidationIssue[]): void {
        const entries: LogEntry[] = [];
        for (const issue of issues) {
            const id = [
                issue.id,
                issue.source.url,
                issue.source.sourceHash,
                issue.source.styleName,
                issue.rulePath,
                issue.property,
                issue.expression,
                issue.message,
                issue.runtimeContext?.mapName,
                issue.runtimeContext?.layerName,
                issue.runtimeContext?.tileKey,
                issue.runtimeContext?.renderPath
            ].join("|");
            if (this.loggedStyleIssueIds.has(id)) {
                continue;
            }
            this.loggedStyleIssueIds.add(id);
            entries.push({
                at: issue.at,
                level: issue.severity === "error"
                    ? "error"
                    : issue.severity === "warning" ? "warn" : "info",
                message:
                    this.styleValidationReportService.formatIssueSummary(issue),
                data: issue
            });
        }
        this.appendLogEntries(entries);
    }

    private appendLogEntries(entries: LogEntry[]): void {
        if (entries.length) {
            this.logs$.next(
                [...this.logs$.getValue(), ...entries].slice(-MAX_LOGS)
            );
        }
    }

    private patchConsoleLogging(): void {
        DiagnosticsDatasource.consoleLogHandler = (level, args) => {
            this.appendLogEntries([{
                at: Date.now(),
                level,
                message: args.map(value => this.stringifyLogPart(value))
                    .filter(Boolean)
                    .join(" ") || "(empty log)",
                data: args.some(value =>
                    typeof value === "object" && value !== null
                ) ? args : undefined
            }]);
        };
        if (DiagnosticsDatasource.consolePatched) {
            return;
        }
        DiagnosticsDatasource.consolePatched = true;
        const methods: Array<[keyof Console, LogLevel]> = [
            ["log", "info"],
            ["info", "info"],
            ["warn", "warn"],
            ["error", "error"],
            ["debug", "info"]
        ];
        for (const [method, level] of methods) {
            const original = console[method] as (...args: unknown[]) => void;
            (console as any)[method] = (...args: unknown[]) => {
                DiagnosticsDatasource.consoleLogHandler?.(level, args);
                original.apply(console, args);
            };
        }
    }

    private stringifyLogPart(value: unknown): string {
        if (value instanceof Error) {
            return value.stack ?? value.message;
        }
        if (typeof value === "string") {
            return value;
        }
        try {
            return JSON.stringify(value) ?? String(value);
        } catch (_error) {
            return String(value);
        }
    }
}
