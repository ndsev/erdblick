export type LogLevel = 'info' | 'warn' | 'error';

export interface ProgressCounter {
    done: number;
    total: number;
}

export interface TilePipelineProgress {
    requested: ProgressCounter;
    fetched: ProgressCounter;
    converted: ProgressCounter;
    received: ProgressCounter;
    rendered: ProgressCounter;
}

export interface TileStateCounts {
    expected: number;
    loaded: number;
    cached: number;
    errors: number;
}

export interface VisualizationCounts {
    present: number;
    queue: number;
    tilesWithFeatures: number;
    features: number;
}

export interface BackendState {
    connected: boolean;
    lastStatus?: string;
    lastError?: string;
    lastStatusAt?: number;
}

export interface DiagnosticsSnapshot {
    at: number;
    tiles: TileStateCounts;
    progress: TilePipelineProgress;
    visualizations: VisualizationCounts;
    backend: BackendState;
}

export type SuspiciousLevel = 'ok' | 'warn' | 'bad';

export interface PerfStat {
    key: string;
    path: string[];
    unit?: string;
    peak: number;
    average?: number;
    peakTileIds?: string[];
    suspicious?: SuspiciousLevel;
}

export interface LogEntry {
    at: number;
    level: LogLevel;
    message: string;
    data?: unknown;
}

export interface DiagnosticsExportBundle {
    exportedAt: string;
    metadata: {
        erdblickVersion?: string;
        distributionVersions?: unknown;
        userAgent?: string;
        url?: string;
    };
    progress?: DiagnosticsSnapshot;
    performance?: {
        stats: PerfStat[];
        raw?: unknown;
    };
    logs?: LogEntry[];
}
