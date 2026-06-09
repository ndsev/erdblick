import {coreLib, initializeLibrary, uint8ArrayToWasm} from "../integrations/wasm";
import type {TileLayerParser} from "../../build/libs/core/erdblick-core";
import type {
    FeatureSearchAttributeScopeCandidate,
    FeatureSearchStyleFieldCandidate,
    FeatureSearchStyleValueKind
} from "../mapdata/map-runtime.model";
import type {CompletionCandidate} from "./search.model";
import type {FeatureSearchMapLayerRef} from "../shared/feature-search-state";
import type {
    SearchCompletionRequestMessage,
    SearchCompletionResultMessage,
    SearchQueryDiagnosticsRequestMessage,
    SearchQueryDiagnosticsResultMessage,
    SearchScopeAnalysisRequestMessage,
    SearchScopeAnalysisResultMessage,
    SearchCompletionWorkerInboundMessage,
    SearchCompletionWorkerOptions,
    SearchStyleFieldsRequestMessage,
    SearchStyleFieldsResultMessage
} from "./search-completion.worker.protocol";

let parser: TileLayerParser | null = null;
let dataSourceInfoJson: string | null = null;
let parserConfiguration: Promise<void> = Promise.resolve();
const dataSourceInfoEncoder = new TextEncoder();
const latestCompletionSerialByOwner = new Map<string, number>();

interface CompletionContext {
    selectedMapLayers?: FeatureSearchMapLayerRef[];
}

interface SchemaOptions {
    selectedMapLayers?: FeatureSearchMapLayerRef[];
}

interface SearchQueryNormalizationNativeResult {
    concreteScope?: unknown;
    normalizedQuery?: unknown;
    attributeScopes?: unknown;
    matchedFeatureTypes?: unknown;
    error?: unknown;
}

type TileLayerParserWithSearchNormalization = TileLayerParser & {
    normalizeSearchQuery(query: string, scope: string, options: SchemaOptions): unknown;
};

/** Returns the feature map/layer refs described by the last `/sources` payload. */
function featureLayerRefsFromDataSourceInfo(): FeatureSearchMapLayerRef[] {
    if (!dataSourceInfoJson) {
        return [];
    }
    let sources: unknown;
    try {
        sources = JSON.parse(dataSourceInfoJson);
    } catch {
        return [];
    }
    if (!Array.isArray(sources)) {
        return [];
    }

    const refs: FeatureSearchMapLayerRef[] = [];
    const known = new Set<string>();
    for (const source of sources) {
        const sourceRecord = recordFromUnknown(source);
        const rawMapId = sourceRecord?.["mapId"];
        const mapId = typeof rawMapId === "string" ? rawMapId : "";
        const layersValue = sourceRecord?.["layers"];
        const layersRecord = recordFromUnknown(layersValue);
        const layers = Array.isArray(layersValue)
            ? layersValue
            : layersRecord ? Object.values(layersRecord) : [];
        for (const layerValue of layers) {
            const layer = recordFromUnknown(layerValue);
            const rawLayerId = layer?.["layerId"];
            const rawFallbackLayerId = layer?.["id"];
            const layerId = typeof rawLayerId === "string"
                ? rawLayerId
                : typeof rawFallbackLayerId === "string" ? rawFallbackLayerId : "";
            if (!mapId || !layerId || layer?.["type"] !== "Features") {
                continue;
            }
            const key = `${mapId}\u0000${layerId}`;
            if (known.has(key)) {
                continue;
            }
            known.add(key);
            refs.push({mapId, layerId});
        }
    }
    return refs;
}

/** Builds a fresh parser with the worker's last known `/sources` metadata. */
function createParserFromDataSourceInfo(): TileLayerParser | null {
    if (!dataSourceInfoJson) {
        return null;
    }
    if (!coreLib?.TileLayerParser) {
        throw new Error("Erdblick WASM core is not initialized for schema completion.");
    }
    const nextParser: TileLayerParser = new coreLib.TileLayerParser();
    uint8ArrayToWasm(
        data => nextParser.setDataSourceInfo(data),
        dataSourceInfoEncoder.encode(dataSourceInfoJson)
    );
    return nextParser;
}

