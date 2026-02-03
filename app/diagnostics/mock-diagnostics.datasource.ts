import {Injectable, OnDestroy} from '@angular/core';
import {BehaviorSubject, interval, Subscription} from 'rxjs';
import {DiagnosticsDataSource} from './diagnostics.datasource';
import {DiagnosticsSnapshot, LogEntry, PerfStat, ProgressCounter} from './diagnostics.model';
import {parsePerfUnit, splitPerfPath} from './diagnostics.utils';

const SNAPSHOT_INTERVAL_MS = 400;
const PERF_INTERVAL_MS = 3000;
const LOG_INTERVAL_MS = 900;
const MAX_LOGS = 200;

const SCENARIOS = ['happy', 'server-down', 'tile-limit', 'conversion-slow', 'render-queue', 'errors'] as const;

type ScenarioName = typeof SCENARIOS[number];

interface ScenarioConfig {
    name: ScenarioName;
    total: number;
    requestRate: number;
    fetchRate: number;
    convertRate: number;
    receiveRate: number;
    renderRate: number;
    backendConnected: boolean;
    loadLimit?: number;
    errorEvery: number;
}

interface PipelineState {
    requested: number;
    fetched: number;
    converted: number;
    received: number;
    rendered: number;
    total: number;
    errorTiles: number;
    tick: number;
    cooldown: number;
}

class LcgRandom {
    private state: number;

    constructor(seed: number) {
        this.state = seed >>> 0;
    }

    next(): number {
        this.state = (1664525 * this.state + 1013904223) >>> 0;
        return this.state / 0x100000000;
    }

    nextInt(max: number): number {
        return Math.floor(this.next() * max);
    }
}

@Injectable()
export class MockDiagnosticsDataSource implements DiagnosticsDataSource, OnDestroy {
    readonly snapshot$: BehaviorSubject<DiagnosticsSnapshot>;
    readonly perfStats$: BehaviorSubject<PerfStat[]>;
    readonly logs$: BehaviorSubject<LogEntry[]>;

    private readonly subscriptions: Subscription[] = [];
    private readonly rng = new LcgRandom(48271);
    private readonly scenario: ScenarioConfig;
    private readonly state: PipelineState;

    private readonly basePerfStats: Array<Omit<PerfStat, 'path' | 'unit'>> = [
        {
            key: 'fill-time-ms',
            peak: 1.0,
            average: 1.0,
            peakTileIds: ["37357750779917"]
        },
        {
            key: 'num-features',
            peak: 88.0,
            average: 88.0,
            peakTileIds: ["37357750779917"]
        },
        {
            key: 'parse-time-ms',
            peak: 1.0,
            average: 0.5,
            peakTileIds: ["37357750779917"]
        },
        {
            key: 'render-time-common-selection-ms',
            peak: 2.0,
            average: 2.0,
            peakTileIds: ["37357750779917"]
        },
        {
            key: 'render-time-nds.live/lanes-selection-ms',
            peak: 0.0,
            average: 0.0,
            peakTileIds: ["37357750779917"]
        },
        {
            key: 'tile-size-kb',
            peak: 49.56,
            average: 49.56,
            peakTileIds: ["37357750779917"]
        }
    ];

    constructor() {
        this.scenario = this.resolveScenario();
        this.state = {
            requested: 0,
            fetched: 0,
            converted: 0,
            received: 0,
            rendered: 0,
            total: this.scenario.total,
            errorTiles: 0,
            tick: 0,
            cooldown: 0
        };

        this.snapshot$ = new BehaviorSubject<DiagnosticsSnapshot>(this.createSnapshot());
        this.perfStats$ = new BehaviorSubject<PerfStat[]>([]);
        this.logs$ = new BehaviorSubject<LogEntry[]>([]);

        this.emitPerfStats();
        this.subscriptions.push(
            interval(SNAPSHOT_INTERVAL_MS).subscribe(() => this.advanceSnapshot()),
            interval(PERF_INTERVAL_MS).subscribe(() => this.emitPerfStats()),
            interval(LOG_INTERVAL_MS).subscribe(() => this.emitLog())
        );
    }

