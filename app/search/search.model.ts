/**
 * Search result, schema-candidate and summary values shared across consumers.
 * These contracts describe delivered data without constructing SearchService,
 * opening a filter subscription or retaining rendered result presentations.
 */
import {z} from "zod";
import {schemaScalarTypeSchema, type SchemaScalarType} from "../mapdata/schema-type.model";
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
    schemaType?: SchemaScalarType;
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
    /** The input already spells this native symbol fully, before predicate expansion. */
    isExactMatch?: boolean;
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
    /** Distinguishes feature and attribute outputs for one source partition. */
    presentationKey?: string;
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
    /**
     * Native references in the accepted predicate, relative to this owner.
     * An empty list requests solid styling; absence allows the primary scalar
     * of a whole-attribute query such as WARNING_SIGN. Never execution scope.
     */
    queriedPaths?: string[];
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

/** A schema owner in which a style expression has one concrete meaning. */
export interface FeatureSearchStyleFieldContext {
    mapId: string;
    layerId: string;
    attrName?: string;
    attrLayerName?: string;
    featureType?: string;
    /** Native scalar shorthand for this attribute, excluding validity/source metadata. */
    primaryValuePath?: string;
}

/** Shared metadata for one exact schema/type, exported once by the native walker. */
export interface FeatureSearchStyleFieldMetadata {
    valueKind: FeatureSearchStyleValueKind;
    enumValues: string[];
    numericRange?: {min: number; max: number};
    schemaType?: SchemaScalarType;
}

/** A path and its distinct meaning; context owners share the same metadata object. */
export interface FeatureSearchStyleFieldCandidate extends FeatureSearchStyleFieldMetadata {
    path: string;
    contexts: FeatureSearchStyleFieldContext[];
}

/** A field name or an array-element edge; native code renders the corresponding Simfil expression. */
export const featureSearchStylePathStepSchema = z.union([
    z.string(),
    z.strictObject({elements: z.literal(true)})
]);
export type FeatureSearchStylePathStep = z.infer<typeof featureSearchStylePathStepSchema>;

/**
 * Semantic discovery controls. Names and array-element edges are explicit so
 * JavaScript never has to parse expressions or reconstruct the schema graph.
 * Direct-child mode supports browsing; recursive mode includes the subtree.
 */
export interface FeatureSearchStyleFieldOptions {
    selectedFeatureTypes?: string[];
    path?: FeatureSearchStylePathStep[];
    recursive?: boolean;
    values?: "scalar" | "all";
    context?: FeatureSearchStyleFieldContext;

    /** Exact attribute owners already resolved during confirmed search preparation. */
    preparedContexts?: FeatureSearchAttributeScopeCandidate[];
}

/** Validate shared type descriptors once, then retain compact integer references. */
export const featureSearchStyleFieldInventorySchema = z.object({
    contexts: z.array(z.object({
        mapId: z.string().min(1), layerId: z.string().min(1),
        featureType: z.string().optional(), attrName: z.string().optional(), attrLayerName: z.string().optional(),
        primaryValuePath: z.string().optional()
    })),
    types: z.array(z.object({
        valueKind: z.enum(["number", "integer", "string", "boolean", "enum", "bitmask", "object", "array", "unknown"]),
        enumValues: z.array(z.string()),
        numericRange: z.object({min: z.number(), max: z.number()}).optional(),
        schemaType: schemaScalarTypeSchema.nullish().transform(value => value ?? undefined)
    })),
    fields: z.array(z.object({
        path: z.string().min(1), metadata: z.number().int().nonnegative(),
        contexts: z.array(z.number().int().nonnegative())
    })),
    branches: z.array(z.object({
        path: z.array(featureSearchStylePathStepSchema), label: z.string(), contexts: z.array(z.number().int().nonnegative())
    })),
    complete: z.boolean(),
    incompleteReason: z.string()
}).superRefine((inventory, context) => {
    for (const field of inventory.fields) {
        if (field.metadata >= inventory.types.length || field.contexts.some(index => index >= inventory.contexts.length)) {
            context.addIssue({code: "custom", message: "Style field references an unknown type or context"});
            return;
        }
    }
    if (inventory.branches.some(branch => branch.contexts.some(index => index >= inventory.contexts.length))) {
        context.addIssue({code: "custom", message: "Style branch references an unknown context"});
    }
});

/** Compact worker result; complete refers to the requested semantic scope, never to loaded data. */
export type FeatureSearchStyleFieldInventory = z.infer<typeof featureSearchStyleFieldInventorySchema>;

/** Resolve table references without cloning shared type metadata or expanding one row per owner. */
export function searchStyleFieldCandidates(inventory: FeatureSearchStyleFieldInventory): FeatureSearchStyleFieldCandidate[] {
    return inventory.fields.map(field => ({
        path: field.path,
        ...inventory.types[field.metadata],
        contexts: field.contexts.map(index => inventory.contexts[index])
    }));
}
