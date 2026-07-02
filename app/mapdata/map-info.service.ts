import {HttpClient} from "@angular/common/http";
import {Injectable} from "@angular/core";
import {BehaviorSubject, firstValueFrom, Subject} from "rxjs";
import {FeatureTile} from "./features.model";
import {RequestedLayerProgressState} from "./map-runtime.model";
import {
    dataSourceCatalogStatus,
    dataSourceProgressPercent,
    isDataSourceCatalogEntryReady,
    MapInfoItem,
    MapLayerTree,
    sortDataSourceCatalogEntries,
    StyleOptionNode
} from "./map.tree.model";
import {SearchResultTile} from "./search-result-tile.model";
import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import {AppStateService, TileGridMode, VIEW_SYNC_LAYERS} from "../shared/appstate.service";
import {InfoMessageService} from "../shared/info.service";
import {StyleService} from "../styledata/style.service";
import type {TileLayerParser} from "../../build/libs/core/erdblick-core";

/** Lightweight datasource status/progress update carried by interactive catalog-change frames. */
interface SourceCatalogEntryUpdate {
    sourceId: string;
    status?: string;
    statusMessage?: string;
    progress?: number | null;
}


/**
 * Owns datasource metadata, the map/layer tree, shared parser metadata, legal info, and layer-tree mutations.
 */
@Injectable({providedIn: "root"})
export class MapInfoService {
    public readonly legalInformationPerMap = new Map<string, Set<string>>();
    public readonly legalInformationUpdated = new Subject<boolean>();
    public readonly layerStateChanged = new Subject<string>();
    public readonly styleOptionChanged = new Subject<[StyleOptionNode, number]>();
    /** Emits after ready datasource metadata has been replaced in the shared parser. */
    public readonly dataSourceInfoChanged = new Subject<void>();
    public readonly maps$: BehaviorSubject<MapLayerTree>;

    /** Shared parser instance whose datasource metadata is populated from `/sources`. */
    private parserInstance: TileLayerParser | null = null;
    /** Raw datasource metadata retained for diagnostics/debug export. */
    private dataSourceInfoJson: string | null = null;
    /** Latest datasource-catalog revision advertised by `/sources`, if the backend supports it. */
    private sourceCatalogRevisionValue: number | null = null;
    /** True while at least one catalog entry is not ready; used to avoid pruning recoverable state. */
    private catalogHasNonReadyEntries = false;
    /** Last catalog snapshot, including initializing/failed entries that are not passed to the parser. */
    private sourceCatalogEntries: MapInfoItem[] = [];
    /** Last requested stage coverage per layer, used to enrich incomplete layer metadata. */
    private requestedLayerProgressByKey: Map<string, RequestedLayerProgressState> = new Map();
    /** Highest stage count observed from streamed tile payloads when `/sources` did not declare it. */
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
    get tileLayerParser(): TileLayerParser {
        if (this.parserInstance !== null) {
            return this.parserInstance;
        }
        const parser = new coreLib.TileLayerParser();
        this.parserInstance = parser;
        return parser;
    }

    /** Returns datasource metadata as a JSON string for diagnostics and debug views. */
    getDataSourceInfoJson(): string | null {
        return this.dataSourceInfoJson;
    }

    /** Returns the last `/sources` catalog revision observed from response headers. */
    get sourceCatalogRevision(): number | null {
        return this.sourceCatalogRevisionValue;
    }

    /** Returns true when state pruning can safely remove unavailable maps/layers from persisted state. */
    canPruneStateForCurrentCatalog(): boolean {
        return !this.catalogHasNonReadyEntries;
    }

    /** Returns whether a map catalog entry is ready for tile and search requests. */
    isMapReady(mapId: string): boolean {
        const map = this.maps.maps.get(mapId);
        return !!map && isDataSourceCatalogEntryReady(map.info);
    }

    /** Returns whether a concrete feature/source-data layer belongs to a ready datasource. */
    isMapLayerReady(mapId: string, layerId: string): boolean {
        const map = this.maps.maps.get(mapId);
        return !!map?.layers.has(layerId) && isDataSourceCatalogEntryReady(map.info);
    }

    /** Returns whether a map catalog entry is currently initializing. */
    isMapInitializing(mapId: string): boolean {
        const map = this.maps.maps.get(mapId);
        return !!map && dataSourceCatalogStatus(map.info) === "initializing";
    }

    /** Returns whether a map catalog entry failed during datasource startup. */
    isMapFailed(mapId: string): boolean {
        const map = this.maps.maps.get(mapId);
        return !!map && dataSourceCatalogStatus(map.info) === "failed";
    }

    /** Formats the current datasource state for map-tree tooltips. */
    dataSourceStatusText(mapInfo: MapInfoItem): string {
        const status = dataSourceCatalogStatus(mapInfo);
        const progress = dataSourceProgressPercent(mapInfo);
        const progressText = progress === null ? "" : ` (${progress}%)`;
        const message = typeof mapInfo.statusMessage === "string" && mapInfo.statusMessage.trim().length
            ? mapInfo.statusMessage.trim()
            : "";
        if (status === "ready") {
            return message || "Datasource ready.";
        }
        if (status === "initializing") {
            return message
                ? `Datasource is still initializing${progressText}. ${message}`
                : `Datasource is still initializing${progressText}.`;
        }
        return message || "Datasource failed to initialize.";
    }

    /** Returns normalized datasource progress for compact indicator rendering. */
    dataSourceProgressPercent(mapInfo: MapInfoItem): number | null {
        return dataSourceProgressPercent(mapInfo);
    }

