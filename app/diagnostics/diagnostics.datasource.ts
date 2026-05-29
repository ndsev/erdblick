import {Injectable, OnDestroy} from '@angular/core';
import {auditTime, BehaviorSubject, interval, Subscription} from 'rxjs';
import {MapTileStreamService} from '../mapdata/map-tile-stream.service';
import {MapRenderService} from '../mapdata/map-render.service';
import {FeatureTile} from '../mapdata/features.model';
import {TileLoadingHudStats} from '../mapdata/map-runtime.model';
import {AppStateService, DIAGNOSTICS_PERFORMANCE_DIALOG_LAYOUT_ID} from '../shared/appstate.service';
import {
    DiagnosticsSnapshot,
    LogEntry,
    LogLevel,
    PerfStat,
    StageProgressCounter,
    TilePipelineProgress,
    TileStateCounts
} from './diagnostics.model';
import {
    COUNT_KEY_PATTERN,
    LOG_INTERVAL_MS,
    MAX_LOGS,
    PEAK_TILE_LIMIT,
    PERF_INTERVAL_MS,
    SNAPSHOT_INTERVAL_MS,
    UNIT_SUFFIXES
} from './diagnostics.constants';
import {StyleValidationReportService} from '../styledata/style-validation-report.service';
import {StyleValidationIssue} from '../styledata/style-validation.model';
const UPDATE_EVENT_DEBOUNCE_MS = 1000;

@Injectable()
/**
 * Collects diagnostics snapshots, performance aggregates, and console-backed logs.
 *
 * The datasource is UI-facing but fed directly from the tile-stream and render services, so it
 * throttles updates to avoid turning high tile throughput into diagnostics noise.
 */
export class DiagnosticsDatasource implements OnDestroy {
    readonly snapshot$ = new BehaviorSubject<DiagnosticsSnapshot>(this.buildSnapshot());
    readonly perfStats$ = new BehaviorSubject<PerfStat[]>([]);
    readonly logs$ = new BehaviorSubject<LogEntry[]>([]);

    private static consolePatched = false;
    private static consoleLogHandler?: (level: LogLevel, args: unknown[]) => void;

    private readonly subscriptions: Subscription[] = [];
    private lastBackendConnected = this.mapService.isTileStreamConnected();
    private readonly errorTileKeys = new Set<string>();
    private readonly loggedStyleIssueIds = new Set<string>();

    constructor(
        private readonly mapService: MapTileStreamService,
        private readonly mapRenderService: MapRenderService,
        private readonly appStateService: AppStateService,
        private readonly styleValidationReportService: StyleValidationReportService
    ) {
        this.patchConsoleLogging();
        this.refreshPerfStatsIfVisible();
        this.refreshLogs();
        let wasPaused = this.mapService.tilePipelinePaused;

        this.subscriptions.push(
            interval(SNAPSHOT_INTERVAL_MS).subscribe(() => {
                if (this.mapService.tilePipelinePaused) {
                    return;
                }
                this.snapshot$.next(this.buildSnapshot());
            }),
            interval(PERF_INTERVAL_MS).subscribe(() => this.refreshPerfStatsIfVisible()),
            interval(LOG_INTERVAL_MS).subscribe(() => this.refreshLogs()),
            this.mapService.tilePipelinePaused$.subscribe(paused => {
                if (wasPaused && !paused) {
                    this.snapshot$.next(this.buildSnapshot());
                    this.refreshPerfStatsIfVisible();
                }
                wasPaused = paused;
            }),
            this.mapService.tileDataChanged
                .pipe(auditTime(UPDATE_EVENT_DEBOUNCE_MS))
                .subscribe(() => this.refreshOnDemand()),
            this.styleValidationReportService.reports$.subscribe(issues => this.appendStyleValidationLogs(issues))
        );
    }

    /** Tears down polling and update subscriptions. */
    ngOnDestroy() {
        this.subscriptions.forEach(sub => sub.unsubscribe());
    }

    /** Rebuilds aggregated performance stats unless the tile pipeline is paused. */
    refreshPerfStats() {
        if (this.mapService.tilePipelinePaused) {
            return;
        }
        const stats = buildAggregatedPerfStats(this.mapService.loadedTileLayers.values(), PEAK_TILE_LIMIT);
        this.perfStats$.next(stats);
    }

    /** Refreshes performance stats only when the performance dialog is visible. */
    refreshPerfStatsIfVisible() {
        if (!this.appStateService.isDialogOpen(DIAGNOSTICS_PERFORMANCE_DIALOG_LAYOUT_ID)) {
            return;
        }
        this.refreshPerfStats();
    }

