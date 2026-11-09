import {preparedSearchBranchSchema} from "./search-preparation.model";
import {featureSearchStyleFieldInventorySchema} from "./search.model";
import {coreLib, initializeLibrary, uint8ArrayToWasmOrThrow} from "../integrations/wasm.adapter";
import type {TileLayerParser} from "../../build/libs/core/erdblick-core";
import type {CompletionCandidate} from "./search.model";
import type {FeatureSearchMapLayerRef} from "./search-definition.model";
import type {
    SearchCompletionRequestMessage,
    SearchCompletionDataSourceInfoMessage,
    SearchCompletionDataSourceInfoReady,
    SearchCompletionResultMessage,
    SearchScopeAnalysisRequestMessage,
    SearchScopeAnalysisResultMessage,
    SearchCompletionWorkerInboundMessage,
    SearchCompletionWorkerOptions,
    SearchStyleFieldsRequestMessage,
    SearchStyleFieldsResultMessage
} from "./search-completion.worker.protocol";

let parser: TileLayerParser | null = null;
let dataSourceInfoJson: string | null = null;
const dataSourceInfoEncoder = new TextEncoder();
const latestCompletionSerialByOwner = new Map<string, number>();

interface CompletionContext {
    selectedMapLayers?: FeatureSearchMapLayerRef[];
}

interface SchemaOptions {
    selectedMapLayers?: FeatureSearchMapLayerRef[];
    selectedFeatureTypes?: string[];
}

/** Returns the feature map/layer refs described by the last `/sources` payload. */
function featureLayerRefsFromDataSourceInfo(): Array<FeatureSearchMapLayerRef & {schemaId: string}> {
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

    const refs: Array<FeatureSearchMapLayerRef & {schemaId: string}> = [];
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
            refs.push({mapId, layerId, schemaId: String(sourceRecord?.["schemaId"] ?? mapId)});
        }
    }
    return refs;
}

/**
 * Binds one requested source scope after installing its binary graphs.
 * Native MapSchema ownership is shared across the old and new parser while
 * replacement validates; failed installation leaves the old parser untouched.
 */
async function configureDataSourceInfo(message: SearchCompletionDataSourceInfoMessage): Promise<void> {
    await initializeLibrary();
    const nextParser: TileLayerParser = new coreLib.TileLayerParser();
    try {
        for (const artifact of message.schemas) {
            uint8ArrayToWasmOrThrow(bytes => nextParser.installMapSchema(bytes, artifact.schemaId), artifact.bytes);
        }
        uint8ArrayToWasmOrThrow(
            bytes => nextParser.setDataSourceInfo(bytes),
            dataSourceInfoEncoder.encode(message.dataSourceInfoJson ?? "[]")
        );
    } catch (error) {
        nextParser.delete();
        throw error;
    }
    parser?.delete();
    parser = nextParser;
    dataSourceInfoJson = message.dataSourceInfoJson;
}

/** Queries are admitted only after the main thread receives the installation acknowledgement. */
async function currentParser(): Promise<TileLayerParser> {
    await initializeLibrary();
    if (!parser) throw new Error("Search schema has not been installed in this worker.");
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
        isExactMatch: candidate?.["isExactMatch"] === true,
        ...(originLayers.length ? {originLayers} : {})
    };
}

/**
 * Scan an identical schema/layer once even when several maps publish it.
 * Keep origin maps as provenance and fallback scope when no layers are active.
 * These are not all maps that can evaluate the accepted portable expression.
 */