    ngOnDestroy() {
        this.subscriptions.forEach(sub => sub.unsubscribe());
    }

    private resolveScenario(): ScenarioConfig {
        const name = this.getScenarioFromQuery();
        const base = {
            name,
            total: 180,
            requestRate: 8,
            fetchRate: 6,
            convertRate: 5,
            receiveRate: 6,
            renderRate: 5,
            backendConnected: true,
            errorEvery: 30
        };

        switch (name) {
            case 'server-down':
                return {
                    ...base,
                    total: 200,
                    fetchRate: 0,
                    convertRate: 0,
                    receiveRate: 0,
                    renderRate: 0,
                    backendConnected: false,
                    errorEvery: 12
                };
            case 'tile-limit':
                return {
                    ...base,
                    total: 320,
                    fetchRate: 4,
                    convertRate: 3,
                    receiveRate: 3,
                    renderRate: 2,
                    loadLimit: 96,
                    errorEvery: 40
                };
            case 'conversion-slow':
                return {
                    ...base,
                    total: 220,
                    fetchRate: 6,
                    convertRate: 2,
                    receiveRate: 3,
                    renderRate: 3,
                    errorEvery: 28
                };
            case 'render-queue':
                return {
                    ...base,
                    total: 210,
                    fetchRate: 7,
                    convertRate: 6,
                    receiveRate: 6,
                    renderRate: 2,
                    errorEvery: 36
                };
            case 'errors':
                return {
                    ...base,
                    total: 200,
                    fetchRate: 6,
                    convertRate: 5,
                    receiveRate: 5,
                    renderRate: 4,
                    errorEvery: 6
                };
            default:
                return base;
        }
    }

    private getScenarioFromQuery(): ScenarioName {
        if (typeof window === 'undefined') {
            return 'happy';
        }
        const params = new URLSearchParams(window.location.search);
        const scenario = params.get('diagScenario')?.toLowerCase() ?? 'happy';
        if (SCENARIOS.includes(scenario as ScenarioName)) {
            return scenario as ScenarioName;
        }
        return 'happy';
    }

    private advanceSnapshot() {
        this.state.tick += 1;
        this.advancePipeline();
        this.applyErrorBursts();
        this.snapshot$.next(this.createSnapshot());
    }

    private advancePipeline() {
        const {requestRate, fetchRate, convertRate, receiveRate, renderRate, loadLimit} = this.scenario;
        const total = this.state.total;

        this.state.requested = Math.min(total, this.state.requested + requestRate);

        const fetchCap = Math.min(this.state.requested, loadLimit ?? this.state.requested);
        this.state.fetched = Math.min(fetchCap, this.state.fetched + fetchRate);
        this.state.converted = Math.min(this.state.fetched, this.state.converted + convertRate);
        this.state.received = Math.min(this.state.converted, this.state.received + receiveRate);
        this.state.rendered = Math.min(this.state.received, this.state.rendered + renderRate);

        if (this.shouldLoop() && this.state.rendered >= total) {
            this.state.cooldown += 1;
            if (this.state.cooldown > 6) {
                this.resetPipeline();
            }
        }
    }

    private shouldLoop(): boolean {
        return this.scenario.name !== 'server-down' && this.scenario.name !== 'tile-limit';
    }

    private resetPipeline() {
        this.state.requested = 0;
        this.state.fetched = 0;
        this.state.converted = 0;
        this.state.received = 0;
        this.state.rendered = 0;
        this.state.errorTiles = 0;
        this.state.cooldown = 0;
        this.state.total = 160 + this.rng.nextInt(80);
    }

