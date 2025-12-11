import type { FullConfig } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Global Playwright teardown.
 *
 * Summarises V8 JavaScript and CSS coverage collected during the test run into
 * `coverage/playwright/v8-coverage-summary.json` and shuts down the `mapget`
 * process that was spawned in `global-setup.ts` using the pid stored in
 * `playwright/.cache/global-state.json`.
 */

interface GlobalState {
    mapgetPid: number | null;
    baseURL: string;
}

interface CoverageStats {
    totalBytes: number;
    usedBytes: number;
    pct: number;
}

interface V8Range {
    startOffset?: number;
    endOffset?: number;
    start?: number;
    end?: number;
    count?: number;
}

interface V8FunctionCoverage {
    functionName?: string;
    isBlockCoverage?: boolean;
    ranges?: V8Range[];
}

interface V8JSCoverageEntry {
    url?: string;
    scriptId?: string;
    source?: string;
    text?: string;
    functions?: V8FunctionCoverage[];
}

interface V8CSSCoverageEntry {
    url?: string;
    text?: string;
    ranges?: V8Range[];
}

interface Summary {
    js: {
        totalBytes: number;
        usedBytes: number;
        pct: number;
        byScript: Record<string, CoverageStats>;
    };
    css: {
        totalBytes: number;
        usedBytes: number;
        pct: number;
        byStylesheet: Record<string, CoverageStats>;
    };
    combined: CoverageStats;
}

/**
 * Loads a newline-delimited JSON (NDJSON) file where each line is a separate
 * JSON object. Missing files are treated as empty input.
 *
 * @param filePath Path to the NDJSON file.
 */
function loadNdjson<T>(filePath: string): T[] {
    if (!fs.existsSync(filePath)) {
        // No coverage file for this kind; treat as empty.
        return [];
    }

    const content = fs.readFileSync(filePath, 'utf8');
    return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as T);
}

/**
 * Aggregates V8 JavaScript coverage entries into total / used byte counts and
 * per-script statistics. Coverage is tracked at the character level to obtain
 * a simple byte-based approximation of usage.
 *
 * @param entries Raw V8 JS coverage entries emitted by Chromium.
 */
function computeJsStats(entries: V8JSCoverageEntry[]): {
    totalBytes: number;
    usedBytes: number;
    pct: number;
    byScript: Record<string, CoverageStats>;
} {
    let totalBytes = 0;
    let usedBytes = 0;
    const byScript: Record<string, CoverageStats> = {};

    for (const entry of entries) {
        // Prefer the original source text when available.
        const source = (entry && (entry.source || entry.text)) || '';
        const len = source.length;
        if (!len) {
            continue;
        }

        // Track per-character coverage information.
        const covered = new Uint8Array(len);
        const functions = Array.isArray(entry.functions) ? entry.functions : [];

        for (const fn of functions) {
            const ranges = Array.isArray(fn.ranges)
                ? [...fn.ranges]
                : [];

            // Sort by range length so later ranges can overwrite earlier ones.
            ranges.sort((a, b) => {
                const aStart = a.startOffset ?? a.start ?? 0;
                const aEnd = a.endOffset ?? a.end ?? aStart;
                const bStart = b.startOffset ?? b.start ?? 0;
                const bEnd = b.endOffset ?? b.end ?? bStart;
                const aLen = aEnd - aStart;
                const bLen = bEnd - bStart;
                return aLen - bLen;
            });

            for (const r of ranges) {
                if (!r) {
                    continue;
                }

                // Clamp coverage ranges to the source length.
                const start = Math.max(
                    0,
                    Math.min(len, r.startOffset ?? r.start ?? 0)
                );
                const end = Math.max(
                    start,
                    Math.min(len, r.endOffset ?? r.end ?? start)
                );

                const value = r.count && r.count > 0 ? 1 : 0;
                for (let i = start; i < end; i++) {
                    covered[i] = value;
                }
            }
        }

        // Count characters that were executed at least once.
        let used = 0;
        for (let i = 0; i < len; i++) {
            if (covered[i]) {
                used++;
            }
        }

        totalBytes += len;
        usedBytes += used;

        const key = entry.url || `<anonymous:${entry.scriptId || 'unknown'}>`;
        const pct = len ? (used * 100) / len : 0;

        byScript[key] = {
            totalBytes: len,
            usedBytes: used,
            pct
        };
    }

    return {
        totalBytes,
        usedBytes,
        pct: totalBytes ? (usedBytes * 100) / totalBytes : 0,
        byScript
    };
}

