import {Injectable} from "@angular/core";
import {
    FeatureSearchAttributeScopeCandidate,
    FeatureSearchStyleFieldCandidate
} from "./map-runtime.model";
import {MapInfoService} from "./map-info.service";
import type {FeatureSearchScope} from "../shared/feature-search-state";

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

    /** Clears cached schema query results after datasource metadata changes. */
    private clearCaches(): void {
        this.attributeScopesByQueryCache.clear();
        this.searchStyleFieldsByQueryCache.clear();
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
}
