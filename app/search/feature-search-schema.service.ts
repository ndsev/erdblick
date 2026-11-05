import { Injectable } from "@angular/core";
import { BehaviorSubject, type Subscription } from "rxjs";
import { MapDataService } from "../mapdata/mapdata.service";
import type {
    SearchCompletionDataSourceInfoMessage,
    SearchCompletionRequestMessage,
    SearchCompletionResultMessage,
    SearchCompletionWorkerOptions,
    SearchCompletionWorkerOutboundMessage,
    SearchScopeAnalysisRequestMessage,
    SearchScopeAnalysisResultMessage,
    SearchStyleFieldsRequestMessage,
    SearchStyleFieldsResultMessage
} from "./search-completion.worker.protocol";
import type { FeatureSearchMapLayerRef, FeatureSearchScope } from "./search-definition.model";
import type { CompletionOwnerState, FeatureSearchCompletionOptions } from "./search-session.model";
import type { CompletionCandidate } from "./search.model";
import { FeatureSearchAttributeScopeCandidate, FeatureSearchStyleFieldCandidate } from "./search.model";

export interface FeatureSearchScopeAnalysis {
    signature: string;
    concreteScope: "feature" | "attribute";
    normalizedQuery: string;
    attributeScopes: FeatureSearchAttributeScopeCandidate[];
    attributeScopeCandidateCount: number;
    rewriteSuppressed: boolean;
    rewriteSuppressionReason: string;
    inferredMapLayers: FeatureSearchMapLayerRef[];
    matchedFieldNames: string[];
    matchedEnumValues: string[];
    matchedFeatureTypes: string[];
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
 * The service deliberately owns the query-result caches instead of MapDataService:
 * datasource metadata still lives on the shared parser, while search-specific interpretation stays here.
 */
@Injectable({providedIn: "root"})
export class FeatureSearchSchemaService {

    private static readonly DEFAULT_COMPLETION_OWNER_ID = "omnibox";

    private readonly completionStates = new Map<string, CompletionOwnerState>();

    private readonly completionTimers = new Map<string, ReturnType<typeof setTimeout>>();

    readonly completionCandidates = this.completionStateForOwner(FeatureSearchSchemaService.DEFAULT_COMPLETION_OWNER_ID).candidates;

    readonly completionPending = this.completionStateForOwner(FeatureSearchSchemaService.DEFAULT_COMPLETION_OWNER_ID).pending;

    completionCandidateLimit: number = 15;

    /** Returns the completion stream pair owned by one input surface. */
    public completionStateForOwner(ownerId: string): CompletionOwnerState {
        const normalizedOwnerId = ownerId || FeatureSearchSchemaService.DEFAULT_COMPLETION_OWNER_ID;
        let state = this.completionStates.get(normalizedOwnerId);
        if (!state) {
            state = {
                candidates: new BehaviorSubject<CompletionCandidate[]>([]),
                pending: new BehaviorSubject<boolean>(false),
                candidateList: [],
                requestSerial: 0
            };
            this.completionStates.set(normalizedOwnerId, state);
        }
        return state;
    }

    /**
     * Clears the currently shown completion list for one input surface.
     */
    public clearCurrentCompletion(ownerId: string = FeatureSearchSchemaService.DEFAULT_COMPLETION_OWNER_ID) {
        const normalizedOwnerId = ownerId || FeatureSearchSchemaService.DEFAULT_COMPLETION_OWNER_ID;
        this.cancelPendingCompletion(normalizedOwnerId);
        const state = this.completionStateForOwner(normalizedOwnerId);
        state.requestSerial++;
        state.candidateList = [];
        state.pending.next(false);
        state.candidates.next([]);
    }

    /**
     * Completes a query for the legacy omnibox owner.
     */
    public completeQuery(query: string, point: number | undefined) {
        // The omnibox is global by design: it should see every schema, not only the active map-layer subset.
        this.completeQueryForOwner(FeatureSearchSchemaService.DEFAULT_COMPLETION_OWNER_ID, query, point);
    }

    /** Returns whether completion already contains the exact current query as a valid candidate. */
    public hasExactCompletionCandidate(
        query: string,
        ownerId: string = FeatureSearchSchemaService.DEFAULT_COMPLETION_OWNER_ID
    ): boolean {
        const trimmedQuery = query.trim();
        const state = this.completionStateForOwner(ownerId);
        return state.candidateList.some(candidate => candidate.query.trim() === trimmedQuery);
    }

