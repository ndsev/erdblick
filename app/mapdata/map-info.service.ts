import {HttpClient} from "@angular/common/http";
import {Injectable} from "@angular/core";
import {BehaviorSubject, firstValueFrom, Subject} from "rxjs";
import {FeatureTile} from "./features.model";
import {
    FeatureSearchAttributeScopeCandidate,
    FeatureSearchStyleFieldCandidate,
    RequestedLayerProgressState
} from "./map-runtime.model";
import {MapInfoItem, MapLayerTree, StyleOptionNode} from "./map.tree.model";
import {SearchResultTile} from "./search-result-tile.model";
import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import {AppStateService, TileGridMode, VIEW_SYNC_LAYERS} from "../shared/appstate.service";
import {InfoMessageService} from "../shared/info.service";
import {StyleService} from "../styledata/style.service";
import {FeatureSearchScope} from "../shared/feature-search-state";
import type {SharedUint8Array, TileLayerParser} from "../../build/libs/core/erdblick-core";

export type SearchSchemaTileLayerParser = TileLayerParser & {
    completeSearchQuery(query: string, point: number, options: {limit: number}): unknown;
    getAttributeScopeForQuery(query: string): unknown;
    isAttributeScopeSearchQuery(query: string): boolean;
    readTileSearchResultLayer(buffer: SharedUint8Array): unknown;
    searchStyleFieldsForQuery(query: string, scope: FeatureSearchScope): unknown;
};

/**
 * Owns datasource metadata, the map/layer tree, parser schema data, legal info, and layer-tree mutations.
 */
@Injectable({providedIn: "root"})
export class MapInfoService {
    public readonly legalInformationPerMap = new Map<string, Set<string>>();
    public readonly legalInformationUpdated = new Subject<boolean>();
    public readonly layerStateChanged = new Subject<string>();
    public readonly styleOptionChanged = new Subject<[StyleOptionNode, number]>();
    public readonly maps$: BehaviorSubject<MapLayerTree>;

    private parserInstance: SearchSchemaTileLayerParser | null = null;
    private dataSourceInfoJson: string | null = null;
    private attributeScopesByQueryCache = new Map<string, FeatureSearchAttributeScopeCandidate[]>();
    private searchStyleFieldsByQueryCache = new Map<string, FeatureSearchStyleFieldCandidate[]>();
    private requestedLayerProgressByKey: Map<string, RequestedLayerProgressState> = new Map();
    private observedLayerStageCountByKey: Map<string, number> = new Map();

    constructor(
        private readonly httpClient: HttpClient,
        private readonly stateService: AppStateService,
        private readonly styleService: StyleService,
        private readonly messageService: InfoMessageService
    ) {
        this.maps$ = new BehaviorSubject<MapLayerTree>(
            new MapLayerTree([], this.stateService, this.styleService)
        );
    }

    /** Returns the mutable map tree owned by the map info service. */
    get maps(): MapLayerTree {
        return this.maps$.getValue();
    }

    /** Exposes the shared WASM tile parser used by tile hydration, search schema helpers, and inspection. */
    get tileLayerParser(): SearchSchemaTileLayerParser {
        if (!this.parserInstance) {
            this.parserInstance = new coreLib.TileLayerParser() as SearchSchemaTileLayerParser;
        }
        return this.parserInstance;
    }

    /** Returns datasource metadata as a JSON string for diagnostics and debug views. */
    getDataSourceInfoJson(): string | null {
        return this.dataSourceInfoJson;
    }

    /** Reloads `/sources`, rebuilds the map tree, and refreshes parser datasource metadata. */
    async reloadDataSources() {
        try {
            const result = await firstValueFrom(this.httpClient.get<Array<MapInfoItem>>("/sources"));
            const maps = result.filter(m => !m.addOn).map(mapInfo => mapInfo);
            this.maps$.next(new MapLayerTree(maps, this.stateService, this.styleService));
            this.reapplySyncOptionsForAllViews();

            const jsonString = JSON.stringify(result);
            this.dataSourceInfoJson = jsonString;
            uint8ArrayToWasm(wasmBuffer => {
                this.tileLayerParser.setDataSourceInfo(wasmBuffer);
            }, new TextEncoder().encode(jsonString));
            FeatureTile.clearDataSourceInfoBlobCache();
            SearchResultTile.clearDataSourceInfoBlobCache();
            this.clearSearchSchemaMetadataCaches();
            this.layerStateChanged.next("datasources");
        } catch (err) {
            console.error("Failed to load data source info.", err);
            this.messageService.showError("Failed to load data source info.");
        }
    }

