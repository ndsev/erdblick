import {HttpClient} from "@angular/common/http";
import {Injectable} from "@angular/core";
import {BehaviorSubject, firstValueFrom, Subject} from "rxjs";
import {
    dataSourceCatalogStatus,
    dataSourceProgressPercent,
    isDataSourceCatalogEntryReady,
    MapInfoItem,
    MapLayerTree,
    layerPresetInferenceKey,
    sortDataSourceCatalogEntries,
    StyleOptionNode
} from "./map.tree.model";
import {
    coreLib,
    uint8ArrayFromWasm,
    uint8ArrayToWasm
} from "../integrations/wasm";
import {AppStateService, TileGridMode, VIEW_SYNC_LAYERS} from "../shared/appstate.service";
import {InfoMessageService} from "../shared/info.service";
import {StyleService} from "../styledata/style.service";
import type {
    FeatureLayerStyle,
    TileLayerParser
} from "../../build/libs/core/erdblick-core";
import {MapgetLayer} from "./mapget-layer.model";
import {MapPresetService} from "../styledata/map-preset.service";

/** Lightweight datasource status/progress update carried by interactive catalog-change frames. */
interface SourceCatalogEntryUpdate {
    configIndex: number;
    status?: string;
    statusMessage?: string;
    progress?: number | null;
}

/** One concrete option/view pair invalidated by an atomic style-option transaction. */
export interface StyleOptionChange {
    optionNode: StyleOptionNode;
    viewIndex: number;
}


/**
 * Owns datasource metadata, the map/layer tree, shared parser metadata, legal info, and layer-tree mutations.
 */
@Injectable({providedIn: "root"})
export class MapInfoService {
    public readonly legalInformationPerMap = new Map<string, Set<string>>();
    public readonly legalInformationUpdated = new Subject<boolean>();
    public readonly layerStateChanged = new Subject<string>();
    public readonly styleOptionsChanged = new Subject<StyleOptionChange[]>();
    /** Emits after ready datasource metadata has been replaced in the shared parser. */
    public readonly dataSourceInfoChanged = new Subject<void>();
    public readonly maps$: BehaviorSubject<MapLayerTree>;

    /** Shared parser instance whose datasource metadata is populated from `/sources`. */
    private parserInstance: TileLayerParser | null = null;
    /** Full-schema style planners created only for maps which are actually presented. */
    private readonly styleParsersByMapId = new Map<string, TileLayerParser>();
    /** Raw datasource metadata retained for diagnostics/debug export. */
    private dataSourceInfoJson: string | null = null;
    /** UTF-8 form of ready datasource metadata shared with render workers. */
    private dataSourceInfoBlobValue: Uint8Array | null = null;
    /** Schema-free, map-local parser metadata used only by subset render workers. */
    private readonly renderDataSourceInfoBlobCache = new Map<string, Uint8Array>();
    /** Complete dictionary snapshots reused until the stream appends new fields. */
    private readonly fieldDictBlobCache = new Map<string, Uint8Array>();
    /** Latest datasource-catalog revision advertised by `/sources`, if the backend supports it. */
    private sourceCatalogRevisionValue: number | null = null;
    /** True while at least one catalog entry is not ready; used to avoid pruning recoverable state. */
    private catalogHasNonReadyEntries = false;
    /** Last catalog snapshot, including initializing/failed entries that are not passed to the parser. */
    private sourceCatalogEntries: MapInfoItem[] = [];
    /** Immutable feature-layer identities rebuilt from the current source catalog. */
    private mapgetLayersByKey = new Map<string, MapgetLayer>();

