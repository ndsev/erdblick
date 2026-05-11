import type { FullConfig } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import v8ToIstanbul = require('v8-to-istanbul');
import { createCoverageMap, type CoverageMap } from 'istanbul-lib-coverage';
import { createContext } from 'istanbul-lib-report';
import reports = require('istanbul-reports');

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
    sourceMappedJs?: {
        generated: boolean;
        reportPath?: string;
        fileCount: number;
    };
}

function isInsideDir(candidatePath: string, dirPath: string): boolean {
    const relative = path.relative(dirPath, candidatePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveCoverageAssetPath(repoRoot: string, url?: string): string | null {
    if (!url) {
        return null;
    }

    let pathname: string;
    try {
        pathname = decodeURIComponent(new URL(url).pathname);
    } catch {
        return null;
    }

    const candidates = [
        path.join(repoRoot, pathname.replace(/^\/+/, '')),
        path.join(repoRoot, 'static', 'browser', path.basename(pathname))
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

function normalizeSourceMappedFilePath(repoRoot: string, sourcePath: string): string | null {
    const normalizedSourcePath = path.normalize(sourcePath);
    const appDir = path.join(repoRoot, 'app');
    const bundledAppDir = path.join(repoRoot, 'static', 'browser', 'app');

    if (isInsideDir(normalizedSourcePath, bundledAppDir)) {
        return path.join(appDir, path.relative(bundledAppDir, normalizedSourcePath));
    }

    if (isInsideDir(normalizedSourcePath, appDir)) {
        return normalizedSourcePath;
    }

    return null;
}

async function buildSourceMappedJsCoverage(
    repoRoot: string,
    entries: V8JSCoverageEntry[]
): Promise<CoverageMap | null> {
    const coverageMap = createCoverageMap({});

    for (const entry of entries) {
        const scriptPath = resolveCoverageAssetPath(repoRoot, entry.url);
        if (!scriptPath) {
            continue;
        }

        const sourceMapPath = `${scriptPath}.map`;
        if (!fs.existsSync(sourceMapPath)) {
            continue;
        }

        const compiledSource = entry.source || entry.text || fs.readFileSync(scriptPath, 'utf8');
        const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, 'utf8'));
        const converter = v8ToIstanbul(scriptPath, 0, {
            source: compiledSource,
            sourceMap: { sourcemap: sourceMap }
        });

        await converter.load();
        converter.applyCoverage(entry.functions || []);
        const convertedCoverage = converter.toIstanbul();
        for (const [convertedPath, fileCoverage] of Object.entries(convertedCoverage)) {
            const normalizedPath = normalizeSourceMappedFilePath(repoRoot, convertedPath);
            if (!normalizedPath) {
                continue;
            }
            coverageMap.merge({
                [normalizedPath]: {
                    ...fileCoverage,
                    path: normalizedPath
                }
            });
        }
    }

    return coverageMap.files().length ? coverageMap : null;
}

function writeSourceMappedJsHtmlReport(covDir: string, coverageMap: CoverageMap): string {
    const reportDir = path.join(covDir, 'source');
    fs.rmSync(reportDir, { recursive: true, force: true });
    fs.mkdirSync(reportDir, { recursive: true });

    const context = createContext({
        dir: reportDir,
        coverageMap,
        defaultSummarizer: 'nested'
    });

    reports.create('html').execute(context);
    reports.create('lcovonly').execute(context);
    reports.create('json-summary').execute(context);

    return path.relative(covDir, path.join(reportDir, 'index.html'));
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function renderCoverageRow(label: string, stats: CoverageStats): string {
    const unusedBytes = Math.max(0, stats.totalBytes - stats.usedBytes);
    const coveragePct = Number.isFinite(stats.pct) ? stats.pct : 0;
    return `
        <tr>
            <td class="label-cell"><code>${escapeHtml(label)}</code></td>
            <td class="coverage-cell">
                <div class="coverage-bar">
                    <div class="coverage-bar-fill" style="width:${coveragePct.toFixed(2)}%"></div>
                </div>
                <span>${coveragePct.toFixed(1)}%</span>
            </td>
            <td>${formatBytes(stats.usedBytes)}</td>
            <td>${formatBytes(stats.totalBytes)}</td>
            <td>${formatBytes(unusedBytes)}</td>
        </tr>
    `;
}

function renderCoverageTable(
    title: string,
    entries: Record<string, CoverageStats>
): string {
    const rows = Object.entries(entries)
        .sort(([, a], [, b]) => {
            const uncoveredDiff = (b.totalBytes - b.usedBytes) - (a.totalBytes - a.usedBytes);
            if (uncoveredDiff !== 0) {
                return uncoveredDiff;
            }
            return b.totalBytes - a.totalBytes;
        })
        .map(([label, stats]) => renderCoverageRow(label, stats))
        .join('\n');

    return `
        <section class="report-section">
            <h2>${escapeHtml(title)}</h2>
            <table>
                <thead>
                    <tr>
                        <th>Script / Stylesheet</th>
                        <th>Coverage</th>
                        <th>Used</th>
                        <th>Total</th>
                        <th>Unused</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows || '<tr><td colspan="5">No coverage entries recorded.</td></tr>'}
                </tbody>
            </table>
        </section>
    `;
}

function writeV8CoverageHtmlReport(summary: Summary, covDir: string): void {
    const sourceReportHtml = summary.sourceMappedJs?.generated
        ? `<li>Source-mapped JavaScript coverage is available at <a href="${escapeHtml(summary.sourceMappedJs.reportPath || 'source/index.html')}"><code>${escapeHtml(summary.sourceMappedJs.reportPath || 'source/index.html')}</code></a> for ${summary.sourceMappedJs.fileCount} frontend source file(s).</li>`
        : '<li>Source-mapped JavaScript coverage was not generated. Build the UI with the <code>playwright-coverage</code> configuration so sibling <code>.map</code> files are available.</li>';
    const html = `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Playwright V8 Coverage</title>
    <style>
        :root {
            color-scheme: dark;
            --bg: #0f1115;
            --panel: #171a21;
            --panel-border: #2b3140;
            --text: #e6ebf5;
            --muted: #99a3b8;
            --accent: #5ea1ff;
            --accent-soft: rgba(94, 161, 255, 0.2);
            --good: #58cf08;
            --warn: #f0be4e;
            --bad: #dd4d31;
        }

        body {
            margin: 0;
            padding: 2rem;
            background: var(--bg);
            color: var(--text);
            font: 14px/1.5 Inter, system-ui, sans-serif;
        }

        h1, h2 {
            margin: 0 0 1rem 0;
        }

        p, li {
            color: var(--muted);
        }

        a {
            color: var(--accent);
        }

        code {
            font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
            font-size: 0.92em;
        }

        .summary-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 1rem;
            margin: 1.5rem 0 2rem;
        }

        .summary-card,
        .report-section,
        .note {
            background: var(--panel);
            border: 1px solid var(--panel-border);
            border-radius: 12px;
            padding: 1rem 1.25rem;
        }

        .summary-card h2 {
            font-size: 1rem;
            margin-bottom: 0.5rem;
        }

        .summary-pct {
            font-size: 2rem;
            font-weight: 700;
        }

        .summary-meta {
            margin-top: 0.5rem;
        }

        .report-section + .report-section {
            margin-top: 1rem;
        }

        table {
            width: 100%;
            border-collapse: collapse;
        }

        th, td {
            padding: 0.65rem 0.5rem;
            border-top: 1px solid var(--panel-border);
            text-align: left;
            vertical-align: middle;
        }

        thead th {
            border-top: none;
            color: var(--muted);
            font-weight: 600;
        }

        .label-cell {
            max-width: 48rem;
            word-break: break-word;
        }

        .coverage-cell {
            min-width: 180px;
        }

        .coverage-bar {
            width: 100%;
            height: 8px;
            margin-bottom: 0.35rem;
            border-radius: 999px;
            overflow: hidden;
            background: #262c38;
        }

        .coverage-bar-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--bad), var(--warn), var(--good));
        }

        .note {
            margin-bottom: 1rem;
        }
    </style>
</head>
<body>
    <h1>Playwright V8 Coverage</h1>
    <div class="note">
        <p>This report is generated from Chromium V8 JavaScript and CSS coverage collected during the Playwright integration run.</p>
        <ul>
            <li>The percentages are byte-based approximations.</li>
            <li>The top-level JavaScript table is reported against emitted browser scripts.</li>
            ${sourceReportHtml}
            <li>The raw NDJSON files remain available under <code>coverage/playwright</code> for post-processing.</li>
        </ul>
    </div>
    <div class="summary-grid">
        <section class="summary-card">
            <h2>Combined</h2>
            <div class="summary-pct">${summary.combined.pct.toFixed(1)}%</div>
            <div class="summary-meta">${formatBytes(summary.combined.usedBytes)} used / ${formatBytes(summary.combined.totalBytes)} total</div>
        </section>
        <section class="summary-card">
            <h2>JavaScript</h2>
            <div class="summary-pct">${summary.js.pct.toFixed(1)}%</div>
            <div class="summary-meta">${formatBytes(summary.js.usedBytes)} used / ${formatBytes(summary.js.totalBytes)} total</div>
        </section>
        <section class="summary-card">
            <h2>CSS</h2>
            <div class="summary-pct">${summary.css.pct.toFixed(1)}%</div>
            <div class="summary-meta">${formatBytes(summary.css.usedBytes)} used / ${formatBytes(summary.css.totalBytes)} total</div>
        </section>
    </div>
    ${renderCoverageTable('JavaScript by Script', summary.js.byScript)}
    ${renderCoverageTable('CSS by Stylesheet', summary.css.byStylesheet)}
</body>
</html>`;

    fs.writeFileSync(path.join(covDir, 'index.html'), html, { encoding: 'utf8' });
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
 * `coverage/playwright`, computes high-level statistics, and writes both a
 * compact JSON summary and a browsable HTML report. When hidden source maps are
 * present next to the browser bundle, it also emits an Istanbul HTML report
 * mapped back to frontend source files.
 */
async function writeV8CoverageSummary(): Promise<void> {
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

    const sourceMappedCoverage = await buildSourceMappedJsCoverage(repoRoot, jsEntries);
    if (sourceMappedCoverage) {
        summary.sourceMappedJs = {
            generated: true,
            reportPath: writeSourceMappedJsHtmlReport(covDir, sourceMappedCoverage),
            fileCount: sourceMappedCoverage.files().length
        };
    } else {
        summary.sourceMappedJs = {
            generated: false,
            fileCount: 0
        };
    }

    fs.mkdirSync(covDir, { recursive: true });
    // Persist a compact summary that can be inspected by humans or CI.
    fs.writeFileSync(
        path.join(covDir, 'v8-coverage-summary.json'),
        JSON.stringify(summary, null, 2),
        { encoding: 'utf8' }
    );
    writeV8CoverageHtmlReport(summary, covDir);
}

async function globalTeardown(config: FullConfig): Promise<void> {
    try {
        // Coverage summary generation is best-effort; ignore failures so tests
        // do not fail purely due to coverage post-processing.
        await writeV8CoverageSummary();
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

    let state: GlobalState | null;
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