    private applyErrorBursts() {
        if (this.state.tick % this.scenario.errorEvery !== 0) {
            return;
        }
        const maxErrors = Math.max(1, Math.floor(this.state.received * 0.1));
        const nextErrors = Math.min(maxErrors, this.state.errorTiles + 1 + this.rng.nextInt(3));
        this.state.errorTiles = nextErrors;
    }

    private createSnapshot(): DiagnosticsSnapshot {
        const now = Date.now();
        const requested: ProgressCounter = {
            done: this.state.requested,
            total: this.state.total
        };
        const fetched: ProgressCounter = {
            done: this.state.fetched,
            total: this.state.total
        };
        const converted: ProgressCounter = {
            done: this.state.converted,
            total: this.state.total
        };
        const received: ProgressCounter = {
            done: this.state.received,
            total: this.state.total
        };
        const rendered: ProgressCounter = {
            done: this.state.rendered,
            total: this.state.total
        };

        const expected = requested.total;
        const loaded = received.done;
        const cached = Math.min(loaded, Math.floor(loaded * (0.15 + this.rng.next() * 0.1)));
        const errors = Math.min(loaded, this.state.errorTiles);
        const queue = Math.max(0, received.done - rendered.done);

        return {
            at: now,
            tiles: {
                expected,
                loaded,
                cached,
                errors
            },
            progress: {
                requested,
                fetched,
                converted,
                received,
                rendered
            },
            visualizations: {
                present: rendered.done,
                queue
            },
            backend: {
                connected: this.scenario.backendConnected,
                lastStatus: this.scenario.backendConnected ? 'Streaming' : 'Disconnected',
                lastError: this.scenario.backendConnected ? undefined : 'WebSocket closed',
                lastStatusAt: now
            }
        };
    }

    private emitPerfStats() {
        const stats = this.basePerfStats.map(stat => {
            const unit = stat.key === 'num-features' ? 'count' : parsePerfUnit(stat.key);
            return {
                ...stat,
                path: splitPerfPath(stat.key),
                unit
            };
        });
        this.perfStats$.next(stats);
    }

    private emitLog() {
        const now = Date.now();
        const level = this.pickLogLevel();
        const message = this.pickLogMessage(level);
        const entry: LogEntry = {
            at: now,
            level,
            message
        };

        if (level === 'error' && this.scenario.name === 'server-down') {
            entry.data = {code: 'WS_CLOSED'};
        }

        const logs = [...this.logs$.getValue(), entry];
        this.logs$.next(logs.slice(-MAX_LOGS));
    }

    private pickLogLevel(): LogEntry['level'] {
        const roll = this.rng.next();
        switch (this.scenario.name) {
            case 'errors':
                return roll < 0.4 ? 'error' : roll < 0.7 ? 'warn' : 'info';
            case 'server-down':
                return roll < 0.5 ? 'error' : roll < 0.8 ? 'warn' : 'info';
            case 'tile-limit':
                return roll < 0.1 ? 'error' : roll < 0.5 ? 'warn' : 'info';
            case 'conversion-slow':
            case 'render-queue':
                return roll < 0.1 ? 'error' : roll < 0.4 ? 'warn' : 'info';
            default:
                return roll < 0.05 ? 'error' : roll < 0.2 ? 'warn' : 'info';
        }
    }

    private pickLogMessage(level: LogEntry['level']): string {
        const messages = {
            info: [
                'Tile request batch issued',
                'Tiles converted successfully',
                'Visualization queue updated',
                'Backend heartbeat received'
            ],
            warn: [
                'Tile limit reached, throttling requests',
                'Conversion backlog detected',
                'Render queue growing',
                'Backend response delayed'
            ],
            error: [
                'Tile conversion error',
                'Backend connection lost',
                'Render task failed',
                'Tile fetch failed'
            ]
        };

        if (this.scenario.name === 'server-down' && level !== 'info') {
            return level === 'error' ? 'WebSocket closed while requesting tiles' : 'Backend disconnected';
        }

        const list = messages[level];
        return list[this.rng.nextInt(list.length)];
    }
}