    /** Appends backend-connectivity and tile-error log entries discovered since the last refresh. */
    refreshLogs() {
        const now = Date.now();
        const connected = this.mapService.isTileStreamConnected();
        const newEntries: LogEntry[] = [];

        if (connected !== this.lastBackendConnected) {
            newEntries.push({
                at: now,
                level: connected ? 'info' : 'error',
                message: connected ? 'Backend connected' : 'Backend disconnected'
            });
            this.lastBackendConnected = connected;
        }

        for (const tile of this.mapService.loadedTileLayers.values()) {
            const tileKey = tile.mapTileKey ?? tile.tileId?.toString() ?? '';
            if (!tileKey) {
                continue;
            }
            if (tile.error && !this.errorTileKeys.has(tileKey)) {
                newEntries.push({
                    at: now,
                    level: 'error',
                    message: `Tile error: ${tile.error}`,
                    data: {
                        tileId: tileKey,
                        mapName: tile.mapName,
                        layerName: tile.layerName
                    }
                });
                this.errorTileKeys.add(tileKey);
            }
        }

        this.appendLogEntries(newEntries);
    }

    /** Runs the lightweight on-demand refresh path used after tile-data changes. */
    private refreshOnDemand() {
        this.refreshPerfStatsIfVisible();
        this.refreshLogs();
    }

    /** Aggregates the tile-loading HUD statistics from stream, cache, and render state. */
    private getTileLoadingHudStats(): TileLoadingHudStats {
        let features = 0;
        let vertices = 0;
        for (const tile of this.mapService.loadedTileLayers.values()) {
            if (!tile.hasData()) {
                continue;
            }
            const tileFeatures = Number(tile.numFeatures);
            if (Number.isFinite(tileFeatures) && tileFeatures > 0) {
                features += Math.floor(tileFeatures);
            }
            vertices += tile.vertexCount();
        }

        const compressionStats = this.mapService.getTileStreamTransportCompressionStats();
        return {
            backend: this.mapService.getBackendRequestProgress(),
            downstreamBytesPerSecond: this.mapService.getDownstreamBytesPerSecond(),
            pullResponses: compressionStats.totalPullResponses,
            pullGzipResponses: compressionStats.totalPullGzipResponses,
            pullUncompressedBytes: compressionStats.totalUncompressedBytes,
            pullCompressedBytesKnown: compressionStats.knownCompressedBytes,
            pullCompressionRatioPct: compressionStats.compressionRatioPct,
            pullCompressionCoveragePct: compressionStats.knownCompressedCoveragePct,
            features,
            vertices,
            parseQueueSize: this.mapService.getPendingFrameQueueSize(),
            renderQueueSize: this.mapRenderService.visualizationQueueLength(),
            frameTimeMs: this.mapRenderService.currentFrameTimeMs(),
            viewportRenderSeconds: this.mapService.currentViewportRenderSeconds()
        };
    }

    /** Builds one diagnostics snapshot from the current tile pipeline state. */
    private buildSnapshot(): DiagnosticsSnapshot {
        const tiles = Array.from(this.mapService.loadedTileLayers.values());
        const expected = tiles.length;
        let loaded = 0;
        let errors = 0;
        for (const tile of tiles) {
            const hasData = tile.hasData();
            if (hasData) {
                loaded += 1;
            }
            if (tile.error) {
                errors += 1;
            }
        }
        const stageCounters = this.mapService.getRequestedStageProgress();
        const stageLabels = this.mapService.getRequestedStageLabels();
        const stageProgress: StageProgressCounter[] = stageCounters.map((counter, stage) => ({
            done: counter.done,
            total: counter.total,
            label: stageLabels[stage] ?? `Stage ${stage}`
        }));

        const tilesSummary: TileStateCounts = {
            expected,
            loaded,
            cached: 0,
            errors
        };

        const backendProgress = this.mapService.getBackendRequestProgress();
        const hudStats = this.getTileLoadingHudStats();
        const progress: TilePipelineProgress = {
            stages: stageProgress,
            backend: {
                done: backendProgress.done,
                total: backendProgress.total,
            },
            rendered: this.mapRenderService.getVisualizationCounts(),
            bubbles: {
                downstreamBytesPerSecond: hudStats.downstreamBytesPerSecond,
                pullResponses: hudStats.pullResponses,
                pullGzipResponses: hudStats.pullGzipResponses,
                pullUncompressedBytes: hudStats.pullUncompressedBytes,
                pullCompressedBytesKnown: hudStats.pullCompressedBytesKnown,
                pullCompressionRatioPct: hudStats.pullCompressionRatioPct,
                pullCompressionCoveragePct: hudStats.pullCompressionCoveragePct,
                features: hudStats.features,
                vertices: hudStats.vertices,
                parseQueueSize: hudStats.parseQueueSize,
                renderQueueSize: hudStats.renderQueueSize,
                frameTimeMs: hudStats.frameTimeMs,
                renderSeconds: hudStats.viewportRenderSeconds,
            }
        };

        return {
            at: Date.now(),
            tiles: tilesSummary,
            progress,
            backend: {
                connected: this.mapService.isTileStreamConnected()
            }
        };
    }

