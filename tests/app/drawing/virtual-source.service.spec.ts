import '@angular/compiler';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {coreLib, uint8ArrayToWasmOrThrow} from '../../../app/integrations/wasm.adapter';
import {Subject} from 'rxjs';
import {DrawingToolsService} from '../../../app/drawing/drawing-tools.service';
import type {MapViewService} from '../../../app/mapview/mapview.service';
import {DrawingRuntime} from '../../../app/drawing/drawing-runtime.adapter';
import {DrawingWorkerClient, DrawingWorkerStoppedError} from '../../../app/drawing/drawing-worker.client';
import {VirtualSourceService} from '../../../app/drawing/virtual-source.service';
import {EMPTY_DRAWING, type DrawingOperation, type DrawingReply} from '../../../app/drawing/drawing.model';
import type {TileSubsetDelivery} from '../../../app/mapdata/filter-subscription.model';
import {EditorService} from '../../../app/editor/editor.service';
import {DrawingDocumentsService} from '../../../app/drawing/drawing-documents.service';
import {DrawingStorageService} from '../../../app/drawing/drawing-storage.service';
import {stateOwners, testPersistence} from '../../support/state-owners';

const geo = (text: string) => coreLib.drawingCoordinatesToGeoJson(text);

const disposers: Array<() => void> = [];
afterEach(() => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
    vi.restoreAllMocks();
    for (const key of Object.keys(localStorage)) if ((key.startsWith('drawingDocumentData:') || key.startsWith('drawingCollectionData:'))) localStorage.removeItem(key);
});

/** Exercise real WASM documents and parser, substituting only the asynchronous Worker transport. */
function fixture() {
    let runtime = new DrawingRuntime();
    const request = vi.spyOn(DrawingWorkerClient.prototype, 'request').mockImplementation(async operation => runtime.execute(operation));
    const parser = new coreLib.TileLayerParser();
    const maps = {
        tileLayerParser: parser,
        registerVirtualSource: vi.fn((metadata, schema, dictionary) => {
            uint8ArrayToWasmOrThrow(bytes => parser.installMapSchema(bytes, schema.schemaId), schema.bytes);
            uint8ArrayToWasmOrThrow(bytes => parser.applyDataSourceChanges(bytes), new TextEncoder().encode(JSON.stringify({removedMapIds: [], addedSources: [metadata]})));
            uint8ArrayToWasmOrThrow(bytes => parser.addFieldDict(bytes), dictionary);
        }),
        installVirtualDictionary: vi.fn((_mapId, dictionary) => uint8ArrayToWasmOrThrow(bytes => parser.addFieldDict(bytes), dictionary)),
        removeVirtualSource: vi.fn(mapId => uint8ArrayToWasmOrThrow(bytes => parser.applyDataSourceChanges(bytes),
            new TextEncoder().encode(JSON.stringify({removedMapIds: [mapId], addedSources: []})))),
        renameVirtualSource: vi.fn()
    };
    const service = new VirtualSourceService(maps as never);
    disposers.push(() => { service.ngOnDestroy(); runtime.destroy(); parser.delete(); });
    return {service, maps, parser, request, run: (operation: DrawingOperation) => runtime.execute(operation),
        crash: () => { runtime.destroy(); runtime = new DrawingRuntime(); }};
}

const definition = {mapId: 'drawing-test', layerId: 'Drawing', channels: [{channelId: 'points', scope: 'feature' as const,
    rewrite: false, featureTypes: [], featureFields: ['attributes.drawing.description'], entryFields: [], geometryTypes: 1}]};
const coverage = {partitions: [{kind: 'object' as const, id: '0'}]};

describe('Virtual source acquisition', () => {
    it('delivers real local filter bytes and exact snapshots, then retains removed ownership as a tombstone', async () => {
        const {service, parser} = fixture();
        await service.create('drawing-test', geo('0 0 "café"\n1 1 other\n'), 'example.txt');
        const deliveries: TileSubsetDelivery[] = [];
        service.subscribe(definition, coverage, {onTile: tile => { deliveries.push(tile); return {status: 'accepted', valueVersion: deliveries.length}; }});
        await vi.waitFor(() => expect(deliveries).toHaveLength(1));
        const tile = uint8ArrayToWasmOrThrow(bytes => parser.readTileSubsetLayer(bytes), deliveries[0].blob);
        expect(tile.numEntries()).toBe(2); tile.delete();
        const row = (await service.rows('drawing-test', 0, 1))[0];
        const target = {mapTileKey: deliveries[0].mapTileKey, featureId: row.featureId};
        const features = await service.loadFeatures([target]);
        expect(features).toHaveLength(1);
        expect(features[0].featureTile.hasIncomingRelations(target.featureId)).toBe(false);
        await expect(features[0].featureTile.loadIncoming(target.featureId, new AbortController().signal)).rejects.toThrow('local drawings');
        await service.remove('drawing-test');
        expect(service.ownsKey(target.mapTileKey)).toBe(true);
        expect(await service.loadFeatures([target])).toEqual([]);
    });

    it('ignores a released subscription reply and does not block the preview lane behind imports', async () => {
        const {service, request, run} = fixture();
        await service.create('drawing-test', geo('0 0 point\n'), 'example.txt');
        let finish!: (reply: DrawingReply) => void;
        request.mockImplementationOnce(operation => new Promise(resolve => { finish = () => resolve(run(operation)); }));
        const onTile = vi.fn(() => ({status: 'accepted' as const, valueVersion: 1}));
        const ref = service.subscribe(definition, coverage, {onTile});
        await Promise.resolve();
        await service.create('drawing-preview', EMPTY_DRAWING, 'Preview', true);
        await service.change({type: 'tool', mapId: 'drawing-preview', text: '{"points":[[0,0],[1,0]]}', preview: true});
        expect(service.sources.has('drawing-preview')).toBe(true);
        ref.release(); finish({}); await Promise.resolve(); await Promise.resolve();
        expect(onTile).not.toHaveBeenCalled();
    });

    it('restores accepted sources after a lost worker heap before retrying source replacement', async () => {
        const {service, maps, request, crash} = fixture();
        await service.create('drawing-test', geo('1 1 retired\n0 0 old\n'), 'example.txt');
        await service.change({type: 'replace', mapId: 'drawing-test', text: geo('0 0 old\n')});
        const recovered = vi.fn(); service.recovered.subscribe(recovered);
        request.mockImplementationOnce(async () => { crash(); throw new DrawingWorkerStoppedError('crashed'); });
        await service.change({type: 'replace', mapId: 'drawing-test', text: geo('0 0 new\n')});
        expect(maps.removeVirtualSource).toHaveBeenCalledWith('drawing-test', true);
        expect(recovered).toHaveBeenCalledWith('drawing-test');
        expect((await service.rows('drawing-test', 0, 1))[0].description).toBe('new');
        expect((await service.rows('drawing-test', 0, 1))[0].id).toBe('2');
        await service.change({type: 'append', mapId: 'drawing-test', longitude: 2, latitude: 2, description: 'next'});
        expect((await service.rows('drawing-test', 0, 2))[1].id).toBe('3');
    });
});

