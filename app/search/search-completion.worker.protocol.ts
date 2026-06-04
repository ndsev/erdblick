import type {
    FeatureSearchAttributeScopeCandidate,
    FeatureSearchStyleFieldCandidate
} from "../mapdata/map-runtime.model";
import type {FeatureSearchMapLayerRef, FeatureSearchScope} from "../shared/feature-search-state";
import type {CompletionCandidate} from "./search.model";

/** Parser options needed by the schema-completion worker. */
export interface SearchCompletionWorkerOptions {
    limit: number;
    timeoutMs: number;
    scope?: FeatureSearchScope;
    selectedMapLayers?: FeatureSearchMapLayerRef[];
}

/** Refreshes the worker-local parser with the current `/sources` metadata. */
export interface SearchCompletionDataSourceInfoMessage {
    type: "SearchCompletionDataSourceInfo";
    dataSourceInfoJson: string | null;
}

/** Requests one schema-backed completion pass off the UI thread. */
export interface SearchCompletionRequestMessage {
    type: "SearchCompletionRequest";
    ownerId: string;
    requestSerial: number;
    query: string;
    point: number;
    options: SearchCompletionWorkerOptions;
}

/** Completion result emitted by the worker for the owning input surface. */
export interface SearchCompletionResultMessage {
    type: "SearchCompletionResult";
    ownerId: string;
    requestSerial: number;
    candidates: CompletionCandidate[];
    done: boolean;
    error?: string;
}

/** Requests concrete search-scope inference from the schema worker. */
export interface SearchScopeAnalysisRequestMessage {
    type: "SearchScopeAnalysisRequest";
    requestId: number;
    query: string;
    scope: FeatureSearchScope;
    selectedMapLayers?: FeatureSearchMapLayerRef[];
}

/** Result of schema-backed concrete scope inference. */
export interface SearchScopeAnalysisResultMessage {
    type: "SearchScopeAnalysisResult";
    requestId: number;
    concreteScope: "feature" | "attribute";
    attributeScopes: FeatureSearchAttributeScopeCandidate[];
    error?: string;
}

/** Requests schema-backed result field candidates for search visualization controls. */
export interface SearchStyleFieldsRequestMessage {
    type: "SearchStyleFieldsRequest";
    requestId: number;
    query: string;
    scope: FeatureSearchScope;
    selectedMapLayers?: FeatureSearchMapLayerRef[];
}

/** Result field candidates computed by the schema worker. */
export interface SearchStyleFieldsResultMessage {
    type: "SearchStyleFieldsResult";
    requestId: number;
    fields: FeatureSearchStyleFieldCandidate[];
    error?: string;
}

/** Schema-AST diagnostic shown in the feature-search Diagnostics tab. */
export interface SearchQueryDiagnosticMessage {
    query: string;
    message: string;
    location?: {offset: number, size: number};
    fix: null | string;
}

/** Requests schema-AST diagnostics for the Diagnostics tab. */
export interface SearchQueryDiagnosticsRequestMessage {
    type: "SearchQueryDiagnosticsRequest";
    requestId: number;
    query: string;
    scope: FeatureSearchScope;
    selectedMapLayers?: FeatureSearchMapLayerRef[];
}

/** Schema-AST diagnostics produced by the worker. */
export interface SearchQueryDiagnosticsResultMessage {
    type: "SearchQueryDiagnosticsResult";
    requestId: number;
    diagnostics: SearchQueryDiagnosticMessage[];
    error?: string;
}

export type SearchCompletionWorkerInboundMessage =
    SearchCompletionDataSourceInfoMessage |
    SearchCompletionRequestMessage |
    SearchScopeAnalysisRequestMessage |
    SearchStyleFieldsRequestMessage |
    SearchQueryDiagnosticsRequestMessage;

export type SearchCompletionWorkerOutboundMessage =
    SearchCompletionResultMessage |
    SearchScopeAnalysisResultMessage |
    SearchStyleFieldsResultMessage |
    SearchQueryDiagnosticsResultMessage;
