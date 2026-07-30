import type {SubsetDiagnosticsTile} from "../mapview/view-layer-diagnostics.service";
import {COUNT_KEY_PATTERN, UNIT_SUFFIXES} from "./diagnostics.constants";
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
    unit?: string;
    peakTileIds: Set<string>;
};

/** Aggregates only current-generation, already deduplicated diagnostics rows. */
export function buildAggregatedPerfStats(
    tiles: Iterable<SubsetDiagnosticsTile>,
    maxPeakTileIds = 5
): PerfStat[] {
    const statsByKey = new Map<string, AggregatedPerfAccumulator>();
    for (const tile of tiles) {
        if (!tile.ready) {
            continue;
        }
        for (const [rawKey, rawValues] of tile.stats) {
            const values = rawValues.filter(Number.isFinite);
            const key = stripPerfUnitSuffix(rawKey);
            if (!key || !values.length) {
                continue;
            }
            const existing = statsByKey.get(key) ?? {
                sum: 0,
                count: 0,
                peak: -Infinity,
                unit: resolvePerfUnit(rawKey, values),
                peakTileIds: new Set<string>()
            };
            existing.sum += values.reduce((sum, value) => sum + value, 0);
            existing.count += values.length;
            const peak = Math.max(...values);
            if (peak > existing.peak) {
                existing.peak = peak;
                existing.peakTileIds = new Set([tile.tileId.toString()]);
            } else if (peak === existing.peak) {
                existing.peakTileIds.add(tile.tileId.toString());
            }
            statsByKey.set(key, existing);
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
            peakTileIds: [...value.peakTileIds].slice(0, maxPeakTileIds)
        }))
        .sort((left, right) => left.key.localeCompare(right.key));
}
