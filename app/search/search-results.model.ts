import type {
    DiagnosticsMessage,
    FeatureSearchResultEntry,
    SearchResultFieldValueSummary,
    SearchTraceValueSummary,
    SearchValueHistogramBucket,
    SearchValueKindCounts,
    SearchValueNumericSummary,
    SearchValueSummariesState,
    SearchValueSummary
} from "./search.model";

/**
 * Flat result point exposed to map overlays and result-tree hover interactions.
 */
export interface SearchResultPoint {
    coordinates: [number, number];
    mapId: string;
    layerId: string;
    tileId: number;
    mapTileKey: string;
    sourceTileKey: string;
    sourceMapId: string;
    sourceLayerId: string;
    sourceTileId: number;
    featureId: string;
    resultIndex: number;
    resultKey: string;
    featureKey: string;
    hoverFeatureId: string;
}

/** Result points grouped by their streamed source tile for viewport/density materialization. */
export interface SearchResultPointBucket {
    sourceTileKey: string;
    mapId: string;
    layerId: string;
    tileId: number;
    requestOrder: number;
    points: SearchResultPoint[];
}

/** Circle marker rendered by the search-result density overlay. */
export interface SearchResultDensityMarker {
    coordinates: [number, number];
    pixelOffset?: [number, number];
    count: number;
    mapId: string;
    layerId: string;
    tileId: number;
    featureId: string;
    resultKey: string;
    featureKey: string;
    featureKeys: string[];
    resultKeys: string[];
    showBucketLabel?: boolean;
}

/** Parameters for materializing visible source-tile contributions into density markers. */
export interface SearchResultDensityMaterializationRequest {
    sourceTileKeys: Iterable<string>;
    targetLevel: number;
}

/** Native-backed density implementations expose this narrow contribution/projection contract. */
export interface SearchResultDensity {
    readonly isEmpty: boolean;
    addContribution(sourceTileKey: string, points: readonly SearchResultPoint[]): void;
    removeContribution(sourceTileKey: string): boolean;
    clear(): void;
    materialize(request: SearchResultDensityMaterializationRequest): SearchResultDensityMarker[];
}

export interface SearchRequestProgress {
    tilesQueued: number;
    tilesSearched: number;
    chunksEmitted: number;
    chunksReported: boolean;
    matches: number;
    terminal: boolean;
}

export interface SearchResultTileContribution {
    refresh: number;
    sourceTileKey: string;
    sourceMapId: string;
    sourceLayerId: string;
    sourceTileId: number;
    requestOrder: number;
    resultCount: number;
    resultChannelOrdinal: number;
    resultFields: string[];
    results: FeatureSearchResultEntry[];
    diagnostics: Uint8Array | null;
    layerBlob: Uint8Array;
    valueSummary: SearchTileValueSummaries | null;
    points: SearchResultPoint[];
}

export interface SearchTileValueSummaries {
    resultFields: SearchResultFieldValueSummary[];
    traces: SearchTraceValueSummary[];
}
/** One run's retained contributions and derived results; independent of Angular and rendering. */
export class SearchResults {
    static readonly VALUE_SUMMARY_HISTOGRAM_LIMIT = 64;
    static readonly VALUE_SUMMARY_DISTINCT_LIMIT = 2048;
    private runId = "";
    private retired = false;
    rebuildPending = false;
    progressDone = 0;
    progressTotal = 1;
    backendComplete = false;
    resultTileIngressDone = 0;
    resultTileIngressTotal = 0;
    complete = false;
    totalFeatureCount = 0;
    searchResults: FeatureSearchResultEntry[] = [];
    diagnostics: DiagnosticsMessage[] = [];
    diagnosticsBlobs: Uint8Array[] = [];
    valueSummaries = this.emptyValueSummariesState("idle", 0);
    valueSummaryRevision = 0;
    errors = new Set<string>();
    progressByRequestKey = new Map<string, SearchRequestProgress>();
    searchResultTilesBySourceKey = new Map<string, SearchResultTileContribution>();
    searchResultPointsByFeatureKey = new Map<string, SearchResultPoint>();
    searchResultPointsCache: SearchResultPoint[] = [];
    searchResultPointBucketsCache: SearchResultPointBucket[] = [];
    searchResultPointBucketIndexBySourceKey = new Map<string, number>();
    searchResultPointsCacheDirty = false;
    searchResultPointsVersion = 0;
    readonly searchResultDensityIndex: SearchResultDensity;

