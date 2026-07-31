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
    unit?: string;
    peakTileIds: Set<string>;
};

type ConversionAgeAccumulator = {
    sum: number;
    count: number;
    newest: number;
    oldest: number;
    newestTileIds: Set<string>;
    oldestTileIds: Set<string>;
};

/** Aggregates only current-generation, already deduplicated diagnostics rows. */
export function buildAggregatedPerfStats(
    tiles: Iterable<SubsetDiagnosticsTile>,
    maxPeakTileIds = 5,
    nowMs = Date.now()
): PerfStat[] {
    const statsByKey = new Map<string, AggregatedPerfAccumulator>();
    const conversionAges: ConversionAgeAccumulator = {
        sum: 0,
        count: 0,
        newest: Infinity,
        oldest: -Infinity,
        newestTileIds: new Set<string>(),
        oldestTileIds: new Set<string>()
    };
    for (const tile of tiles) {
        if (!tile.ready) {
            continue;
        }
        const tileId = tile.tileId.toString();
        if (tile.conversionTimestampMs !== null &&
            Number.isFinite(tile.conversionTimestampMs)) {
            const age = nowMs - tile.conversionTimestampMs;
            conversionAges.sum += age;
            conversionAges.count += 1;
            if (age < conversionAges.newest) {
                conversionAges.newest = age;
                conversionAges.newestTileIds = new Set([tileId]);
            } else if (age === conversionAges.newest) {
                conversionAges.newestTileIds.add(tileId);
            }
            if (age > conversionAges.oldest) {
                conversionAges.oldest = age;
                conversionAges.oldestTileIds = new Set([tileId]);
            } else if (age === conversionAges.oldest) {
                conversionAges.oldestTileIds.add(tileId);
            }
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
                existing.peakTileIds = new Set([tileId]);
            } else if (peak === existing.peak) {
                existing.peakTileIds.add(tileId);
            }
            statsByKey.set(key, existing);
        }
    }
    const aggregated = [...statsByKey.entries()]
        .filter(([, value]) => value.count > 0)
        .map(([key, value]) => ({
            key,
            path: key.split("/").map(segment => segment.trim()).filter(Boolean),
            unit: value.unit,
            peak: value.peak,
            average: value.sum / value.count,
            peakTileIds: [...value.peakTileIds].slice(0, maxPeakTileIds)
        }));
    if (conversionAges.count > 0) {
        const average = conversionAges.sum / conversionAges.count;
        aggregated.push({
            key: "Load+Convert/Age",
            path: ["Load+Convert", "Age"],
            unit: CONVERSION_AGE_UNIT,
            peak: conversionAges.oldest,
            average,
            peakTileIds: [...conversionAges.oldestTileIds]
                .slice(0, maxPeakTileIds)
        });
        aggregated.push({
            key: "Load+Convert/Freshness",
            path: ["Load+Convert", "Freshness"],
            unit: CONVERSION_AGE_UNIT,
            peak: conversionAges.newest,
            average,
            peakTileIds: [...conversionAges.newestTileIds]
                .slice(0, maxPeakTileIds)
        });
    }
    return aggregated.sort((left, right) => left.key.localeCompare(right.key));
}