function completionContexts(options: SearchCompletionWorkerOptions): CompletionContext[] {
    const available = featureLayerRefsFromDataSourceInfo();
    const identities = new Map(available.map(ref => [ref.mapId, ref.schemaId]));
    const selected = options.selectedMapLayers ?? available;
    const groups = new Map<string, FeatureSearchMapLayerRef[]>();
    for (const {mapId, layerId} of selected) {
        const key = JSON.stringify([identities.get(mapId) ?? mapId, layerId]);
        const refs = groups.get(key) ?? [];
        refs.push({mapId, layerId});
        groups.set(key, refs);
    }
    return [...groups.values()].map(selectedMapLayers => ({selectedMapLayers}));
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

/**
 * Stream completion between native passes so a cancellation can interrupt an
 * obsolete prefix. Always acknowledge completion, including cancellation: the
 * main thread keeps schema replacement serialized until this scan has stopped.
 */
async function completeQuery(message: SearchCompletionRequestMessage): Promise<void> {
    latestCompletionSerialByOwner.set(message.ownerId, message.requestSerial);
    const stale = () => latestCompletionSerialByOwner.get(message.ownerId) !== message.requestSerial;
    let error: string | undefined;
    try {
        const activeParser = await currentParser();
        const contexts = completionContexts(message.options);
        for (let index = 0; index < contexts.length; index++) {
            if (stale()) return;
            const candidates = completeQueryInContext(activeParser, message, contexts[index]);
            if (candidates.length) {
                postMessage({
                    type: "SearchCompletionResult", ownerId: message.ownerId,
                    requestSerial: message.requestSerial, candidates, done: false
                } satisfies SearchCompletionResultMessage);
            }
            if (index + 1 < contexts.length) await new Promise(resolve => setTimeout(resolve, 0));
        }
    } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
    } finally {
        postMessage({
            type: "SearchCompletionResult", ownerId: message.ownerId,
            requestSerial: message.requestSerial, candidates: [], done: true,
            ...(error ? {error} : {})
        } satisfies SearchCompletionResultMessage);
    }
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
        ...(context.selectedMapLayers !== undefined ? {selectedMapLayers: context.selectedMapLayers.slice(0, 1)} : {})
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
            attributeScopeCandidateCount: 0,
            rewriteSuppressed: false,
            rewriteSuppressionReason: "",
            inferredMapLayers: [],
            matchedFieldNames: [],
            matchedEnumValues: [],
            matchedFeatureTypes: []
        } satisfies SearchScopeAnalysisResultMessage);
        return;
    }

    const interpretations = preparedSearchBranchSchema.array().parse(activeParser.prepareSearchQuery(
        message.query, message.scope, {...schemaOptions(message.selectedMapLayers),
            ...(message.selectedFeatureTypes ? {selectedFeatureTypes: message.selectedFeatureTypes} : {})}));
    const attributeScopes = interpretations.flatMap(branch => branch.attributeScopes);
    postMessage({
        type: "SearchScopeAnalysisResult", requestId: message.requestId, interpretations,
        // This is candidate metadata only. SearchService chooses and commits
        // concrete per-layer branches after any required user decision.
        concreteScope: interpretations.length && interpretations.every(branch => branch.scope === "attribute") ? "attribute" : "feature",
        normalizedQuery: message.query, attributeScopes, attributeScopeCandidateCount: attributeScopes.length,
        rewriteSuppressed: false, rewriteSuppressionReason: "",
        inferredMapLayers: [...new Map(interpretations.map(branch => [JSON.stringify([branch.mapId, branch.layerId]),
            {mapId: branch.mapId, layerId: branch.layerId}])).values()],
        matchedFieldNames: [...new Set(interpretations.flatMap(branch => branch.matchedFieldNames ?? []))],
        matchedEnumValues: [...new Set(interpretations.flatMap(branch => branch.matchedEnumValues ?? []))],
        matchedFeatureTypes: [...new Set(interpretations.flatMap(branch => branch.featureTypes))]
    } satisfies SearchScopeAnalysisResultMessage);
}

/** Discover and validate shared native metadata before transferring it to the UI. */
async function enumerateSearchStyleFields(message: SearchStyleFieldsRequestMessage): Promise<void> {
    const activeParser = await currentParser();
    if (!activeParser) throw new Error("Schema parser is unavailable.");
    const started = performance.now();
    const raw = activeParser.searchStyleFieldsForQuery(message.query, message.scope, {
        ...schemaOptions(message.selectedMapLayers), ...message.options
    });
    const nativeDone = performance.now();
    const inventory = featureSearchStyleFieldInventorySchema.parse(raw);
    const normalized = performance.now();
    postMessage({
        type: "SearchStyleFieldsResult",
        requestId: message.requestId,
        inventory,
        timing: {
            nativeMs: nativeDone - started,
            normalizationMs: normalized - nativeDone,
            postedAt: performance.timeOrigin + normalized
        }
    } satisfies SearchStyleFieldsResultMessage);
}

/** Handles one inbound worker message and posts completion results back to the UI thread. */
async function handleMessage(message: SearchCompletionWorkerInboundMessage): Promise<void> {
    try {
        if (message.type === "SearchCompletionDataSourceInfo") {
            await configureDataSourceInfo(message);
            postMessage({
                type: "SearchCompletionDataSourceInfoReady", requestId: message.requestId
            } satisfies SearchCompletionDataSourceInfoReady);
            return;
        }
        if (message.type === "SearchCompletionCancel") {
            latestCompletionSerialByOwner.delete(message.ownerId);
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
    } catch (error) {
        if (message.type === "SearchCompletionDataSourceInfo") {
            postMessage({
                type: "SearchCompletionDataSourceInfoReady", requestId: message.requestId,
                error: error instanceof Error ? error.message : String(error)
            } satisfies SearchCompletionDataSourceInfoReady);
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
                attributeScopeCandidateCount: 0,
                rewriteSuppressed: false,
                rewriteSuppressionReason: "",
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
                error: error instanceof Error ? error.message : String(error)
            } satisfies SearchStyleFieldsResultMessage);
        }
    }
}

addEventListener("message", (event: MessageEvent<SearchCompletionWorkerInboundMessage>) => {
    void handleMessage(event.data);
});
