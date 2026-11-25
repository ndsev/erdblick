import {Injectable, OnDestroy} from "@angular/core";
import {Subject} from "rxjs";
import {coreLib, normalizeWasmException, uint8ArrayToWasmOrThrow} from "../integrations/wasm.adapter";
import {MapDataService} from "../mapdata/mapdata.service";
import {
    FilterSubscriptionRef, type FilterSubscriptionCallbacks, type FilterSubscriptionCoverage,
    type FilterSubscriptionDefinition, type FilterSubscriptionOwner, type TileSubsetDelivery
} from "../mapdata/filter-subscription.model";
import {FeatureWrapper, InspectionFeatureTile} from "../mapdata/feature-inspection.adapter";
import {parseMapPartitionKey, parsePartition, partitionKey} from "../mapdata/partition.model";
import type {TileFeatureId} from "../inspection/inspection.model";
import {stripFeatureInspectionTarget} from "../inspection/feature-identity.model";
import type {DrawingOperation, DrawingReply, DrawingRow, DrawingSummary} from "./drawing.model";
import {DrawingWorkerClient, DrawingWorkerStoppedError} from "./drawing-worker.client";
import {DrawingRuntime} from "./drawing-runtime.adapter";

/** Accepted native source incarnation, distinct from an Editor's possibly invalid draft. */
export interface VirtualDrawingSource {
    readonly mapId: string;
    readonly preview: boolean;
    displayName: string;
    summary: DrawingSummary;
    text: string;
    checkpoint?: string;
}

/** Routes browser-owned mapget data through existing delivery and inspection contracts. */
@Injectable({providedIn: "root"})
export class VirtualSourceService implements FilterSubscriptionOwner, OnDestroy {
    readonly changed = new Subject<string>();
    readonly recovered = new Subject<string>();
    private recovery?: Promise<void>;
    readonly sources = new Map<string, VirtualDrawingSource>();
    private readonly ownedIds = new Set<string>();
    private readonly worker = new DrawingWorkerClient();
    private readonly preview = new DrawingRuntime();
    private readonly refs = new Map<FilterSubscriptionRef, {mapId: string; token: number}>();
    private serial = 0;

    /** Keep catalog and local acquisition ownership separate from the remote transport. */
    constructor(private readonly maps: MapDataService) {}

    /** Tombstones prevent late references to removed documents from reaching a server. */
    owns(mapId: string): boolean { return this.ownedIds.has(mapId); }

    /** Resolve canonical keys with the native helper, including after a local source is removed. */
    ownsKey(mapTileKey: string): boolean {
        try { return this.owns(parseMapPartitionKey(coreLib, mapTileKey)[0]); }
        catch { return false; }
    }

    /** Convert at the import boundary; coordinate text never enters the source catalog. */
    async convertCoordinates(text: string): Promise<string> {
        const reply = await this.execute({type: 'convert-coordinates', text});
        if (reply.text === undefined) throw new Error('Coordinate conversion returned no GeoJSON.');
        return reply.text;
    }

    /** Create a source atomically; failed import creates no map-tree row. */
    async create(mapId: string, text: string, displayName: string, preview = false): Promise<VirtualDrawingSource> {
        this.ownedIds.add(mapId);
        const reply = await this.execute({type: "create", mapId, text}, preview);
        if (!reply.summary || !reply.schema || !reply.dictionary) throw new Error("Incomplete local source initialization.");
        const source = {mapId, preview, displayName, summary: reply.summary, text: reply.text ?? text,
            checkpoint: reply.checkpoint};
        this.sources.set(mapId, source);
        try {
            this.maps.registerVirtualSource({
                ...reply.summary.metadata, sourceId: mapId, displayName,
                renderLane: preview ? "drawing-preview" : undefined,
                transient: preview
            }, {schemaId: reply.summary.metadata.schemaId!, bytes: reply.schema}, reply.dictionary);
        } catch (error) {
            this.sources.delete(mapId);
            this.maps.removeVirtualSource(mapId);
            await this.execute({type: "remove", mapId}, preview);
            throw error;
        }
        this.changed.next(mapId);
        return source;
    }

