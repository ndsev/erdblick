/** Severity levels used by the diagnostics log. */
export type LogLevel = 'info' | 'warn' | 'error';

/** Simple `done/total` counter pair used throughout the diagnostics UI. */
export interface ProgressCounter {
    done: number;
    total: number;
}

/** Named progress stage shown in the pipeline progress widget. */
export interface StageProgressCounter extends ProgressCounter {
    label: string;
}

/** Miscellaneous loading metrics shown as compact bubbles in the progress HUD. */
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

/** Full tile-pipeline progress model consumed by diagnostics widgets. */
export interface TilePipelineProgress {
    stages: StageProgressCounter[];
    backend: ProgressCounter;
    rendered: ProgressCounter;
    bubbles: LoadingStatBubbles;
}

/** High-level counts for the currently tracked tiles. */
export interface TileStateCounts {
    expected: number;
    loaded: number;
    cached: number;
    errors: number;
}

/** Counts for rendered or queued visualization work. */
export interface VisualizationCounts {
    present: number;
    queue: number;
    tilesWithFeatures: number;
    features: number;
}

/** Backend connectivity state shown in the diagnostics UI. */
export interface BackendState {
    connected: boolean;
    lastStatus?: string;
    lastError?: string;
    lastStatusAt?: number;
}

/** Point-in-time diagnostics snapshot combining tile, progress, and backend state. */
export interface DiagnosticsSnapshot {
    at: number;
    tiles: TileStateCounts;
    progress: TilePipelineProgress;
    backend: BackendState;
}

/** Aggregated performance statistic derived from one raw backend stat path. */
export interface PerfStat {
    key: string;
    path: string[];
    unit?: string;
    peak: number;
    average?: number;
    peakTileIds?: string[];
}

/** One diagnostics log entry, including optional structured payload data. */
export interface LogEntry {
    at: number;
    level: LogLevel;
    message: string;
    data?: unknown;
}

/** Checkbox state for log-level filtering in dialogs and exports. */
export interface DiagnosticsLogFilter {
    info: boolean;
    warn: boolean;
    error: boolean;
}

/** Persisted options for diagnostics export generation. */
export interface DiagnosticsExportOptions {
    includeProgress: boolean;
    includePerformance: boolean;
    includeLogs: boolean;
    logFilter: DiagnosticsLogFilter;
}

/** Tile-size histogram reported by `/status-data`. */
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

/** Subset of backend status data relevant for diagnostics export. */
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

/** JSON payload written when the user exports diagnostics. */
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
