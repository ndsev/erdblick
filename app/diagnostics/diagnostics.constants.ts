export interface DiagnosticsUnitSuffix {
    suffix: string;
    unit: string;
}

export const SNAPSHOT_INTERVAL_MS = 2500;
export const PERF_INTERVAL_MS = 2500;
export const LOG_INTERVAL_MS = 1500;
export const MAX_LOGS = 1000;
export const PEAK_TILE_LIMIT = 5;

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

export const COUNT_KEY_PATTERN = /(count|num|tile|tiles)/i;
export const LOAD_CONVERT_ROOT_BADGE_PATTERN = /(load|convert)/i;
export const RENDER_ROOT_BADGE_PATTERN = /render/i;
export const ROOT_BADGE_LOAD_DT = {primary: {background: '{blue.500}'}};
export const ROOT_BADGE_RENDER_DT = {primary: {background: '{emerald.500}'}};
export const DISPLAY_DECIMALS = 3;