    /** Reloads `/sources`, rebuilds the map tree from the catalog snapshot, and refreshes ready parser metadata. */
    async reloadDataSources(): Promise<boolean> {
        try {
            const response = await firstValueFrom(this.httpClient.get<Array<MapInfoItem>>("/sources?blocking=false", {
                observe: "response"
            }));
            const result = Array.isArray(response.body) ? response.body : [];
            const catalog = this.normalizeSourceCatalogEntries(result);
            this.sourceCatalogRevisionValue = this.parseSourceCatalogRevision(
                response.headers.get("X-Mapget-Sources-Revision")
            );
            const configStatus = response.headers.get("X-Mapget-Sources-Config-Status");
            const configMessage = response.headers.get("X-Mapget-Sources-Config-Message");
            if (configStatus === "error") {
                const message = configMessage || "Datasource configuration contains errors.";
                console.warn("Datasource config status:", message);
            }

            this.messageService.clearBackendConnectionError();
            this.publishSourceCatalogTree(catalog);
            const readyEntries = catalog.filter(isDataSourceCatalogEntryReady);
            const jsonString = JSON.stringify(readyEntries);
            this.dataSourceInfoJson = jsonString;
            uint8ArrayToWasm(wasmBuffer => {
                this.tileLayerParser.setDataSourceInfo(wasmBuffer);
            }, new TextEncoder().encode(jsonString));
            FeatureTile.clearDataSourceInfoBlobCache();
            SearchResultTile.clearDataSourceInfoBlobCache();
            this.dataSourceInfoChanged.next();
            this.layerStateChanged.next("datasources");
            return true;
        } catch (err) {
            console.error("Failed to load data source info.", err);
            this.messageService.showBackendConnectionError("Could not connect to the map backend to load datasource metadata.");
            return false;
        }
    }

    /** Applies a lightweight source-status update from the interactive stream without reloading `/sources`. */
    applySourceCatalogChange(update: SourceCatalogEntryUpdate, revision: number | null = null): boolean {
        if (!update.sourceId) {
            return false;
        }
        const index = this.sourceCatalogEntries.findIndex(entry => entry.sourceId === update.sourceId);
        if (index < 0) {
            return false;
        }
        const updatedEntry: MapInfoItem = {
            ...this.sourceCatalogEntries[index],
            progress: this.normalizeProgressValue(update.progress)
        };
        if (typeof update.status === "string") {
            updatedEntry.status = update.status;
        }
        updatedEntry.statusMessage = typeof update.statusMessage === "string"
            ? update.statusMessage
            : "";
        this.sourceCatalogEntries = [
            ...this.sourceCatalogEntries.slice(0, index),
            updatedEntry,
            ...this.sourceCatalogEntries.slice(index + 1)
        ];
        if (revision !== null) {
            this.sourceCatalogRevisionValue = this.sourceCatalogRevisionValue === null
                ? revision
                : Math.max(this.sourceCatalogRevisionValue, revision);
        }
        this.publishSourceCatalogTree(this.sourceCatalogEntries);
        this.layerStateChanged.next("datasources");
        return true;
    }

    /** Returns true when a lightweight update announces readiness but the local entry still lacks full metadata. */
    sourceCatalogChangeNeedsRefresh(update: SourceCatalogEntryUpdate): boolean {
        const entry = this.sourceCatalogEntries.find(sourceEntry => sourceEntry.sourceId === update.sourceId);
        if (!entry) {
            return true;
        }
        const nextStatus = typeof update.status === "string"
            ? dataSourceCatalogStatus({status: update.status})
            : dataSourceCatalogStatus(entry);
        const hasLayerMetadata = !!entry.layers && Object.keys(entry.layers).length > 0;
        return nextStatus === "ready" && (!isDataSourceCatalogEntryReady(entry) || !hasLayerMetadata);
    }

    /** Normalizes a full catalog snapshot and clears unsupported loading percentages. */
    private normalizeSourceCatalogEntries(entries: MapInfoItem[]): MapInfoItem[] {
        return sortDataSourceCatalogEntries(entries).map(entry => ({
            ...entry,
            progress: this.normalizeProgressValue(entry.progress)
        }));
    }

    /** Stores and publishes the catalog entries that should appear in the map tree. */
    private publishSourceCatalogTree(catalog: MapInfoItem[]): void {
        this.sourceCatalogEntries = sortDataSourceCatalogEntries(catalog);
        this.catalogHasNonReadyEntries = this.sourceCatalogEntries.some(entry => !isDataSourceCatalogEntryReady(entry));
        const maps = this.sourceCatalogEntries.filter(entry => !entry.addOn || !isDataSourceCatalogEntryReady(entry));
        this.maps$.next(new MapLayerTree(
            maps,
            this.stateService,
            this.styleService,
            this.canPruneStateForCurrentCatalog()
        ));
        this.reapplySyncOptionsForAllViews();
    }

    /** Converts absent/null/invalid source progress to the UI's "no percentage available" state. */
    private normalizeProgressValue(progress: unknown): number | null {
        return typeof progress === "number" && Number.isFinite(progress)
            ? progress
            : null;
    }

    /** Parses the optional monotonic datasource-catalog revision header. */
    private parseSourceCatalogRevision(rawRevision: string | null): number | null {
        if (rawRevision === null || rawRevision.trim() === "") {
            return null;
        }
        const revision = Number(rawRevision);
        return Number.isFinite(revision) && revision >= 0
            ? Math.floor(revision)
            : null;
    }

    /** Reapplies persisted tree parameters after style, view, or datasource state changes. */
    configureTreeParameters(): void {
        this.maps.configureTreeParameters();
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
    findSourceDataMapsForTileId(tileId: number): Array<{id: string, name: string}> {
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

}