describe('Drawing editor transactions', () => {
    it('retains invalid source separately, restores geometry on discard, and leaves failed saves dirty', async () => {
        const {service, maps} = fixture();
        const persistence = testPersistence(), owners = stateOwners(persistence), editors = new EditorService();
        const docs = new DrawingDocumentsService(service, editors, {open: vi.fn()} as never,
            {} as never, owners.viewSettings);
        disposers.push(() => { docs.ngOnDestroy(); persistence.ngOnDestroy(); });
        await docs.create('geojson', 'input.geojson', geo('0 0 original\n'), true);
        const doc = [...docs.documents.values()][0];
        editors.updateSessionSource(doc.sessionId, 'invalid draft'); await docs.validate(doc);
        expect(doc.error).not.toBe(''); expect(service.sources.get(doc.mapId)?.text).toBe(geo('0 0 original\n'));
        expect(docs.dirty(doc)).toBe(true);
        expect(await docs.discard(doc)).toBe(true); expect(docs.dirty(doc)).toBe(false);
        editors.updateSessionSource(doc.sessionId, geo('1 1 revised\n')); await docs.validate(doc);
        const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage full', 'QuotaExceededError'); });
        expect(await docs.save(doc)).toBe(false);
        expect(docs.dirty(doc)).toBe(true); expect(doc.saving).toBe(false);
        expect(doc.storageError).toContain('Storage full');
        write.mockRestore();
        const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
        expect(await docs.save(doc)).toBe(true);
        expect(download).not.toHaveBeenCalled();
        expect(docs.dirty(doc)).toBe(false);
        const stored = new DrawingStorageService().load().documents[0];
        expect(stored.baseline ?? stored.source).toBe(doc.draft);
        editors.updateSessionSource(doc.sessionId, geo('2 2 exported draft\n')); await docs.validate(doc);
        await docs.exportFile(doc);
        expect(download).toHaveBeenCalledOnce(); expect(docs.dirty(doc)).toBe(true);

    });
});

/** A fresh document owner models a page reload; the browser storage remains shared. */
function documentFixture() {
    const {service, maps} = fixture();
    const persistence = testPersistence(), owners = stateOwners(persistence), editors = new EditorService();
    owners.viewSettings.mode2dState.next(0, true);
    const workspace = {open: vi.fn(), entries: [] as Array<{descriptor: {target: string}}>, requestClose: vi.fn()};
    const docs = new DrawingDocumentsService(service, editors, workspace as never, {} as never, owners.viewSettings);
    disposers.push(() => { docs.ngOnDestroy(); persistence.ngOnDestroy(); });
    return {docs, editors, service, workspace, owners, persistence};
}

