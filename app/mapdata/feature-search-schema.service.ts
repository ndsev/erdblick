import {Injectable} from "@angular/core";
import {
    FeatureSearchAttributeScopeCandidate,
    FeatureSearchStyleFieldCandidate
} from "./map-runtime.model";
import {MapInfoService} from "./map-info.service";
import type {FeatureSearchScope, FeatureSearchStateEntry} from "../shared/feature-search-state";

export interface FeatureSearchDiagnosticMessage {
    query: string;
    message: string;
    location?: {offset: number, size: number};
    fix: null | string;
}

/**
 * Provides schema-backed feature-search helpers exposed by the native TileLayerParser.
 *
 * The service deliberately owns the query-result caches instead of MapInfoService:
 * datasource metadata still lives on the shared parser, while search-specific interpretation stays here.
 */
@Injectable({providedIn: "root"})
export class FeatureSearchSchemaService {
    private attributeScopesByQueryCache = new Map<string, FeatureSearchAttributeScopeCandidate[]>();
    private searchStyleFieldsByQueryCache = new Map<string, FeatureSearchStyleFieldCandidate[]>();
    private searchAstDiagnosticsByQueryCache = new Map<string, FeatureSearchDiagnosticMessage[]>();

    constructor(private readonly mapInfo: MapInfoService) {
        this.mapInfo.layerStateChanged.subscribe(reason => {
            if (reason === "datasources") {
                this.clearCaches();
            }
        });
    }

    /** Returns schema-backed attribute contexts matching a search query. */
    getAttributeScopeForQuery(query: string): FeatureSearchAttributeScopeCandidate[] {
        const cacheKey = query.trim();
        const cached = this.attributeScopesByQueryCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        try {
            const candidates = this.mapInfo.tileLayerParser.getAttributeScopeForQuery(query);
            const normalized = this.normalizeAttributeScopeCandidates(candidates);
            this.attributeScopesByQueryCache.set(cacheKey, normalized);
            return normalized;
        } catch (error) {
            console.warn("Failed to infer feature-search attribute scope from schema metadata.", error);
            return [];
        }
    }

    /** Returns schema-backed field expressions available to search-result style rules. */
    searchStyleFieldsForQuery(query: string, scope: FeatureSearchScope): FeatureSearchStyleFieldCandidate[] {
        const cacheKey = `${scope}\n${query.trim()}`;
        const cached = this.searchStyleFieldsByQueryCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        try {
            const candidates = this.mapInfo.tileLayerParser.searchStyleFieldsForQuery(query, scope);
            const normalized = this.normalizeSearchStyleFieldCandidates(candidates);
            this.searchStyleFieldsByQueryCache.set(cacheKey, normalized);
            return normalized;
        } catch (error) {
            console.warn("Failed to enumerate feature-search style fields from schema metadata.", error);
            return [];
        }
    }

    /** Uses the schema-aware native parser to keep auto scope aligned with completion. */
    isAttributeScopeSearchQuery(query: string): boolean {
        try {
            return this.mapInfo.tileLayerParser.isAttributeScopeSearchQuery(query);
        } catch (error) {
            console.warn("Failed to infer feature-search scope from schema metadata.", error);
            return false;
        }
    }

    /** Resolves persisted search scope state to the concrete token expected by mapget. */
    resolveSearchScope(definition: Pick<FeatureSearchStateEntry, "query" | "scope">): "feature" | "attribute" {
        if (definition.scope === "feature" || definition.scope === "attribute") {
            return definition.scope;
        }
        return this.isAttributeScopeSearchQuery(definition.query) ? "attribute" : "feature";
    }

    /**
     * Converts schema-backed search shorthand into the predicate mapget evaluates.
     *
     * A bare attribute code such as `WARNING_SIGN` is user-facing shorthand. In attribute
     * search, mapget evaluates each attribute object as the root, where the equivalent
     * backend filter is the attribute name predicate.
     */
    resolveBackendQuery(definition: Pick<FeatureSearchStateEntry, "query" | "scope">): string {
        if (this.resolveSearchScope(definition) !== "attribute" || !this.isBareSearchIdentifier(definition.query)) {
            return definition.query;
        }

        const queryIdentifier = definition.query.trim();
        const attributeNames = Array.from(new Set(
            this.getAttributeScopeForQuery(definition.query)
                .map(scope => scope.attrName)
                .filter(attrName => attrName === queryIdentifier)
        )).sort();
        if (attributeNames.length === 0) {
            return definition.query;
        }

        return attributeNames
            .map(attrName => `$name == ${JSON.stringify(attrName)}`)
            .join(" or ");
    }