    /**
     * Completes a query from schema metadata. Datasources without feature-model schema provide no candidates.
     */
    public completeQueryForOwner(
        ownerId: string,
        query: string,
        point: number | undefined,
        options: FeatureSearchCompletionOptions = {}
    ) {
        const normalizedOwnerId = ownerId || FeatureSearchSchemaService.DEFAULT_COMPLETION_OWNER_ID;
        this.cancelPendingCompletion(normalizedOwnerId);
        const state = this.completionStateForOwner(normalizedOwnerId);
        const requestSerial = ++state.requestSerial;
        const caret = point ?? query.length;
        state.candidateList = [];
        state.candidates.next([]);
        state.pending.next(true);
        const timer = setTimeout(() => {
            this.completionTimers.delete(normalizedOwnerId);
            const currentState = this.completionStateForOwner(normalizedOwnerId);
            if (currentState.requestSerial !== requestSerial) {
                return;
            }
            if (this.requestWorkerCompletion(normalizedOwnerId, requestSerial, query, caret, options)) {
                return;
            }
            currentState.pending.next(false);
            currentState.candidates.next([]);
        }, 0);
        this.completionTimers.set(normalizedOwnerId, timer);
    }

    /** Sends one completion request to the schema worker, returning false when completion is unavailable. */
    private requestWorkerCompletion(
        ownerId: string,
        requestSerial: number,
        query: string,
        point: number,
        options: FeatureSearchCompletionOptions
    ): boolean {
        const message: SearchCompletionRequestMessage = {
            type: "SearchCompletionRequest",
            ownerId,
            requestSerial,
            query,
            point,
            options: this.completionWorkerOptions(options)
        };
        return this.requestCompletion(
            message,
            result => this.handleCompletionWorkerMessage(result)
        );
    }

    /** Applies a worker completion result if it still matches the owner's latest request serial. */
    private handleCompletionWorkerMessage(message: SearchCompletionResultMessage): void {
        const state = this.completionStateForOwner(message.ownerId);
        if (state.requestSerial !== message.requestSerial) {
            return;
        }
        if (message.error) {
            console.warn("Schema completion worker failed to complete a query.", message.error);
        }
        if (message.candidates.length > 0) {
            state.candidateList = this.mergeCompletionCandidates(state.candidateList, message.candidates);
            state.candidates.next(state.candidateList);
        }
        if (message.done) {
            state.pending.next(false);
            if (message.candidates.length === 0) {
                state.candidates.next(state.candidateList);
            }
        }
    }

    /** Adds streamed candidate batches while preserving stable order and removing cross-layer duplicates. */
    private mergeCompletionCandidates(
        currentCandidates: CompletionCandidate[],
        nextCandidates: CompletionCandidate[]
    ): CompletionCandidate[] {
        const merged = [...currentCandidates];
        const indexByKey = new Map(currentCandidates.map((candidate, index) => [
            this.completionCandidateKey(candidate),
            index
        ]));
        for (const candidate of nextCandidates) {
            const key = this.completionCandidateKey(candidate);
            const existingIndex = indexByKey.get(key);
            if (existingIndex !== undefined) {
                merged[existingIndex] = this.mergeCompletionCandidateOrigins(merged[existingIndex]!, candidate);
                continue;
            }
            if (merged.length >= this.completionCandidateLimit) {
                continue;
            }
            indexByKey.set(key, merged.length);
            merged.push(candidate);
        }
        return merged;
    }

    /** Preserves all schema origins when identical completion text is produced by multiple layers. */
    private mergeCompletionCandidateOrigins(
        currentCandidate: CompletionCandidate,
        nextCandidate: CompletionCandidate
    ): CompletionCandidate {
        const originLayers = this.mergeCompletionOriginLayers(
            currentCandidate.originLayers ?? [],
            nextCandidate.originLayers ?? []
        );
        return originLayers.length
            ? { ...currentCandidate, originLayers }
            : currentCandidate;
    }

    /** Returns unique completion-origin layers in first-seen order. */
    private mergeCompletionOriginLayers(
        currentLayers: FeatureSearchMapLayerRef[],
        nextLayers: FeatureSearchMapLayerRef[]
    ): FeatureSearchMapLayerRef[] {
        const result: FeatureSearchMapLayerRef[] = [];
        const seen = new Set<string>();
        for (const layer of [...currentLayers, ...nextLayers]) {
            const key = JSON.stringify([layer.mapId, layer.layerId]);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            result.push(layer);
        }
        return result;
    }

    /** Builds a de-duplication key for completion candidates streamed from multiple schema contexts. */
    private completionCandidateKey(candidate: CompletionCandidate): string {
        return `${candidate.query}\u0000${candidate.begin}\u0000${candidate.end}\u0000${candidate.kind}\u0000${candidate.hint}`;
    }

    /** Converts UI completion options into the worker/native option shape. */
    private completionWorkerOptions(options: FeatureSearchCompletionOptions): SearchCompletionWorkerOptions {
        return {
            limit: this.completionCandidateLimit,
            timeoutMs: options.timeoutMs ?? 35,
            ...(options.scope ? { scope: options.scope } : {}),
            ...(options.selectedMapLayers !== undefined ? { selectedMapLayers: options.selectedMapLayers } : {})
        };
    }