    /** The native density adapter belongs to this result owner, without coupling the model to WASM. */
    constructor(density: SearchResultDensity) { this.searchResultDensityIndex = density; }

    /** Retires an old generation and resets progress before accepting the next run. */
    beginRun(runId: string, paused = false): void {
        this.runId = runId;
        this.resetProgress(paused);
    }

    /** Resets run progress independently of retained contributions during a server refresh. */
    resetProgress(paused: boolean): void {
        this.progressDone = paused ? 1 : 0;
        this.progressTotal = 1;
        this.progressByRequestKey.clear();
        this.backendComplete = paused;
        this.resultTileIngressDone = 0;
        this.resultTileIngressTotal = 0;
        this.complete = paused;
        this.diagnostics = [];
    }

    /** Closing a search rejects late contributions and releases all retained result data. */
    destroy(): void {
        this.retired = true;
        this.clear();
        this.progressByRequestKey.clear();
    }

    /** Clears derived data while preserving the controller's progress/reset policy. */
    clear(): void {
        this.searchResultTilesBySourceKey.clear();
        this.clearSessionSearchResultPoints();
        this.searchResults = [];
        this.diagnostics = [];
        this.diagnosticsBlobs = [];
        this.markValueSummariesDirty();
        this.errors.clear();
        this.totalFeatureCount = 0;
        this.resultTileIngressDone = 0;
        this.resultTileIngressTotal = 0;
        this.rebuildPending = false;
    }

    /** Adds a header, replaces a tile, or appends a bounded entry batch for the current run only. */
    add(runId: string, contribution: SearchResultTileContribution, append: boolean, entriesComplete: boolean): "ignored" | "appended" | "replaced" {
        if (this.retired || this.runId !== runId) return "ignored";
        const key = contribution.sourceTileKey;
        const previous = this.searchResultTilesBySourceKey.get(key);
        if (previous && append) {
            this.appendSessionResultEntryBatch(previous, contribution, entriesComplete);
            return "appended";
        }
        this.searchResultTilesBySourceKey.set(key, contribution);
        this.markValueSummariesDirty();
        if (previous) {
            this.searchResultDensityIndex.removeContribution(key);
            this.searchResultDensityIndex.addContribution(key, contribution.points);
            this.rebuildPending = true;
            return "replaced";
        }
        this.appendSessionResultContribution(contribution);
        return "appended";
    }

    /** Evicts one source contribution without disturbing other tiles or density buckets. */
    remove(runId: string, sourceTileKey: string): boolean {
        if (this.retired || this.runId !== runId || !this.searchResultTilesBySourceKey.delete(sourceTileKey)) return false;
        this.searchResultDensityIndex.removeContribution(sourceTileKey);
        this.markValueSummariesDirty();
        this.updateSearchResultIngressProgress();
        this.rebuildPending = true;
        return true;
    }

