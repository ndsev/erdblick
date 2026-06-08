import {Injectable} from "@angular/core";
import {
    FeatureSearchAttributeScopeCandidate,
    FeatureSearchStyleFieldCandidate
} from "./map-runtime.model";
import {MapInfoService} from "./map-info.service";
import type {FeatureSearchMapLayerRef, FeatureSearchScope} from "../shared/feature-search-state";
import type {
    SearchCompletionDataSourceInfoMessage,
    SearchCompletionRequestMessage,
    SearchCompletionResultMessage,
    SearchCompletionWorkerOutboundMessage,
    SearchQueryDiagnosticsRequestMessage,
    SearchQueryDiagnosticsResultMessage,
    SearchScopeAnalysisRequestMessage,
    SearchScopeAnalysisResultMessage,
    SearchStyleFieldsRequestMessage,
    SearchStyleFieldsResultMessage
} from "../search/search-completion.worker.protocol";

export interface FeatureSearchDiagnosticMessage {
    query: string;
    message: string;
    location?: {offset: number, size: number};
    fix: null | string;
}

export interface FeatureSearchScopeAnalysis {
    signature: string;
    concreteScope: "feature" | "attribute";
    attributeScopes: FeatureSearchAttributeScopeCandidate[];
    inferredMapLayers: FeatureSearchMapLayerRef[];
    matchedFieldNames: string[];
    matchedEnumValues: string[];
    error?: string;
}

type SchemaWorkerKind = "completion" | "analysis";

interface SchemaWorkerState {
    worker: Worker | null;
    failed: boolean;
    dataSourceInfoJson: string | null | undefined;
}

/**
 * Provides schema-backed feature-search helpers exposed by the native TileLayerParser.
 *
 * The service deliberately owns the query-result caches instead of MapInfoService:
 * datasource metadata still lives on the shared parser, while search-specific interpretation stays here.
 */
@Injectable({providedIn: "root"})
export class FeatureSearchSchemaService {
    private searchStyleFieldsByQueryCache = new Map<string, FeatureSearchStyleFieldCandidate[]>();
    private searchAstDiagnosticsByQueryCache = new Map<string, FeatureSearchDiagnosticMessage[]>();
    private readonly pendingCompletionHandlers = new Map<string, (message: SearchCompletionResultMessage) => void>();
    private readonly pendingScopeAnalysis = new Map<number, {
        resolve: (value: FeatureSearchScopeAnalysis) => void;
        signature: string;
    }>();
    private readonly pendingStyleFields = new Map<number, {
        resolve: (value: FeatureSearchStyleFieldCandidate[]) => void;
        cacheKey: string;
    }>();
    private readonly pendingQueryDiagnostics = new Map<number, {
        resolve: (value: FeatureSearchDiagnosticMessage[]) => void;
        cacheKey: string;
    }>();
    private scopeAnalysisByQueryCache = new Map<string, Promise<FeatureSearchScopeAnalysis>>();
    private readonly workerStates: Record<SchemaWorkerKind, SchemaWorkerState> = {
        completion: {worker: null, failed: false, dataSourceInfoJson: undefined},
        analysis: {worker: null, failed: false, dataSourceInfoJson: undefined}
    };
    private workerRequestSerial = 0;

    constructor(private readonly mapInfo: MapInfoService) {
        this.mapInfo.layerStateChanged.subscribe(reason => {
            if (reason === "datasources") {
                this.clearCaches();
                this.syncAllWorkerDataSourceInfo();
            }
        });
    }

    /** Returns the stable signature used for schema-derived search analysis caches. */
    searchScopeAnalysisSignature(
        query: string,
        scope: FeatureSearchScope,
        selectedMapLayers?: FeatureSearchMapLayerRef[]
    ): string {
        return `${scope}\n${this.selectedMapLayerSignature(selectedMapLayers)}\n${query.trim()}`;
    }