/** Replaces the worker-local parser metadata after `/sources` changed. */
async function configureDataSourceInfoNow(nextDataSourceInfoJson: string | null): Promise<void> {
    await initializeLibrary();
    parser?.delete();
    parser = null;
    dataSourceInfoJson = nextDataSourceInfoJson;
    parser = createParserFromDataSourceInfo();
}

/** Serializes parser reconfiguration so requests never observe a half-updated parser. */
function configureDataSourceInfo(nextDataSourceInfoJson: string | null): Promise<void> {
    parserConfiguration = parserConfiguration
        .catch(() => undefined)
        .then(() => configureDataSourceInfoNow(nextDataSourceInfoJson));
    return parserConfiguration;
}

/** Ensures the worker can answer completion requests even if the first metadata sync races startup. */
async function currentParser(): Promise<TileLayerParser | null> {
    await initializeLibrary();
    await parserConfiguration.catch(() => undefined);
    if (!parser) {
        parser = createParserFromDataSourceInfo();
    }
    return parser;
}

/** Returns an object record or null for untrusted native completion values. */
function recordFromUnknown(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

/** Normalizes one native SIMFIL completion object into the UI model. */
function normalizeCompletionCandidate(
    sourceQuery: string,
    item: unknown,
    originLayers: FeatureSearchMapLayerRef[] = []
): CompletionCandidate | null {
    const candidate = recordFromUnknown(item);
    const rangeValue = candidate?.["range"];
    const range = Array.isArray(rangeValue) ? rangeValue : [];
    const begin = Number(range[0] ?? 0);
    const end = Number(range[1] ?? 0);
    const queryValue = candidate?.["query"];
    if (!Number.isFinite(begin) || !Number.isFinite(end) || typeof queryValue !== "string") {
        return null;
    }
    const hintValue = candidate?.["hint"];
    const rawKind = String(candidate?.["type"] ?? "").toLowerCase();
    const rawHint = typeof hintValue === "string" ? hintValue : "";
    const enumKind = rawKind === "constant" && rawHint.startsWith("enum ") ? rawHint : "";
    return {
        text: String(candidate?.["text"] ?? ""),
        kind: enumKind || rawKind,
        begin,
        end,
        query: queryValue,
        source: sourceQuery,
        hint: enumKind ? "" : rawHint,
        ...(originLayers.length ? {originLayers} : {})
    };
}

/** Normalizes a native style-field value kind into the frontend union. */
function normalizeStyleFieldValueKind(value: unknown): FeatureSearchStyleValueKind {
    switch (value) {
        case "number":
        case "integer":
        case "string":
        case "boolean":
        case "enum":
        case "object":
        case "array":
            return value;
        default:
            return "unknown";
    }
}

/** Normalizes optional native numeric range metadata for schema-backed style fields. */
function normalizeStyleFieldNumericRange(value: unknown): {min: number; max: number} | undefined {
    const record = recordFromUnknown(value);
    if (!record) {
        return undefined;
    }
    const min = Number(record["min"]);
    const max = Number(record["max"]);
    return Number.isFinite(min) && Number.isFinite(max) ? {min, max} : undefined;
}

/** Normalizes untyped WASM attribute-scope candidates into the TypeScript-facing shape. */
function normalizeAttributeScopeCandidates(value: unknown): FeatureSearchAttributeScopeCandidate[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap(item => {
        const raw = recordFromUnknown(item);
        if (!raw) {
            return [];
        }
        const attrName = typeof raw["attrName"] === "string" ? raw["attrName"] : "";
        const attrLayerName = typeof raw["attrLayerName"] === "string" ? raw["attrLayerName"] : "";
        const featureType = typeof raw["featureType"] === "string" ? raw["featureType"] : "";
        const mapId = typeof raw["mapId"] === "string" ? raw["mapId"] : "";
        const layerId = typeof raw["layerId"] === "string" ? raw["layerId"] : "";
        return attrName && mapId && layerId
            ? [{attrName, attrLayerName, featureType, mapId, layerId}]
            : [];
    });
}

/** Normalizes untrusted map/layer refs returned by native schema analysis. */
function normalizeMapLayerRefs(value: unknown): FeatureSearchMapLayerRef[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const refs: FeatureSearchMapLayerRef[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        const raw = recordFromUnknown(item);
        const mapId = typeof raw?.["mapId"] === "string" ? raw["mapId"] : "";
        const layerId = typeof raw?.["layerId"] === "string" ? raw["layerId"] : "";
        const key = `${mapId}\u0000${layerId}`;
        if (!mapId || !layerId || seen.has(key)) {
            continue;
        }
        seen.add(key);
        refs.push({mapId, layerId});
    }
    return refs;
}

/** Normalizes untrusted string arrays returned by native schema analysis. */
function normalizeStringList(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
}

/** Normalizes native map-layer inference into the worker protocol shape. */
function normalizeMapLayerInference(value: unknown): Pick<
    SearchScopeAnalysisResultMessage,
    "inferredMapLayers" | "matchedFieldNames" | "matchedEnumValues"
> {
    const raw = recordFromUnknown(value);
    return {
        inferredMapLayers: normalizeMapLayerRefs(raw?.["mapLayers"]),
        matchedFieldNames: normalizeStringList(raw?.["matchedFieldNames"]),
        matchedEnumValues: normalizeStringList(raw?.["matchedEnumValues"])
    };
}

/** Normalizes the native mapget-backed search-query normalization result. */
function normalizeSearchQueryNormalization(
    query: string,
    scope: string,
    value: unknown
): Pick<
    SearchScopeAnalysisResultMessage,
    "concreteScope" | "normalizedQuery" | "attributeScopes" | "matchedFeatureTypes" | "error"
> {
    const raw = recordFromUnknown(value) as SearchQueryNormalizationNativeResult | null;
    const concreteScope = raw?.concreteScope === "attribute" || raw?.concreteScope === "feature"
        ? raw.concreteScope
        : (scope === "attribute" ? "attribute" : "feature");
    const normalizedQuery = typeof raw?.normalizedQuery === "string" && raw.normalizedQuery.trim()
        ? raw.normalizedQuery
        : query;
    const error = typeof raw?.error === "string" && raw.error
        ? raw.error
        : undefined;
    return {
        concreteScope,
        normalizedQuery,
        attributeScopes: normalizeAttributeScopeCandidates(raw?.attributeScopes),
        matchedFeatureTypes: normalizeStringList(raw?.matchedFeatureTypes),
        ...(error ? {error} : {})
    };
}

/** Normalizes untyped WASM search-style field candidates into the TypeScript-facing shape. */
function normalizeSearchStyleFieldCandidates(value: unknown): FeatureSearchStyleFieldCandidate[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap(item => {
        const raw = recordFromUnknown(item);
        if (!raw) {
            return [];
        }
        const path = typeof raw["path"] === "string" ? raw["path"] : "";
        const mapId = typeof raw["mapId"] === "string" ? raw["mapId"] : "";
        const layerId = typeof raw["layerId"] === "string" ? raw["layerId"] : "";
        if (!path || !mapId || !layerId) {
            return [];
        }
        const attrName = typeof raw["attrName"] === "string" ? raw["attrName"] : undefined;
        const attrLayerName = typeof raw["attrLayerName"] === "string" ? raw["attrLayerName"] : undefined;
        const featureType = typeof raw["featureType"] === "string" ? raw["featureType"] : undefined;
        const enumValues = Array.isArray(raw["enumValues"])
            ? raw["enumValues"].filter((item): item is string => typeof item === "string")
            : [];
        const numericRange = normalizeStyleFieldNumericRange(raw["numericRange"]);
        return [{
            path,
            mapId,
            layerId,
            attrName,
            attrLayerName,
            featureType,
            valueKind: normalizeStyleFieldValueKind(raw["valueKind"]),
            enumValues,
            ...(numericRange ? {numericRange} : {})
        }];
    });
}

/** Converts native AST diagnostic records into the UI diagnostics model. */
function normalizeQueryDiagnostics(query: string, value: unknown): SearchQueryDiagnosticsResultMessage["diagnostics"] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap(item => {
        const raw = recordFromUnknown(item);
        if (!raw) {
            return [];
        }
        const message = typeof raw["message"] === "string" ? raw["message"] : "";
        if (!message) {
            return [];
        }
        const locationValue = recordFromUnknown(raw["location"]);
        const offset = Number(locationValue?.["offset"]);
        const size = Number(locationValue?.["size"]);
        const location = Number.isFinite(offset) && Number.isFinite(size)
            ? {offset, size}
            : undefined;
        return [{
            query,
            message,
            ...(location ? {location} : {}),
            fix: typeof raw["fix"] === "string" ? raw["fix"] : null
        }];
    });
}