describe('Drawing browser persistence', () => {
    it('restores unified GeoJSON documents and joined polygons with their local-save baselines', async () => {
        const first = documentFixture();
        const coordinates = '\ufeff0\t0\t12.5\t"café"\r\n1 0 second\n1 1 third\r\n';
        const geojson = '{"type":"Feature","id":9007199254740993,"geometry":{"type":"Point","coordinates":[2,3]},"properties":{"name":"Original"}}\r\n';
        await first.docs.create('coordinates', 'points.txt', coordinates, true);
        await first.docs.create('geojson', 'data.geojson', geojson, true);
        const [points, feature] = [...first.docs.documents.values()];
        expect(points.name).toBe('points.geojson');
        expect(first.service.sources.get(points.mapId)?.text).toBe(geo(coordinates));
        await first.docs.edit(points, {type: 'description', mapId: points.mapId, id: (await first.service.rows(points.mapId, 0, 1))[0].id, description: 'edited café'});
        await first.docs.edit(points, {type: 'join', mapId: points.mapId, ids: (await first.service.rows(points.mapId, 0, 3)).map(row => row.id)});
        expect(points.notice).toBe('');
        expect(first.service.sources.get(points.mapId)?.summary.joined).toBe(true);
        const stored = new DrawingStorageService().load().documents;
        expect(stored).toHaveLength(2);
        expect(stored.every(record => record.schemaVersion === 2 && !('kind' in record))).toBe(true);
        expect(stored.find(row => row.mapId === feature.mapId)?.source).toBe(geojson);
        expect(stored.find(row => row.mapId === feature.mapId)?.baseline).toBeUndefined();
        const second = documentFixture();
        await second.docs.restore(); await second.docs.restore();
        expect(second.docs.documents.size).toBe(2);
        const restored = second.docs.documents.get(points.mapId)!;
        expect(restored.draft).toBe(points.draft);
        expect(restored.baseline).toBe(geo(coordinates));
        expect(second.docs.dirty(restored)).toBe(true);
        expect(second.docs.dirty(second.docs.documents.get(feature.mapId)!)).toBe(false);
        expect(second.service.sources.get(points.mapId)?.summary.joined).toBe(true);
        expect(second.workspace.open).not.toHaveBeenCalled();
        expect(await second.docs.discard(restored)).toBe(true);
        expect(second.service.sources.has(points.mapId)).toBe(false);
        expect(second.docs.unloadUnsafe).toBe(false);
    });

    it('flushes an unvalidated invalid draft while retaining accepted geometry and disk baseline across reload', async () => {
        const first = documentFixture();
        await first.docs.create('coordinates', 'draft.txt', '0 0 baseline\n', true);
        const original = [...first.docs.documents.values()][0];
        first.editors.updateSessionSource(original.sessionId, geo('1 1 accepted\n')); await first.docs.validate(original);
        first.editors.updateSessionSource(original.sessionId, 'unfinished draft');
        expect(original.storagePending).toBe(true);
        first.docs.flushPersistence();
        expect(first.docs.unloadUnsafe).toBe(false);
        first.docs.ngOnDestroy();
        const second = documentFixture();
        await second.docs.restore();
        const restored = second.docs.documents.get(original.mapId)!;
        expect(restored.draft).toBe('unfinished draft');
        expect(second.docs.trayVisible).toBe(true);
        expect(second.docs.workingIds).toContain(original.mapId);
        expect(restored.baseline).toBe(geo('0 0 baseline\n'));
        expect(restored.error).not.toBe('');
        expect((await second.service.rows(restored.mapId, 0, 1))[0].description).toBe('accepted');
        expect(second.service.sources.get(restored.mapId)?.text).toBe(geo('1 1 accepted\n'));
        expect(second.docs.unloadUnsafe).toBe(false);
    });

    it('retains the previous stored revision on quota failure and allows a retry without losing live work', async () => {
        const {docs, editors, service} = documentFixture();
        await docs.create('coordinates', 'quota.txt', '0 0 original\n', true);
        const doc = [...docs.documents.values()][0];
        const key = 'drawingDocumentData:' + doc.mapId, original = localStorage.getItem(key);
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage full', 'QuotaExceededError'); });
        editors.updateSessionSource(doc.sessionId, geo('1 1 edited\n')); await docs.validate(doc);
        expect(doc.draft).toBe(geo('1 1 edited\n'));
        expect(service.sources.get(doc.mapId)?.text).toBe(doc.draft);
        expect(localStorage.getItem(key)).toBe(original);
        expect(doc.storageError).toContain('Browser copy not updated'); expect(docs.unloadUnsafe).toBe(true);
        setItem.mockRestore(); docs.persist(doc);
        expect(doc.storageError).toBe(''); expect(docs.unloadUnsafe).toBe(false);
        expect(JSON.parse(localStorage.getItem(key)!).source).toBe(doc.draft);
    });

    it('keeps a document visible when storage deletion fails and never restores a successfully removed map', async () => {
        const first = documentFixture();
        await first.docs.create('coordinates', 'remove.txt', '0 0 original\n', true);
        const doc = [...first.docs.documents.values()][0];
        // The UI uses a managed confirmation; false below represents its confirmed command.
        const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
        await first.docs.remove(doc.mapId,false);
        expect(first.docs.documents.has(doc.mapId)).toBe(true);
        expect(doc.storageError).toContain('Could not remove');
        remove.mockRestore(); await first.docs.remove(doc.mapId,false);
        expect(first.docs.documents.size).toBe(0);
        const second = documentFixture(); await second.docs.restore();
        expect(second.docs.documents.size).toBe(0);
    });

    it('isolates malformed, unsupported and native-invalid records without overwriting their browser copies', async () => {
        const first = documentFixture();
        await first.docs.create('coordinates', 'valid.txt', '0 0 valid\n', true);
        const [valid] = new DrawingStorageService().load().documents;
        const invalid = {...valid, mapId: 'drawing-' + crypto.randomUUID(), name: 'invalid.txt', source: 'bad source'};
        const unsupported = {...valid, mapId: 'drawing-' + crypto.randomUUID(), schemaVersion: 1};
        localStorage.setItem('drawingDocumentData:broken', '{broken');
        localStorage.setItem('drawingDocumentData:' + invalid.mapId, JSON.stringify(invalid));
        localStorage.setItem('drawingDocumentData:' + unsupported.mapId, JSON.stringify(unsupported));
        const second = documentFixture(); await second.docs.restore();
        expect(second.docs.documents.size).toBe(1);
        expect(second.docs.restoreErrors).toHaveLength(3);
        expect(localStorage.getItem('drawingDocumentData:broken')).toBe('{broken');
        expect(localStorage.getItem('drawingDocumentData:' + invalid.mapId)).toBe(JSON.stringify(invalid));
        expect(localStorage.getItem('drawingDocumentData:' + unsupported.mapId)).toBe(JSON.stringify(unsupported));
    });

    it('detects already stored changes from another tab and preserves its unrelated imports', async () => {
        const first = documentFixture();
        await first.docs.create('coordinates', 'shared.txt', '0 0 original\n', true);
        const original = [...first.docs.documents.values()][0];
        const second = documentFixture(); await second.docs.restore();
        const newer = second.docs.documents.get(original.mapId)!;
        second.editors.updateSessionSource(newer.sessionId, geo('2 2 other tab\n')); await second.docs.validate(newer);
        await second.docs.create('geojson', 'other.geojson');
        // Flush text without calling the first page's replaced worker transport.
        first.editors.updateSessionSource(original.sessionId, geo('1 1 this tab\n')); first.docs.flushPersistence();
        expect(original.storageError).toContain('another tab');
        expect(new DrawingStorageService().load().documents).toHaveLength(2);
        expect(JSON.parse(localStorage.getItem('drawingDocumentData:' + original.mapId)!).source).toBe(geo('2 2 other tab\n'));
        first.docs.ngOnDestroy();
    });

    it('guards reload while a submitted structured edit has not yet returned its source text', async () => {
        const {docs, service} = documentFixture();
        await docs.create('coordinates', 'pending.txt', '0 0 original\n', true);
        const doc = [...docs.documents.values()][0], change = service.change.bind(service);
        let release!: () => void;
        const wait = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(service, 'change').mockImplementationOnce(async (...args) => { await wait; return change(...args); });
        const edit = docs.edit(doc, {type: 'description', mapId: doc.mapId, id: (await service.rows(doc.mapId, 0, 1))[0].id, description: 'pending edit'});
        docs.flushPersistence();
        expect(docs.unloadUnsafe).toBe(true);
        release(); await edit;
        expect(docs.unloadUnsafe).toBe(false);
        expect(new DrawingStorageService().load().documents[0].source).toContain('pending edit');
    });

    it.each(['{"type":"Point","coordinates":[2,2]}', 'unfinished newer draft'])(
        'does not overwrite a newer raw draft when an older structured operation returns: %s', async draft => {
            const {docs, service, editors} = documentFixture();
            await docs.create('coordinates', 'race.txt', '0 0 original\n', true);
            const doc = [...docs.documents.values()][0], change = service.change.bind(service);
            let release!: () => void;
            const wait = new Promise<void>(resolve => { release = resolve; });
            vi.spyOn(service, 'change').mockImplementationOnce(async (...args) => { await wait; return change(...args); });
            const edit = docs.edit(doc, {type: 'description', mapId: doc.mapId, id: (await service.rows(doc.mapId, 0, 1))[0].id, description: 'structured edit'});
            editors.updateSessionSource(doc.sessionId, draft);
            release(); await expect(edit).rejects.toThrow(/changed during editing|newer raw draft/);
            expect(doc.draft).toBe(draft);
            expect(editors.getSessionSource(doc.sessionId)).toBe(draft);
            const stored = new DrawingStorageService().load().documents[0];
            expect(stored.draft ?? stored.source).toBe(draft);
            expect(!!doc.error).toBe(draft.startsWith('unfinished'));
            expect(docs.unloadUnsafe).toBe(false);
        });


});