    /** Publish a valid source edit; a rejected candidate leaves the accepted native model intact. */
    async change(operation: Exclude<DrawingOperation, {type: "create" | "remove" | "filter" | "snapshot" | "rows" | "convert-coordinates"}>): Promise<DrawingReply> {
        const source = this.sources.get(operation.mapId);
        if (!source) throw new Error("Local document was removed.");
        const reply = await this.execute(operation, source.preview);
        if (this.sources.get(operation.mapId) !== source) throw new Error("Local document was removed.");
        if (reply.summary) source.summary = reply.summary;
        if (reply.text !== undefined) source.text = reply.text;
        if (reply.checkpoint !== undefined) source.checkpoint = reply.checkpoint;
        if (reply.dictionary) this.maps.installVirtualDictionary(source.mapId, reply.dictionary);
        for (const [ref, state] of this.refs) if (state.mapId === source.mapId && !ref.released) ref.refresh();
        this.changed.next(source.mapId);
        return reply;
    }

    /** Return bounded file-order rows without reparsing source in TypeScript. */
    async rows(mapId: string, offset: number, count: number): Promise<DrawingRow[]> {
        const source = this.sources.get(mapId);
        if (!source) return [];
        return (await this.execute({type: "rows", mapId, offset, count}, source.preview)).rows ?? [];
    }

    /** Remove all local demand before releasing native and catalog ownership. */
    async remove(mapId: string): Promise<void> {
        const source = this.sources.get(mapId);
        if (!source) return;
        this.sources.delete(mapId);
        for (const [ref, state] of this.refs) if (state.mapId === mapId) ref.release();
        this.maps.removeVirtualSource(mapId);
        await this.execute({type: "remove", mapId}, source.preview);
        this.changed.next(mapId);
    }

    /** Reuse the ordinary subscription ref while supplying a local owner. */
    subscribe(definition: FilterSubscriptionDefinition, coverage: FilterSubscriptionCoverage,
              callbacks: FilterSubscriptionCallbacks): FilterSubscriptionRef {
        const ref = new FilterSubscriptionRef(this, "drawing-filter-" + ++this.serial, definition, coverage, callbacks);
        this.refs.set(ref, {mapId: definition.mapId, token: 0});
        this.updateFilterSubscription(ref, true);
        return ref;
    }

    /** Coalesce coverage changes and admit only replies for the latest source and filter generation. */
    updateFilterSubscription(ref: FilterSubscriptionRef, force: boolean): void {
        const state = this.refs.get(ref);
        if (!state || !force) return;
        const token = ++state.token;
        queueMicrotask(() => {
            if (state.token !== token || ref.released || ref.suspended || !ref.pendingPartitionCount) return;
            const source = this.sources.get(state.mapId);
            if (!source) { ref.reportError("Local document is no longer available."); return; }
            const revision = source.summary.revision, generation = ref.generation;
            void this.execute({type: "filter", mapId: state.mapId, request: ref.requestJson()}, source.preview).then(reply => {
                if (this.sources.get(state.mapId) !== source || state.token !== token || ref.released ||
                    ref.suspended || ref.generation !== generation || source.summary.revision !== revision ||
                    reply.revision !== revision) return;
                if (!reply.bytes || !reply.dictionary) throw new Error("Incomplete local filter output.");
                this.maps.installVirtualDictionary(state.mapId, reply.dictionary);
                const metadata = uint8ArrayToWasmOrThrow(
                    bytes => this.maps.tileLayerParser.readTileSubsetLayerMetadata(bytes),
                    reply.bytes.subarray(0, 256 * 1024)
                );
                const partition = parsePartition(metadata.layer.partition);
                const info: Record<string, unknown> = metadata.layer.scalarFields ?? {};
                const delivery: TileSubsetDelivery = {
                    blob: reply.bytes, filterId: ref.filterId, generation,
                    mapId: state.mapId, layerId: "Drawing", partition,
                    partitionKey: partitionKey(partition), mapTileKey: String(metadata.layer.id),
                    stringPoolId: String(metadata.layer.stringPoolId),
                    conversionTimestampMs: null, ttlMs: null,
                    dependencies: metadata.dependencies ?? [], issues: metadata.issues ?? [],
                    error: metadata.layer.error ? String(metadata.layer.error) : null, warnings: metadata.layer.warnings ?? [],
                    info, numEntries: Number(info["Filter/Entries/Total#count"] ?? 0),
                    geometryVertexCount: Number(info["Filter/Geometry/Vertices#count"] ?? 0),
                    glbAttachmentName: "", receivedAt: performance.now()
                };
                ref.accept(delivery);
                ref.notifyRequestSynchronized();
            }).catch(error => {
                if (!ref.released && state.token === token) ref.reportError(normalizeWasmException(error).message);
            });
        });
    }

