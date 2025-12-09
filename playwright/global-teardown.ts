import type { FullConfig } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

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

function loadNdjson<T>(filePath: string): T[] {
    if (!fs.existsSync(filePath)) {
        return [];
    }

    const content = fs.readFileSync(filePath, 'utf8');
    return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as T);
}

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
        const source = (entry && (entry.source || entry.text)) || '';
        const len = source.length;
        if (!len) {
            continue;
        }

        const covered = new Uint8Array(len);
        const functions = Array.isArray(entry.functions) ? entry.functions : [];

        for (const fn of functions) {
            const ranges = Array.isArray(fn.ranges)
                ? [...fn.ranges]
                : [];

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
        const text = (entry && entry.text) || '';
        const len = text.length;
        if (!len) {
            continue;
        }

        const covered = new Uint8Array(len);
        const ranges = Array.isArray(entry.ranges) ? entry.ranges : [];

        for (const r of ranges) {
            if (!r) {
                continue;
            }
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

function writeV8CoverageSummary(): void {
    const repoRoot = process.cwd();
    const covDir = path.join(repoRoot, 'coverage', 'playwright');

    const jsEntries = loadNdjson<V8JSCoverageEntry>(
        path.join(covDir, 'v8-js-coverage.ndjson')
    );
    const cssEntries = loadNdjson<V8CSSCoverageEntry>(
        path.join(covDir, 'v8-css-coverage.ndjson')
    );

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
    fs.writeFileSync(
        path.join(covDir, 'v8-coverage-summary.json'),
        JSON.stringify(summary, null, 2),
        { encoding: 'utf8' }
    );
}

async function globalTeardown(config: FullConfig): Promise<void> {
    try {
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
            process.kill(state.mapgetPid);
        } catch {
            // ignore if already exited
        }
    }
}

export default globalTeardown;
