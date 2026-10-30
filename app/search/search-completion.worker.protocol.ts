import type { FeatureSearchAttributeScopeCandidate, FeatureSearchStyleFieldCandidate } from "./search.model";
import type {FeatureSearchMapLayerRef, FeatureSearchScope} from "./search-definition.model";
import type {CompletionCandidate} from "./search.model";
import type {MapSchemaArtifact} from "../mapdata/source-catalog.model";

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
    requestId: number;
    dataSourceInfoJson: string | null;
    schemas: MapSchemaArtifact[];
}

/** Native installation acknowledgement; dependent queries remain queued until this arrives. */
export interface SearchCompletionDataSourceInfoReady {
    type: "SearchCompletionDataSourceInfoReady";
    requestId: number;
    error?: string;
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

export type SearchCompletionWorkerInboundMessage =
    SearchCompletionDataSourceInfoMessage |
    SearchCompletionRequestMessage |
    SearchScopeAnalysisRequestMessage |
    SearchStyleFieldsRequestMessage;

export type SearchCompletionWorkerOutboundMessage =
    SearchCompletionDataSourceInfoReady |
    SearchCompletionResultMessage |
    SearchScopeAnalysisResultMessage |
    SearchStyleFieldsResultMessage;
