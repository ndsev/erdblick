/** Unit suffix mapping used to derive display units from raw perf-stat keys. */
export interface DiagnosticsUnitSuffix {
    suffix: string;
    unit: string;
}

/** Snapshot refresh cadence for progress diagnostics. */
export const SNAPSHOT_INTERVAL_MS = 2500;
/** Performance-stat refresh cadence. */
export const PERF_INTERVAL_MS = 2500;
/** Log refresh cadence. */
export const LOG_INTERVAL_MS = 1500;
/** Maximum number of log entries kept in memory. */
export const MAX_LOGS = 1000;
/** Maximum number of tile ids retained for a shared peak value. */
export const PEAK_TILE_LIMIT = 5;

/** Supported perf-key suffixes that imply a display unit. */
export const UNIT_SUFFIXES: DiagnosticsUnitSuffix[] = [
    {suffix: '#ms', unit: 'ms'},
    {suffix: '-ms', unit: 'ms'},
    {suffix: '#kb', unit: 'KB'},
    {suffix: '-kb', unit: 'KB'},
    {suffix: '#mb', unit: 'MB'},
    {suffix: '-mb', unit: 'MB'},
    {suffix: '#pct', unit: '%'},
    {suffix: '-pct', unit: '%'},
    {suffix: '#%', unit: '%'},
    {suffix: '-%', unit: '%'},
    {suffix: '#count', unit: 'count'},
    {suffix: '-count', unit: 'count'},
    {suffix: '#features', unit: 'features'},
    {suffix: '-features', unit: 'features'}
];

/** Heuristic for keys that likely represent integer counts. */
export const COUNT_KEY_PATTERN = /(count|num|tile|tiles)/i;
/** Heuristic for load/convert perf roots that get the blue root badge. */
export const LOAD_CONVERT_ROOT_BADGE_PATTERN = /(load|convert)/i;
/** Heuristic for render perf roots that get the green root badge. */
export const RENDER_ROOT_BADGE_PATTERN = /render/i;
/** PrimeNG design token override for load/convert root badges. */
export const ROOT_BADGE_LOAD_DT = {primary: {background: '{blue.500}'}};
/** PrimeNG design token override for render root badges. */
export const ROOT_BADGE_RENDER_DT = {primary: {background: '{emerald.500}'}};
/** Default number of decimals shown in formatted perf values. */
export const DISPLAY_DECIMALS = 3;
