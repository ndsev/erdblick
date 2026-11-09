import type {PreparedSearchBranch} from "./search-preparation.model";
import { Injectable } from "@angular/core";
import { MapDataService } from "../mapdata/mapdata.service";
import type { FeatureSearchAttributeScopeCandidate, FeatureSearchStyleFieldInventory, FeatureSearchStyleFieldOptions } from "./search.model";
import type { FeatureSearchMapLayerRef, FeatureSearchScope } from "./search-definition.model";
import type {
    SearchCompletionDataSourceInfoMessage,
    SearchCompletionRequestMessage,
    SearchCompletionResultMessage,
    SearchCompletionWorkerOutboundMessage,
    SearchScopeAnalysisRequestMessage,
    SearchScopeAnalysisResultMessage,
    SearchStyleFieldsRequestMessage,
    SearchStyleFieldsResultMessage
} from "./search-completion.worker.protocol";

export interface FeatureSearchScopeAnalysis {
    signature: string;
    interpretations?: PreparedSearchBranch[];
    waitingForSchema?: boolean;
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
    /** Serializes installation plus its dependent query, keeping their source scope coherent. */
    queue: Promise<void>;
}

/**
 * Provides schema-backed feature-search helpers exposed by the native TileLayerParser.
 *
 * The service deliberately owns the query-result caches instead of MapDataService:
 * datasource metadata still lives on the shared parser, while search-specific interpretation stays here.
 */
@Injectable({providedIn: "root"})
export class FeatureSearchSchemaService {
    private readonly styleFieldInventories = new Map<string, Promise<FeatureSearchStyleFieldInventory>>();
    private readonly pendingCompletionHandlers = new Map<string, (message: SearchCompletionResultMessage) => void>();
    private readonly pendingScopeAnalysis = new Map<number, {
        resolve: (value: FeatureSearchScopeAnalysis) => void;
        signature: string;
    }>();
    private readonly pendingStyleFields = new Map<number, {
        resolve: (value: FeatureSearchStyleFieldInventory) => void;
        reject: (error: Error) => void;
        startedAt: number;
    }>();
    private scopeAnalysisByQueryCache = new Map<string, Promise<FeatureSearchScopeAnalysis>>();
    private readonly workerStates: Record<SchemaWorkerKind, SchemaWorkerState> = {
        completion: {worker: null, failed: false, dataSourceInfoJson: undefined, queue: Promise.resolve()},
        analysis: {worker: null, failed: false, dataSourceInfoJson: undefined, queue: Promise.resolve()}
    };
    private workerRequestSerial = 0;
    private readonly schemaInstallations = new Map<number, {
        kind: SchemaWorkerKind;
        resolve: () => void;
        reject: (error: Error) => void;
    }>();
    private readonly latestCompletionSerialByOwner = new Map<string, number>();

    constructor(private readonly mapInfo: MapDataService) {
        let catalogSignature = this.mapInfo.schemaScopeSignature();
        this.mapInfo.layerStateChanged.subscribe(reason => {
            if (reason === "datasources") {
                const nextSignature = this.mapInfo.schemaScopeSignature();
                if (nextSignature === catalogSignature) return;
                catalogSignature = nextSignature;
                this.clearCaches();
                // Each lane installs only the maps requested by its next query.
                // Existing requests use their own scope identity, so changes to
                // another map do not discard their work or restart a search.
            }
        });
    }

    /** Returns the stable signature used for schema-derived search analysis caches. */
    searchScopeAnalysisSignature(
        query: string,
        scope: FeatureSearchScope,
        selectedMapLayers?: FeatureSearchMapLayerRef[]
    ): string {
        const mapIds = selectedMapLayers?.map(layer => layer.mapId);
        return `${this.mapInfo.schemaScopeSignature(mapIds)}\n${scope}\n${this.selectedMapLayerSignature(selectedMapLayers)}\n${query.trim()}`;
    }