    /** Release invalidates queued callbacks without a transport cancellation request. */
    releaseFilterSubscription(ref: FilterSubscriptionRef): void {
        const state = this.refs.get(ref);
        if (state) ++state.token;
        this.refs.delete(ref);
    }

    /** Build exact feature snapshots locally, with explicit local-miss semantics. */
    async loadFeatures(requested: TileFeatureId[], signal?: AbortSignal): Promise<FeatureWrapper[]> {
        const groups = new Map<string, TileFeatureId[]>();
        for (const target of requested) {
            const [mapId] = parseMapPartitionKey(coreLib, target.mapTileKey);
            const group = groups.get(mapId) ?? [];
            group.push(target);
            groups.set(mapId, group);
        }
        const result: FeatureWrapper[] = [];
        for (const [mapId, targets] of groups) {
            signal?.throwIfAborted();
            const source = this.sources.get(mapId);
            if (!source) continue;
            const reply = await this.execute({
                type: "snapshot", mapId, ids: [...new Set(targets.map(target => stripFeatureInspectionTarget(target.featureId)))]
            }, source.preview);
            signal?.throwIfAborted();
            if (this.sources.get(mapId) !== source || !reply.bytes || !reply.dictionary) continue;
            this.maps.installVirtualDictionary(mapId, reply.dictionary);
            const tile = new InspectionFeatureTile(this.maps.tileLayerParser, reply.bytes, "virtual");
            for (const target of targets) if (tile.contains(target.featureId)) result.push(new FeatureWrapper(target.featureId, tile));
        }
        return result;
    }

    /** Live preview uses a tiny independent heap owner so imports cannot stall pointer updates. */
    private async execute(operation: DrawingOperation, preview = false): Promise<DrawingReply> {
        if (preview) {
            try { return this.preview.execute(operation); }
            catch (error) { throw normalizeWasmException(error); }
        }
        if (this.recovery) await this.recovery;
        try { return await this.worker.request(operation); }
        catch (error) {
            if (!(error instanceof DrawingWorkerStoppedError)) throw error;
            if (!this.recovery) {
                this.recovery = this.restoreWorker().finally(() => { this.recovery = undefined; });
            }
            await this.recovery;
            if (operation.type === "replace" || operation.type === "create" || operation.type === "rows" || operation.type === "convert-coordinates") {
                return this.worker.request(operation);
            }
            throw new Error("Local drawing data was recovered after a worker restart. Repeat this action.", {cause: error});
        }
    }

    /** Restore accepted text into a fresh parser incarnation; old dictionaries and subsets are retired first. */
    private async restoreWorker(): Promise<void> {
        const retained = [...this.sources.values()].filter(source => !source.preview);
        for (const source of retained) this.maps.removeVirtualSource(source.mapId, true);
        for (const source of retained) {
            if (this.sources.get(source.mapId) !== source) continue;
            const reply = await this.worker.request({type: "create", mapId: source.mapId,
                text: source.text, checkpoint: source.checkpoint});
            if (this.sources.get(source.mapId) !== source) { await this.worker.request({type: "remove", mapId: source.mapId}); continue; }
            if (!reply.summary || !reply.schema || !reply.dictionary) throw new Error("Local drawing recovery failed.");
            source.summary = reply.summary;
            source.checkpoint = reply.checkpoint;
            this.maps.registerVirtualSource({...reply.summary.metadata, sourceId: source.mapId,
                displayName: source.displayName},
                {schemaId: reply.summary.metadata.schemaId!, bytes: reply.schema}, reply.dictionary);
            this.recovered.next(source.mapId); this.changed.next(source.mapId);
        }
    }

    /** Retire workers and refs with the Angular owner. */
    ngOnDestroy(): void {
        for (const ref of this.refs.keys()) ref.release();
        this.worker.destroy();
        this.preview.destroy();
        this.changed.complete();
        this.recovered.complete();
    }
}