    /** Requests concrete scope analysis without blocking the UI thread. */
    requestSearchScopeAnalysis(
        query: string,
        scope: FeatureSearchScope,
        selectedMapLayers?: FeatureSearchMapLayerRef[]
    ): Promise<FeatureSearchScopeAnalysis> {
        const signature = this.searchScopeAnalysisSignature(query, scope, selectedMapLayers);
        const cached = this.scopeAnalysisByQueryCache.get(signature);
        if (cached) {
            return cached;
        }

        const worker = this.schemaWorker("analysis");
        if (!worker) {
            const result = Promise.resolve(this.workerUnavailableScopeAnalysis(
                signature,
                scope,
                "Schema worker is unavailable; search schema analysis is disabled."
            ));
            this.scopeAnalysisByQueryCache.set(signature, result);
            return result;
        }

        this.syncWorkerDataSourceInfo("analysis");
        const requestId = ++this.workerRequestSerial;
        const promise = new Promise<FeatureSearchScopeAnalysis>(resolve => {
            this.pendingScopeAnalysis.set(requestId, {resolve, signature});
            worker.postMessage({
                type: "SearchScopeAnalysisRequest",
                requestId,
                query,
                scope,
                ...(selectedMapLayers !== undefined ? {selectedMapLayers} : {})
            } satisfies SearchScopeAnalysisRequestMessage);
        });
        this.scopeAnalysisByQueryCache.set(signature, promise);
        return promise;
    }

    /** Requests schema-backed field expressions for visualization controls off the UI thread. */
    requestSearchStyleFields(
        query: string,
        scope: FeatureSearchScope,
        selectedMapLayers?: FeatureSearchMapLayerRef[]
    ): Promise<FeatureSearchStyleFieldCandidate[]> {
        const cacheKey = `${scope}\n${this.selectedMapLayerSignature(selectedMapLayers)}\n${query.trim()}`;
        const cached = this.searchStyleFieldsByQueryCache.get(cacheKey);
        if (cached) {
            return Promise.resolve(cached);
        }
        const worker = this.schemaWorker("analysis");
        if (!worker) {
            return Promise.resolve([]);
        }

        this.syncWorkerDataSourceInfo("analysis");
        const requestId = ++this.workerRequestSerial;
        return new Promise(resolve => {
            this.pendingStyleFields.set(requestId, {resolve, cacheKey});
            worker.postMessage({
                type: "SearchStyleFieldsRequest",
                requestId,
                query,
                scope,
                ...(selectedMapLayers !== undefined ? {selectedMapLayers} : {})
            } satisfies SearchStyleFieldsRequestMessage);
        });
    }

    /** Requests schema-AST diagnostics for the Diagnostics tab off the UI thread. */
    requestSearchQueryAstDiagnostics(
        query: string,
        scope: FeatureSearchScope,
        selectedMapLayers?: FeatureSearchMapLayerRef[]
    ): Promise<FeatureSearchDiagnosticMessage[]> {
        const cacheKey = `${scope}\n${this.selectedMapLayerSignature(selectedMapLayers)}\n${query.trim()}`;
        const cached = this.searchAstDiagnosticsByQueryCache.get(cacheKey);
        if (cached) {
            return Promise.resolve(cached);
        }
        const worker = this.schemaWorker("analysis");
        if (!worker) {
            return Promise.resolve([]);
        }

        this.syncWorkerDataSourceInfo("analysis");
        const requestId = ++this.workerRequestSerial;
        return new Promise(resolve => {
            this.pendingQueryDiagnostics.set(requestId, {resolve, cacheKey});
            worker.postMessage({
                type: "SearchQueryDiagnosticsRequest",
                requestId,
                query,
                scope,
                ...(selectedMapLayers !== undefined ? {selectedMapLayers} : {})
            } satisfies SearchQueryDiagnosticsRequestMessage);
        });
    }

    /** Sends one completion request through the dedicated completion worker. */
    requestCompletion(
        message: SearchCompletionRequestMessage,
        handler: (message: SearchCompletionResultMessage) => void
    ): boolean {
        const worker = this.schemaWorker("completion");
        if (!worker) {
            return false;
        }
        this.syncWorkerDataSourceInfo("completion");
        this.pendingCompletionHandlers.set(this.completionHandlerKey(message.ownerId, message.requestSerial), handler);
        worker.postMessage(message);
        return true;
    }

