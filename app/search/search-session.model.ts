import type { BehaviorSubject } from "rxjs";
import type { FeatureSearchResolvedDefinition } from "./feature-search-runtime-state.model";
import type { FeatureSearchRenderStrategy } from "./search-definition.model";
import type { FeatureSearchMapLayerRef, FeatureSearchScope, FeatureSearchStateEntry } from "./search-definition.model";
import type {
    SearchResultDensity,
    SearchResultPoint,
    SearchResultPointBucket,
    SearchResultsSnapshot
} from "./search-results.model";
import type { CompletionCandidate, FeatureSearchAttributeScopeCandidate } from "./search.model";

export interface FeatureSearchOverlayLayer {
    id: string;
    pointsVersion: number;
    pointColor: string;
    pointColorRgba: [number, number, number, number];
    selectedViewIndices: number[];
    renderStrategy: FeatureSearchRenderStrategy;
    styleRuleCount: number;
    pointBuckets: SearchResultPointBucket[];
    densityIndex: Pick<SearchResultDensity, "isEmpty" | "materialize">;
}

export interface FeatureSearchResultLayer extends FeatureSearchOverlayLayer {
    points: SearchResultPoint[];
}

export interface CompletionOwnerState {
    candidates: BehaviorSubject<CompletionCandidate[]>;
    pending: BehaviorSubject<boolean>;
    candidateList: CompletionCandidate[];
    requestSerial: number;
}

export interface FeatureSearchCompletionOptions {
    scope?: FeatureSearchScope;
    selectedMapLayers?: FeatureSearchMapLayerRef[];
    timeoutMs?: number;
}

export interface FeatureSearchActionPayload {
    selectedMapLayers: FeatureSearchMapLayerRef[];
    selectedViewIndices?: number[];
    selectedMapLayersManual?: boolean;
}

/** Extracts a compact feature-search payload from a schema completion candidate. */
export function featureSearchActionPayloadFromCompletion(
    candidate: CompletionCandidate | null | undefined
): FeatureSearchActionPayload | undefined {
    const selectedMapLayers = uniqueFeatureSearchMapLayers(candidate?.originLayers ?? []);
    return selectedMapLayers.length ? { selectedMapLayers } : undefined;
}

/** Extracts selected map/layers from a persisted or transient feature-search action payload. */
export function featureSearchSelectedMapLayersFromPayload(payload: unknown): FeatureSearchMapLayerRef[] | undefined {
    const record = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
    const selectedMapLayers = Array.isArray(record?.["selectedMapLayers"])
        ? record["selectedMapLayers"]
        : [];
    const result = uniqueFeatureSearchMapLayers(selectedMapLayers.flatMap(item => {
        const raw = item && typeof item === "object" && !Array.isArray(item)
            ? item as Record<string, unknown>
            : null;
        const mapId = typeof raw?.["mapId"] === "string" ? raw["mapId"] : "";
        const layerId = typeof raw?.["layerId"] === "string" ? raw["layerId"] : "";
        return mapId && layerId ? [{ mapId, layerId }] : [];
    }));
    return result.length ? result : undefined;
}

/** Extracts selected result views from a persisted or transient feature-search action payload. */
export function featureSearchSelectedViewIndicesFromPayload(payload: unknown): number[] | undefined {
    const record = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
    const selectedViewIndices = Array.isArray(record?.["selectedViewIndices"])
        ? record["selectedViewIndices"]
        : [];
    const seen = new Set<number>();
    const result: number[] = [];
    for (const item of selectedViewIndices) {
        const viewIndex = Number(item);
        if (!Number.isInteger(viewIndex) || viewIndex < 0 || viewIndex >= 32
            || seen.has(viewIndex)) {
            continue;
        }
        seen.add(viewIndex);
        result.push(viewIndex);
    }
    return result.length ? result.sort((lhs, rhs) => lhs - rhs) : undefined;
}

export interface FeatureSearchExportGroupingOption {
    id: number;
    name: string;
}

export interface FeatureSearchExportDialogRequest {
    searchId: string;
    includeConfiguration: boolean;
    includeResults: boolean;
    closeAfterExport: boolean;
    grouping: FeatureSearchExportGroupingOption[];
    filterValue: string;
}

export interface FeatureSearchExportDialogOptions {
    includeConfiguration?: boolean;
    includeResults?: boolean;
    closeAfterExport?: boolean;
    grouping?: FeatureSearchExportGroupingOption[];
    filterValue?: string;
}

export type FeatureSearchRunOptions = Partial<Pick<
    FeatureSearchStateEntry,
    "scope" | "selectedMapLayers" | "selectedViewIndices" | "selectedMapLayersManual" | "selectedFeatureTypes" | "autoUpdate" | "selectedTileLevels"
>>;

/** Returns unique feature-search map/layer refs in first-seen order. */
export function uniqueFeatureSearchMapLayers(refs: FeatureSearchMapLayerRef[]): FeatureSearchMapLayerRef[] {
    const result: FeatureSearchMapLayerRef[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
        const mapId = ref.mapId?.trim();
        const layerId = ref.layerId?.trim();
        const key = JSON.stringify([mapId, layerId]);
        if (!mapId || !layerId || seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push({ mapId, layerId });
    }
    return result;
}

export interface FeatureSearchSession {
    readonly results: SearchResultsSnapshot;
    id: string;
    layoutId: string;
    definition: FeatureSearchStateEntry;
    runId: string;
    refresh: number;
    paused: boolean;
    startTime: number;
    endTime: number;
    pointColor: string;
    timeElapsed: string;
    schemaAnalysis: FeatureSearchSessionSchemaAnalysis;
    lastResolvedDefinition?: FeatureSearchResolvedDefinition;
    lastResolvedDefinitionSignature?: string;
}

export interface FeatureSearchSessionSchemaAnalysis {
    signature: string;
    status: "pending" | "ready" | "error";
    concreteScope: "feature" | "attribute";
    normalizedQuery: string;
    attributeScopes: FeatureSearchAttributeScopeCandidate[];
    attributeScopeCandidateCount: number;
    rewriteSuppressed: boolean;
    rewriteSuppressionReason: string;
    matchedFieldNames: string[];
    matchedEnumValues: string[];
    matchedFeatureTypes: string[];
    error?: string;
}

/** Returns whether a feature-search action payload represents explicit user map-layer scope. */
export function featureSearchMapLayersManualFromPayload(payload: unknown): boolean | undefined {
    const record = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
    return typeof record?.["selectedMapLayersManual"] === "boolean"
        ? record["selectedMapLayersManual"]
        : undefined;
}