/** Returns completion contexts narrow enough to stream useful batches as they are produced. */
function completionContexts(options: SearchCompletionWorkerOptions): CompletionContext[] {
    if (options.selectedMapLayers && options.selectedMapLayers.length > 0) {
        return options.selectedMapLayers.map(ref => ({selectedMapLayers: [ref]}));
    }
    const featureLayerRefs = featureLayerRefsFromDataSourceInfo();
    return featureLayerRefs.length > 0
        ? featureLayerRefs.map(ref => ({selectedMapLayers: [ref]}))
        : [{}];
}

/** Runs one native completion pass in the worker-local parser. */
function completeQueryInContext(
    activeParser: TileLayerParser,
    message: SearchCompletionRequestMessage,
    context: CompletionContext
): CompletionCandidate[] {
    const rawCandidates = activeParser.completeSearchQuery(
        message.query,
        message.point,
        completionOptionsForNative(message.options, context)
    );
    return Array.isArray(rawCandidates)
        ? rawCandidates
            .map(item => normalizeCompletionCandidate(message.query, item, context.selectedMapLayers ?? []))
            .filter((candidate): candidate is CompletionCandidate => candidate !== null)
        : [];
}

/** Runs native schema completion and streams partial result batches by map/layer context. */
async function completeQuery(message: SearchCompletionRequestMessage): Promise<void> {
    latestCompletionSerialByOwner.set(message.ownerId, message.requestSerial);
    const activeParser = await currentParser();
    if (!activeParser) {
        postMessage({
            type: "SearchCompletionResult",
            ownerId: message.ownerId,
            requestSerial: message.requestSerial,
            candidates: [],
            done: true
        } satisfies SearchCompletionResultMessage);
        return;
    }

    const contexts = completionContexts(message.options);
    const stale = () => latestCompletionSerialByOwner.get(message.ownerId) !== message.requestSerial;
    if (stale()) {
        return;
    }
    if (contexts.length === 1) {
        postMessage({
            type: "SearchCompletionResult",
            ownerId: message.ownerId,
            requestSerial: message.requestSerial,
            candidates: completeQueryInContext(activeParser, message, contexts[0]!),
            done: true
        } satisfies SearchCompletionResultMessage);
        return;
    }

    for (const context of contexts) {
        if (stale()) {
            return;
        }
        const candidates = completeQueryInContext(activeParser, message, context);
        if (candidates.length > 0) {
            postMessage({
                type: "SearchCompletionResult",
                ownerId: message.ownerId,
                requestSerial: message.requestSerial,
                candidates,
                done: false
            } satisfies SearchCompletionResultMessage);
        }
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (stale()) {
        return;
    }
    postMessage({
        type: "SearchCompletionResult",
        ownerId: message.ownerId,
        requestSerial: message.requestSerial,
        candidates: [],
        done: true
    } satisfies SearchCompletionResultMessage);
}

/** Keeps the posted worker options limited to the native parser's expected shape. */
function completionOptionsForNative(
    options: SearchCompletionWorkerOptions,
    context: CompletionContext
): SearchCompletionWorkerOptions {
    return {
        limit: options.limit,
        timeoutMs: options.timeoutMs,
        ...(options.scope ? {scope: options.scope} : {}),
        ...(context.selectedMapLayers !== undefined ? {selectedMapLayers: context.selectedMapLayers} : {})
    };
}

/** Keeps parser options limited to the native schema-analysis shape. */
function schemaOptions(selectedMapLayers?: FeatureSearchMapLayerRef[]): SchemaOptions {
    return selectedMapLayers === undefined ? {} : {selectedMapLayers};
}

/** Resolves concrete scope and attribute candidates in the worker-local parser. */
async function analyzeSearchScope(message: SearchScopeAnalysisRequestMessage): Promise<void> {
    const activeParser = await currentParser();
    if (!activeParser) {
        postMessage({
            type: "SearchScopeAnalysisResult",
            requestId: message.requestId,
            concreteScope: message.scope === "attribute" ? "attribute" : "feature",
            normalizedQuery: message.query,
            attributeScopes: [],
            inferredMapLayers: [],
            matchedFieldNames: [],
            matchedEnumValues: [],
            matchedFeatureTypes: []
        } satisfies SearchScopeAnalysisResultMessage);
        return;
    }

    const normalization = normalizeSearchQueryNormalization(
        message.query,
        message.scope,
        (activeParser as TileLayerParserWithSearchNormalization).normalizeSearchQuery(
            message.query,
            message.scope,
            schemaOptions(message.selectedMapLayers)
        )
    );
    const mapLayerInference = normalizeMapLayerInference(
        activeParser.getMapLayersForQuery(message.query, schemaOptions())
    );
    postMessage({
        type: "SearchScopeAnalysisResult",
        requestId: message.requestId,
        ...normalization,
        ...mapLayerInference
    } satisfies SearchScopeAnalysisResultMessage);
}

/** Enumerates style field candidates in the worker-local parser. */
async function enumerateSearchStyleFields(message: SearchStyleFieldsRequestMessage): Promise<void> {
    const activeParser = await currentParser();
    const fields = activeParser
        ? normalizeSearchStyleFieldCandidates(activeParser.searchStyleFieldsForQuery(
            message.query,
            message.scope,
            schemaOptions(message.selectedMapLayers)
        ))
        : [];
    postMessage({
        type: "SearchStyleFieldsResult",
        requestId: message.requestId,
        fields
    } satisfies SearchStyleFieldsResultMessage);
}

/** Computes schema-AST diagnostics in the worker-local parser. */
async function computeSearchQueryDiagnostics(message: SearchQueryDiagnosticsRequestMessage): Promise<void> {
    const activeParser = await currentParser();
    const diagnostics = activeParser
        ? normalizeQueryDiagnostics(message.query, activeParser.searchQueryAstDiagnostics(
            message.query,
            message.scope,
            schemaOptions(message.selectedMapLayers)
        ))
        : [];
    postMessage({
        type: "SearchQueryDiagnosticsResult",
        requestId: message.requestId,
        diagnostics
    } satisfies SearchQueryDiagnosticsResultMessage);
}

/** Handles one inbound worker message and posts completion results back to the UI thread. */
async function handleMessage(message: SearchCompletionWorkerInboundMessage): Promise<void> {
    try {
        if (message.type === "SearchCompletionDataSourceInfo") {
            await configureDataSourceInfo(message.dataSourceInfoJson);
            return;
        }
        if (message.type === "SearchCompletionRequest") {
            await completeQuery(message);
            return;
        }
        if (message.type === "SearchScopeAnalysisRequest") {
            await analyzeSearchScope(message);
            return;
        }
        if (message.type === "SearchStyleFieldsRequest") {
            await enumerateSearchStyleFields(message);
            return;
        }
        await computeSearchQueryDiagnostics(message);
    } catch (error) {
        if (message.type === "SearchCompletionDataSourceInfo") {
            console.error("Failed to configure schema completion worker.", error);
        } else if (message.type === "SearchCompletionRequest") {
            postMessage({
                type: "SearchCompletionResult",
                ownerId: message.ownerId,
                requestSerial: message.requestSerial,
                candidates: [],
                done: true,
                error: error instanceof Error ? error.message : String(error)
            } satisfies SearchCompletionResultMessage);
        } else if (message.type === "SearchScopeAnalysisRequest") {
            postMessage({
                type: "SearchScopeAnalysisResult",
                requestId: message.requestId,
                concreteScope: message.scope === "attribute" ? "attribute" : "feature",
                normalizedQuery: message.query,
                attributeScopes: [],
                inferredMapLayers: [],
                matchedFieldNames: [],
                matchedEnumValues: [],
                matchedFeatureTypes: [],
                error: error instanceof Error ? error.message : String(error)
            } satisfies SearchScopeAnalysisResultMessage);
        } else if (message.type === "SearchStyleFieldsRequest") {
            postMessage({
                type: "SearchStyleFieldsResult",
                requestId: message.requestId,
                fields: [],
                error: error instanceof Error ? error.message : String(error)
            } satisfies SearchStyleFieldsResultMessage);
        } else {
            postMessage({
                type: "SearchQueryDiagnosticsResult",
                requestId: message.requestId,
                diagnostics: [],
                error: error instanceof Error ? error.message : String(error)
            } satisfies SearchQueryDiagnosticsResultMessage);
        }
    }
}

addEventListener("message", (event: MessageEvent<SearchCompletionWorkerInboundMessage>) => {
    void handleMessage(event.data);
});