    /** Convenience helper for appending a single log entry. */
    private appendLogEntry(entry: LogEntry) {
        this.appendLogEntries([entry]);
    }

    /** Appends log entries while keeping the in-memory buffer bounded. */
    private appendLogEntries(entries: LogEntry[]) {
        if (!entries.length) {
            return;
        }
        const merged = [...this.logs$.getValue(), ...entries];
        this.logs$.next(merged.slice(-MAX_LOGS));
    }

    /** Adds new style-validation issues to the diagnostics log stream. */
    private appendStyleValidationLogs(issues: StyleValidationIssue[]): void {
        const entries: LogEntry[] = [];
        for (const issue of issues) {
            const issueLogId = this.styleIssueLogId(issue);
            if (this.loggedStyleIssueIds.has(issueLogId)) {
                continue;
            }
            this.loggedStyleIssueIds.add(issueLogId);
            entries.push({
                at: issue.at,
                level: issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warn' : 'info',
                message: this.styleValidationReportService.formatIssueSummary(issue),
                data: issue
            });
        }
        this.appendLogEntries(entries);
    }

    /** Builds a stable-enough identity for style issues that may reuse wasm-local ids across tiles. */
    private styleIssueLogId(issue: StyleValidationIssue): string {
        return [
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
        ].join('|');
    }

    /** Monkey-patches console methods once so frontend logs also appear in the diagnostics log. */
    private patchConsoleLogging() {
        DiagnosticsDatasource.consoleLogHandler = (level: LogLevel, args: unknown[]) => this.handleConsoleLog(level, args);
        if (DiagnosticsDatasource.consolePatched) {
            return;
        }
        DiagnosticsDatasource.consolePatched = true;

        const original = {
            log: console.log,
            info: console.info,
            warn: console.warn,
            error: console.error,
            debug: console.debug
        };

        /** Wraps a console method so diagnostics can mirror emitted messages. */
        const wrap = (method: keyof typeof original, level: LogLevel) => {
            const originalMethod = original[method] ?? original.log;
            (console as any)[method] = (...args: unknown[]) => {
                DiagnosticsDatasource.forwardConsoleLog(level, args);
                if (originalMethod) {
                    originalMethod.apply(console, args as any);
                }
            };
        };

        wrap('log', 'info');
        wrap('info', 'info');
        wrap('warn', 'warn');
        wrap('error', 'error');
        wrap('debug', 'info');
    }

    /** Forwards patched console calls into the active datasource instance, if any. */
    private static forwardConsoleLog(level: LogLevel, args: unknown[]) {
        DiagnosticsDatasource.consoleLogHandler?.(level, args);
    }

    /** Converts one console call into a structured diagnostics log entry. */
    private handleConsoleLog(level: LogLevel, args: unknown[]) {
        const entry: LogEntry = {
            at: Date.now(),
            level,
            message: this.formatConsoleMessage(args),
            data: this.extractConsoleData(args)
        };
        this.appendLogEntry(entry);
    }

    /** Produces the human-readable message string for a captured console call. */
    private formatConsoleMessage(args: unknown[]): string {
        if (!args.length) {
            return '(empty log)';
        }
        return args
            .map(value => this.stringifyLogPart(value))
            .filter(part => part.length)
            .join(' ');
    }

    /** Preserves raw console arguments only when there is object/function payload worth inspecting. */
    private extractConsoleData(args: unknown[]): unknown {
        if (!args.length) {
            return undefined;
        }
        const hasObjectPayload = args.some(value =>
            (typeof value === 'object' && value !== null) || typeof value === 'function');
        return hasObjectPayload ? args : undefined;
    }