describe('Measurement GeoJSON documents', () => {
    it('retains and restores completed geometry, stops input before editing, and deletes stored results', async () => {
        const first = documentFixture();
        const views = {drawingChanged: new Subject(), drawingViewBounds: new Map(), viewStateChanged: new Subject(), setMapLayerVisibility: vi.fn()} as unknown as MapViewService;
        const tools = new DrawingToolsService(first.owners.drawing, first.service, first.docs, views, first.owners.viewSettings);
        disposers.push(() => tools.ngOnDestroy());
        await tools.select('distance');
        const view = first.owners.viewSettings.viewIdAt(0);
        views.drawingInput!.click(view, [179, 0]); views.drawingInput!.click(view, [-179, 0]);
        await tools.close(); // Includes the latest queued click before detaching the producer.
        expect(first.docs.documents.size).toBe(1);
        const doc = [...first.docs.documents.values()][0];
        expect(doc.name).toBe('Untitled drawing'); expect(first.docs.closeDialog).toBe(true);
        const geojson = JSON.parse(doc.draft);
        expect(geojson.type).toBe('FeatureCollection');
        expect(geojson.features).toHaveLength(1);
        expect(geojson.features[0]['erdblick:drawing'].measurements.distances).toBe(true);
        expect(geojson.features[0].geometry.type).toBe('MultiLineString');
        expect(first.service.sources.has(doc.mapId)).toBe(true);
        const second = documentFixture(); await second.docs.restore();
        expect(second.docs.documents.get(doc.mapId)?.draft).toBe(doc.draft);
        // A new active measurement relinquishes its producer before the same Editor opens.
        const secondTools = new DrawingToolsService(second.owners.drawing, second.service, second.docs, views, second.owners.viewSettings);
        disposers.push(() => secondTools.ngOnDestroy());
        second.docs.openTray([]); await secondTools.select('point'); views.drawingInput!.click(view, [0, 0]); await secondTools.pause();
        await vi.waitFor(() => expect(second.docs.documents.size).toBe(2));
        const active = [...second.docs.documents.values()].find(item => item.mapId !== doc.mapId)!;
        await second.docs.open(active.mapId);
        expect(secondTools.active).toBe(false); expect(secondTools.visible).toBe(true);
        expect(active.stopInput).toBeUndefined(); expect((await second.service.rows(active.mapId, 0, 10))).toHaveLength(1);
        await second.docs.edit(active, {type: 'description', mapId: active.mapId, id: (await second.service.rows(active.mapId, 0, 1))[0].id, description: 'measured point'});
        expect(JSON.parse(active.draft).features[0].properties.description).toBe('measured point');
        // The UI uses a managed confirmation; false below represents its confirmed command.
        await second.docs.remove(doc.mapId,false);
        expect(localStorage.getItem('drawingDocumentData:' + doc.mapId)).toBeNull();
        expect(second.service.sources.has(doc.mapId)).toBe(false);
    });
});


describe('Local document deletion ownership', () => {
    it('waits for a submitted description edit before honoring confirmed deletion', async () => {
        const {docs, service} = documentFixture();
        const doc = await docs.create('coordinates', 'delete.txt', '0 0 point\n');
        const change = service.change.bind(service);
        let release!: () => void;
        const wait = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(service, 'change').mockImplementationOnce(async (...args) => { await wait; return change(...args); });
        const edit = docs.edit(doc, {type: 'description', mapId: doc.mapId, id: (await service.rows(doc.mapId, 0, 1))[0].id, description: 'updated'});
        // The UI uses a managed confirmation; false below represents its confirmed command.
        const remove = docs.remove(doc.mapId,false);
        expect(docs.documents.has(doc.mapId)).toBe(true);
        release(); await edit; await remove;
        expect(docs.documents.has(doc.mapId)).toBe(false);
        expect(service.sources.has(doc.mapId)).toBe(false);
        expect(localStorage.getItem('drawingDocumentData:' + doc.mapId)).toBeNull();
    });

    it('drains a pending Clear before opening the active measurement document', async () => {
        const {docs, service, owners} = documentFixture();
        const views = {drawingChanged: new Subject(), drawingViewBounds: new Map(), viewStateChanged: new Subject(), setMapLayerVisibility: vi.fn()} as unknown as MapViewService;
        const tools = new DrawingToolsService(owners.drawing, service, docs, views, owners.viewSettings);
        disposers.push(() => tools.ngOnDestroy());
        await tools.select('point'); views.drawingInput!.click(owners.viewSettings.viewIdAt(0), [0, 0]);
        await vi.waitFor(() => expect(JSON.parse([...docs.documents.values()][0]?.draft ?? '{}').features).toHaveLength(1));
        const doc = [...docs.documents.values()][0];
        const edit = docs.edit.bind(docs);
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const wait = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(docs, 'edit').mockImplementationOnce(async (...args) => { entered(); await wait; return edit(...args); });
        const clear = tools.clear(); await started;
        let opened = false;
        const open = docs.open(doc.mapId).then(() => { opened = true; });
        await Promise.resolve(); expect(opened).toBe(false); expect(tools.pendingUpdates).toBe(true);
        release(); await clear; await open;
        expect(tools.active).toBe(false); expect(tools.pendingUpdates).toBe(false);
        expect(JSON.parse(doc.draft).features).toEqual([]);
        expect(doc.stopInput).toBeUndefined();
    });
});