    /** Reapplies persisted tree parameters after style, view, or datasource state changes. */
    configureTreeParameters(): void {
        this.maps.configureTreeParameters();
    }

    /** Returns schema-backed attribute contexts matching a search query. */
    getAttributeScopeForQuery(query: string): FeatureSearchAttributeScopeCandidate[] {
        const cacheKey = query.trim();
        const cached = this.attributeScopesByQueryCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        try {
            const candidates = this.tileLayerParser.getAttributeScopeForQuery(query);
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
            const candidates = this.tileLayerParser.searchStyleFieldsForQuery(query, scope);
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
            return this.tileLayerParser.isAttributeScopeSearchQuery(query);
        } catch (error) {
            console.warn("Failed to infer feature-search scope from schema metadata.", error);
            return false;
        }
    }

    /** Returns the best-known stage count for a layer from metadata, requests, and observed payloads. */
    getLayerStageCount(mapId: string, layerId: string): number {
        let stageCount = 1;
        const layerInfo = this.maps.maps.get(mapId)?.layers.get(layerId)?.info as {
            stages?: unknown;
            stageLabels?: unknown;
        } | undefined;

        if (typeof layerInfo?.stages === "number"
            && Number.isFinite(layerInfo.stages)
            && layerInfo.stages > 0) {
            stageCount = Math.max(stageCount, Math.floor(layerInfo.stages));
        }
        if (Array.isArray(layerInfo?.stageLabels) && layerInfo.stageLabels.length > 0) {
            stageCount = Math.max(stageCount, layerInfo.stageLabels.length);
        }

        const layerKey = this.layerRequestKey(mapId, layerId);
        const trackedRequestState = this.requestedLayerProgressByKey.get(layerKey);
        if (trackedRequestState) {
            stageCount = Math.max(stageCount, trackedRequestState.stageCount);
        }
        const observedStageCount = this.observedLayerStageCountByKey.get(layerKey);
        if (typeof observedStageCount === "number" && observedStageCount > 0) {
            stageCount = Math.max(stageCount, observedStageCount);
        }

        return stageCount;
    }

    /** Resolves stage labels for a layer, filling gaps with generic `Stage N` labels. */
    getLayerStageLabels(mapId: string, layerId: string, stageCount: number): string[] {
        const layerInfo = this.maps.maps.get(mapId)?.layers.get(layerId)?.info as {
            stageLabels?: unknown;
        } | undefined;
        const declaredStageLabels = Array.isArray(layerInfo?.stageLabels)
            ? layerInfo.stageLabels
            : [];
        const result: string[] = [];
        for (let stage = 0; stage < stageCount; stage++) {
            const label = declaredStageLabels[stage];
            if (typeof label === "string" && label.trim().length > 0) {
                result.push(label.trim());
            } else {
                result.push(`Stage ${stage}`);
            }
        }
        return result;
    }

    /** Returns the stage considered high-fidelity for rendering decisions and inspection labels. */
    getLayerHighFidelityStage(mapId: string, layerId: string): number {
        const stageCount = this.getLayerStageCount(mapId, layerId);
        const layerInfo = this.maps.maps.get(mapId)?.layers.get(layerId)?.info as {
            highFidelityStage?: unknown;
        } | undefined;
        const fallback = stageCount > 1 ? 1 : 0;
        if (typeof layerInfo?.highFidelityStage !== "number"
            || !Number.isFinite(layerInfo.highFidelityStage)) {
            return fallback;
        }
        return Math.max(0, Math.min(stageCount - 1, Math.floor(layerInfo.highFidelityStage)));
    }

    /** Replaces the stage-count request state used to enrich layer metadata for progress and inspection. */
    setRequestedLayerProgress(progress: Map<string, RequestedLayerProgressState>): void {
        this.requestedLayerProgressByKey = progress;
    }

    /** Returns the current requested-layer progress state. */
    requestedLayerProgress(): Iterable<RequestedLayerProgressState> {
        return this.requestedLayerProgressByKey.values();
    }

    /** Expands the known stage count for a layer when incoming payloads reveal additional stages. */
    trackObservedLayerStage(mapId: string, layerId: string, stage: number) {
        if (!Number.isInteger(stage) || stage < 0) {
            return;
        }

        const layerKey = this.layerRequestKey(mapId, layerId);
        const observedStageCount = Math.max(1, Math.floor(stage) + 1);
        const previousStageCount = this.observedLayerStageCountByKey.get(layerKey) ?? 1;
        if (observedStageCount <= previousStageCount) {
            return;
        }
        this.observedLayerStageCountByKey.set(layerKey, observedStageCount);
    }

