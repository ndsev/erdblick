import { type ConnectionRetryPolicy, connectionRetryPolicySchema } from "./connection-retry-policy.model";
import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import {
    BehaviorSubject,
    filter,
    firstValueFrom,
    Subject,
    take
} from "rxjs";
import { z } from "zod";
import type { FeatureLayerStyle, TileLayerParser } from "../../build/libs/core/erdblick-core";
import {
    catalogPage,
    ControlReadContext,
    discoveryPageShape,
    discoveryResult,
    identifierSchema,
    indexSchema,
    rejectAction
} from "../action/action.model";
import { AppActionContributor, AppActionRegistration } from "../action/action-contributor.model";
import { InspectionPanelService } from "../inspection/inspection-panel.service";
import { coreLib, uint8ArrayFromWasm, uint8ArrayToWasmOrThrow } from "../integrations/wasm.adapter";
import { TileGridMode, VIEW_SYNC_LAYERS, viewIdSchema } from "../mapview/mapview.model";
import { MapViewState } from "../mapview/mapview.state";
import { InfoMessageService } from "../diagnostics/info.service";
import { boundedUnicodeString, unicodePrefix } from "../utils/unicode-string.util";
import { AppStateService } from "../appstate/appstate.service";
import type { LayerPresetRef } from "../mapstyle/layer-preset.model";
import { MapPresetService } from "../mapstyle/map-preset.service";
import { MapStyleService } from "../mapstyle/mapstyle.service";
import { MapDataState } from "./mapdata.state";
import {
    layerPresetInferenceKey,
    layerPresetNode,
    layerStyleOptions,
    MapLayerTree,
    StyleOptionNode
} from "./map-tree.controller";
import {
    dataSourceCatalogStatus,
    dataSourceReadinessStatus,
    dataSourceProgressPercent,
    isDataSourceCatalogEntryReady,
    MapInfoItem,
    MapSchemaArtifact,
    sortDataSourceCatalogEntries
} from "./source-catalog.model";
import { MapgetLayer } from "./mapget-layer.model";

/** Lightweight datasource status/progress update carried by interactive catalog-change frames. */
interface SourceCatalogEntryUpdate {
    configIndex: number;
    status?: string;
    statusMessage?: string;
    progress?: number | null;
    retrying?: boolean;
}

/** One concrete option/view pair invalidated by an atomic style-option transaction. */
export interface StyleOptionChange {
    optionNode: StyleOptionNode;
    viewIndex: number;
}

/** Shared validation used by registration and the corresponding domain operation. */
const styleOptionValueSchema = z.union([z.boolean(), z.number(), boundedUnicodeString(4096)]);

/** Shared validation used by registration and the corresponding domain operation. */
const styleOptionSelectorSchema = z
    .strictObject({ viewId: viewIdSchema })
    .extend({ mapId: identifierSchema, layerId: identifierSchema })
    .extend({ styleId: identifierSchema, optionId: identifierSchema });

/**
 * Owns datasource metadata, the map/layer tree, shared parser metadata and layer edits.
 * Compression and coordinated retry-policy edits use the same MapDataState as
 * the tile stream; this controller also contributes their public controls.
 */
@Injectable({ providedIn: "root" })
export class MapDataService implements AppActionContributor {
    public readonly legalInformationPerMap = new Map<string, Set<string>>();
    public readonly legalInformationUpdated = new Subject<boolean>();
    public readonly layerStateChanged = new Subject<string>();
    public readonly styleOptionsChanged = new Subject<StyleOptionChange[]>();
    /** Emits on replacement/removal, requiring a stream reset; additions leave existing consumers live. */
    public readonly dataSourceInfoChanged = new Subject<void>();
    public readonly maps$: BehaviorSubject<MapLayerTree>;