describe('Deletion while raw validation advances', () => {
    it('drains newly queued validation before closing the already-confirmed Editor', async () => {
        const {docs, service, editors, workspace} = documentFixture();
        const doc = await docs.create('coordinates', 'queued.txt', '0 0 point\n');
        workspace.entries.push({descriptor: {target: doc.mapId}});
        workspace.requestClose.mockImplementation(() => { expect(doc.busy).toBe(false); });
        const change = service.change.bind(service);
        let firstRelease!: () => void, secondRelease!: () => void, secondStarted!: () => void;
        const firstWait = new Promise<void>(resolve => { firstRelease = resolve; });
        const secondWait = new Promise<void>(resolve => { secondRelease = resolve; });
        const secondEntered = new Promise<void>(resolve => { secondStarted = resolve; });
        vi.spyOn(service, 'change').mockImplementationOnce(async operation => { await firstWait; return change(operation); })
            .mockImplementationOnce(async operation => { secondStarted(); await secondWait; return change(operation); });
        editors.updateSessionSource(doc.sessionId, geo('1 1 first\n'));
        const firstValidation = docs.validate(doc);
        await Promise.resolve();
        // The UI uses a managed confirmation; false below represents its confirmed command.
        const removal = docs.remove(doc.mapId,false);
        await Promise.resolve();
        editors.updateSessionSource(doc.sessionId, geo('2 2 second\n'));
        const secondValidation = docs.validate(doc);
        firstRelease(); await secondEntered;
        expect(workspace.requestClose).not.toHaveBeenCalled();
        secondRelease(); await Promise.all([firstValidation, secondValidation, removal]);
        expect(workspace.requestClose).toHaveBeenCalledTimes(1);
        expect(docs.documents.has(doc.mapId)).toBe(false);
    });
});


describe('Drawing tool geometry', () => {
    it('snaps the live cursor and committed endpoint identically, and retains segment/total labels and color', async () => {
        const {docs, service, owners} = documentFixture();
        const views = {drawingChanged: new Subject(), drawingViewBounds: new Map(), viewStateChanged: new Subject(), setMapLayerVisibility: vi.fn()} as unknown as MapViewService;
        const tools = new DrawingToolsService(owners.drawing, service, docs, views, owners.viewSettings);
        disposers.push(() => tools.ngOnDestroy());
        await tools.select('distance'); tools.setColor('#123abc');
        const view = owners.viewSettings.viewIdAt(0);
        views.drawingInput!.click(view, [0, 0]);
        views.drawingInput!.move(view, [1, .8], true);
        const snapped = tools.cursor!;
        expect(snapped).not.toEqual([1, .8]);
        tools.setShift(false); expect(tools.cursor).toEqual([1, .8]);
        views.drawingInput!.click(view, [1, .8], true);
        expect(tools.points[1]).toEqual(snapped);
        await tools.close();
        const features = JSON.parse([...docs.documents.values()][0].draft).features;
        expect(features.every((f: {properties: {color: string}}) => f.properties.color === '#123abc')).toBe(true);
        expect(features).toHaveLength(1); expect(features[0]['erdblick:drawing'].measurements.distances).toBe(true);
        const evaluated = JSON.parse(coreLib.drawingEvaluate(JSON.stringify({authoring: features[0]['erdblick:drawing']}))); expect(evaluated.decorations).toHaveLength(2);
    });

    it('measures area and angles, then captures a freehand stroke without taking clicks in another view', async () => {
        const {docs, service, owners} = documentFixture();
        const views = {drawingChanged: new Subject(), drawingViewBounds: new Map(), viewStateChanged: new Subject(), setMapLayerVisibility: vi.fn()} as unknown as MapViewService;
        const tools = new DrawingToolsService(owners.drawing, service, docs, views, owners.viewSettings);
        disposers.push(() => tools.ngOnDestroy());
        const view = owners.viewSettings.viewIdAt(0);
        await tools.select('area');
        for (const point of [[0, 0], [1, 0], [1, 1], [0, 1]] as [number, number][]) views.drawingInput!.click(view, point);
        expect(tools.areaSquareMeters).toBeCloseTo(12308778361.46945, 1);
        owners.drawing.unit.next('miles'); expect(tools.formatArea(tools.areaSquareMeters)).toContain('mi²');
        await tools.select('angle');
        for (const point of [[0, 1], [0, 0], [1, 0]] as [number, number][]) views.drawingInput!.click(view, point);
        expect(tools.angleDegrees).toBe(90); expect(tools.active).toBe(false);
        await tools.select('pen');
        expect(views.drawingInput!.down('other-view', [0, 0])).toBe(false);
        expect(views.drawingInput!.down(view, [0, 0])).toBe(true);
        views.drawingInput!.move(view, [1, 1]);
        await new Promise(resolve => requestAnimationFrame(resolve));
        views.drawingInput!.up(view, [2, 1]);
        expect(tools.points).toHaveLength(3); expect(tools.active).toBe(false);
        await tools.close();
        expect(docs.documents.size).toBe(1);
        const pen = [...docs.documents.values()][0];
        expect(JSON.parse(pen.draft).features).toHaveLength(3);
        expect(JSON.parse(pen.draft).features[2].geometry.type).toBe('LineString');
    });
});

it('does not clear a failed committed shape diagnostic when its cursor preview succeeds', async () => {
    const {docs, service, owners} = documentFixture();
    const views = {drawingChanged: new Subject(), drawingViewBounds: new Map(), viewStateChanged: new Subject(), setMapLayerVisibility: vi.fn()} as unknown as MapViewService;
    const tools = new DrawingToolsService(owners.drawing, service, docs, views, owners.viewSettings);
    disposers.push(() => tools.ngOnDestroy());
    const view = owners.viewSettings.viewIdAt(0);
    tools.start(); views.drawingInput!.click(view, [0, 0]);
    await vi.waitFor(() => expect(tools.pendingUpdates).toBe(false));
    vi.spyOn(docs, 'edit').mockRejectedValueOnce(new Error('Document update failed'));
    views.drawingInput!.click(view, [0, 1]);
    await vi.waitFor(() => expect(tools.error).toBe('Document update failed'));
    views.drawingInput!.move(view, [1, 1]);
    await vi.waitFor(() => expect([...service.sources.values()].some(source => source.preview && source.text.includes('cursor-segment'))).toBe(true));
    expect(tools.error).toBe('Document update failed');
    views.drawingInput!.click(view, [1, 1]);
    await vi.waitFor(() => expect(tools.error).toBe(''));
});