    constructor(
        private readonly httpClient: HttpClient,
        private readonly stateService: AppStateService,
        private readonly styleService: StyleService,
        private readonly mapPresetService: MapPresetService,
        private readonly messageService: InfoMessageService
    ) {
        this.maps$ = new BehaviorSubject<MapLayerTree>(
            new MapLayerTree([], this.stateService, this.styleService, this.mapPresetService)
        );
        this.stateService.urlStateApplied.subscribe(() => {
            this.configureTreeParameters();
            this.layerStateChanged.next("url-state");
        });
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

    /** Returns immutable ready datasource metadata for worker-local parsers. */
    getDataSourceInfoBlob(): Uint8Array | null {
        return this.dataSourceInfoBlobValue;
    }

    /**
     * Plans one stylesheet against the full schema of its exact map only.
     *
     * Tile transport and feature-id lookup use the shared schema-free parser.
     * Keeping schema construction here makes the expensive completion model
     * lazy per presented map instead of blocking startup on every configured
     * datasource.
     */
    planStyleFilter(
        style: FeatureLayerStyle,
        mapId: string,
        layerId: string,
        highlightMode: number,
        lod: number
    ): unknown {
        return this.styleParserForMap(mapId).planStyleFilter(
            style,
            mapId,
            layerId,
            highlightMode,
            lod
        );
    }

    /**
     * Returns the minimal datasource metadata needed to deserialize one map's
     * subset layers in a render worker.
     *
     * Rendering consumes LayerInfo identity, versions, feature-id
     * compositions, and geometry metadata, but it does not compile SIMFIL or
     * provide completion. Keeping featureModelSchema out of this payload
     * avoids parsing the complete completion catalog independently in every
     * renderer.
     */
    getRenderDataSourceInfoBlob(mapId: string): Uint8Array | null {
        const cached = this.renderDataSourceInfoBlobCache.get(mapId);
        if (cached) {
            return cached;
        }

        const sources = this.schemaFreeDataSourceInfo(
            this.sourceCatalogEntries
                .filter(source =>
                    source.mapId === mapId &&
                    isDataSourceCatalogEntryReady(source))
        );
        if (!sources.length) {
            return null;
        }

        const blob = new TextEncoder().encode(JSON.stringify(sources));
        this.renderDataSourceInfoBlobCache.set(mapId, blob);
        return blob;
    }

    /**
     * Snapshots one complete string-pool dictionary for an isolated consumer.
     *
     * Streamed layer payloads refer to dictionary IDs but do not embed their
     * strings. Render workers do not consume the ordered transport stream, so
     * each worker task must carry the dictionary state against which its
     * subset payload was decoded on the main thread.
     */
    getFieldDictBlob(stringPoolId: string): Uint8Array | null {
        const cached = this.fieldDictBlobCache.get(stringPoolId);
        if (cached) {
            return cached;
        }
        const snapshot = uint8ArrayFromWasm(data =>
            this.tileLayerParser.getFieldDict(data, stringPoolId)
        );
        if (snapshot) {
            this.fieldDictBlobCache.set(stringPoolId, snapshot);
        }
        return snapshot;
    }

    /** Invalidates worker snapshots after an additive field-dictionary frame. */
    invalidateFieldDictBlobCache(): void {
        this.fieldDictBlobCache.clear();
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

    /** Returns the immutable catalog identity for one feature layer. */
    mapgetLayer(mapId: string, layerId: string): MapgetLayer | undefined {
        return this.mapgetLayersByKey.get(`${mapId}/${layerId}`);
    }

    /** Iterates all current non-source-data mapget layer identities. */
    mapgetLayers(): Iterable<MapgetLayer> {
        return this.mapgetLayersByKey.values();
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
                // Catalog validators from older mapget servers can collide after a restart.
                // Fetching the authoritative snapshot must therefore bypass the HTTP cache.
                cache: "no-store",
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
            const dataSourceInfoChanged = jsonString !== this.dataSourceInfoJson;
            this.dataSourceInfoJson = jsonString;
            if (dataSourceInfoChanged) {
                this.invalidateFieldDictBlobCache();
                this.renderDataSourceInfoBlobCache.clear();
                this.clearStyleParsers();
                this.dataSourceInfoBlobValue = new TextEncoder().encode(jsonString);
                const parserJson = JSON.stringify(
                    this.schemaFreeDataSourceInfo(readyEntries)
                );
                uint8ArrayToWasm(wasmBuffer => {
                    this.tileLayerParser.setDataSourceInfo(wasmBuffer);
                }, new TextEncoder().encode(parserJson));
                this.dataSourceInfoChanged.next();
            }
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
        if (!Number.isInteger(update.configIndex) || update.configIndex < 0) {
            return false;
        }
        const index = this.sourceCatalogEntries.findIndex(entry => entry.configIndex === update.configIndex);
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
        const entry = this.sourceCatalogEntries.find(
            sourceEntry => sourceEntry.configIndex === update.configIndex
        );
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
        this.mapgetLayersByKey = this.materializeMapgetLayers(this.sourceCatalogEntries);
        const maps = this.sourceCatalogEntries.filter(entry => !entry.addOn || !isDataSourceCatalogEntryReady(entry));
        const nextTree = new MapLayerTree(
            maps,
            this.stateService,
            this.styleService,
            this.mapPresetService,
            this.canPruneStateForCurrentCatalog()
        );
        this.maps.destroy();
        this.maps$.next(nextTree);
        this.reapplySyncOptionsForAllViews();
    }

    /** Materializes the catalog-only layer model without view or presentation state. */
    private materializeMapgetLayers(catalog: MapInfoItem[]): Map<string, MapgetLayer> {
        const result = new Map<string, MapgetLayer>();
        for (const source of catalog) {
            if (!isDataSourceCatalogEntryReady(source) || source.addOn) {
                continue;
            }
            for (const layer of Object.values(source.layers ?? {})) {
                if (layer.type === "SourceData") {
                    continue;
                }
                const key = `${source.mapId}/${layer.layerId}`;
                const current = this.mapgetLayersByKey.get(key);
                if (current &&
                    current.sourceId === source.sourceId &&
                    current.stringPoolId === source.stringPoolId &&
                    current.info === layer) {
                    result.set(key, current);
                    continue;
                }
                const mapgetLayer = new MapgetLayer(
                    source.sourceId,
                    source.stringPoolId,
                    source.mapId,
                    layer.layerId,
                    layer
                );
                result.set(key, mapgetLayer);
            }
        }
        return result;
    }

    /** Returns a lazily initialized full-schema parser for one presented map. */
    private styleParserForMap(mapId: string): TileLayerParser {
        const cached = this.styleParsersByMapId.get(mapId);
        if (cached) {
            return cached;
        }
        const sources = this.sourceCatalogEntries.filter(source =>
            source.mapId === mapId &&
            isDataSourceCatalogEntryReady(source)
        );
        if (!sources.length) {
            throw new Error(`Datasource '${mapId}' is not ready for style planning.`);
        }
        const parser = new coreLib.TileLayerParser() as TileLayerParser;
        try {
            const json = new TextEncoder().encode(JSON.stringify(sources));
            uint8ArrayToWasm(
                wasmBuffer => parser.setDataSourceInfo(wasmBuffer),
                json
            );
        } catch (error) {
            parser.delete();
            throw error;
        }
        this.styleParsersByMapId.set(mapId, parser);
        return parser;
    }

    /** Releases full-schema planners before installing a changed catalog. */
    private clearStyleParsers(): void {
        for (const parser of this.styleParsersByMapId.values()) {
            parser.delete();
        }
        this.styleParsersByMapId.clear();
    }

    /** Removes completion schemas while retaining all transport/model identity metadata. */
    private schemaFreeDataSourceInfo(
        sources: readonly MapInfoItem[]
    ): MapInfoItem[] {
        return sources.map(source => ({
            ...source,
            layers: Object.fromEntries(
                Object.entries(source.layers ?? {}).map(([layerId, layer]) => {
                    const parserLayer = {...layer};
                    delete parserLayer["featureModelSchema"];
                    return [layerId, parserLayer];
                })
            )
        }));
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

    /** Sets the independent tile-grid line level for one view. */
    setViewTileGridLevel(viewIndex: number, level: number): void {
        this.maps.setViewTileGridLevel(viewIndex, level);
        this.layerStateChanged.next("tile-grid");
    }

    /** Sets whether the tile grid follows the viewport-based auto-level heuristic. */
    setViewTileGridAutoLevel(viewIndex: number, autoLevel: boolean): void {
        this.maps.setViewTileGridAutoLevel(viewIndex, autoLevel);
        this.layerStateChanged.next("tile-grid");
    }

    /** Returns whether the tile grid currently follows the auto-level heuristic. */
    isViewTileGridAutoLevelEnabled(viewIndex: number): boolean {
        return this.maps.getViewTileGridAutoLevel(viewIndex);
    }

    /** Sets the tile-grid line colour for one view. */
    setViewTileGridColor(viewIndex: number, color: string): void {
        this.maps.setViewTileGridColor(viewIndex, color);
        this.layerStateChanged.next("tile-grid");
    }

    /** Sets the tile-grid opacity for one view. */
    setViewTileGridOpacity(viewIndex: number, opacity: number): void {
        this.maps.setViewTileGridOpacity(viewIndex, opacity);
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
        this.publishStyleOptionChanges(result.styleOptionChanges.map(([optionNode, targetIndex]) => ({
            optionNode,
            viewIndex: targetIndex
        })));
        return result.viewConfigChanged;
    }

    /** Pushes one view's current style-option values into every compatible layer and sibling view. */
    applySyncOptionsForView(viewIndex: number) {
        const changes: StyleOptionChange[] = [];
        for (const layer of this.maps.allFeatureLayers()) {
            const syncedOptions = this.maps.syncLayers(viewIndex, layer.mapId, layer.id, false);
            for (const syncedOption of syncedOptions) {
                changes.push({optionNode: syncedOption, viewIndex});
            }
        }
        let viewConfigChanged = false;
        if (this.stateService.viewSync.includes(VIEW_SYNC_LAYERS)) {
            const result = this.maps.syncViews(viewIndex, false);
            viewConfigChanged = result.viewConfigChanged;
            changes.push(...result.styleOptionChanges.map(([optionNode, targetIndex]) => ({
                optionNode,
                viewIndex: targetIndex
            })));
        }
        this.persistAndPublishStyleOptionChanges(changes);
        if (viewConfigChanged) {
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
        this.applyStyleOptionChanges([optionNode], viewIndex);
    }

    /** Applies one atomic collection of option mutations and performs synchronization once. */
    applyStyleOptionChanges(optionNodes: StyleOptionNode[], viewIndex: number): void {
        const directNodes = optionNodes.filter(optionNode => optionNode.value.length > viewIndex);
        const sourceLayers = new Set(directNodes.map(optionNode =>
            `${optionNode.mapId}\u0000${optionNode.layerId}`));
        this.applyStyleOptionTransaction(directNodes, viewIndex, sourceLayers, true);
    }

    /** Applies preset-owned changes while synchronizing every component source layer once. */
    applyPresetChanges(
        optionNodes: StyleOptionNode[],
        viewIndex: number,
        sourceLayers: ReadonlyArray<{mapId: string; layerId: string}>
    ): void {
        const directNodes = optionNodes.filter(optionNode => optionNode.value.length > viewIndex);
        this.applyStyleOptionTransaction(
            directNodes,
            viewIndex,
            new Set(sourceLayers.map(source => `${source.mapId}\u0000${source.layerId}`)),
            false);
    }

    /** Executes one option transaction across direct, layer-synced, and view-synced targets. */
    private applyStyleOptionTransaction(
        directNodes: StyleOptionNode[],
        viewIndex: number,
        sourceLayers: Set<string>,
        inferPresets: boolean
    ): void {
        const changes: StyleOptionChange[] = directNodes.map(optionNode => ({optionNode, viewIndex}));
        if (this.isSyncOptionsForViewEnabled(viewIndex)) {
            for (const sourceLayer of sourceLayers) {
                const [mapId, layerId] = sourceLayer.split("\u0000");
                const syncedOptions = this.maps.syncLayers(viewIndex, mapId, layerId, false);
                changes.push(...syncedOptions.map(optionNode => ({optionNode, viewIndex})));
            }
        }
        let viewConfigChanged = false;
        if (this.stateService.viewSync.includes(VIEW_SYNC_LAYERS)) {
            const result = this.maps.syncViews(viewIndex, false);
            viewConfigChanged = result.viewConfigChanged;
            changes.push(...result.styleOptionChanges.map(([optionNode, targetIndex]) => ({
                optionNode,
                viewIndex: targetIndex
            })));
        }
        if (changes.length) {
            this.persistAndPublishStyleOptionChanges(changes, inferPresets);
        } else {
            this.maps.reconcilePresetSelections();
        }
        if (viewConfigChanged) {
            this.layerStateChanged.next("style-options");
        }
    }

    /** Writes changed option arrays once and publishes one deduplicated render transaction. */
    private persistAndPublishStyleOptionChanges(
        changes: StyleOptionChange[],
        inferPresets = true
    ): void {
        if (!changes.length) {
            return;
        }
        const changedOptions = new Map<string, StyleOptionNode>();
        for (const change of changes) {
            changedOptions.set(change.optionNode.key, change.optionNode);
        }
        this.stateService.setStyleOptionValuesBatch([...changedOptions.values()].map(optionNode => ({
            mapId: optionNode.mapId,
            layerId: optionNode.layerId,
            shortStyleId: optionNode.shortStyleId,
            optionId: optionNode.id,
            values: optionNode.value
        })));
        const inferenceTargets = inferPresets
            ? new Set(changes.map(change => layerPresetInferenceKey(
                change.viewIndex,
                change.optionNode.mapId,
                change.optionNode.layerId)))
            : new Set<string>();
        this.maps.reconcilePresetSelections(inferenceTargets);
        this.publishStyleOptionChanges(changes);
    }

    /** Emits a render batch with duplicate option/view pairs removed in first-seen order. */
    private publishStyleOptionChanges(changes: StyleOptionChange[]): void {
        const unique = new Map<string, StyleOptionChange>();
        for (const change of changes) {
            unique.set(`${change.viewIndex}\u0000${change.optionNode.key}`, change);
        }
        if (unique.size) {
            this.styleOptionsChanged.next([...unique.values()]);
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
