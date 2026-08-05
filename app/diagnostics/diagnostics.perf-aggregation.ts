import type {SubsetDiagnosticsTile} from "../mapview/view-layer-diagnostics.service";
import {
    CONVERSION_AGE_UNIT,
    COUNT_KEY_PATTERN,
    UNIT_SUFFIXES
} from "./diagnostics.constants";
import type {PerfStat} from "./diagnostics.model";

function parsePerfUnit(key: string): string | undefined {
    const lower = key.toLowerCase();
    return UNIT_SUFFIXES.find(entry => lower.endsWith(entry.suffix))?.unit;
}

function stripPerfUnitSuffix(key: string): string {
    const lower = key.toLowerCase();
    const suffix = UNIT_SUFFIXES.find(entry => lower.endsWith(entry.suffix));
    return suffix ? key.slice(0, key.length - suffix.suffix.length) : key;
}

function resolvePerfUnit(key: string, values: number[]): string | undefined {
    return parsePerfUnit(key) ??
        (values.every(Number.isInteger) &&
        COUNT_KEY_PATTERN.test(stripPerfUnitSuffix(key))
            ? "count"
            : undefined);
}

type AggregatedPerfAccumulator = {
    sum: number;
    count: number;
    peak: number;
    min: number;
    unit?: string;
    peakTileIds: Set<string>;
};

/** Adds one tile's finite samples to the aggregate for a normalized metric key. */
function accumulatePerfValues(
    statsByKey: Map<string, AggregatedPerfAccumulator>,
    rawKey: string,
    rawValues: number[],
    tileId: string,
    unitOverride?: string
): void {
    const values = rawValues.filter(Number.isFinite);
    const key = stripPerfUnitSuffix(rawKey);
    if (!key || !values.length) {
        return;
    }
    const existing = statsByKey.get(key) ?? {
        sum: 0,
        count: 0,
        peak: -Infinity,
        min: Infinity,
        unit: unitOverride ?? resolvePerfUnit(rawKey, values),
        peakTileIds: new Set<string>()
    };
    existing.sum += values.reduce((sum, value) => sum + value, 0);
    existing.count += values.length;
    existing.min = Math.min(existing.min, ...values);
    const peak = Math.max(...values);
    if (peak > existing.peak) {
        existing.peak = peak;
        existing.peakTileIds = new Set([tileId]);
    } else if (peak === existing.peak) {
        existing.peakTileIds.add(tileId);
    }
    statsByKey.set(key, existing);
}

/** Aggregates only current-generation, already deduplicated diagnostics rows. */
export function buildAggregatedPerfStats(
    tiles: Iterable<SubsetDiagnosticsTile>,
    maxPeakTileIds = 5,
    nowMs = Date.now()
): PerfStat[] {
    const statsByKey = new Map<string, AggregatedPerfAccumulator>();
    for (const tile of tiles) {
        if (!tile.ready) {
            continue;
        }
        const tileId = tile.tileId.toString();
        if (tile.conversionTimestampMs !== null &&
            Number.isFinite(tile.conversionTimestampMs)) {
            const age = nowMs - tile.conversionTimestampMs;
            accumulatePerfValues(
                statsByKey,
                "Load+Convert/Age",
                [age],
                tileId,
                CONVERSION_AGE_UNIT
            );
        }
        for (const [rawKey, rawValues] of tile.stats) {
            accumulatePerfValues(statsByKey, rawKey, rawValues, tileId);
        }
    }
    return [...statsByKey.entries()]
        .filter(([, value]) => value.count > 0)
        .map(([key, value]) => ({
            key,
            path: key.split("/").map(segment => segment.trim()).filter(Boolean),
            unit: value.unit,
            peak: value.peak,
            average: value.sum / value.count,
            min: value.min,
            peakTileIds: [...value.peakTileIds].slice(0, maxPeakTileIds)
        }))
        .sort((left, right) => left.key.localeCompare(right.key));
}