it('keeps completed angle and ellipse input stopped when reopening the palette', async () => {
    const {docs, service, owners} = documentFixture();
    const views = {drawingChanged: new Subject(), drawingViewBounds: new Map(), viewStateChanged: new Subject(), setMapLayerVisibility: vi.fn()} as unknown as MapViewService;
    const tools = new DrawingToolsService(owners.drawing, service, docs, views, owners.viewSettings);
    disposers.push(() => tools.ngOnDestroy());
    const view = owners.viewSettings.viewIdAt(0);
    for (const mode of ['angle', 'ellipse'] as const) {
        await tools.select(mode);
        for (const point of (mode === 'angle' ? [[0, 1], [0, 0], [1, 0]] : [[0, 0], [1, 1]]) as [number, number][])
            views.drawingInput!.click(view, point);
        const count = tools.points.length;
        tools.start();
        expect(tools.visible).toBe(true); expect(tools.active).toBe(false);
        expect(views.drawingInput!.click(view, [2, 2])).toBe(false);
        expect(tools.points).toHaveLength(count);
        tools.backspace(); tools.start(); expect(tools.active).toBe(true); await tools.clear();
    }
    await tools.close();
});

describe('Phase 0+ working sets and domain dispatch', () => {
    it('recovers an incomplete draft separately from valid GeoJSON and discards it without a saved copy', async () => {
        const first = documentFixture();
        const views = {drawingChanged:new Subject(),drawingViewBounds:new Map(),viewStateChanged:new Subject(),setMapLayerVisibility:vi.fn()} as unknown as MapViewService;
        const tools = new DrawingToolsService(first.owners.drawing,first.service,first.docs,views,first.owners.viewSettings);
        disposers.push(()=>tools.ngOnDestroy()); tools.start(); views.drawingInput!.click(first.owners.viewSettings.viewIdAt(0),[10,20]);
        await tools.pause(); first.docs.flushPersistence();
        const doc = first.docs.workingDocuments[0]; expect(JSON.parse(doc.draft).features).toEqual([]);
        expect(doc.pendingObject?.authoring.points).toEqual([[10,20]]);
        const restored = documentFixture(); await restored.docs.restore();
        const resumed = new DrawingToolsService(restored.owners.drawing,restored.service,restored.docs,views,restored.owners.viewSettings);
        disposers.push(()=>resumed.ngOnDestroy()); resumed.start();
        await vi.waitFor(()=>expect(resumed.points).toEqual([[10,20]]));
        expect(await restored.docs.saveWorkingSet('Incomplete','one')).toBe(false);
        await restored.docs.discardWorkingSet(); expect(new DrawingStorageService().load().documents).toEqual([]);
    });
    it('atomically saves separate objects, reopens the collection and repacks to one document', async () => {
        const first = documentFixture(); const doc = await first.docs.create('geojson','Draft',geo('1 1 a\n2 2 b\n'),false,{openEditor:false}); first.docs.openTray([doc.mapId]);
        const originalSet = Storage.prototype.setItem;
        const write = vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(this: Storage,key,value){if(key.startsWith('drawingCollectionData:'))throw new DOMException('Full','QuotaExceededError');originalSet.call(this,key,value);});
        expect(await first.docs.saveWorkingSet('Collection','separate')).toBe(false); expect(first.docs.documents.has(doc.mapId)).toBe(true);
        expect(new DrawingStorageService().load().documents).toHaveLength(1); write.mockRestore();
        expect(await first.docs.saveWorkingSet('Collection','separate')).toBe(true);
        expect(first.docs.workingDocuments).toHaveLength(2);
        const members = first.docs.workingIds.slice();
        expect(members.every(id=>localStorage.getItem('drawingDocumentData:'+id)===null)).toBe(true);
        const second = documentFixture(); await second.docs.restore(); second.docs.openTray([members[1]]);
        expect(second.docs.workingIds).toEqual(members);
        expect(await second.docs.saveWorkingSet('Unified','one')).toBe(true);
        expect(second.docs.workingDocuments).toHaveLength(1); expect(JSON.parse(second.docs.workingDocuments[0].draft).features).toHaveLength(2);
        const stored = new DrawingStorageService().load(); expect(stored.errors).toEqual([]); expect(stored.documents).toHaveLength(1);
        const stale = first.docs.workingDocuments[0]; expect(first.docs.persist(stale)).toBe(false); expect(stale.storageError).toContain('another tab');
    });
    it('uses actual registry and MCP dispatch for revisions, edits, undo, staged transfer and cancellation', async () => {
        const {AppActionRegistry} = await import('../../../app/action/action-registry.service');
        const {McpActionService} = await import('../../../app/action/mcp-action.service');
        const f = documentFixture(), registry = new AppActionRegistry(f.persistence); registry.registerContributors([f.docs]);
        const zone = {run:(fn:()=>unknown)=>fn(),runOutsideAngular:(fn:()=>unknown)=>fn()};
        const mcp = new McpActionService(f.persistence,registry,zone as never,{} as never,{clear:vi.fn()} as never,{snapshot:{mcpEnabled:true}} as never);
        const call = (name:string,args:Record<string,unknown>)=>mcp.invokeLocal(name,args,new AbortController().signal) as Promise<any>;
        const workspace = await call('viewer_drawing_workspace',{action:'new'}), mapId=workspace.activeId;
        const first = await call('viewer_drawing_objects',{mapId});
        await call('viewer_drawing_edit',{mapId,revision:first.revision,operations:[{type:'insert',feature:{type:'Feature',geometry:null,properties:{name:'Label'},'erdblick:object':'stable','erdblick:drawing':{version:1,kind:'annotation',space:'2d',points:[[0,0]],text:'Plain <b>text</b>'}}}]});
        const rows = await call('viewer_drawing_objects',{mapId}); expect(rows.total).toBe(1);
        await expect(call('viewer_drawing_edit',{mapId,revision:first.revision,operations:[{type:'delete',id:rows.rows[0].id}]})).rejects.toThrow();
        await call('viewer_drawing_edit',{mapId,revision:rows.revision,operations:[{type:'delete',id:rows.rows[0].id}]});
        await call('viewer_drawing_history',{mapId,revision:(await call('viewer_drawing_objects',{mapId})).revision,direction:'undo'}); expect((await call('viewer_drawing_objects',{mapId})).rows[0].id).toBe(rows.rows[0].id);
        const text=geo('10 10 imported\n'), staged=await call('viewer_drawing_transfer',{action:'begin',name:'Import',total:text.length});
        await call('viewer_drawing_transfer',{action:'append',transferId:staged.transferId,offset:0,text});
        const imported=await call('viewer_drawing_transfer',{action:'commit',transferId:staged.transferId});
        expect((await call('viewer_drawing_read',{mapId:imported.mapId})).text).toBe(text);
        const abort = new AbortController(); abort.abort(); expect(()=>registry.execute('viewer_drawing_workspace',{action:'new'},abort.signal)).toThrow();
        mcp.ngOnDestroy();
    });
    it('repartitions a separate collection after objects are added to a member', async () => {
        const f = documentFixture();
        const doc = await f.docs.create('geojson','Draft',geo('1 1 a\n2 2 b\n'),false,{openEditor:false});
        f.docs.openTray([doc.mapId]);
        expect(await f.docs.saveWorkingSet('Collection','separate')).toBe(true);
        const member = f.docs.workingDocuments[0];
        await f.docs.objectEdit(member, [{type:'insert',feature:{type:'Feature',geometry:{type:'Point',coordinates:[3,3]},properties:{name:'Third'}}}]);
        expect(await f.docs.saveWorkingSet('Collection','separate')).toBe(true);
        expect(f.docs.workingDocuments).toHaveLength(3);
        for (const output of f.docs.workingDocuments) expect(JSON.parse(output.draft).features).toHaveLength(1);
        const restored = documentFixture(); await restored.docs.restore();
        restored.docs.openTray([f.docs.workingIds[1]]);
        expect(restored.docs.workingDocuments).toHaveLength(3);
    });
    it('does not append the committed ellipse handle again to its cursor preview', async () => {
        const f = documentFixture();
        const views = {drawingChanged:new Subject(),drawingViewBounds:new Map(),viewStateChanged:new Subject(),setMapLayerVisibility:vi.fn()} as unknown as MapViewService;
        const tools = new DrawingToolsService(f.owners.drawing,f.service,f.docs,views,f.owners.viewSettings);
        disposers.push(()=>tools.ngOnDestroy());
        const notice = vi.spyOn(f.docs, 'notify');
        await tools.select('ellipse');
        const view = f.owners.viewSettings.viewIdAt(0);
        views.drawingInput!.click(view,[0,0]); await tools.pause(); tools.start();
        views.drawingInput!.move(view,[1,1]);
        await vi.waitFor(()=>expect([...f.service.sources.values()].some(source=>source.preview&&source.text.includes('Polygon'))).toBe(true));
        views.drawingInput!.click(view,[1,1]); await tools.pause();
        expect(tools.error).toBe('');
        expect(notice.mock.calls.filter(([scope,text])=>scope==='preview'&&!!text)).toEqual([]);
    });
});