    /** Returns the stable key used to aggregate per-layer request progress. */
    layerRequestKey(mapId: string, layerId: string): string {
        return `${mapId}/${layerId}`;
    }

    /** Persists map/layer visibility changes and emits the resulting map-state event. */
    setMapLayerVisibility(viewIndex: number, mapOrGroupId: string, layerId: string = "", state: boolean) {
        this.maps.setMapLayerVisibility(viewIndex, mapOrGroupId, layerId, state);
        this.layerStateChanged.next("visibility");
    }

    /** Toggles the diagnostic tile-border overlay in one view. */
    toggleViewTileBorderVisibility(viewIndex: number) {
        const nextState = !this.maps.getViewTileBorderState(viewIndex);
        this.setViewTileBorderVisibility(viewIndex, nextState);
    }

    /** Sets diagnostic tile-border overlay visibility in one view. */
    setViewTileBorderVisibility(viewIndex: number, enabled: boolean) {
        if (this.maps.getViewTileBorderState(viewIndex) === enabled) {
            return;
        }
        this.maps.setViewTileBorderState(viewIndex, enabled);
        this.layerStateChanged.next("tile-border");
    }

    /** Sets the tile-grid coordinate mode and refreshes affected overlays. */
    setViewTileGridMode(viewIndex: number, mode: TileGridMode) {
        this.maps.setViewTileGridMode(viewIndex, mode);
        this.layerStateChanged.next("tile-grid");
    }

    /** Persists an explicit layer level for one view. */
    setMapLayerLevel(viewIndex: number, mapId: string, layerId: string, level: number) {
        this.maps.setMapLayerLevel(viewIndex, mapId, layerId, level);
        this.layerStateChanged.next("layer-level");
    }

    /** Persists whether a map layer currently follows the auto-level heuristic. */
    setMapLayerAutoLevel(viewIndex: number, mapId: string, layerId: string, autoLevel: boolean) {
        this.maps.setMapLayerAutoLevel(viewIndex, mapId, layerId, autoLevel);
        this.layerStateChanged.next("auto-level");
    }

    /** Returns whether a map layer currently follows the auto-level heuristic in the given view. */
    isMapLayerAutoLevelEnabled(viewIndex: number, mapId: string, layerId: string): boolean {
        return this.maps.getMapLayerAutoLevel(viewIndex, mapId, layerId);
    }

    /** Enables or disables one view as the source for cross-view option synchronization. */
    setSyncOptionsForView(viewIndex: number, enabled: boolean) {
        const current = this.stateService.getLayerSyncOption(viewIndex);
        if (current !== enabled) {
            this.stateService.setLayerSyncOption(viewIndex, enabled);
        }
    }

    /** Returns whether the given view currently drives option synchronization. */
    isSyncOptionsForViewEnabled(viewIndex: number): boolean {
        return this.stateService.getLayerSyncOption(viewIndex);
    }

    /** Mirrors layer, style, and background-layer state to sibling views when global view sync is enabled. */
    syncViewsIfEnabled(viewIndex: number): boolean {
        if (!this.stateService.viewSync.includes(VIEW_SYNC_LAYERS)) {
            return false;
        }
        const result = this.maps.syncViews(viewIndex);
        for (const [optionNode, targetIndex] of result.styleOptionChanges) {
            this.styleOptionChanged.next([optionNode, targetIndex]);
        }
        return result.viewConfigChanged;
    }

    /** Pushes one view's current style-option values into every compatible layer and sibling view. */
    applySyncOptionsForView(viewIndex: number) {
        for (const layer of this.maps.allFeatureLayers()) {
            const syncedOptions = this.maps.syncLayers(viewIndex, layer.mapId, layer.id);
            for (const syncedOption of syncedOptions) {
                this.styleOptionChanged.next([syncedOption, viewIndex]);
            }
        }
        if (this.syncViewsIfEnabled(viewIndex)) {
            this.layerStateChanged.next("sync-options");
        }
    }

    /** Replays sync settings after the number of views or tree contents changed. */
    reapplySyncOptionsForAllViews() {
        const numViews = this.stateService.numViews;
        for (let viewIndex = 0; viewIndex < numViews; viewIndex++) {
            if (this.stateService.getLayerSyncOption(viewIndex)) {
                this.applySyncOptionsForView(viewIndex);
            }
        }
    }