    /** Requests scope analysis only after its selected sources are installed in this worker. */
    requestSearchScopeAnalysis(
        query: string,
        scope: FeatureSearchScope,
        selectedMapLayers?: FeatureSearchMapLayerRef[],
        selectedFeatureTypes: string[] = []
    ): Promise<FeatureSearchScopeAnalysis> {
        const signature = this.searchScopeAnalysisSignature(query, scope, selectedMapLayers) + "\n" + JSON.stringify([...selectedFeatureTypes].sort());
        const cached = this.scopeAnalysisByQueryCache.get(signature);
        if (cached) return cached;
        const promise: Promise<FeatureSearchScopeAnalysis> = this.enqueueSchemaRequest("analysis", selectedMapLayers, worker =>
            new Promise<FeatureSearchScopeAnalysis>(resolve => {
                const requestId = ++this.workerRequestSerial;
                this.pendingScopeAnalysis.set(requestId, {resolve, signature});
                worker.postMessage({
                    type: "SearchScopeAnalysisRequest", requestId, query, scope, selectedFeatureTypes,
                    ...(selectedMapLayers !== undefined ? {selectedMapLayers} : {})
                } satisfies SearchScopeAnalysisRequestMessage);
            })
        ).catch(error => ({...this.workerUnavailableScopeAnalysis(signature, scope, String(error)),
            waitingForSchema: !!this.mapInfo.schemaReadinessError(selectedMapLayers?.map(layer => layer.mapId))})).then(result => {
            // A temporarily unavailable source can recover without changing its
            // model generation; failed analysis is never a reusable answer.
            if (result.error && this.scopeAnalysisByQueryCache.get(signature) === promise) {
                this.scopeAnalysisByQueryCache.delete(signature);
            }
            return result;
        });
        this.scopeAnalysisByQueryCache.set(signature, promise);
        return promise;
    }

    /** Failed or pending schema installation rejects, rather than claiming there are no fields. */
    requestSearchStyleFields(
        query: string,
        scope: FeatureSearchScope,
        selectedMapLayers?: FeatureSearchMapLayerRef[],
        options: FeatureSearchStyleFieldOptions = {values: "scalar"}
    ): Promise<FeatureSearchStyleFieldInventory> {
        const normalized = {
            values: options.values ?? "scalar",
            recursive: options.recursive ?? true,
            path: options.path ?? [],
            selectedFeatureTypes: [...new Set(options.selectedFeatureTypes ?? [])].sort(),
            ...(options.context ? {context: options.context} : {}),
            ...(options.preparedContexts ? {preparedContexts: options.preparedContexts} : {})
        };
        const cacheKey = this.searchScopeAnalysisSignature(scope === "feature" ? "" : query, scope, selectedMapLayers)
            + "\n" + JSON.stringify(normalized);
        const cached = this.styleFieldInventories.get(cacheKey);
        if (cached) return cached;
        const startedAt = performance.now();
        const promise = this.enqueueSchemaRequest("analysis", selectedMapLayers, worker =>
            new Promise<FeatureSearchStyleFieldInventory>((resolve, reject) => {
                const requestId = ++this.workerRequestSerial;
                this.pendingStyleFields.set(requestId, {resolve, reject, startedAt});
                worker.postMessage({
                    type: "SearchStyleFieldsRequest", requestId, query, scope, options: normalized,
                    ...(selectedMapLayers !== undefined ? {selectedMapLayers} : {})
                } satisfies SearchStyleFieldsRequestMessage);
            })
        ).catch(error => {
            if (this.styleFieldInventories.get(cacheKey) === promise)
                this.styleFieldInventories.delete(cacheKey);
            throw error;
        });
        // Coalesce concurrent consumers, but do not retain every branch visited
        // during a long session. Eviction does not cancel an active consumer.
        this.styleFieldInventories.set(cacheKey, promise);
        if (this.styleFieldInventories.size > 32)
            this.styleFieldInventories.delete(this.styleFieldInventories.keys().next().value!);
        return promise;
    }