    /** Normalizes untrusted progress counts without changing their caller-supplied fallback. */
    static nonNegativeNumber(value: unknown, fallback: number): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
    }

    /** Sorts streamed result-tile data by the same first-seen tile order used for backend search requests. */
    compareSearchResultTileContributions(
        lhs: SearchResultTileContribution,
        rhs: SearchResultTileContribution
    ): number {
        if (lhs.requestOrder !== rhs.requestOrder) {
            return lhs.requestOrder - rhs.requestOrder;
        }
        return lhs.sourceTileKey.localeCompare(rhs.sourceTileKey);
    }

    /** Applies full-coverage progress snapshots from MapTileStreamService without losing streamed result state. */
    applyProgressSnapshot(
        tilesConsidered: unknown,
        tilesCompleted: unknown
    ): void {
        const total = SearchResults.nonNegativeNumber(tilesConsidered, 0);
        if (total > 0) {
            this.progressTotal = Math.max(1, total);
        }
        const completed = SearchResults.nonNegativeNumber(tilesCompleted, 0);
        if (completed > 0 || total > 0) {
            this.progressDone = Math.min(this.progressTotal, Math.max(this.progressDone, completed));
        }
        this.updateSearchResultIngressProgress();
    }

    /** Returns true once all expected search-result tile layers have entered the UI service. */
    canSummarizeSessionValues(): boolean {
        return this.complete
            && this.resultTileIngressDone >= this.resultTileIngressTotal;
    }

    /** Updates result-tile ingress counters from current coverage and accepted contributions. */
    updateSearchResultIngressProgress(): void {
        const progressEntries = Array.from(this.progressByRequestKey.values());
        const reportedChunkTotal = progressEntries
            .filter(item => item.chunksReported)
            .reduce((sum, item) => sum + item.chunksEmitted, 0);
        this.resultTileIngressTotal = Math.max(reportedChunkTotal, this.searchResultTilesBySourceKey.size);
        this.resultTileIngressDone = Math.min(
            this.resultTileIngressTotal,
            this.searchResultTilesBySourceKey.size
        );
    }

    /** Recomputes the externally visible completion state after backend status or result ingress changes. */
    updateSessionCompletion(paused: boolean): boolean {
        const wasComplete = this.complete;
        if (paused) {
            this.complete = true;
            return !wasComplete;
        }
        // Full-area coverage is the canonical completion signal. Individual
        // request status entries can be invalidated by auto-update races and
        // should not keep a session open once every considered tile is done.
        if (this.progressTotal > 0 && this.progressDone >= this.progressTotal) {
            this.backendComplete = true;
        }
        const ingressComplete = this.resultTileIngressTotal === 0
            || this.resultTileIngressDone >= this.resultTileIngressTotal;
        this.complete = this.backendComplete && ingressComplete;
        return this.complete && !wasComplete;
    }

    /** Rebuilds derived result arrays from per-tile contributions after add, replace, or eviction. */
    rebuildSessionResultData(): void {
        this.rebuildPending = false;
        const nextResults: FeatureSearchResultEntry[] = [];
        const nextDiagnosticsBlobs: Uint8Array[] = [];
        const nextPoints = new Map<string, SearchResultPoint>();
        const nextBuckets: SearchResultPointBucket[] = [];
        let totalFeatureCount = 0;

        const contributions = Array.from(this.searchResultTilesBySourceKey.values())
            .sort((lhs, rhs) => this.compareSearchResultTileContributions(lhs, rhs));
        for (const contribution of contributions) {
            totalFeatureCount += contribution.resultCount;
            this.appendArray(nextResults, contribution.results);
            if (contribution.diagnostics) {
                nextDiagnosticsBlobs.push(contribution.diagnostics);
            }
            for (const point of contribution.points) {
                if (!nextPoints.has(point.resultKey)) {
                    nextPoints.set(point.resultKey, point);
                }
            }
            const bucket = this.searchResultPointBucketFromContribution(contribution);
            if (bucket) {
                nextBuckets.push(bucket);
            }
        }

        this.searchResults = nextResults;
        this.diagnosticsBlobs = nextDiagnosticsBlobs;
        this.totalFeatureCount = totalFeatureCount;
        this.searchResultPointsByFeatureKey = nextPoints;
        this.searchResultPointBucketsCache = nextBuckets;
        this.searchResultPointBucketIndexBySourceKey = this.searchResultPointBucketIndex(nextBuckets);
        this.searchResultPointsCacheDirty = true;
        this.searchResultPointsVersion += 1;
    }

    /** Appends a new source tile contribution without touching previously aggregated result arrays. */
    private appendSessionResultEntryBatch(
        contribution: SearchResultTileContribution,
        batch: SearchResultTileContribution,
        entriesComplete: boolean
    ): void {
        contribution.refresh = batch.refresh;
        contribution.resultFields = batch.resultFields;
        contribution.resultChannelOrdinal = batch.resultChannelOrdinal;
        contribution.layerBlob = batch.layerBlob;
        contribution.valueSummary = null;
        this.appendArray(contribution.results, batch.results);
        this.appendArray(contribution.points, batch.points);
        this.appendArray(this.searchResults, batch.results);

        let pointsChanged = false;
        for (const point of batch.points) {
            if (!this.searchResultPointsByFeatureKey.has(point.resultKey)) {
                this.searchResultPointsByFeatureKey.set(point.resultKey, point);
                pointsChanged = true;
            }
        }

        if (entriesComplete && contribution.points.length > 0) {
            this.searchResultDensityIndex.addContribution(contribution.sourceTileKey, contribution.points);
            this.upsertSearchResultPointBucket(contribution);
            pointsChanged = true;
        }
        if (pointsChanged || batch.results.length > 0) {
            this.searchResultPointsCacheDirty = this.searchResultPointsCacheDirty || pointsChanged;
            this.searchResultPointsVersion += pointsChanged ? 1 : 0;
        }
    }

    /** Appends or replaces the source-tile bucket exposed to search-result overlay code. */
    private upsertSearchResultPointBucket(
        contribution: SearchResultTileContribution
    ): void {
        const bucket = this.searchResultPointBucketFromContribution(contribution);
        if (!bucket) {
            return;
        }
        const existingIndex = this.searchResultPointBucketIndexBySourceKey.get(contribution.sourceTileKey);
        if (existingIndex !== undefined) {
            this.searchResultPointBucketsCache[existingIndex] = bucket;
            return;
        }
        this.searchResultPointBucketIndexBySourceKey.set(
            contribution.sourceTileKey,
            this.searchResultPointBucketsCache.length);
        this.searchResultPointBucketsCache.push(bucket);
    }

    /** Builds the source-key index used to avoid O(n²) bucket replacement during broad streamed searches. */
    private searchResultPointBucketIndex(buckets: SearchResultPointBucket[]): Map<string, number> {
        const index = new Map<string, number>();
        buckets.forEach((bucket, position) => index.set(bucket.sourceTileKey, position));
        return index;
    }

    /** Appends a new source tile contribution without touching previously aggregated result arrays. */
    private appendSessionResultContribution(
        contribution: SearchResultTileContribution
    ): void {
        this.appendArray(this.searchResults, contribution.results);
        if (contribution.diagnostics) {
            this.diagnosticsBlobs.push(contribution.diagnostics);
        }
        this.totalFeatureCount += contribution.resultCount;
        const densityChanged = contribution.points.length > 0;
        if (densityChanged) {
            this.searchResultDensityIndex.addContribution(contribution.sourceTileKey, contribution.points);
            const bucket = this.searchResultPointBucketFromContribution(contribution);
            if (bucket) {
                this.searchResultPointBucketIndexBySourceKey.set(
                    contribution.sourceTileKey,
                    this.searchResultPointBucketsCache.length);
                this.searchResultPointBucketsCache.push(bucket);
            }
        }

        let pointsChanged = false;
        for (const point of contribution.points) {
            if (!this.searchResultPointsByFeatureKey.has(point.resultKey)) {
                this.searchResultPointsByFeatureKey.set(point.resultKey, point);
                pointsChanged = true;
            }
        }
        if (pointsChanged || densityChanged) {
            this.searchResultPointsCacheDirty = this.searchResultPointsCacheDirty || pointsChanged;
            this.searchResultPointsVersion += 1;
            }
    }

    /** Appends large result batches without using spread syntax, which can exceed V8's argument limit. */
    private appendArray<T>(target: T[], items: readonly T[]): void {
        for (const item of items) {
            target.push(item);
        }
    }

    /** Converts one streamed source-tile contribution into the overlay bucket cache entry. */
    private searchResultPointBucketFromContribution(
        contribution: SearchResultTileContribution
    ): SearchResultPointBucket | null {
        if (!contribution.points.length) {
            return null;
        }
        return {
            sourceTileKey: contribution.sourceTileKey,
            mapId: contribution.sourceMapId,
            layerId: contribution.sourceLayerId,
            tileId: contribution.sourceTileId,
            requestOrder: contribution.requestOrder,
            points: contribution.points
        };
    }

    /** Returns one session's cached marker list, rebuilding it only after mutations. */
    getSessionSearchResultPoints(): SearchResultPoint[] {
        if (this.searchResultPointsCacheDirty) {
            this.searchResultPointsCache = Array.from(this.searchResultPointsByFeatureKey.values());
            this.searchResultPointsCacheDirty = false;
        }
        return this.searchResultPointsCache;
    }

    /** Returns one session's cached marker list grouped by source map/layer/tile. */
    getSessionSearchResultPointBuckets(): SearchResultPointBucket[] {
        return this.searchResultPointBucketsCache;
    }

    /** Clears one session's marker caches and returns whether anything changed. */
    private clearSessionSearchResultPoints(): boolean {
        if (!this.searchResultPointsByFeatureKey.size
            && !this.searchResultPointsCache.length
            && !this.searchResultPointBucketsCache.length
            && !this.searchResultPointBucketIndexBySourceKey.size
            && !this.searchResultPointsCacheDirty) {
            return false;
        }
        this.searchResultPointsByFeatureKey.clear();
        this.searchResultPointsCache = [];
        this.searchResultPointBucketsCache = [];
        this.searchResultPointBucketIndexBySourceKey.clear();
        this.searchResultPointsCacheDirty = false;
        this.searchResultPointsVersion += 1;
        this.searchResultDensityIndex.clear();
        return true;
    }

    /** Retires all generations of one filter without removing other layers' progress. */
    clearFilterSearchProgress(filterId: string): void {
        for (const key of this.progressByRequestKey.keys()) {
            if (key.startsWith(`${filterId}\n`)) {
                this.progressByRequestKey.delete(key);
            }
        }
        this.updateSearchResultIngressProgress();
    }

    /** Creates a blank summary state with stable empty arrays for Angular templates. */
    emptyValueSummariesState(
        status: SearchValueSummariesState["status"],
        revision: number,
        totalTiles = 0
    ): SearchValueSummariesState {
        return {
            status,
            revision,
            processedTiles: 0,
            totalTiles,
            resultFields: [],
            traces: []
        };
    }

    /** Invalidates cached value diagnostics after streamed tile contributions change. */
    markValueSummariesDirty(): void {
        this.valueSummaryRevision += 1;
        this.valueSummaries = this.emptyValueSummariesState("idle", this.valueSummaryRevision);
    }

    /** Normalizes one native `TileSubsetLayer.valueSummaries()` return value. */
    normalizeTileValueSummaries(value: unknown): SearchTileValueSummaries {
        const record = this.recordFromUnknown(value);
        const rawResultFields = Array.isArray(record?.["resultFields"]) ? record["resultFields"] : [];
        const rawTraces = Array.isArray(record?.["traces"]) ? record["traces"] : [];
        return {
            resultFields: rawResultFields
                .map(item => this.normalizeResultFieldValueSummary(item))
                .filter((item): item is SearchResultFieldValueSummary => item !== null),
            traces: rawTraces
                .map(item => this.normalizeTraceValueSummary(item))
                .filter((item): item is SearchTraceValueSummary => item !== null)
        };
    }

    /** Normalizes a native withFields summary object. */
    private normalizeResultFieldValueSummary(value: unknown): SearchResultFieldValueSummary | null {
        const record = this.recordFromUnknown(value);
        if (!record) {
            return null;
        }
        const index = SearchResults.nonNegativeNumber(record["index"], 0);
        return {
            source: "resultField",
            index,
            expression: String(record["expression"] ?? `values[${index}]`),
            summary: this.normalizeValueSummary(record["summary"])
        };
    }

    /** Normalizes a native trace summary object. */
    private normalizeTraceValueSummary(value: unknown): SearchTraceValueSummary | null {
        const record = this.recordFromUnknown(value);
        if (!record) {
            return null;
        }
        return {
            source: "trace",
            name: String(record["name"] ?? ""),
            calls: SearchResults.nonNegativeNumber(record["calls"], 0),
            totalus: SearchResults.nonNegativeNumber(record["totalus"], 0),
            summary: this.normalizeValueSummary(record["summary"])
        };
    }

    /** Normalizes one native value-summary object. */
    private normalizeValueSummary(value: unknown): SearchValueSummary {
        const record = this.recordFromUnknown(value);
        const kindsRecord = this.recordFromUnknown(record?.["kinds"]);
        const histogramValue = Array.isArray(record?.["histogram"]) ? record["histogram"] : [];
        const summary: SearchValueSummary = {
            count: SearchResults.nonNegativeNumber(record?.["count"], 0),
            missing: SearchResults.nonNegativeNumber(record?.["missing"], 0),
            nulls: SearchResults.nonNegativeNumber(record?.["nulls"], 0),
            kinds: this.normalizeKindCounts(kindsRecord),
            histogram: histogramValue
                .map(item => this.normalizeHistogramBucket(item))
                .filter((item): item is SearchValueHistogramBucket => item !== null),
            otherCount: SearchResults.nonNegativeNumber(record?.["otherCount"], 0),
            distinctLimitReached: Boolean(record?.["distinctLimitReached"])
        };
        const numeric = this.normalizeNumericSummary(record?.["numeric"]);
        if (numeric) {
            summary.numeric = numeric;
        }
        return summary;
    }

    /** Normalizes per-kind counters from native diagnostics. */
    private normalizeKindCounts(record: Record<string, unknown> | null): SearchValueKindCounts {
        return {
            integer: SearchResults.nonNegativeNumber(record?.["integer"], 0),
            number: SearchResults.nonNegativeNumber(record?.["number"], 0),
            boolean: SearchResults.nonNegativeNumber(record?.["boolean"], 0),
            string: SearchResults.nonNegativeNumber(record?.["string"], 0),
            object: SearchResults.nonNegativeNumber(record?.["object"], 0),
            list: SearchResults.nonNegativeNumber(record?.["list"], 0),
            blob: SearchResults.nonNegativeNumber(record?.["blob"], 0),
            unknown: SearchResults.nonNegativeNumber(record?.["unknown"], 0)
        };
    }

    /** Normalizes one numeric summary object. */
    private normalizeNumericSummary(value: unknown): SearchValueNumericSummary | undefined {
        const record = this.recordFromUnknown(value);
        const count = SearchResults.nonNegativeNumber(record?.["count"], 0);
        if (!record || count === 0) {
            return undefined;
        }
        const sum = Number(record["sum"] ?? 0);
        return {
            count,
            min: Number(record["min"] ?? 0),
            max: Number(record["max"] ?? 0),
            sum: Number.isFinite(sum) ? sum : 0,
            average: Number(record["average"] ?? 0)
        };
    }

    /** Normalizes one string histogram bucket. */
    private normalizeHistogramBucket(value: unknown): SearchValueHistogramBucket | null {
        const record = this.recordFromUnknown(value);
        if (!record) {
            return null;
        }
        return {
            value: String(record["value"] ?? ""),
            count: SearchResults.nonNegativeNumber(record["count"], 0)
        };
    }

    /** Merges one tile's native summaries into session-wide accumulators. */
    mergeTileValueSummaries(
        resultFieldsByKey: Map<string, SearchResultFieldValueSummary>,
        tracesByName: Map<string, SearchTraceValueSummary>,
        tileSummary: SearchTileValueSummaries
    ): void {
        for (const resultField of tileSummary.resultFields) {
            const key = `${resultField.index}\n${resultField.expression}`;
            let target = resultFieldsByKey.get(key);
            if (!target) {
                target = {
                    source: "resultField",
                    index: resultField.index,
                    expression: resultField.expression,
                    summary: this.emptyValueSummary()
                };
                resultFieldsByKey.set(key, target);
            }
            this.mergeValueSummary(target.summary, resultField.summary);
        }

        for (const trace of tileSummary.traces) {
            let target = tracesByName.get(trace.name);
            if (!target) {
                target = {
                    source: "trace",
                    name: trace.name,
                    calls: 0,
                    totalus: 0,
                    summary: this.emptyValueSummary()
                };
                tracesByName.set(trace.name, target);
            }
            target.calls += trace.calls;
            target.totalus += trace.totalus;
            this.mergeValueSummary(target.summary, trace.summary);
        }
    }

    /** Creates a zeroed mutable summary accumulator. */
    private emptyValueSummary(): SearchValueSummary {
        return {
            count: 0,
            missing: 0,
            nulls: 0,
            kinds: this.normalizeKindCounts(null),
            histogram: [],
            otherCount: 0,
            distinctLimitReached: false
        };
    }

    /** Adds one value summary into another. */
    private mergeValueSummary(target: SearchValueSummary, source: SearchValueSummary): void {
        target.count += source.count;
        target.missing += source.missing;
        target.nulls += source.nulls;
        target.kinds.integer += source.kinds.integer;
        target.kinds.number += source.kinds.number;
        target.kinds.boolean += source.kinds.boolean;
        target.kinds.string += source.kinds.string;
        target.kinds.object += source.kinds.object;
        target.kinds.list += source.kinds.list;
        target.kinds.blob += source.kinds.blob;
        target.kinds.unknown += source.kinds.unknown;
        target.otherCount += source.otherCount;
        target.distinctLimitReached = target.distinctLimitReached || source.distinctLimitReached;

        if (source.numeric) {
            if (!target.numeric) {
                target.numeric = { ...source.numeric };
            } else {
                target.numeric.count += source.numeric.count;
                target.numeric.min = Math.min(target.numeric.min, source.numeric.min);
                target.numeric.max = Math.max(target.numeric.max, source.numeric.max);
                target.numeric.sum += source.numeric.sum;
                target.numeric.average = target.numeric.count > 0
                    ? target.numeric.sum / target.numeric.count
                    : 0;
            }
        }

        const histogramByValue = new Map(target.histogram.map(bucket => [bucket.value, bucket.count]));
        for (const bucket of source.histogram) {
            histogramByValue.set(bucket.value, (histogramByValue.get(bucket.value) ?? 0) + bucket.count);
        }
        target.histogram = Array.from(histogramByValue.entries())
            .map(([value, count]) => ({ value, count }));
    }

    /** Sorts and trims a merged summary for display. */
    finalizeValueSummary(summary: SearchValueSummary): SearchValueSummary {
        const histogram = [...summary.histogram]
            .sort((lhs, rhs) => rhs.count - lhs.count || lhs.value.localeCompare(rhs.value));
        const visibleHistogram = histogram.slice(0, SearchResults.VALUE_SUMMARY_HISTOGRAM_LIMIT);
        const hiddenHistogramCount = histogram
            .slice(SearchResults.VALUE_SUMMARY_HISTOGRAM_LIMIT)
            .reduce((sum, bucket) => sum + bucket.count, 0);
        return {
            ...summary,
            numeric: summary.numeric
                ? {
                    ...summary.numeric,
                    average: summary.numeric.count > 0 ? summary.numeric.sum / summary.numeric.count : 0
                }
                : undefined,
            histogram: visibleHistogram,
            otherCount: summary.otherCount + hiddenHistogramCount
        };
    }

    /** Returns an object record or null for untrusted native values. */
    private recordFromUnknown(value: unknown): Record<string, unknown> | null {
        return value && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown>
            : null;
    }
}

/** Public session consumers receive values, not the result owner's mutation API. */
export type SearchResultsSnapshot = Readonly<Pick<SearchResults,
    "progressDone" | "progressTotal" | "backendComplete" | "resultTileIngressDone" |
    "resultTileIngressTotal" | "complete" | "totalFeatureCount" | "searchResults" |
    "diagnostics" | "diagnosticsBlobs" | "valueSummaries" | "valueSummaryRevision" | "errors"
>>;
