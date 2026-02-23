export type LogLevel = 'info' | 'warn' | 'error';

export interface ProgressCounter {
    done: number;
    total: number;
}

export interface LoadingStatBubbles {
    downstreamBytesPerSecond: number;
    features: number;
    vertices: number;
    renderSeconds: number;
}

export interface TilePipelineProgress {
    stages: ProgressCounter[];
    backend: ProgressCounter;
    rendered: ProgressCounter;
    bubbles: LoadingStatBubbles;
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
    backend: BackendState;
}

export interface PerfStat {
    key: string;
    path: string[];
    unit?: string;
    peak: number;
    average?: number;
    peakTileIds?: string[];
}

export interface LogEntry {
    at: number;
    level: LogLevel;
    message: string;
    data?: unknown;
}

export interface DiagnosticsLogFilter {
    info: boolean;
    warn: boolean;
    error: boolean;
}

export interface DiagnosticsExportOptions {
    includeProgress: boolean;
    includePerformance: boolean;
    includeLogs: boolean;
    logFilter: DiagnosticsLogFilter;
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