function computeCssStats(entries: V8CSSCoverageEntry[]): {
    totalBytes: number;
    usedBytes: number;
    pct: number;
    byStylesheet: Record<string, CoverageStats>;
} {
    let totalBytes = 0;
    let usedBytes = 0;
    const byStylesheet: Record<string, CoverageStats> = {};

    for (const entry of entries) {
        // CSS coverage only exposes `text` and ranges.
        const text = (entry && entry.text) || '';
        const len = text.length;
        if (!len) {
            continue;
        }

        // Track per-character coverage information.
        const covered = new Uint8Array(len);
        const ranges = Array.isArray(entry.ranges) ? entry.ranges : [];

        for (const r of ranges) {
            if (!r) {
                continue;
            }
            // Clamp coverage ranges to the stylesheet length.
            const start = Math.max(
                0,
                Math.min(len, r.start ?? r.startOffset ?? 0)
            );
            const end = Math.max(
                start,
                Math.min(len, r.end ?? r.endOffset ?? start)
            );
            for (let i = start; i < end; i++) {
                covered[i] = 1;
            }
        }

        let used = 0;
        for (let i = 0; i < len; i++) {
            if (covered[i]) {
                used++;
            }
        }

        totalBytes += len;
        usedBytes += used;

        const key = entry.url || '<anonymous-style>';
        const pct = len ? (used * 100) / len : 0;

        byStylesheet[key] = {
            totalBytes: len,
            usedBytes: used,
            pct
        };
    }

    return {
        totalBytes,
        usedBytes,
        pct: totalBytes ? (usedBytes * 100) / totalBytes : 0,
        byStylesheet
    };
}

/**
 * Reads previously appended V8 JS and CSS coverage NDJSON files from
 * `coverage/playwright`, computes high-level statistics, and writes a compact
 * JSON summary for inspection or CI reporting.
 */
function writeV8CoverageSummary(): void {
    const repoRoot = process.cwd();
    const covDir = path.join(repoRoot, 'coverage', 'playwright');

    const jsEntries = loadNdjson<V8JSCoverageEntry>(
        path.join(covDir, 'v8-js-coverage.ndjson')
    );
    const cssEntries = loadNdjson<V8CSSCoverageEntry>(
        path.join(covDir, 'v8-css-coverage.ndjson')
    );

    // If no coverage was collected at all, do not emit a summary.
    if (!jsEntries.length && !cssEntries.length) {
        return;
    }

    const js = computeJsStats(jsEntries);
    const css = computeCssStats(cssEntries);

    const combinedTotal = js.totalBytes + css.totalBytes;
    const combinedUsed = js.usedBytes + css.usedBytes;

    const summary: Summary = {
        js,
        css,
        combined: {
            totalBytes: combinedTotal,
            usedBytes: combinedUsed,
            pct: combinedTotal ? (combinedUsed * 100) / combinedTotal : 0
        }
    };

    fs.mkdirSync(covDir, { recursive: true });
    // Persist a compact summary that can be inspected by humans or CI.
    fs.writeFileSync(
        path.join(covDir, 'v8-coverage-summary.json'),
        JSON.stringify(summary, null, 2),
        { encoding: 'utf8' }
    );
}

async function globalTeardown(config: FullConfig): Promise<void> {
    try {
        // Coverage summary generation is best-effort; ignore failures so tests
        // do not fail purely due to coverage post-processing.
        writeV8CoverageSummary();
    } catch {
        // ignore coverage summary failures
    }

    const configDir = process.cwd();
    const statePath = path.join(
        configDir,
        'playwright',
        '.cache',
        'global-state.json'
    );

    // If there is no state file, there is no `mapget` process to terminate.
    if (!fs.existsSync(statePath)) {
        return;
    }

    let state: GlobalState | null = null;
    try {
        const content = fs.readFileSync(statePath, 'utf-8');
        state = JSON.parse(content) as GlobalState;
    } catch {
        state = null;
    }

    if (state && state.mapgetPid) {
        try {
            // Best-effort termination of the `mapget` process started in setup.
            process.kill(state.mapgetPid);
        } catch {
            // ignore if already exited
        }
    }
}

export default globalTeardown;