    /** Shared parser instance whose datasource metadata is populated from `/sources`. */
    private parserInstance: TileLayerParser | null = null;
    /** Raw datasource metadata retained for diagnostics/debug export. */
    private dataSourceInfoJson: string | null = null;
    /** UTF-8 form of ready datasource metadata shared with render workers. */
    private dataSourceInfoBlobValue: Uint8Array | null = null;
    /** Installed ready metadata keyed by JSON content, excluding catalog progress/status decoration. */
    private readySourceMetadata = new Map<string, MapInfoItem>();
    /** Server-ready metadata awaiting or retaining its local schema installation. */
    private catalogMetadata = new Map<string, MapInfoItem>();
    /** Coalesces binary downloads before allocating another copy of the same schema. */
    private readonly schemaRequests = new Map<string, {
        sourceId: string;
        promise: Promise<MapSchemaArtifact>;
    }>();
    private readonly schemaArtifacts = new Map<string, MapSchemaArtifact>();
    /** Limit simultaneous downloads/decodes without making readiness an all-source barrier. */
    private activeSchemaDownloads = 0;
    private readonly waitingSchemaDownloads: Array<() => void> = [];
    /** One initialization per exact source snapshot; late completions cannot publish a replacement. */
    private readonly sourceHydrations = new Map<string, Promise<void>>();
    private catalogLoadSerial = 0;
    private catalogChangeSerial = 0;
    /** Per-map model generations exclude progress updates and other maps becoming ready. */
    private readonly mapMetadataGenerations = new Map<string, number>();
    private nextMetadataGeneration = 0;
    /** Map-local parser metadata used only by subset render workers. */
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
        private readonly styleService: MapStyleService,
        private readonly mapPresetService: MapPresetService,
        private readonly messageService: InfoMessageService,
        public readonly state: MapDataState,
        public readonly viewSettings: MapViewState,
        private readonly inspectionState: InspectionPanelService
    ) {
        this.maps$ = new BehaviorSubject<MapLayerTree>(
            new MapLayerTree([], this.stateService, this.styleService, this.mapPresetService, this.viewSettings, this.state)
        );
        this.stateService.ready.pipe(filter(ready => ready), take(1)).subscribe(() => this.pruneCatalogState());
        this.stateService.stateApplied.subscribe(() => {
            this.configureTreeParameters();
            this.layerStateChanged.next("external-state");
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
    getDataSourceInfoJson(mapIds?: readonly string[]): string | null {
        return mapIds
            ? JSON.stringify([...this.readySourceMetadata.values()].filter(source => mapIds.includes(source.mapId)))
            : this.dataSourceInfoJson;
    }

    /** Reports incomplete schema scope explicitly; an empty type list would imply false absence. */
    schemaReadinessError(mapIds?: readonly string[]): string | undefined {
        const sources = this.sourceCatalogEntries.filter(source => !mapIds || mapIds.includes(source.mapId));
        if (mapIds?.some(id => !sources.some(source => source.mapId === id))) {
            return "A requested map is no longer present in the datasource catalog.";
        }
        const pending = sources.find(source => !isDataSourceCatalogEntryReady(source));
        return pending ? `${pending.mapId}: ${this.dataSourceStatusText(pending)}` : undefined;
    }

    /** Returns immutable ready datasource metadata for worker-local parsers. */
    getDataSourceInfoBlob(): Uint8Array | null {
        return this.dataSourceInfoBlobValue;
    }

    /**
     * Plans against the same immutable schema used to decode this map's tiles.
     * Local readiness guarantees that the shared parser already owns the graph;
     * style planning no longer constructs a second schema parser per map.
     */
    planStyleFilter(
        style: FeatureLayerStyle,
        mapId: string,
        layerId: string,
        highlightMode: number,
        lod: number
    ): unknown {
        if (!this.isMapLayerReady(mapId, layerId)) {
            throw new Error(`Datasource '${mapId}' is not ready for style planning.`);
        }
        return this.tileLayerParser.planStyleFilter(
            style,
            mapId,
            layerId,
            highlightMode,
            lod
        );
    }

    /**
     * Returns one map's small catalog metadata for worker-local decoding.
     * Its referenced binary schema is installed separately before task admission.
     * Legacy inline input remains intact until native import normalizes it.
     */
    getRenderDataSourceInfoBlob(mapId: string): Uint8Array | null {
        const cached = this.renderDataSourceInfoBlobCache.get(mapId);
        if (cached) {
            return cached;
        }

        const sources = [...this.readySourceMetadata.values()]
            .filter(source => source.mapId === mapId);
        if (!sources.length) {
            return null;
        }

        const blob = new TextEncoder().encode(JSON.stringify(sources));
        this.renderDataSourceInfoBlobCache.set(mapId, blob);
        return blob;
    }

    /** Returns only the schema artifacts required by the selected ready maps. */
    getSchemaArtifacts(mapIds?: readonly string[]): MapSchemaArtifact[] {
        const artifacts = new Map<string, MapSchemaArtifact>();
        for (const source of this.readySourceMetadata.values()) {
            if (mapIds && !mapIds.includes(source.mapId)) continue;
            const artifact = source.schemaId ? this.schemaArtifacts.get(source.schemaId) : undefined;
            if (artifact) artifacts.set(artifact.schemaId, artifact);
        }
        return [...artifacts.values()];
    }

    /** Model generation used by isolated decoders; catalog status has no effect on it. */
    mapMetadataGeneration(mapId: string): number {
        return this.mapMetadataGenerations.get(mapId) ?? 0;
    }

    /**
     * Identifies the model snapshots a schema request actually depends on.
     * A progress update or another map becoming ready leaves a selected scope
     * unchanged. Removal, loss of readiness or replacement invalidates it.
     */
    schemaScopeSignature(mapIds?: readonly string[]): string {
        const scope = [...new Set(mapIds ?? this.sourceCatalogEntries.map(source => source.mapId))].sort();
        return JSON.stringify(scope.map(mapId => [mapId, this.mapMetadataGeneration(mapId), this.isMapReady(mapId)]));
    }

    /** Enumerates types from the installed graph, rather than a duplicate catalog registry. */
    featureTypesForLayer(mapId: string, layerId: string, includeReferenceTypes = false): string[] {
        if (!this.isMapLayerReady(mapId, layerId)) return [];
        const types: unknown = this.tileLayerParser.featureTypes(mapId, layerId, includeReferenceTypes);
        if (!Array.isArray(types) || !types.every(type => typeof type === "string")) {
            throw new Error(`Invalid native feature types for '${mapId}/${layerId}'.`);
        }
        return types;
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
        return !!map && dataSourceReadinessStatus(map.info) === "initializing";
    }

    /** Returns whether a map catalog entry failed during datasource startup. */
    isMapFailed(mapId: string): boolean {
        const map = this.maps.maps.get(mapId);
        return !!map && dataSourceReadinessStatus(map.info) === "failed";
    }

    /** Formats the current datasource state for map-tree tooltips. */
    dataSourceStatusText(mapInfo: MapInfoItem): string {
        const status = dataSourceCatalogStatus(mapInfo);
        if (status === "ready" && mapInfo.schemaStatus === "loading") {
            return "Datasource ready; loading its schema in this browser.";
        }
        if (status === "ready" && mapInfo.schemaStatus === "failed") {
            return `Datasource ready; schema installation failed. ${mapInfo.schemaMessage || ""}`.trim();
        }
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

    /**
     * Publishes catalog rows immediately and initializes each source independently.
     * Awaiting this method never waits for all schemas: one slow or broken source
     * must not block the application, MCP, or another map becoming usable.
     */
    async reloadDataSources(): Promise<boolean> {
        const serial = ++this.catalogLoadSerial;
        const changeSerial = this.catalogChangeSerial;
        try {
            const response = await firstValueFrom(this.httpClient.get<Array<MapInfoItem>>("/sources?blocking=false", {
                cache: "no-store",
                observe: "response"
            }));
            if (serial !== this.catalogLoadSerial) return true;
            const revision = this.parseSourceCatalogRevision(response.headers.get("X-Mapget-Sources-Revision"));
            if (changeSerial !== this.catalogChangeSerial &&
                (revision === null || this.sourceCatalogRevisionValue === null || revision < this.sourceCatalogRevisionValue)) {
                // A newer stream notification arrived while HTTP was in flight.
                // Preserve it and fetch a fresh snapshot, including for direct UI reloads.
                void this.reloadDataSources();
                return true;
            }
            const nextMetadata = new Map<string, MapInfoItem>();
            const result = Array.isArray(response.body) ? response.body : [];
            this.sourceCatalogEntries = this.normalizeSourceCatalogEntries(result).map(source => {
                if (dataSourceCatalogStatus(source) !== "ready") return source;
                const metadata = this.sourceMetadata(source);
                const signature = JSON.stringify(metadata);
                const retained = this.readySourceMetadata.get(signature) ?? metadata;
                nextMetadata.set(signature, retained);
                // Preserve existing layer identities across fresh HTTP objects.
                return { ...source, layers: retained.layers };
            });
            this.catalogMetadata = nextMetadata;
            this.sourceCatalogRevisionValue = revision;
            if (response.headers.get("X-Mapget-Sources-Config-Status") === "error") {
                console.warn("Datasource config status:", response.headers.get("X-Mapget-Sources-Config-Message")
                    || "Datasource configuration contains errors.");
            }
            this.reconcileReadySources(result);
            this.messageService.clearBackendConnectionError();
            for (const [signature, source] of nextMetadata) {
                if (source.schemaId && !this.readySourceMetadata.has(signature) && !this.sourceHydrations.has(signature)) {
                    const hydration = this.hydrateSourceSchema(signature, source);
                    this.sourceHydrations.set(signature, hydration);
                    void hydration.finally(() => {
                        if (this.sourceHydrations.get(signature) === hydration) this.sourceHydrations.delete(signature);
                    });
                }
            }
            return true;
        } catch (err) {
            if (serial !== this.catalogLoadSerial) return false;
            console.error("Failed to load data source info.", err);
            this.messageService.showBackendConnectionError("Could not connect to the map backend to load datasource metadata.");
            return false;
        }
    }

    /** Removes lifecycle decoration from the metadata identity and native input. */
    private sourceMetadata(source: MapInfoItem): MapInfoItem {
        const metadata = { ...source };
        for (const field of ["status", "statusMessage", "progress", "configIndex", "retrying", "schemaStatus", "schemaMessage"]) {
            delete metadata[field];
        }
        metadata.layers = Object.fromEntries(Object.entries(metadata.layers).map(([id, layer]) => {
            const model = { ...layer };
            delete model["incomingRelationTargetTypes"];
            delete model["incomingRelationCoverageUnknown"];
            return [id, model];
        }));
        return metadata;
    }

    /**
     * Installs complete source snapshots before publishing ready rows.
     * Additions preserve dictionaries and live scenes. Only actual replacement
     * or removal resets the stream, independently of schema download completion.
     */
    private reconcileReadySources(catalogHints?: MapInfoItem[]): void {
        const removed = [...this.readySourceMetadata.keys()].some(key => !this.catalogMetadata.has(key));
        if (removed) {
            const retained = [...this.readySourceMetadata].filter(([key]) => this.catalogMetadata.has(key));
            uint8ArrayToWasmOrThrow(
                buffer => this.tileLayerParser.setDataSourceInfo(buffer),
                new TextEncoder().encode(JSON.stringify(retained.map(([, source]) => source)))
            );
            this.readySourceMetadata = new Map(retained);
            this.invalidateFieldDictBlobCache();
            this.renderDataSourceInfoBlobCache.clear();
        }
        this.sourceCatalogEntries = this.sourceCatalogEntries.map(source => {
            if (dataSourceCatalogStatus(source) !== "ready") return source;
            const signature = JSON.stringify(this.sourceMetadata(source));
            const metadata = this.catalogMetadata.get(signature);
            if (!metadata) return source;
            if (!this.readySourceMetadata.has(signature)) {
                if (metadata.schemaId && !this.schemaArtifacts.has(metadata.schemaId)) {
                    if (source.schemaStatus === "failed") return source;
                    return { ...source, schemaStatus: "loading", schemaMessage: undefined };
                }
                try {
                    const artifact = metadata.schemaId ? this.schemaArtifacts.get(metadata.schemaId) : undefined;
                    if (artifact) {
                        uint8ArrayToWasmOrThrow(bytes => this.tileLayerParser.installMapSchema(bytes, artifact.schemaId), artifact.bytes);
                    }
                    uint8ArrayToWasmOrThrow(
                        buffer => this.tileLayerParser.addDataSourceInfo(buffer),
                        new TextEncoder().encode(JSON.stringify([metadata]))
                    );
                    this.readySourceMetadata.set(signature, metadata);
                    this.mapMetadataGenerations.set(metadata.mapId, ++this.nextMetadataGeneration);
                    this.renderDataSourceInfoBlobCache.delete(metadata.mapId);
                } catch (error) {
                    return { ...source, schemaStatus: "failed", schemaMessage: String(error) };
                }
            }
            return { ...source, schemaStatus: "ready", schemaMessage: undefined };
        });
        if (catalogHints) {
            uint8ArrayToWasmOrThrow(buffer => this.tileLayerParser.setIncomingRelationHints(buffer),
                new TextEncoder().encode(JSON.stringify(catalogHints)));
        }
        const referencedIds = new Set([...this.catalogMetadata.values()].map(source => source.schemaId));
        for (const schemaId of this.schemaArtifacts.keys()) {
            if (!referencedIds.has(schemaId)) this.schemaArtifacts.delete(schemaId);
        }
        this.dataSourceInfoJson = JSON.stringify([...this.readySourceMetadata.values()]);
        this.dataSourceInfoBlobValue = new TextEncoder().encode(this.dataSourceInfoJson);
        this.publishSourceCatalogTree(this.sourceCatalogEntries);
        if (removed) this.dataSourceInfoChanged.next();
        this.layerStateChanged.next("datasources");
    }

    /** Completes one exact catalog snapshot; a replaced source cannot be revived by a late response. */
    private async hydrateSourceSchema(signature: string, source: MapInfoItem): Promise<void> {
        try {
            await this.loadMapSchema(source);
            if (this.catalogMetadata.has(signature)) this.reconcileReadySources();
        } catch (error) {
            if (!this.catalogMetadata.has(signature)) return;
            this.sourceCatalogEntries = this.sourceCatalogEntries.map(entry =>
                JSON.stringify(this.sourceMetadata(entry)) === signature
                    ? { ...entry, schemaStatus: "failed", schemaMessage: String(error) }
                    : entry
            );
            this.publishSourceCatalogTree(this.sourceCatalogEntries);
            this.layerStateChanged.next("datasources");
        }
    }

    /**
     * Coalesces downloads and native validation by exact artifact identity.
     * The public endpoint authorizes the source before serving its schema. A
     * failed fetch or identity check leaves no cached success and can be retried.
     */
    private loadMapSchema(source: MapInfoItem): Promise<MapSchemaArtifact> {
        const schemaId = source.schemaId!;
        const cached = this.schemaArtifacts.get(schemaId);
        if (cached) return Promise.resolve(cached);
        const pending = this.schemaRequests.get(schemaId);
        if (pending) {
            return pending.promise.catch(error => {
                // A shared graph can be served by several authorized sources.
                // Failure of the first provider must not strand another one.
                if (pending.sourceId === source.sourceId) throw error;
                return this.loadMapSchema(source);
            });
        }
        const request = this.downloadMapSchema(source).finally(() => {
            if (this.schemaRequests.get(schemaId)?.promise === request) this.schemaRequests.delete(schemaId);
        });
        this.schemaRequests.set(schemaId, {sourceId: source.sourceId, promise: request});
        return request;
    }

    /** Downloads and validates one live artifact while holding a bounded download slot. */
    private async downloadMapSchema(source: MapInfoItem): Promise<MapSchemaArtifact> {
        if (this.activeSchemaDownloads >= 2) {
            await new Promise<void>(resolve => this.waitingSchemaDownloads.push(resolve));
        } else {
            ++this.activeSchemaDownloads;
        }
        try {
            const schemaId = source.schemaId!;
            const stillReferenced = () => [...this.catalogMetadata.values()].some(entry => entry.schemaId === schemaId);
            if (!stillReferenced()) throw new Error("Datasource schema was replaced before its download started.");
            const buffer = await firstValueFrom(this.httpClient.get("/schema", {
                params: {sourceId: source.sourceId, schemaId},
                responseType: "arraybuffer"
            }));
            if (!stillReferenced()) throw new Error("Datasource schema was replaced during its download.");
            const bytes = new Uint8Array(buffer);
            if (!bytes.byteLength || bytes.byteLength > 64 * 1024 * 1024) {
                throw new Error("Map schema artifact is empty or exceeds the 64 MiB limit.");
            }
            uint8ArrayToWasmOrThrow(data => this.tileLayerParser.installMapSchema(data, schemaId), bytes);
            const artifact = {schemaId, bytes};
            this.schemaArtifacts.set(schemaId, artifact);
            return artifact;
        } finally {
            // Hand the occupied slot directly to the next waiter. Decrementing
            // first would let a new arrival overtake it and exceed the limit.
            const next = this.waitingSchemaDownloads.shift();
            if (next) next();
            else --this.activeSchemaDownloads;
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
        ++this.catalogChangeSerial;
        const updatedEntry: MapInfoItem = {
            ...this.sourceCatalogEntries[index],
            retrying: update.retrying === true,
            progress: this.normalizeProgressValue(update.progress)
        };
        if (typeof update.status === "string") {
            updatedEntry.status = update.status;
        }
        if (dataSourceCatalogStatus(updatedEntry) === "ready" &&
            !this.readySourceMetadata.has(JSON.stringify(this.sourceMetadata(updatedEntry)))) {
            updatedEntry.schemaStatus = "loading";
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

    /** Reports constructor recovery independently of whether mapget's transport is connected. */
    getSourceRecoveryState(): { retrying: boolean; failed: boolean; message: string } {
        const failures = this.sourceCatalogEntries.filter(entry => dataSourceCatalogStatus(entry) === "failed");
        return {
            retrying: failures.some(entry => entry.retrying === true), failed: failures.length > 0,
            message: failures.map(entry => `${entry.mapId}: ${entry.statusMessage || "Datasource unavailable."}`).join("\n")
        };
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
            ? dataSourceCatalogStatus({ status: update.status })
            : dataSourceCatalogStatus(entry);
        const hasLayerMetadata = !!entry.layers && Object.keys(entry.layers).length > 0;
        return nextStatus === "ready" && (dataSourceCatalogStatus(entry) !== "ready" || !hasLayerMetadata);
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
            this.mapPresetService, this.viewSettings, this.state
        );
        this.maps.destroy();
        this.maps$.next(nextTree);
        this.pruneCatalogState();
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
        const current = this.state.getLayerSyncOption(viewIndex);
        if (current !== enabled) {
            this.state.setLayerSyncOption(viewIndex, enabled);
        }
    }

    /** Returns whether the given view currently drives option synchronization. */
    isSyncOptionsForViewEnabled(viewIndex: number): boolean {
        return this.state.getLayerSyncOption(viewIndex);
    }

    /** Mirrors layer, style, and background-layer state to sibling views when global view sync is enabled. */
    syncViewsIfEnabled(viewIndex: number): boolean {
        if (!this.viewSettings.viewSync.includes(VIEW_SYNC_LAYERS)) {
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
                changes.push({ optionNode: syncedOption, viewIndex });
            }
        }
        let viewConfigChanged = false;
        if (this.viewSettings.viewSync.includes(VIEW_SYNC_LAYERS)) {
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
        const numViews = this.viewSettings.numViews;
        for (let viewIndex = 0; viewIndex < numViews; viewIndex++) {
            if (this.state.getLayerSyncOption(viewIndex)) {
                this.applySyncOptionsForView(viewIndex);
            }
        }
    }

    /** Copies one view's background-layer selection and opacity to the other views. */
    syncBackgroundSettingsFromView(viewIndex: number): boolean {
        const numViews = this.viewSettings.numViews;
        if (viewIndex < 0 || viewIndex >= numViews) {
            return false;
        }
        const sourceBackground = this.viewSettings.getBackgroundState(viewIndex);
        let changed = false;
        for (let targetIndex = 0; targetIndex < numViews; targetIndex++) {
            if (targetIndex === viewIndex) {
                continue;
            }
            const targetBackground = this.viewSettings.getBackgroundState(targetIndex);
            if (targetBackground.layerId !== sourceBackground.layerId || targetBackground.opacity !== sourceBackground.opacity) {
                this.viewSettings.setBackgroundState(targetIndex, sourceBackground.layerId, sourceBackground.opacity);
                changed = true;
            }
        }
        return changed;
    }

    /** Public entry point that syncs background-layer settings only when layer sync is globally active. */
    syncBackgroundSettings(viewIndex: number) {
        if (!this.viewSettings.viewSync.includes(VIEW_SYNC_LAYERS)) {
            return;
        }
        this.syncBackgroundSettingsFromView(viewIndex);
    }

    /** Applies a style-option value change and emits it for render invalidation. */
    applyStyleOptionChange(optionNode: StyleOptionNode, viewIndex: number): void {
        this.applyStyleOptionChanges([optionNode], viewIndex);
    }

    /** Applies a preset through the same transaction for map-tree controls and agent actions. */
    applyLayerPreset(viewIndex: number, mapId: string, layerId: string, ref: LayerPresetRef | null): boolean {
        const layer = this.maps.getFeatureLayer(mapId, layerId);
        if (!layer || viewIndex < 0 || viewIndex >= this.viewSettings.numViews) return false;
        const preset = ref ? layerPresetNode(layer)?.presets.find(candidate =>
            candidate.styleId === ref.styleId && candidate.id === ref.presetId) : undefined;
        if (ref && !preset) return false;
        const options = layerStyleOptions(layer);
        this.commitPresetEdit(() => {
            const changed: StyleOptionNode[] = [];
            for (const value of preset?.values ?? []) {
                const option = options.find(candidate => candidate.styleId === preset!.styleId && candidate.id === value.optionId);
                if (option && option.value[viewIndex] !== value.value) {
                    option.value[viewIndex] = value.value;
                    changed.push(option);
                }
            }
            this.maps.setLayerPresetSelection(viewIndex, mapId, layerId, ref);
            this.applyPresetChanges(changed, viewIndex, [{ mapId, layerId }]);
        });
        return true;
    }

    /** Validates an entire map composition before changing any of its component options. */
    applyMapPreset(viewIndex: number, mapId: string, presetId: string | null): boolean {
        const map = this.maps.maps.get(mapId);
        if (!map || viewIndex < 0 || viewIndex >= this.viewSettings.numViews) return false;
        if (!presetId) {
            this.commitPresetEdit(() => {
                this.maps.setMapPresetSelection(viewIndex, mapId, null);
                this.maps.reconcilePresetSelections();
            });
            return true;
        }
        const preset = map.mapPresets.find(candidate => candidate.id === presetId);
        const components = preset ? this.maps.resolveMapPresetComponents(map, preset) : undefined;
        if (!preset || !components || (this.isSyncOptionsForViewEnabled(viewIndex) && this.maps.mapPresetHasSyncConflict(map, preset))) return false;
        this.commitPresetEdit(() => {
            const changed: StyleOptionNode[] = [];
            for (const component of components) {
                const options = layerStyleOptions(component.layer);
                for (const value of component.preset.values) {
                    const option = options.find(candidate => candidate.styleId === component.preset.styleId && candidate.id === value.optionId);
                    if (option && option.value[viewIndex] !== value.value) {
                        option.value[viewIndex] = value.value;
                        changed.push(option);
                    }
                }
                this.maps.setLayerPresetSelection(viewIndex, mapId, component.layer.id, component.preset.ref);
            }
            this.maps.setMapPresetSelection(viewIndex, mapId, preset.id);
            this.applyPresetChanges(changed, viewIndex, components.map(component => ({ mapId, layerId: component.layer.id })));
        });
        return true;
    }

    /** Restores cached tree values if a prepared option write fails before publication. */
    private commitPresetEdit(edit: () => void): void {
        try { this.stateService.transaction(edit); }
        catch (error) {
            this.maps.configureTreeParameters();
            throw error;
        }
    }

    /** Applies one atomic collection of option mutations and performs synchronization once. */
    applyStyleOptionChanges(optionNodes: StyleOptionNode[], viewIndex: number): void {
        const directNodes = optionNodes.filter(optionNode => optionNode.value.length > viewIndex);
        const sourceLayers = new Set(directNodes.map(optionNode =>
            `${optionNode.mapId}\u0000${optionNode.layerId}`));
        this.commitPresetEdit(() => this.applyStyleOptionTransaction(directNodes, viewIndex, sourceLayers, true));
    }

    /** Applies preset-owned changes while synchronizing every component source layer once. */
    applyPresetChanges(
        optionNodes: StyleOptionNode[],
        viewIndex: number,
        sourceLayers: ReadonlyArray<{ mapId: string; layerId: string }>
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
        const changes: StyleOptionChange[] = directNodes.map(optionNode => ({ optionNode, viewIndex }));
        if (this.isSyncOptionsForViewEnabled(viewIndex)) {
            for (const sourceLayer of sourceLayers) {
                const [mapId, layerId] = sourceLayer.split("\u0000");
                const syncedOptions = this.maps.syncLayers(viewIndex, mapId, layerId, false);
                changes.push(...syncedOptions.map(optionNode => ({ optionNode, viewIndex })));
            }
        }
        let viewConfigChanged = false;
        if (this.viewSettings.viewSync.includes(VIEW_SYNC_LAYERS)) {
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
        this.state.setStyleOptionValuesBatch([...changedOptions.values()].map(optionNode => ({
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
    findSourceDataMapsForTileId(tileId: number): Array<{ id: string, name: string }> {
        const level = coreLib.getTileLevel(tileId);
        const result: Array<{ id: string, name: string }> = [];
        for (const mapInfo of this.maps.maps.values()) {
            for (const layerInfo of mapInfo.layers.values()) {
                if (layerInfo.type != "SourceData") {
                    continue;
                }
                if (layerInfo.info.zoomLevels.length && !layerInfo.info.zoomLevels.includes(level)) {
                    continue;
                }
                result.push({ id: mapInfo.id, name: mapInfo.id });
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
        return isMetadata ? match[2] : `${match[1]}`.replace('-', '.');
    }
    /** Registers semantic operations and their live omnibar candidates. */
    registerActions(actions: AppActionRegistration): void {
        actions.registerAction(
            {
                name: "viewer_list_maps",
                mutation: false,
                description:
                    "List configured map identities and current availability without loading data or exposing " +
                    "source URLs or credentials.",
                inputSchema: z.strictObject({ ...discoveryPageShape }),
                outputSchema: discoveryResult(
                    z.strictObject({ id: identifierSchema, available: z.boolean() })
                )
            },
            (input) => this.listMaps(input)
        );
        actions.registerAction(
            {
                name: "viewer_list_layers",
                mutation: false,
                description:
                    "List map layers, supported zoom levels and schema-owning feature types. Features are the " +
                    "default; use layerType=SourceData for raw tables. featureTypes lists produced types; " +
                    "referenceTypes lists additional ID targets. Both are absent until the source's schema is ready. " +
                    "Optional viewId adds the current visibility, without changing defaults or loading data.",
                inputSchema: z.strictObject({
                    mapId: identifierSchema.optional(),
                    layerId: identifierSchema.optional(),
                    layerType: z.enum(["Features", "SourceData", "all"]).default("Features"),
                    viewId: viewIdSchema.optional(),
                    ...discoveryPageShape
                }),
                outputSchema: discoveryResult(
                    z.strictObject({
                        id: identifierSchema,
                        mapId: identifierSchema,
                        kind: z.enum(["Features", "SourceData"]),
                        available: z.boolean(),
                        visible: z.boolean().optional(),
                        zoomLevels: z.array(z.number().int().min(0).max(15)).max(16),
                        featureTypes: z.array(identifierSchema).max(1000).optional(),
                        referenceTypes: z.array(identifierSchema).max(1000).optional(),
                        schemaStatus: z.enum(["loading", "ready", "failed"]),
                        schemaId: identifierSchema.optional(),
                        partitionKind: z.enum(["tile", "object"])
                    })
                )
            },
            (input) => this.listLayers(input)
        );
        actions.registerAction(
            {
                name: "viewer_list_style_options",
                mutation: false,
                description:
                    "List public style options for one layer and view. Each item supplies its exact writeTarget for " +
                    "viewer_set_control. For a coordinated named appearance, use viewer_list_presets. Reads never " +
                    "turn defaults into user-owned values.",
                inputSchema: z.strictObject({
                    mapId: identifierSchema,
                    layerId: identifierSchema,
                    viewId: viewIdSchema,
                    styleId: identifierSchema.optional(),
                    ...discoveryPageShape
                }),
                outputSchema: discoveryResult(
                    z.strictObject({
                        id: identifierSchema,
                        name: boundedUnicodeString(4096),
                        styleId: identifierSchema,
                        mapId: identifierSchema,
                        layerId: identifierSchema,
                        kind: boundedUnicodeString(128),
                        value: styleOptionValueSchema,
                        defaultValue: styleOptionValueSchema,
                        description: boundedUnicodeString(4096),
                        writeTarget: styleOptionSelectorSchema.extend({
                            control: z.literal("view.styleOption")
                        })
                    })
                )
            },
            (input) => this.listStyleOptions(input)
        );
        actions.registerAction(
            {
                name: "viewer_list_presets",
                mutation: false,
                description:
                    "List layer presets when layerId is supplied, otherwise map presets. Optional viewId checks " +
                    "synchronized-option conflicts. Apply with view.layerPreset or view.mapPreset controls.",
                inputSchema: z.strictObject({
                    mapId: identifierSchema,
                    layerId: identifierSchema.optional(),
                    styleId: identifierSchema.optional(),
                    viewId: viewIdSchema.optional(),
                    ...discoveryPageShape
                }),
                outputSchema: discoveryResult(
                    z.strictObject({
                        id: identifierSchema,
                        name: boundedUnicodeString(4096),
                        kind: z.enum(["map", "layer"]),
                        mapId: identifierSchema,
                        layerId: identifierSchema.optional(),
                        styleId: identifierSchema.optional(),
                        available: z.boolean()
                    })
                )
            },
            (input) => this.listPresets(input)
        );
    }

    /** Registers typed state readers and writers without exposing persistence keys. */
    registerControls(actions: AppActionRegistration): void {
        actions.registerControl(
            {
                name: "app.preferences.connection",
                description: "Browser tile-stream transport compression preference.",
                selectorSchema: z.strictObject({}),
                valueSchema: z.strictObject({ tilePullCompression: z.boolean() }),
                readable: true,
                writable: true,
                persistence: "local-storage",
                synchronization: "none"
            },
            {
                read: () => ({ tilePullCompression: this.state.tilePullCompressionEnabled }),
                write: (_selector, value) => {
                    this.state.tilePullCompressionEnabled = value.tilePullCompression;
                }
            }
        );

        actions.registerControl(
            {
                name: "view.layers",
                description:
                    "Read-only layer overview; mapId/layerId selectors also include hidden layers. To change " +
                    "visibility or level, use viewer_set_control with the singular view.layer control.",
                selectorSchema: z
                    .strictObject({ viewId: viewIdSchema })
                    .extend({ mapId: identifierSchema.optional(), layerId: identifierSchema.optional() }),
                valueSchema: z
                    .array(
                        z.strictObject({
                            mapId: identifierSchema,
                            layerId: identifierSchema,
                            visible: z.boolean(),
                            level: indexSchema,
                            autoLevel: z.boolean()
                        })
                    )
                    .max(100),
                readable: true,
                writable: false,
                persistence: "runtime-summary",
                synchronization: "none"
            },
            {
                read: (target, context) => this.layerSummary(target, context),
                defaultTargets: () => this.viewSettings.viewIds.map((viewId) => ({ viewId }))
            }
        );
        // Layer visibility/level assignment also needs renderer auto-level policy;
        // MapViewService binds that control alongside its ordinary layer operations.
        actions.registerControl(
            {
                name: "view.styleOption",
                description:
                    "One applicable style option, validated against its declared type. For a named look such as " +
                    "Cinematic or Lane Topology, call viewer_list_presets and use view.layerPreset to apply all " +
                    "supporting options together; a same-named boolean alone may not enable the needed geometry.",
                selectorSchema: styleOptionSelectorSchema,
                valueSchema: styleOptionValueSchema,
                readable: true,
                writable: true,
                synchronization: "follow-view-sync",
                persistence: "url-and-local-storage"
            },
            {
                read: (target) =>
                    this.requirePublicOption(target).value[this.controlViewIndex(target.viewId)],
                write: (target, value) => this.assignStyleOption(target, value)
            }
        );
        actions.registerControl(
            {
                name: "view.layerPreset",
                description:
                    "Apply all options of a qualified layer preset. Discover viewer_list_presets with " +
                    "mapId/layerId, then assign {styleId,presetId}; null clears its association without resetting " +
                    "options.",
                selectorSchema: z
                    .strictObject({ viewId: viewIdSchema })
                    .extend({ mapId: identifierSchema, layerId: identifierSchema }),
                valueSchema: z
                    .strictObject({ styleId: identifierSchema, presetId: identifierSchema })
                    .nullable(),
                readable: true,
                writable: true,
                synchronization: "follow-view-sync",
                persistence: "url-and-local-storage"
            },
            {
                read: (target) => {
                    this.requireLayer(target.mapId, target.layerId);
                    return this.state.getLayerPresetSelection(
                        this.controlViewIndex(target.viewId),
                        target.mapId,
                        target.layerId
                    );
                },
                write: (target, value) => {
                    this.requireLayer(target.mapId, target.layerId);
                    if (
                        !this.applyLayerPreset(
                            this.controlViewIndex(target.viewId),
                            target.mapId,
                            target.layerId,
                            value
                        )
                    )
                        rejectAction("The layer preset is unavailable");
                }
            }
        );
        actions.registerControl(
            {
                name: "view.mapPreset",
                description: "Apply a map preset; null clears its association without resetting options.",
                selectorSchema: z.strictObject({ viewId: viewIdSchema }).extend({ mapId: identifierSchema }),
                valueSchema: identifierSchema.nullable(),
                readable: true,
                writable: true,
                synchronization: "follow-view-sync",
                persistence: "url-and-local-storage"
            },
            {
                read: (target) => {
                    this.requireMap(target.mapId);
                    return this.state.getMapPresetSelection(
                        this.controlViewIndex(target.viewId),
                        target.mapId
                    );
                },
                write: (target, value) => {
                    this.requireMap(target.mapId);
                    if (!this.applyMapPreset(this.controlViewIndex(target.viewId), target.mapId, value))
                        rejectAction("The map preset is unavailable or conflicts with synchronized options");
                }
            }
        );
    }


    private controlViewIndex(viewId: string): number {
        const index = this.viewSettings.viewIds.indexOf(viewId);
        if (index < 0) rejectAction("The requested view is unavailable", "not_available", "view_unavailable");
        return index;
    }

    requireMap(mapId: string) {
        const map = this.maps.maps.get(mapId);
        if (!map) rejectAction("The requested map is unavailable");
        return map;
    }

    requireLayer(mapId: string, layerId: string) {
        const layer = this.requireMap(mapId).layers.get(layerId);
        if (!layer) rejectAction("The requested layer is unavailable");
        return layer;
    }

    layerConfiguration(target: { viewId: string; mapId: string; layerId: string }) {
        const index = this.controlViewIndex(target.viewId);
        const config = this.requireLayer(target.mapId, target.layerId).viewConfig[index];
        if (!config) rejectAction("The requested feature layer is unavailable");
        return { ...config };
    }

    layerSummary(target: { viewId: string; mapId?: string; layerId?: string }, context: ControlReadContext) {
        const index = this.controlViewIndex(target.viewId);
        if (target.layerId && !target.mapId) rejectAction("layerId requires mapId", "invalid_arguments");
        const maps = target.mapId ? [this.requireMap(target.mapId)] : this.maps.maps.values();
        if (target.layerId) this.requireLayer(target.mapId!, target.layerId);
        function* layers() {
            for (const map of maps)
                for (const layer of target.layerId
                    ? [map.layers.get(target.layerId)!]
                    : map.layers.values()) {
                    const config = layer.viewConfig[index];
                    if (!config || (!target.mapId && !config.visible)) continue;
                    yield { mapId: map.id, layerId: layer.id, ...config };
                }
        }
        return context.collect(layers());
    }

    private requirePublicOption(target: {
        viewId: string;
        mapId: string;
        layerId: string;
        styleId: string;
        optionId: string;
    }) {
        const option = layerStyleOptions(this.requireLayer(target.mapId, target.layerId)).find(
            (option) =>
                option.styleId === target.styleId && option.id === target.optionId && !option.info.internal
        );
        if (!option) rejectAction("The requested style option is unavailable");
        return option;
    }

    assignStyleOption(
        target: { viewId: string; mapId: string; layerId: string; styleId: string; optionId: string },
        value: string | number | boolean
    ): void {
        const index = this.controlViewIndex(target.viewId);
        const option = this.requirePublicOption(target);
        if (typeof value !== typeof option.info.defaultValue)
            rejectAction("Value does not match the style option type", "invalid_arguments");
        this.stateService.transaction(() => {
            option.value = option.value.map((previous, viewIndex) =>
                viewIndex === index ? value : previous
            );
            this.applyStyleOptionChange(option, index);
        });
    }

    listMaps(input: { offset?: number; limit?: number }) {
        const maps = this.maps.maps.values();
        const available = (mapId: string) => this.isMapReady(mapId);
        function* values() {
            for (const map of maps) yield { id: map.id, available: available(map.id) };
        }
        return catalogPage(values(), input);
    }

    listLayers(input: {
        layerType: "Features" | "SourceData" | "all";
        offset?: number;
        limit?: number;
        mapId?: string;
        layerId?: string;
        viewId?: string;
    }) {
        if (input.layerId && !input.mapId) rejectAction("layerId requires mapId", "invalid_arguments");
        const index = input.viewId === undefined ? undefined : this.controlViewIndex(input.viewId);
        const maps = input.mapId ? [this.requireMap(input.mapId)] : this.maps.maps.values();
        const layer = input.layerId ? this.requireLayer(input.mapId!, input.layerId) : undefined;
        const available = (mapId: string) => this.isMapReady(mapId);
        const featureTypes = (mapId: string, layerId: string, references = false) =>
            this.featureTypesForLayer(mapId, layerId, references);
        function* values() {
            for (const map of maps)
                for (const child of layer ? [layer] : map.layers.values()) {
                    if (input.layerType !== "all" && child.type !== input.layerType) continue;
                    const produced = available(map.id) ? featureTypes(map.id, child.id) : undefined;
                    yield {
                        id: child.id,
                        mapId: map.id,
                        kind: child.type as "Features" | "SourceData",
                        available: available(map.id),
                        ...(index === undefined
                            ? {}
                            : { visible: child.viewConfig[index]?.visible ?? false }),
                        zoomLevels: child.info.zoomLevels,
                        ...(produced ? {
                            featureTypes: produced,
                            referenceTypes: featureTypes(map.id, child.id, true).filter(type => !produced.includes(type))
                        } : {}),
                        schemaStatus: map.info.schemaStatus ?? (available(map.id) ? "ready" : "loading"),
                        ...(map.info.schemaId ? { schemaId: map.info.schemaId } : {}),
                        partitionKind: child.info.partitionKind ?? ("tile" as const)
                    };
                }
        }
        return catalogPage(values(), input);
    }

    listStyleOptions(input: {
        mapId: string;
        layerId: string;
        viewId: string;
        offset?: number;
        limit?: number;
        styleId?: string;
    }) {
        const layer = this.requireLayer(input.mapId, input.layerId);
        const index = this.controlViewIndex(input.viewId);
        function* values() {
            for (const option of layerStyleOptions(layer)) {
                if (option.info.internal || (input.styleId && input.styleId !== option.styleId)) continue;
                yield {
                    id: option.id,
                    name: option.info.label,
                    kind: option.type,
                    styleId: option.styleId,
                    mapId: layer.mapId,
                    layerId: layer.id,
                    value: option.value[index],
                    defaultValue: option.info.defaultValue,
                    description: unicodePrefix(option.info.description, 4096),
                    writeTarget: {
                        control: "view.styleOption" as const,
                        viewId: input.viewId,
                        mapId: layer.mapId,
                        layerId: layer.id,
                        styleId: option.styleId,
                        optionId: option.id
                    }
                };
            }
        }
        return catalogPage(values(), input);
    }

    listPresets(input: {
        mapId: string;
        offset?: number;
        limit?: number;
        layerId?: string;
        styleId?: string;
        viewId?: string;
    }) {
        const map = this.requireMap(input.mapId);
        const layer = input.layerId ? this.requireLayer(input.mapId, input.layerId) : undefined;
        const index = input.viewId === undefined ? undefined : this.controlViewIndex(input.viewId);
        const syncOptions = index !== undefined && this.isSyncOptionsForViewEnabled(index);
        const tree = this.maps;
        function* values() {
            if (layer) {
                for (const preset of layerPresetNode(layer)?.presets ?? []) {
                    if (!input.styleId || input.styleId === preset.styleId)
                        yield {
                            id: preset.id,
                            name: preset.name,
                            kind: "layer" as const,
                            mapId: map.id,
                            layerId: layer.id,
                            styleId: preset.styleId,
                            available: true
                        };
                }
            } else
                for (const preset of map.mapPresets)
                    yield {
                        id: preset.id,
                        name: preset.name,
                        kind: "map" as const,
                        mapId: map.id,
                        available: !syncOptions || !tree.mapPresetHasSyncConflict(map, preset)
                    };
        }
        return catalogPage(values(), input);
    }

    /** Complete catalog cleanup is one system edit across independent domain owners. */
    pruneCatalogState(): void {
        if (!this.stateService.ready.value || !this.maps.maps.size || !this.canPruneStateForCurrentCatalog()) return;
        this.stateService.withSystemStateMutation(() => {
            this.state.pruneCatalog(this.maps.maps, this.styleService.styles);
            this.styleService.pruneVisibility(this.styleService.styles);
            this.inspectionState.pruneCatalog(this.maps.maps);
            this.viewSettings.pruneRetiredViews();
        });
    }

    /** Validate the complete preference edit before publishing any persisted values. */
    setConnectionRetryPolicy(policy: ConnectionRetryPolicy): void {
        const parsed = connectionRetryPolicySchema.parse(policy);
        this.stateService.transaction(() => {
            this.state.connectionRetryEnabledState.next(parsed.enabled);
            this.state.connectionRetryInitialDelayMsState.next(parsed.initialDelayMs);
            this.state.connectionRetryBackoffMultiplierState.next(parsed.backoffMultiplier);
            this.state.connectionRetryMaxDelayMsState.next(parsed.maxDelayMs);
        });
    }
}
