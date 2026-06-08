import type {FeatureSearchMapLayerRef} from "../shared/feature-search-state";

/** Counts of scalar and placeholder value kinds observed in a search value stream. */
export interface SearchValueKindCounts {
    integer: number;
    number: number;
    boolean: number;
    string: number;
    object: number;
    list: number;
    blob: number;
    unknown: number;
}

/** Numeric aggregate for one search value stream. */
export interface SearchValueNumericSummary {
    count: number;
    min: number;
    max: number;
    sum: number;
    average: number;
}

/** One string histogram bucket for a search value stream. */
export interface SearchValueHistogramBucket {
    value: string;
    count: number;
}

/** Aggregated value summary for one withFields expression or one trace expression. */
export interface SearchValueSummary {
    count: number;
    missing: number;
    nulls: number;
    kinds: SearchValueKindCounts;
    numeric?: SearchValueNumericSummary;
    histogram: SearchValueHistogramBucket[];
    otherCount: number;
    distinctLimitReached: boolean;
}

/** Value summary for one withFields expression. */
export interface SearchResultFieldValueSummary {
    source: "resultField";
    index: number;
    expression: string;
    summary: SearchValueSummary;
}

/** Value summary for one SIMFIL trace expression. */
export interface SearchTraceValueSummary {
    source: "trace";
    name: string;
    calls: number;
    totalus: number;
    summary: SearchValueSummary;
}

/** Lazy diagnostics state for value summaries computed from streamed search-result tiles. */
export interface SearchValueSummariesState {
    status: "idle" | "loading" | "ready" | "empty" | "error";
    revision: number;
    processedTiles: number;
    totalTiles: number;
    resultFields: SearchResultFieldValueSummary[];
    traces: SearchTraceValueSummary[];
    error?: string;
}

/**
 * Human-facing query diagnostic emitted by simfil validation or execution.
 */
export interface DiagnosticsMessage {
    query: string;
    message: string;
    location?: {offset: number, size: number},
    fix: null | string;
}

/**
 * One autocompletion suggestion produced for the current query and cursor position.
 */
export interface CompletionCandidate {
    text: string;
    kind: string;
    begin: number;
    end: number;
    query: string;
    source: string;
    hint: string;
    originLayers?: FeatureSearchMapLayerRef[];
}