it('preserves imported altitude during a 2D drag and removes stale handles after deletion', async () => {
    const f = documentFixture();
    const views = {drawingChanged:new Subject(),drawingViewBounds:new Map(),viewStateChanged:new Subject(),setMapLayerVisibility:vi.fn()} as unknown as MapViewService;
    const tools = new DrawingToolsService(f.owners.drawing,f.service,f.docs,views,f.owners.viewSettings);
    disposers.push(()=>tools.ngOnDestroy());
    const doc = await f.docs.create('geojson','Height',JSON.stringify({type:'Feature',geometry:{type:'Point',coordinates:[1,2,123]},properties:{}}));
    f.docs.openTray([doc.mapId]);
    const row = (await f.service.rows(doc.mapId,0,1))[0];
    await f.docs.objectEdit(doc,[{type:'author',id:row.id,value:{space:'2d'}}]);
    await tools.editObject(doc.mapId,await f.service.object(doc.mapId,row.id));
    const view = f.owners.viewSettings.viewIdAt(0), path=tools.handles[0].path;
    expect(views.drawingInput!.down(view,[1,2,0],false,path)).toBe(true);
    views.drawingInput!.move(view,[3,4,0]);views.drawingInput!.up(view,[3,4,0]);
    await vi.waitFor(()=>expect(JSON.parse(doc.draft).features[0].geometry.coordinates).toEqual([3,4,123]));
    await f.docs.history('undo');
    expect(JSON.parse(doc.draft).features[0].geometry.coordinates).toEqual([1,2,123]);
    await f.docs.objectEdit(doc,[{type:'delete',id:row.id}]);
    await vi.waitFor(()=>expect(tools.handles).toEqual([]));
    expect(tools.editing).toBeUndefined();
});

it('cancels prepared native edits before publication without consuming identities', async () => {
    const f=fixture();await f.service.create('drawing-test',geo('0 0 retained\n'),'Retained');
    const original=f.service.sources.get('drawing-test')!.text,controller=new AbortController();
    let release!:()=>void,prepared!:()=>void;
    const waiting=new Promise<void>(resolve=>prepared=resolve),gate=new Promise<void>(resolve=>release=resolve);
    f.request.mockImplementation(async operation=>{const reply=f.run(operation);if(operation.type==='prepare'){prepared();await gate;}return reply;});
    const mutation=f.service.change({type:'append',mapId:'drawing-test',longitude:1,latitude:1,description:'Cancelled'},controller.signal);
    await waiting;controller.abort();release();
    await expect(mutation).rejects.toMatchObject({name:'AbortError'});
    expect(f.service.sources.get('drawing-test')!.text).toBe(original);
    expect(await f.service.rows('drawing-test',0,5)).toHaveLength(1);
    await f.service.change({type:'append',mapId:'drawing-test',longitude:2,latitude:2,description:'Committed'});
    expect((await f.service.rows('drawing-test',0,5))[1].id).toBe('2');
});

it('rejects a stale workspace save without saving newly selected members',async()=>{
    const f=documentFixture();
    const first=await f.docs.create('geojson','First',geo('0 0 a\n'),false,{openEditor:false});
    const second=await f.docs.create('geojson','Second',geo('1 1 b\n'),false,{openEditor:false});
    f.docs.openTray([first.mapId]);const captured=f.docs.captureWorkspace();
    f.docs.openTray([second.mapId]);
    await expect(f.docs.saveWorkingSet('Wrong target','one',captured)).rejects.toThrow('Stale workspace');
    expect(first.saved).toBe(false);expect(second.saved).toBe(false);
    await f.docs.selectObject(second.mapId,(await f.service.rows(second.mapId,0,1))[0].id);
    await f.docs.objectEdit(second,[{type:'delete',id:f.docs.selectedObjectId}]);
    expect(f.docs.activeId).toBe(second.mapId);expect(f.docs.canHistory('undo')).toBe(true);
    await f.docs.history('undo');expect(await f.service.rows(second.mapId,0,5)).toHaveLength(1);
});

