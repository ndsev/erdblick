import {ViewerActionFailure} from '../action/viewer-action-relay.contract';
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
import type {DrawingOperation, DrawingMutation, DrawingReply, DrawingRow, DrawingSummary} from "./drawing.model";
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
    unpublished?: DrawingReply;
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
    private readonly refs = new Map<FilterSubscriptionRef, {mapId: string; token: number; running?: boolean; queued?: boolean}>();
    private serial = 0;
    private readonly mutations = new Map<string, Promise<unknown>>();

    /** Keep catalog and local acquisition ownership separate from the remote transport. */
    constructor(private readonly maps: MapDataService) {}

    /** Tombstones prevent late references to removed documents from reaching a server. */
    owns(mapId: string): boolean { return this.ownedIds.has(mapId); }

    /** Resolve canonical keys with the native helper, including after a local source is removed. */
    ownsKey(mapTileKey: string): boolean {
        try { return this.owns(parseMapPartitionKey(coreLib, mapTileKey)[0]); }
        catch { return false; }
    }

    rename(mapId: string, name: string): void {
        const source = this.sources.get(mapId); if (!source) return;
        source.displayName = name;
        this.maps.renameVirtualSource(mapId, name);
        this.changed.next(mapId);
    }

    /** Convert at the import boundary; coordinate text never enters the source catalog. */
    async convertCoordinates(text: string): Promise<string> {
        const reply = await this.execute({type: 'convert-coordinates', text});
        if (reply.text === undefined) throw new Error('Coordinate conversion returned no GeoJSON.');
        return reply.text;
    }

    /** Create a source atomically; failed import creates no map-tree row. */
    async create(mapId: string, text: string, displayName: string, preview = false, signal?: AbortSignal, publish = true): Promise<VirtualDrawingSource> {
        signal?.throwIfAborted();
        this.ownedIds.add(mapId);
        const reply = await this.execute({type: "create", mapId, text}, preview);
        if (signal?.aborted) { await this.execute({type: 'remove', mapId}, preview); signal.throwIfAborted(); }
        if (!reply.summary || !reply.schema || !reply.dictionary) throw new Error("Incomplete local source initialization.");
        const source: VirtualDrawingSource = {mapId, preview, displayName, summary: reply.summary, text: reply.text ?? text,
            checkpoint: reply.checkpoint, unpublished: reply};
        this.sources.set(mapId, source);
        try { if (publish) this.publishSource(mapId); }
        catch (error) { this.sources.delete(mapId); this.maps.removeVirtualSource(mapId); await this.execute({type:'remove',mapId},preview); throw error; }
        return source;
    }

    /** Reveal a prepared source only after its collection envelope has committed. */
    publishSource(mapId: string): void {
        const source=this.sources.get(mapId),reply=source?.unpublished;
        if(!source||!reply)return;
        this.maps.registerVirtualSource({...source.summary.metadata,sourceId:mapId,displayName:source.displayName,
            renderLane:source.preview?'drawing-preview':undefined,transient:source.preview},
            {schemaId:source.summary.metadata.schemaId!,bytes:reply.schema!},reply.dictionary!);
        source.unpublished=undefined;this.changed.next(mapId);
    }

    /** Publish a valid source edit; a rejected candidate leaves the accepted native model intact. */
    async change(operation: DrawingMutation | Extract<DrawingOperation, {type: 'tool'}>, signal?: AbortSignal, accept?: () => boolean): Promise<DrawingReply> {
        const previous = this.mutations.get(operation.mapId) ?? Promise.resolve();
        const pending = previous.catch(() => undefined).then(() => this.publishChange(operation, signal, accept));
        this.mutations.set(operation.mapId, pending);
        try { return await pending; }
        finally { if (this.mutations.get(operation.mapId) === pending) this.mutations.delete(operation.mapId); }
    }

    /** Cancellation is checked after native preparation and before the single publication point. */
    private async publishChange(operation: DrawingMutation | Extract<DrawingOperation, {type: 'tool'}>, signal?: AbortSignal, accept?: () => boolean): Promise<DrawingReply> {
        signal?.throwIfAborted();
        const source = this.sources.get(operation.mapId);
        if (!source) throw new Error("Local document was removed.");
        let reply: DrawingReply;
        if (operation.type === 'tool' || source.preview) reply = await this.execute(operation, source.preview);
        else {
            await this.execute({type: 'prepare', mapId: operation.mapId, operation});
            try {
                signal?.throwIfAborted();
                if (accept && !accept()) throw new Error('Document changed during editing; the newer raw draft was retained.');
                if (this.sources.get(operation.mapId) !== source) throw new Error('Local document was removed.');
            } catch (error) { await this.execute({type: 'cancel', mapId: operation.mapId}).catch(() => undefined); throw error; }
            // Once commit has been sent, return its actual outcome even if the caller cancels.
            reply = await this.execute({type: 'commit', mapId: operation.mapId});
        }
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
    async object(mapId: string, id: string) {
        const source = this.sources.get(mapId);
        if (!source) throw new Error('Drawing no longer exists.');
        return (await this.execute({type: 'object', mapId, id}, source.preview)).object!;
    }
    /** Read a bounded feature branch and exact leaf lexemes for Quick and MCP. */
    async branch(mapId: string, request: Extract<DrawingOperation, {type: 'branch'}>['request']) {
        const source = this.sources.get(mapId);
        if (!source) throw new Error('Drawing no longer exists.');
        return (await this.execute({type: 'branch', mapId, request}, source.preview)).branch!;
    }
    async compose(sources: string[], separate: boolean, collection?: Extract<DrawingOperation, {type:'compose'}>['collection'], ordinary = false): Promise<string[]> {
        return (await this.execute({type: 'compose', sources, separate, collection, ordinary})).sources!;
    }

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
            if (state.running) { state.queued = true; return; }
            state.running = true;
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
            }).finally(() => {
                state.running = false;
                if(state.queued && !ref.released){state.queued=false;this.updateFilterSubscription(ref,true);}
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
            if (operation.type === "replace" || operation.type === "create" || operation.type === "rows" || operation.type === "branch" || operation.type === "object" || operation.type === "prepare" || operation.type === "convert-coordinates") {
                return this.worker.request(operation);
            }
            throw new ViewerActionFailure({code:'busy',reason:'worker_recovered',outcome:'not_applied',message:'The drawing worker restarted. Its last published document was restored; read the revision before retrying.'});
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
            if(source.unpublished){source.unpublished=reply;continue;}
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
