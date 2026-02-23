import {Injectable, OnDestroy} from '@angular/core';
import {auditTime, BehaviorSubject, interval, Subscription} from 'rxjs';
import {MapDataService} from '../mapdata/map.service';
import {FeatureTile} from '../mapdata/features.model';
import {DiagnosticsSnapshot, LogEntry, LogLevel, PerfStat, TilePipelineProgress, TileStateCounts} from './diagnostics.model';
import {
    COUNT_KEY_PATTERN,
    LOG_INTERVAL_MS,
    MAX_LOGS,
    PEAK_TILE_LIMIT,
    PERF_INTERVAL_MS,
    SNAPSHOT_INTERVAL_MS,
    UNIT_SUFFIXES
} from './diagnostics.constants';
const UPDATE_EVENT_DEBOUNCE_MS = 1000;

@Injectable()
export class DiagnosticsDatasource implements OnDestroy {
    readonly snapshot$ = new BehaviorSubject<DiagnosticsSnapshot>(this.buildSnapshot());
    readonly perfStats$ = new BehaviorSubject<PerfStat[]>([]);
    readonly logs$ = new BehaviorSubject<LogEntry[]>([]);

    private static consolePatched = false;
    private static consoleLogHandler?: (level: LogLevel, args: unknown[]) => void;

    private readonly subscriptions: Subscription[] = [];
    private lastBackendConnected = this.mapService.isTileStreamConnected();
    private readonly errorTileKeys = new Set<string>();

    constructor(private readonly mapService: MapDataService) {
        this.patchConsoleLogging();
        this.refreshPerfStats();
        this.refreshLogs();
        let wasPaused = this.mapService.tilePipelinePaused;

        this.subscriptions.push(
            interval(SNAPSHOT_INTERVAL_MS).subscribe(() => {
                if (this.mapService.tilePipelinePaused) {
                    return;
                }
                this.snapshot$.next(this.buildSnapshot());
            }),
            interval(PERF_INTERVAL_MS).subscribe(() => this.refreshPerfStats()),
            interval(LOG_INTERVAL_MS).subscribe(() => this.refreshLogs()),
            this.mapService.tilePipelinePaused$.subscribe(paused => {
                if (wasPaused && !paused) {
                    this.snapshot$.next(this.buildSnapshot());
                    this.refreshPerfStats();
                }
                wasPaused = paused;
            }),
            this.mapService.statsDialogNeedsUpdate
                .pipe(auditTime(UPDATE_EVENT_DEBOUNCE_MS))
                .subscribe(() => this.refreshOnDemand())
        );
    }

    ngOnDestroy() {
        this.subscriptions.forEach(sub => sub.unsubscribe());
    }

    refreshPerfStats() {
        if (this.mapService.tilePipelinePaused) {
            return;
        }
        const stats = buildAggregatedPerfStats(this.mapService.loadedTileLayers.values(), PEAK_TILE_LIMIT);
        this.perfStats$.next(stats);
    }

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

    private refreshOnDemand() {
        this.refreshPerfStats();
        this.refreshLogs();
    }

    private buildSnapshot(): DiagnosticsSnapshot {
        const tiles = Array.from(this.mapService.loadedTileLayers.values());
        const expected = tiles.length;
        let loaded = 0;
        let errors = 0;
        const stageCounters: Array<{done: number; total: number}> = [];
        for (const tile of tiles) {
            const hasData = tile.hasData();
            if (hasData) {
                loaded += 1;
            }
            if (tile.error) {
                errors += 1;
            }
            const stageCount = this.mapService.getLayerStageCount(tile.mapName, tile.layerName);
            for (let stage = 0; stage < stageCount; stage++) {
                if (stageCounters.length <= stage) {
                    stageCounters.push({done: 0, total: 0});
                }
                const counter = stageCounters[stage];
                counter.total += 1;
                if (tile.hasStage(stage)) {
                    counter.done += 1;
                }
            }
        }

        const tilesSummary: TileStateCounts = {
            expected,
            loaded,
            cached: 0,
            errors
        };

        const backendProgress = this.mapService.getBackendRequestProgress();
        const hudStats = this.mapService.getTileLoadingHudStats();
        const progress: TilePipelineProgress = {
            stages: stageCounters,
            backend: {
                done: backendProgress.done,
                total: backendProgress.total,
            },
            rendered: this.mapService.getVisualizationCounts(),
            bubbles: {
                downstreamBytesPerSecond: hudStats.downstreamBytesPerSecond,
                features: hudStats.features,
                vertices: hudStats.vertices,
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

    private appendLogEntry(entry: LogEntry) {
        this.appendLogEntries([entry]);
    }

    private appendLogEntries(entries: LogEntry[]) {
        if (!entries.length) {
            return;
        }
        const merged = [...this.logs$.getValue(), ...entries];
        this.logs$.next(merged.slice(-MAX_LOGS));
    }

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

    private static forwardConsoleLog(level: LogLevel, args: unknown[]) {
        DiagnosticsDatasource.consoleLogHandler?.(level, args);
    }

    private handleConsoleLog(level: LogLevel, args: unknown[]) {
        const entry: LogEntry = {
            at: Date.now(),
            level,
            message: this.formatConsoleMessage(args),
            data: this.extractConsoleData(args)
        };
        this.appendLogEntry(entry);
    }

    private formatConsoleMessage(args: unknown[]): string {
        if (!args.length) {
            return '(empty log)';
        }
        return args
            .map(value => this.stringifyLogPart(value))
            .filter(part => part.length)
            .join(' ');
    }

    private extractConsoleData(args: unknown[]): unknown {
        if (!args.length) {
            return undefined;
        }
        const hasObjectPayload = args.some(value =>
            (typeof value === 'object' && value !== null) || typeof value === 'function');
        return hasObjectPayload ? args : undefined;
    }

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

function parsePerfUnit(key: string): string | undefined {
    const lower = key.toLowerCase();
    for (const entry of UNIT_SUFFIXES) {
        if (lower.endsWith(entry.suffix)) {
            return entry.unit;
        }
    }
    return undefined;
}

function stripPerfUnitSuffix(key: string): string {
    const lower = key.toLowerCase();
    for (const entry of UNIT_SUFFIXES) {
        if (lower.endsWith(entry.suffix)) {
            return key.slice(0, key.length - entry.suffix.length);
        }
    }
    return key;
}

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

function resolvePerfUnit(key: string, values: number[]): string | undefined {
    const explicit = parsePerfUnit(key);
    if (explicit) {
        return explicit;
    }
    const baseKey = stripPerfUnitSuffix(key);
    return inferCountUnit(baseKey, values);
}

type AggregatedPerfAccumulator = {
    sum: number;
    count: number;
    peak: number;
    unit?: string;
    peakTileIds: Set<string>;
};

function isFiniteNumber(value: number): boolean {
    return Number.isFinite(value);
}

export function buildAggregatedPerfStats(tiles: Iterable<FeatureTile>, maxPeakTileIds: number = 5): PerfStat[] {
    const statsByKey = new Map<string, AggregatedPerfAccumulator>();

    for (const tile of tiles) {
        if (!tile || typeof tile.hasData !== 'function' || !tile.hasData() || tile.numFeatures <= 0) {
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