    /**
     * Browse the accepted owners together, without re-inferring their query.
     * One request shares metadata across maps and keeps the worker's installed
     * schema set stable; per-owner requests repeatedly replaced that set.
     */
    async requestPreparedSearchStyleFields(
        branches: readonly PreparedSearchBranch[], options: FeatureSearchStyleFieldOptions
    ): Promise<FeatureSearchStyleFieldInventory> {
        const attributeBranches = branches.filter(branch => branch.scope === "attribute" && branch.attributeScopes.length);
        const featureBranches = branches.filter(branch => branch.scope === "feature");
        const owners = [...new Map(attributeBranches.flatMap(branch => branch.attributeScopes)
            .map(owner => [JSON.stringify(owner), owner])).values()];
        const requests: Promise<FeatureSearchStyleFieldInventory>[] = [];
        if (attributeBranches.length) {
            const layers = attributeBranches.map(({mapId, layerId}) => ({mapId, layerId}));
            requests.push(this.requestSearchStyleFields("", "attribute", layers, {...options, preparedContexts: owners}));
        }
        if (featureBranches.length) {
            const layers = featureBranches.map(({mapId, layerId}) => ({mapId, layerId}));
            requests.push(this.requestSearchStyleFields("", "feature", layers, options));
        }
        // Explicit attribute expressions without resolved owners still need
        // native normalization; an empty owner list is not the entire layer.
        for (const branch of branches.filter(branch => branch.scope === "attribute" && !branch.attributeScopes.length)) {
            requests.push(this.requestSearchStyleFields(branch.query, branch.scope,
                [{mapId: branch.mapId, layerId: branch.layerId}], options));
        }
        const inventories = await Promise.all(requests);
        const result: FeatureSearchStyleFieldInventory = {
            contexts: [], types: [], fields: [], branches: [], complete: true, incompleteReason: ""
        };
        for (const inventory of inventories) {
            const contextOffset = result.contexts.length, typeOffset = result.types.length;
            result.contexts.push(...inventory.contexts);
            result.types.push(...inventory.types);
            result.fields.push(...inventory.fields.map(field => ({...field, metadata: field.metadata + typeOffset,
                contexts: field.contexts.map(index => index + contextOffset)})));
            result.branches.push(...inventory.branches.map(branch => ({...branch,
                contexts: branch.contexts.map(index => index + contextOffset)})));
            result.complete &&= inventory.complete;
            if (inventory.incompleteReason) result.incompleteReason = inventory.incompleteReason;
        }
        return result;
    }

    /** Queues completion behind native installation, superseding older queued input from the same owner. */
    requestCompletion(
        message: SearchCompletionRequestMessage,
        handler: (message: SearchCompletionResultMessage) => void
    ): boolean {
        if (!this.schemaWorker("completion")) return false;
        this.cancelCompletion(message.ownerId);
        this.latestCompletionSerialByOwner.set(message.ownerId, message.requestSerial);
        void this.enqueueSchemaRequest("completion", message.options.selectedMapLayers, (worker, isCurrent) =>
            new Promise<void>(resolve => {
                if (this.latestCompletionSerialByOwner.get(message.ownerId) !== message.requestSerial) {
                    handler({ type: "SearchCompletionResult", ownerId: message.ownerId,
                        requestSerial: message.requestSerial, candidates: [], done: true });
                    resolve();
                    return;
                }
                this.pendingCompletionHandlers.set(
                    this.completionHandlerKey(message.ownerId, message.requestSerial), result => {
                        if (isCurrent() && this.latestCompletionSerialByOwner.get(message.ownerId) === message.requestSerial) {
                            handler(result);
                        }
                        if (result.done) resolve();
                    }
                );
                worker.postMessage(message);
            })
        ).catch(error => handler({
            type: "SearchCompletionResult", ownerId: message.ownerId,
            requestSerial: message.requestSerial, candidates: [], done: true, error: String(error)
        }));
        return true;
    }

    /**
     * Stop obsolete prefixes at the worker's next context boundary. Merely
     * ignoring their replies leaves newer typing queued behind the entire scan.
     * The worker's final acknowledgement releases the serialized schema lane.
     */
    cancelCompletion(ownerId: string): void {
        this.latestCompletionSerialByOwner.delete(ownerId);
        this.workerStates.completion.worker?.postMessage({type: "SearchCompletionCancel", ownerId});
    }