    /** Cancels a deferred completion computation that has not started yet. */
    private cancelPendingCompletion(ownerId: string): void {
        const timer = this.completionTimers.get(ownerId);
        if (!timer) {
            return;
        }
        clearTimeout(timer);
        this.completionTimers.delete(ownerId);
    }
    private readonly catalogSubscription: Subscription;
    private destroyed = false;

    private searchStyleFieldsByQueryCache = new Map<string, FeatureSearchStyleFieldCandidate[]>();
    private readonly pendingCompletionHandlers = new Map<string, (message: SearchCompletionResultMessage) => void>();
    private readonly pendingScopeAnalysis = new Map<number, {
        resolve: (value: FeatureSearchScopeAnalysis) => void;
        signature: string;
    }>();
    private readonly pendingStyleFields = new Map<number, {
        resolve: (value: FeatureSearchStyleFieldCandidate[]) => void;
        cacheKey: string;
    }>();
    private scopeAnalysisByQueryCache = new Map<string, Promise<FeatureSearchScopeAnalysis>>();
    private readonly workerStates: Record<SchemaWorkerKind, SchemaWorkerState> = {
        completion: {worker: null, failed: false, dataSourceInfoJson: undefined},
        analysis: {worker: null, failed: false, dataSourceInfoJson: undefined}
    };
    private workerRequestSerial = 0;

    constructor(private readonly mapInfo: MapDataService) {
        this.catalogSubscription = this.mapInfo.layerStateChanged.subscribe(reason => {
            if (reason === "datasources") {
                this.clearCaches();
                this.syncAllWorkerDataSourceInfo();
            }
        });
    }

    /** Cancels both lanes and owner timers when the application injector is retired. */
    ngOnDestroy(): void {
        this.destroyed = true;
        this.catalogSubscription.unsubscribe();
        for (const timer of this.completionTimers.values()) clearTimeout(timer);
        this.completionTimers.clear();
        this.resetWorker("completion", "Search completion owner was destroyed.");
        this.resetWorker("analysis", "Search schema owner was destroyed.");
        for (const state of this.completionStates.values()) {
            state.candidates.complete();
            state.pending.complete();
        }
        this.completionStates.clear();
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
            normalizedQuery: "",
            attributeScopes: [],
            attributeScopeCandidateCount: 0,
            rewriteSuppressed: false,
            rewriteSuppressionReason: "",
            inferredMapLayers: [],
            matchedFieldNames: [],
            matchedEnumValues: [],
            matchedFeatureTypes: [],
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
        this.scopeAnalysisByQueryCache.clear();
    }

    /** Lazily creates an isolated schema-processing worker for one workload lane. */
    private schemaWorker(kind: SchemaWorkerKind): Worker | null {
        const state = this.workerStates[kind];
        if (this.destroyed || state.failed || typeof Worker === "undefined") {
            return null;
        }
        if (state.worker) {
            return state.worker;
        }
        try {
            const worker = new Worker(new URL("./search-completion.worker", import.meta.url), {
                type: "module"
            });
            worker.onmessage = (event: MessageEvent<SearchCompletionWorkerOutboundMessage>) => {
                this.handleWorkerMessage(event.data);
            };
            worker.onerror = (event) => {
                console.warn(`Schema ${kind} worker failed; recreating on the next request.`, event.message);
                this.resetWorker(kind, event.message);
            };
            state.worker = worker;
            return worker;
        } catch (error) {
            console.warn(
                `Failed to create schema ${kind} worker. Schema-backed search helpers are disabled.`,
                error
            );
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
            normalizedQuery: message.normalizedQuery,
            attributeScopes: message.attributeScopes,
            attributeScopeCandidateCount: message.attributeScopeCandidateCount,
            rewriteSuppressed: message.rewriteSuppressed,
            rewriteSuppressionReason: message.rewriteSuppressionReason,
            inferredMapLayers: message.inferredMapLayers,
            matchedFieldNames: message.matchedFieldNames,
            matchedEnumValues: message.matchedEnumValues,
            matchedFeatureTypes: message.matchedFeatureTypes,
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
                normalizedQuery: "",
                attributeScopes: [],
                attributeScopeCandidateCount: 0,
                rewriteSuppressed: false,
                rewriteSuppressionReason: "",
                inferredMapLayers: [],
                matchedFieldNames: [],
                matchedEnumValues: [],
                matchedFeatureTypes: [],
                error: message
            });
        }
        for (const [requestId, pending] of this.pendingStyleFields) {
            this.pendingStyleFields.delete(requestId);
            pending.resolve([]);
        }
    }
}
