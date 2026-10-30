/**
 * Search result, schema-candidate and summary values shared across consumers.
 * These contracts describe delivered data without constructing SearchService,
 * opening a filter subscription or retaining rendered result presentations.
 */
import type {SchemaScalarDomain} from "../mapdata/schema-domain.model";
import type {FeatureSearchMapLayerRef} from "./search-definition.model";

/** Counts of scalar and placeholder value kinds observed in a search value stream. */
export interface SearchValueKindCounts {
    integer: number;
    number: number;
    boolean: number;
    string: number;
    object: number;
    list: number;
    blob: number;
    bitmask: number;
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
    /** Exact source meaning; unqualified calculations remain a separate group. */
    domain?: SchemaScalarDomain;
    count: number;
    missing: number;
    nulls: number;
    /** Named sentinels remain in raw histograms but are excluded from numeric aggregates. */
    specials: number;
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


export interface FeatureSearchResultEntry {
    label: string;
    mapId: string;
    layerId: string;
    featureId: string;
    resultIndex: number;
    resultKey: string;
    mapTileKey: string;
    sourceTileKey: string;
    sourceMapId: string;
    sourceLayerId: string;
    sourceTileId: number;
    hoverFeatureId: string;
    attributeIndex?: number;
    validityIndex?: number;
    validityCount?: number;
}


/** UI-facing result entry projected from one TileSubsetLayer channel. */
export interface SearchResultTileEntry {
    mapTileKey: string;
    featureId: string;
    resultIndex: number;
    position?: {
        cartesian: {x: number; y: number; z: number};
        cartographic: {x: number; y: number; z: number} | null;
        cartographicRad?: {
            longitude: number;
            latitude: number;
            height: number;
        } | null;
    };
    /** One ordered result sequence per expression; [] differs from [null] and [[...]]. */
    values?: unknown[][];
    /** A failed projection has an empty result sequence plus explicit error metadata. */
    valueErrors?: Array<{expressionIndex: number; stage: string; message: string}>;
    attributeIndex?: number;
    validityIndex?: number;
    validityCount?: number;
}

/** Compact list-ingestion payload derived from an immutable search subset. */
export interface SearchResultTilePayload {
    searchId: string;
    refresh: number;
    mapId: string;
    layerId: string;
    tileId: number;
    sourceTileKey: string;
    sourceMapId: string;
    sourceLayerId: string;
    sourceTileId: number;
    requestOrder: number;
    resultCount: number;
    /** Result-only channel in layerBlob, after any rendering channels. */
    resultChannelOrdinal: number;
    resultFields: string[];
    tilesConsidered?: number;
    tilesCompleted?: number;
    layerBlob: Uint8Array;
    diagnostics: Uint8Array | null;
    entries: SearchResultTileEntry[];
    entryOffset?: number;
    entriesComplete?: boolean;
}

/** Schema-backed candidate indicating that a query can run in attribute scope. */
export interface FeatureSearchAttributeScopeCandidate {
    attrName: string;
    attrLayerName: string;
    featureType: string;
    mapId: string;
    layerId: string;
}

export type FeatureSearchStyleValueKind =
    | "number"
    | "integer"
    | "string"
    | "boolean"
    | "enum"
    | "bitmask"
    | "object"
    | "array"
    | "unknown";

/** Schema-backed result-value field candidate for search-result style rules. */
export interface FeatureSearchStyleFieldCandidate {
    path: string;
    mapId: string;
    layerId: string;
    attrName?: string;
    attrLayerName?: string;
    featureType?: string;
    valueKind: FeatureSearchStyleValueKind;
    enumValues: string[];
    numericRange?: {min: number; max: number};
    domain?: SchemaScalarDomain;
}