    /** Builds a non-blocking failure result when schema workers are unavailable. */
    private workerUnavailableScopeAnalysis(
        signature: string,
        scope: FeatureSearchScope,
        error: string
    ): FeatureSearchScopeAnalysis {
        return {
            signature,
            concreteScope: scope === "attribute" ? "attribute" : "feature",
            attributeScopes: [],
            inferredMapLayers: [],
            matchedFieldNames: [],
            matchedEnumValues: [],
            error
        };
    }

    /** Returns a stable cache key fragment for selected map/layer refs. */
    private selectedMapLayerSignature(selectedMapLayers?: FeatureSearchMapLayerRef[]): string {
        if (selectedMapLayers === undefined) {
            return "*";
        }
        return selectedMapLayers
            .map(ref => JSON.stringify([ref.mapId, ref.layerId]))
            .sort()
            .join("|");
    }

    /** Clears cached schema query results after datasource metadata changes. */
    private clearCaches(): void {
        this.searchStyleFieldsByQueryCache.clear();
        this.searchAstDiagnosticsByQueryCache.clear();
        this.scopeAnalysisByQueryCache.clear();
    }

    /** Lazily creates an isolated schema-processing worker for one workload lane. */
    private schemaWorker(kind: SchemaWorkerKind): Worker | null {
        const state = this.workerStates[kind];
        if (state.failed || typeof Worker === "undefined") {
            return null;
        }
        if (state.worker) {
            return state.worker;
        }
        try {
            const worker = new Worker(new URL("../search/search-completion.worker", import.meta.url), {type: "module"});
            worker.onmessage = (event: MessageEvent<SearchCompletionWorkerOutboundMessage>) => {
                this.handleWorkerMessage(event.data);
            };
            worker.onerror = event => {
                console.warn(`Schema ${kind} worker failed; recreating on the next request.`, event.message);
                this.resetWorker(kind, event.message);
            };
            state.worker = worker;
            return worker;
        } catch (error) {
            console.warn(`Failed to create schema ${kind} worker. Schema-backed search helpers are disabled.`, error);
            state.failed = true;
            return null;
        }
    }

    /** Mirrors current datasource metadata into the worker-local parser. */
    private syncWorkerDataSourceInfo(kind: SchemaWorkerKind): void {
        const state = this.workerStates[kind];
        const worker = state.worker;
        if (!worker) {
            return;
        }
        const dataSourceInfoJson = this.mapInfo.getDataSourceInfoJson();
        if (dataSourceInfoJson === state.dataSourceInfoJson) {
            return;
        }
        state.dataSourceInfoJson = dataSourceInfoJson;
        worker.postMessage({
            type: "SearchCompletionDataSourceInfo",
            dataSourceInfoJson
        } satisfies SearchCompletionDataSourceInfoMessage);
    }

    /** Refreshes metadata in every worker that has already been created. */
    private syncAllWorkerDataSourceInfo(): void {
        this.syncWorkerDataSourceInfo("completion");
        this.syncWorkerDataSourceInfo("analysis");
    }

    /** Routes worker messages to the pending request that owns them. */
    private handleWorkerMessage(message: SearchCompletionWorkerOutboundMessage): void {
        if (message.type === "SearchCompletionResult") {
            const key = this.completionHandlerKey(message.ownerId, message.requestSerial);
            const handler = this.pendingCompletionHandlers.get(key);
            if (!handler) {
                return;
            }
            handler(message);
            if (message.done) {
                this.pendingCompletionHandlers.delete(key);
            }
            if (this.isNativeAbortError(message.error)) {
                this.resetWorker("completion", message.error);
            }
            return;
        }
        if (message.type === "SearchScopeAnalysisResult") {
            this.handleScopeAnalysisResult(message);
            if (this.isNativeAbortError(message.error)) {
                this.resetWorker("analysis", message.error);
            }
            return;
        }
        if (message.type === "SearchStyleFieldsResult") {
            this.handleStyleFieldsResult(message);
            if (this.isNativeAbortError(message.error)) {
                this.resetWorker("analysis", message.error);
            }
            return;
        }
        this.handleQueryDiagnosticsResult(message);
        if (this.isNativeAbortError(message.error)) {
            this.resetWorker("analysis", message.error);
        }
    }

