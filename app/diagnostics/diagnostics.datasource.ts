import {Injectable, OnDestroy} from "@angular/core";
import {auditTime, BehaviorSubject, interval, Subscription} from "rxjs";
import {MapTileStreamService} from "../mapdata/map-tile-stream.service";
import {
    TileSubsetLayerRenderService
} from "../mapview/deck/tile-subset-layer-render.service";
import {
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
            StyleValidationReportService
    ) {
        this.patchConsoleLogging();
        let wasPaused = this.mapService.tilePipelinePaused;
        this.subscriptions.push(
            interval(SNAPSHOT_INTERVAL_MS).subscribe(() => {
                if (!this.mapService.tilePipelinePaused) {
                    this.snapshot$.next(this.buildSnapshot());
                }
            }),
            interval(PERF_INTERVAL_MS).subscribe(() =>
                this.refreshPerfStatsIfVisible()
            ),
            interval(LOG_INTERVAL_MS).subscribe(() => this.refreshLogs()),
            this.mapService.tilePipelinePaused$.subscribe(paused => {
                if (wasPaused && !paused) {
                    this.snapshot$.next(this.buildSnapshot());
                    this.refreshPerfStatsIfVisible();
                }
                wasPaused = paused;
            }),
            this.viewDiagnostics.changed
                .pipe(auditTime(UPDATE_EVENT_DEBOUNCE_MS))
                .subscribe(() => {
                    this.snapshot$.next(this.buildSnapshot());
                    this.refreshPerfStatsIfVisible();
                    this.refreshLogs();
                }),
            this.styleValidationReportService.reports$.subscribe(issues =>
                this.appendStyleValidationLogs(issues)
            )
        );
        this.refreshPerfStatsIfVisible();
        this.refreshLogs();
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
            stats.push({
                key: "Rendering/Deck.gl#ms",
                path: ["Rendering", "Deck.gl"],
                unit: "ms",
                peak: deckFrameTimeMs,
                average: deckFrameTimeMs
            });
            this.perfStats$.next(stats);
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
        for (const tile of this.viewDiagnostics.currentTiles()) {
            if (!tile.error) {
                continue;
            }
            const key = `${tile.ownerId}|${tile.mapTileKey}`;
            if (this.errorTileKeys.has(key)) {
                continue;
            }
            this.errorTileKeys.add(key);
            entries.push({
                at: now,
                level: "error",
                message: `Subset error: ${tile.error}`,
                data: {
                    tileId: tile.mapTileKey,
                    mapName: tile.mapName,
                    layerName: tile.layerName,
                    presentation: tile.presentationKind
                }
            });
        }
        this.appendLogEntries(entries);
    }

    private buildSnapshot(): DiagnosticsSnapshot {
        const tiles = this.viewDiagnostics.currentTiles();
        const expected = tiles.length;
        const loaded = tiles.filter(tile => tile.ready).length;
        const errors = tiles.filter(tile => !!tile.error).length;
        const sourceFeatures = new Map<string, number>();
        let vertices = 0;
        let renderedEntries = 0;
        for (const tile of tiles) {
            if (tile.presentationKind === "regular" &&
                tile.sourceFeatureCount !== null) {
                sourceFeatures.set(
                    `${tile.mapName}|${tile.layerName}|${tile.mapTileKey}`,
                    tile.sourceFeatureCount
                );
            }
            renderedEntries += tile.renderedEntryCount;
            vertices +=
                tile.stats.get("Rendering/WASM/Vertices#count")?.[0] ?? 0;
        }
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
                features: [...sourceFeatures.values()]
                    .reduce((sum, value) => sum + value, 0),
                vertices,
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