    /** Builds debug diagnostics for the schema-aware ASTs used by auto-scope and style-field inference. */
    searchQueryAstDiagnostics(query: string, scope: FeatureSearchScope): FeatureSearchDiagnosticMessage[] {
        const cacheKey = `${scope}\n${query.trim()}`;
        const cached = this.searchAstDiagnosticsByQueryCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        try {
            const rawMessages = this.mapInfo.tileLayerParser.searchQueryAstDiagnostics(query, scope);
            if (!Array.isArray(rawMessages)) {
                return [];
            }
            const normalized = rawMessages.flatMap(message => this.toDiagnosticsMessage(query, message));
            this.searchAstDiagnosticsByQueryCache.set(cacheKey, normalized);
            return normalized;
        } catch (error) {
            console.warn("Failed to build schema AST diagnostics for feature search.", error);
            return [];
        }
    }

    /** Clears cached schema query results after datasource metadata changes. */
    private clearCaches(): void {
        this.attributeScopesByQueryCache.clear();
        this.searchStyleFieldsByQueryCache.clear();
        this.searchAstDiagnosticsByQueryCache.clear();
    }

    /** Returns true when the query is a single SIMFIL identifier without operators or path access. */
    private isBareSearchIdentifier(query: string): boolean {
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(query.trim());
    }

    /** Normalizes untyped WASM attribute-scope candidates into the TypeScript-facing shape. */
    private normalizeAttributeScopeCandidates(value: unknown): FeatureSearchAttributeScopeCandidate[] {
        if (!Array.isArray(value)) {
            return [];
        }
        return value.flatMap(item => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                return [];
            }
            const raw = item as Record<string, unknown>;
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

    /** Normalizes untyped WASM search-style field candidates into the TypeScript-facing shape. */
    private normalizeSearchStyleFieldCandidates(value: unknown): FeatureSearchStyleFieldCandidate[] {
        if (!Array.isArray(value)) {
            return [];
        }
        return value.flatMap(item => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                return [];
            }
            const raw = item as Record<string, unknown>;
            const path = typeof raw["path"] === "string" ? raw["path"] : "";
            const mapId = typeof raw["mapId"] === "string" ? raw["mapId"] : "";
            const layerId = typeof raw["layerId"] === "string" ? raw["layerId"] : "";
            if (!path || !mapId || !layerId) {
                return [];
            }
            const attrName = typeof raw["attrName"] === "string" ? raw["attrName"] : undefined;
            const featureType = typeof raw["featureType"] === "string" ? raw["featureType"] : undefined;
            return [{path, mapId, layerId, attrName, featureType}];
        });
    }

    /** Normalizes untyped WASM diagnostics into the UI diagnostics shape. */
    private toDiagnosticsMessage(defaultQuery: string, value: unknown): FeatureSearchDiagnosticMessage[] {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return [];
        }
        const raw = value as Record<string, unknown>;
        const message = typeof raw["message"] === "string" ? raw["message"] : "";
        if (!message) {
            return [];
        }
        const query = typeof raw["query"] === "string" ? raw["query"] : defaultQuery;
        const rawLocation = raw["location"];
        const location = rawLocation && typeof rawLocation === "object" && !Array.isArray(rawLocation)
            ? this.toDiagnosticsLocation(rawLocation as Record<string, unknown>)
            : undefined;
        return [{
            query,
            message,
            location,
            fix: typeof raw["fix"] === "string" ? raw["fix"] : null
        }];
    }

    /** Normalizes optional source-location data carried by native diagnostics. */
    private toDiagnosticsLocation(value: Record<string, unknown>): {offset: number, size: number} | undefined {
        const offset = typeof value["offset"] === "number" ? value["offset"] : undefined;
        const size = typeof value["size"] === "number" ? value["size"] : undefined;
        return offset !== undefined && size !== undefined ? {offset, size} : undefined;
    }
}
