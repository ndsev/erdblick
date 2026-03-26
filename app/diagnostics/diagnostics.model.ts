export type LogLevel = 'info' | 'warn' | 'error';

export interface ProgressCounter {
    done: number;
    total: number;
}

export interface StageProgressCounter extends ProgressCounter {
    label: string;
}

export interface LoadingStatBubbles {
    downstreamBytesPerSecond: number;
    pullResponses: number;
    pullGzipResponses: number;
    pullUncompressedBytes: number;
    pullCompressedBytesKnown: number;
    pullCompressionRatioPct: number | null;
    pullCompressionCoveragePct: number;
    features: number;
    vertices: number;
    parseQueueSize: number;
    renderQueueSize: number;
    frameTimeMs: number;
    renderSeconds: number;
}

export interface TilePipelineProgress {
    stages: StageProgressCounter[];
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

export interface TileSizeDistribution {
    'tile-count'?: number;
    'total-tile-bytes'?: number;
    'min-bytes'?: number;
    'mean-bytes'?: number;
    'max-bytes'?: number;
    histogram?: Array<{
        label?: string;
        count?: number;
    }>;
}

export interface BackendStatusDataSummary {
    timestampMs?: number;
    service?: {
        datasources?: unknown;
        'active-requests'?: unknown;
    };
    cache?: unknown;
    tilesWebsocket?: unknown;
    tileSizeDistribution?: TileSizeDistribution;
    statusFetchError?: string;
}

export interface DiagnosticsExportBundle {
    exportedAt: string;
    metadata: {
        erdblickVersion?: string;
        distributionVersions?: unknown;
        userAgent?: string;
        url?: string;
        backendStatusFetchError?: string;
    };
    backendStatus?: BackendStatusDataSummary;
    progress?: DiagnosticsSnapshot;
    performance?: {
        stats: PerfStat[];
        raw?: unknown;
    };
    logs?: LogEntry[];
}