    /** Stringifies one console argument without throwing on cyclic or exotic values. */
    private stringifyLogPart(value: unknown): string {
        if (value === null) {
            return 'null';
        }
        if (value === undefined) {
            return 'undefined';
        }
        if (typeof value === 'string') {
            return value;
        }
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
            return String(value);
        }
        if (value instanceof Error) {
            return value.stack ?? value.message ?? value.toString();
        }
        try {
            const json = JSON.stringify(value);
            if (json !== undefined) {
                return json;
            }
        } catch (_err) {
            // Ignore serialization errors and fall back to string conversion.
        }
        return Object.prototype.toString.call(value);
    }
}

/** Extracts an explicit unit from a raw perf-stat key suffix. */
function parsePerfUnit(key: string): string | undefined {
    const lower = key.toLowerCase();
    for (const entry of UNIT_SUFFIXES) {
        if (lower.endsWith(entry.suffix)) {
            return entry.unit;
        }
    }
    return undefined;
}

/** Removes the configured unit suffix from a raw perf-stat key. */
function stripPerfUnitSuffix(key: string): string {
    const lower = key.toLowerCase();
    for (const entry of UNIT_SUFFIXES) {
        if (lower.endsWith(entry.suffix)) {
            return key.slice(0, key.length - entry.suffix.length);
        }
    }
    return key;
}

/** Infers count semantics from integer-only samples and count-like key names. */
function inferCountUnit(key: string, values: number[]): string | undefined {
    if (!values.length) {
        return undefined;
    }
    if (!values.every(value => Number.isInteger(value))) {
        return undefined;
    }
    if (COUNT_KEY_PATTERN.test(key)) {
        return 'count';
    }
    return undefined;
}

/** Resolves the best display unit for a perf stat, preferring explicit suffixes. */
function resolvePerfUnit(key: string, values: number[]): string | undefined {
    const explicit = parsePerfUnit(key);
    if (explicit) {
        return explicit;
    }
    const baseKey = stripPerfUnitSuffix(key);
    return inferCountUnit(baseKey, values);
}

/** Accumulator used while merging identical perf-stat keys across tiles. */
type AggregatedPerfAccumulator = {
    sum: number;
    count: number;
    peak: number;
    unit?: string;
    peakTileIds: Set<string>;
};

/** Small guard that rejects `NaN`/`Infinity` samples from backend perf stats. */
function isFiniteNumber(value: number): boolean {
    return Number.isFinite(value);
}

/** Aggregates raw per-tile perf stats into the tree-friendly diagnostics representation. */
export function buildAggregatedPerfStats(tiles: Iterable<FeatureTile>, maxPeakTileIds: number = 5): PerfStat[] {
    const statsByKey = new Map<string, AggregatedPerfAccumulator>();

    for (const tile of tiles) {
        if (!tile || typeof tile.hasData !== 'function' || !tile.hasData()) {
            continue;
        }
        const tileId = tile.tileId?.toString?.() ?? tile.mapTileKey ?? '';
        for (const [rawKey, rawValues] of tile.stats.entries()) {
            if (!rawValues || rawValues.length === 0) {
                continue;
            }
            const values = rawValues.filter(isFiniteNumber);
            if (!values.length) {
                continue;
            }

            const baseKey = stripPerfUnitSuffix(rawKey);
            if (!baseKey) {
                continue;
            }
            const unit = resolvePerfUnit(rawKey, values);
            const existing = statsByKey.get(baseKey) ?? {
                sum: 0,
                count: 0,
                peak: -Infinity,
                unit,
                peakTileIds: new Set<string>()
            };

            existing.sum += values.reduce((a, b) => a + b, 0);
            existing.count += values.length;
            if (unit && !existing.unit) {
                existing.unit = unit;
            }

            const tilePeak = Math.max(...values);
            if (tilePeak > existing.peak) {
                existing.peak = tilePeak;
                existing.peakTileIds = new Set<string>([tileId]);
            } else if (tilePeak === existing.peak) {
                existing.peakTileIds.add(tileId);
            }

            statsByKey.set(baseKey, existing);
        }
    }

    const aggregated: PerfStat[] = [];
    statsByKey.forEach((value, key) => {
        if (value.count === 0 || value.peak === -Infinity) {
            return;
        }
        aggregated.push({
            key,
            path: stripPerfUnitSuffix(key).split('/').map(segment => segment.trim()).filter(Boolean),
            unit: value.unit,
            peak: value.peak,
            average: value.count > 0 ? value.sum / value.count : undefined,
            peakTileIds: Array.from(value.peakTileIds).slice(0, maxPeakTileIds)
        });
    });

    aggregated.sort((a, b) => a.key.localeCompare(b.key));
    return aggregated;
}