it('does not publish staged collection members on quota failure',async()=>{
    const f=documentFixture();const doc=await f.docs.create('geojson','Draft',geo('0 0 a\n1 1 b\n'),false,{openEditor:false});
    f.docs.openTray([doc.mapId]);
    const publish=vi.spyOn(f.service,'publishSource');publish.mockClear();
    const write=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('Full','QuotaExceededError');});
    expect(await f.docs.saveWorkingSet('Collection','separate')).toBe(false);
    expect(publish).not.toHaveBeenCalled();expect([...f.service.sources.keys()]).toEqual([doc.mapId]);expect(doc.saved).toBe(false);
    write.mockRestore();
});

it('enforces transfer Unicode, encoded-frame and cumulative UTF-8 limits without changing selection',async()=>{
    const {AppActionRegistry}=await import('../../../app/action/action-registry.service');
    const f=documentFixture(),registry=new AppActionRegistry(f.persistence);registry.registerContributors([f.docs]);
    const call=(input:Record<string,unknown>)=>registry.execute('viewer_drawing_transfer',input) as Promise<any>;
    const begun=await call({action:'begin',total:12_000_000});
    await expect(call({action:'append',transferId:begun.transferId,offset:0,text:'\ud800'})).rejects.toThrow('Unicode');
    await expect(call({action:'append',transferId:begun.transferId,offset:0,text:'\u0000'.repeat(16000)})).rejects.toThrow('byte budget');
    const chunk='界'.repeat(15000);let offset=0;
    while((offset+chunk.length)*3<=32*1024*1024){const next=await call({action:'append',transferId:begun.transferId,offset,text:chunk});offset=next.offset;}
    await expect(call({action:'append',transferId:begun.transferId,offset,text:chunk})).rejects.toThrow('byte budget');
    const status=await call({action:'status',transferId:begun.transferId});expect(status.bytes).toBe(offset*3);expect(status.offset).toBeLessThan(12_000_000);
    expect((await call({action:'cancel',transferId:begun.transferId})).outcome).toBe('not_applied');
    expect(f.docs.activeId).toBe('');expect(f.docs.documents.size).toBe(0);
});

it('moves a selected vertex by destination click, preserves height, cancels and deletes through shared history',async()=>{
    const f=documentFixture();
    const views={drawingChanged:new Subject(),drawingViewBounds:new Map(),viewStateChanged:new Subject(),setMapLayerVisibility:vi.fn()} as unknown as MapViewService;
    const tools=new DrawingToolsService(f.owners.drawing,f.service,f.docs,views,f.owners.viewSettings);
    disposers.push(()=>tools.ngOnDestroy());
    const doc=await f.docs.create('geojson','Click placement',JSON.stringify({type:'Feature',geometry:{type:'Point',coordinates:[1,2,123]},properties:{}}));
    f.docs.openTray([doc.mapId]);const row=(await f.service.rows(doc.mapId,0,1))[0];
    await f.docs.objectEdit(doc,[{type:'author',id:row.id,value:{space:'2d'}}]);await tools.editTarget(doc.mapId,row.id);
    const view=f.owners.viewSettings.viewIdAt(0),path=tools.handles[0].path;
    await f.docs.selectObject(doc.mapId,row.id,path);tools.placeSelectedVertex();expect(tools.placingVertex).toBe(true);
    expect(tools.canDeleteFocusedVertex).toBe(false);
    views.drawingInput!.move(view,[3,4,0]);tools.cancelGesture();expect(JSON.parse(doc.draft).features[0].geometry.coordinates).toEqual([1,2,123]);
    tools.placeSelectedVertex();expect(views.drawingInput!.down(view,[3,4,0])).toBe(true);views.drawingInput!.up(view,[3,4,0]);
    await vi.waitFor(()=>expect(JSON.parse(doc.draft).features[0].geometry.coordinates).toEqual([3,4,123]));
    await vi.waitFor(()=>expect(tools.editing?.object.revision).toBe(f.service.sources.get(doc.mapId)!.summary.revision));
    views.drawingInput!.down(view,[3,4,123],false,path);views.drawingInput!.up(view,[3,4,123]);
    await vi.waitFor(()=>expect(tools.canDeleteFocusedVertex).toBe(true));await tools.deleteSelectedVertex();
    expect((await f.service.rows(doc.mapId,0,5))).toEqual([]);await f.docs.history('undo');expect((await f.service.rows(doc.mapId,0,5))).toHaveLength(1);
});

it('stores a three-anchor plane on an imported 3D polygon without moving its coordinates',async()=>{
    const f=documentFixture();f.owners.viewSettings.mode2dState.next(0,false);
    const views={drawingChanged:new Subject(),drawingViewBounds:new Map(),viewStateChanged:new Subject(),setMapLayerVisibility:vi.fn()} as unknown as MapViewService;
    const tools=new DrawingToolsService(f.owners.drawing,f.service,f.docs,views,f.owners.viewSettings);disposers.push(()=>tools.ngOnDestroy());
    const coordinates=[[0,0,0],[.001,0,10],[0,.001,20],[0,0,0]];
    const doc=await f.docs.create('geojson','Tilted import',JSON.stringify({type:'Feature',geometry:{type:'Polygon',coordinates:[coordinates]},properties:{}}));
    f.docs.openTray([doc.mapId]);const row=(await f.service.rows(doc.mapId,0,1))[0];
    await f.docs.objectEdit(doc,[{type:'author',id:row.id,value:{space:'3d'}}]);await tools.editTarget(doc.mapId,row.id);
    tools.beginPlane('through');const view=f.owners.viewSettings.viewIdAt(0);
    for(const point of coordinates.slice(0,3))views.drawingInput!.click(view,point as [number,number,number]);
    await vi.waitFor(()=>expect(JSON.parse(doc.draft).features[0]['erdblick:drawing'].plane).toBeDefined());
    expect(JSON.parse(doc.draft).features[0].geometry.coordinates).toEqual([coordinates]);
    expect((await f.service.object(doc.mapId,row.id)).metrics?.areaSquareMeters).toBeGreaterThan(0);
    await f.docs.save(doc);expect(JSON.parse(doc.baseline).features[0]['erdblick:drawing'].plane).toBeDefined();
});