    /** Resolves one pending concrete-scope analysis request. */
    private handleScopeAnalysisResult(message: SearchScopeAnalysisResultMessage): void {
        const pending = this.pendingScopeAnalysis.get(message.requestId);
        if (!pending) {
            return;
        }
        this.pendingScopeAnalysis.delete(message.requestId);
        pending.resolve({
            signature: pending.signature,
            concreteScope: message.concreteScope,
            attributeScopes: message.attributeScopes,
            inferredMapLayers: message.inferredMapLayers,
            matchedFieldNames: message.matchedFieldNames,
            matchedEnumValues: message.matchedEnumValues,
            ...(message.error ? {error: message.error} : {})
        });
    }

    /** Resolves one pending style-field enumeration request. */
    private handleStyleFieldsResult(message: SearchStyleFieldsResultMessage): void {
        const pending = this.pendingStyleFields.get(message.requestId);
        if (!pending) {
            return;
        }
        this.pendingStyleFields.delete(message.requestId);
        if (!message.error) {
            this.searchStyleFieldsByQueryCache.set(pending.cacheKey, message.fields);
        } else {
            console.warn("Failed to enumerate feature-search style fields from schema worker.", message.error);
        }
        pending.resolve(message.fields);
    }

    /** Resolves one pending schema-AST diagnostics request. */
    private handleQueryDiagnosticsResult(message: SearchQueryDiagnosticsResultMessage): void {
        const pending = this.pendingQueryDiagnostics.get(message.requestId);
        if (!pending) {
            return;
        }
        this.pendingQueryDiagnostics.delete(message.requestId);
        if (!message.error) {
            this.searchAstDiagnosticsByQueryCache.set(pending.cacheKey, message.diagnostics);
        } else {
            console.warn("Failed to build schema AST diagnostics from schema worker.", message.error);
        }
        pending.resolve(message.diagnostics);
    }

    /** Returns the unique key for one completion owner/serial pair. */
    private completionHandlerKey(ownerId: string, requestSerial: number): string {
        return `${ownerId}\u0000${requestSerial}`;
    }

    /** Returns true for Emscripten aborts, after which the worker runtime cannot be trusted. */
    private isNativeAbortError(message: string | undefined): boolean {
        return typeof message === "string" && /\bAborted\b|abort\(/i.test(message);
    }

    /** Terminates one worker lane and resolves requests that can no longer complete. */
    private resetWorker(kind: SchemaWorkerKind, message = "Schema worker failed."): void {
        const state = this.workerStates[kind];
        state.worker?.terminate();
        state.worker = null;
        state.dataSourceInfoJson = undefined;
        this.resolvePendingWorkerRequestsAfterFailure(kind, message);
    }

    /** Resolves outstanding async requests conservatively after one worker lane failed. */
    private resolvePendingWorkerRequestsAfterFailure(kind: SchemaWorkerKind, message: string): void {
        if (kind === "completion") {
            for (const [key, handler] of this.pendingCompletionHandlers) {
                const [ownerId, serialValue] = key.split("\u0000");
                this.pendingCompletionHandlers.delete(key);
                handler({
                    type: "SearchCompletionResult",
                    ownerId: ownerId ?? "",
                    requestSerial: Number(serialValue ?? 0),
                    candidates: [],
                    done: true,
                    error: message
                });
            }
            return;
        }

        for (const [requestId, pending] of this.pendingScopeAnalysis) {
            this.pendingScopeAnalysis.delete(requestId);
            pending.resolve({
                signature: pending.signature,
                concreteScope: "feature",
                attributeScopes: [],
                inferredMapLayers: [],
                matchedFieldNames: [],
                matchedEnumValues: [],
                error: message
            });
        }
        for (const [requestId, pending] of this.pendingStyleFields) {
            this.pendingStyleFields.delete(requestId);
            pending.resolve([]);
        }
        for (const [requestId, pending] of this.pendingQueryDiagnostics) {
            this.pendingQueryDiagnostics.delete(requestId);
            pending.resolve([]);
        }
    }
}