    /**
     * Keeps configuration and execution adjacent in one worker lane. Otherwise
     * concurrent requests for two source scopes could replace each other's parser
     * between the installation acknowledgement and the actual native query.
     */
    private enqueueSchemaRequest<T>(
        kind: SchemaWorkerKind,
        selectedMapLayers: FeatureSearchMapLayerRef[] | undefined,
        execute: (worker: Worker, isCurrent: () => boolean) => Promise<T>
    ): Promise<T> {
        const state = this.workerStates[kind];
        const mapIds = selectedMapLayers === undefined
            ? undefined : [...new Set(selectedMapLayers.map(layer => layer.mapId))];
        const signature = this.mapInfo.schemaScopeSignature(mapIds);
        const isCurrent = () => signature === this.mapInfo.schemaScopeSignature(mapIds);
        const assertCurrent = () => {
            if (!isCurrent()) throw new Error("Datasource schema changed while this request was pending. Please retry.");
        };
        const request = state.queue.then(async () => {
            assertCurrent();
            const worker = this.schemaWorker(kind);
            if (!worker) throw new Error(`Schema ${kind} worker is unavailable.`);
            const unavailable = this.mapInfo.schemaReadinessError(mapIds);
            if (unavailable) throw new Error(unavailable);
            await this.syncWorkerDataSourceInfo(kind, mapIds);
            assertCurrent();
            const result = await execute(worker, isCurrent);
            assertCurrent();
            return result;
        });
        state.queue = request.then(() => undefined, () => undefined);
        return request;
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
        this.styleFieldInventories.clear();
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

    /** Installs only this query's source scope and awaits actual native validation. */
    private async syncWorkerDataSourceInfo(kind: SchemaWorkerKind, mapIds?: string[]): Promise<void> {
        const state = this.workerStates[kind];
        const worker = state.worker;
        if (!worker) throw new Error("Schema worker is unavailable.");
        const dataSourceInfoJson = this.mapInfo.getDataSourceInfoJson(mapIds);
        if (dataSourceInfoJson === state.dataSourceInfoJson) return;
        const requestId = ++this.workerRequestSerial;
        await new Promise<void>((resolve, reject) => {
            this.schemaInstallations.set(requestId, {kind, resolve, reject});
            try {
                worker.postMessage({
                    type: "SearchCompletionDataSourceInfo", requestId, dataSourceInfoJson,
                    schemas: this.mapInfo.getSchemaArtifacts(mapIds)
                } satisfies SearchCompletionDataSourceInfoMessage);
            } catch (error) {
                this.schemaInstallations.delete(requestId);
                reject(error);
            }
        });
        state.dataSourceInfoJson = dataSourceInfoJson;
    }

    /** Routes worker messages to the pending request that owns them. */
    private handleWorkerMessage(message: SearchCompletionWorkerOutboundMessage): void {
        if (message.type === "SearchCompletionDataSourceInfoReady") {
            const pending = this.schemaInstallations.get(message.requestId);
            this.schemaInstallations.delete(message.requestId);
            if (message.error) pending?.reject(new Error(message.error));
            else pending?.resolve();
            return;
        }
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
            interpretations: message.interpretations,
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
        if (!message.error && message.inventory) {
            const receivedAt = performance.now();
            if (message.timing) {
                performance.clearMeasures("erdblick.search.style-fields.worker");
                performance.measure("erdblick.search.style-fields.worker", {
                    start: pending.startedAt, end: receivedAt,
                    detail: {
                        ...message.timing,
                        // Includes structured cloning and event-queue delay;
                        // this is observed delivery latency, not isolated CPU.
                        deliveryMs: performance.timeOrigin + receivedAt - message.timing.postedAt,
                        fields: message.inventory.fields.length,
                        types: message.inventory.types.length,
                        contexts: message.inventory.contexts.length,
                        complete: message.inventory.complete
                    }
                });
            }
            pending.resolve(message.inventory);
        } else {
            pending.reject(new Error(message.error ?? "Schema worker returned no field inventory."));
        }
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
        for (const [id, pending] of this.schemaInstallations) {
            if (pending.kind !== kind) continue;
            this.schemaInstallations.delete(id);
            pending.reject(new Error(message));
        }
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
            pending.reject(new Error(message));
        }
    }
}