    /** Copies one view's background-layer selection and opacity to the other views. */
    syncBackgroundSettingsFromView(viewIndex: number): boolean {
        const numViews = this.stateService.numViews;
        if (viewIndex < 0 || viewIndex >= numViews) {
            return false;
        }
        const sourceBackground = this.stateService.getBackgroundState(viewIndex);
        let changed = false;
        for (let targetIndex = 0; targetIndex < numViews; targetIndex++) {
            if (targetIndex === viewIndex) {
                continue;
            }
            const targetBackground = this.stateService.getBackgroundState(targetIndex);
            if (targetBackground.layerId !== sourceBackground.layerId || targetBackground.opacity !== sourceBackground.opacity) {
                this.stateService.setBackgroundState(targetIndex, sourceBackground.layerId, sourceBackground.opacity);
                changed = true;
            }
        }
        return changed;
    }

    /** Public entry point that syncs background-layer settings only when layer sync is globally active. */
    syncBackgroundSettings(viewIndex: number) {
        if (!this.stateService.viewSync.includes(VIEW_SYNC_LAYERS)) {
            return;
        }
        this.syncBackgroundSettingsFromView(viewIndex);
    }

    /** Applies a style-option value change and emits it for render invalidation. */
    applyStyleOptionChange(optionNode: StyleOptionNode, viewIndex: number): void {
        if (optionNode.value.length <= viewIndex) {
            return;
        }
        this.styleOptionChanged.next([optionNode, viewIndex]);
        if (this.isSyncOptionsForViewEnabled(viewIndex)) {
            const syncedOptions = this.maps.syncLayers(viewIndex, optionNode.mapId, optionNode.layerId);
            for (const syncedOption of syncedOptions) {
                this.styleOptionChanged.next([syncedOption, viewIndex]);
            }
        }
        if (this.syncViewsIfEnabled(viewIndex)) {
            this.layerStateChanged.next("style-options");
        }
    }

    /** Deduplicates and publishes legal-info strings per map as tiles arrive. */
    setLegalInfo(mapName: string, legalInfo: string): void {
        if (this.legalInformationPerMap.has(mapName)) {
            this.legalInformationPerMap.get(mapName)!.add(legalInfo);
        } else {
            this.legalInformationPerMap.set(mapName, new Set<string>().add(legalInfo));
        }
        this.legalInformationUpdated.next(true);
    }

    /** Resolves a human-readable source-data layer name back to its internal layer id. */
    sourceDataLayerIdForLayerName(layerName: string) {
        for (const [_, mapInfo] of this.maps.maps.entries()) {
            for (const [_, layerInfo] of mapInfo.layers.entries()) {
                if (layerInfo.type == "SourceData") {
                    if (this.layerNameForSourceDataLayerId(layerInfo.id) == layerName ||
                        this.layerNameForSourceDataLayerId(layerInfo.id) == layerName.replace('-', '.') ||
                        layerInfo.id == layerName) {
                        return layerInfo.id;
                    }
                }
            }
        }
        return null;
    }

    /** Returns every map that could expose source-data for a tile id at the matching level. */
    findSourceDataMapsForTileId(tileId: bigint): Array<{id: string, name: string}> {
        const level = coreLib.getTileLevel(tileId);
        const result: Array<{id: string, name: string}> = [];
        for (const mapInfo of this.maps.maps.values()) {
            for (const layerInfo of mapInfo.layers.values()) {
                if (layerInfo.type != "SourceData") {
                    continue;
                }
                if (layerInfo.info.zoomLevels.length && !layerInfo.info.zoomLevels.includes(level)) {
                    continue;
                }
                result.push({id: mapInfo.id, name: mapInfo.id});
                break;
            }
        }
        return result;
    }

    /** Lists source-data or metadata layers for a map using human-readable names. */
    findLayersForMapId(mapId: string, isMetadata: boolean = false) {
        const map = this.maps.maps.get(mapId);
        if (map) {
            const prefix = isMetadata ? "Metadata" : "SourceData";
            const dataLayers = new Set<string>();
            for (const layer of map.layers.values()) {
                if (layer.type === "SourceData" && layer.id.startsWith(prefix)) {
                    dataLayers.add(layer.id);
                }
            }
            return [...dataLayers].map(layerId => ({
                id: layerId,
                name: this.layerNameForSourceDataLayerId(layerId, isMetadata)
            })).sort((a, b) => a.name.localeCompare(b.name));
        }
        return [];
    }

    /** Returns a human-readable layer name for a layer id. */
    layerNameForSourceDataLayerId(layerId: string, isMetadata: boolean = false) {
        const match = isMetadata ?
            layerId.match(/^Metadata-(.+)-(.+)/) : layerId.match(/^SourceData-(.+-[^-]+)/);
        if (!match) {
            return layerId;
        }
        return isMetadata ? match[2] :`${match[1]}`.replace('-', '.');
    }

    /** Clears schema-derived search UI caches after datasource metadata changes. */
    private clearSearchSchemaMetadataCaches(): void {
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
