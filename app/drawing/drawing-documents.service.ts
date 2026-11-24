import {ViewerActionFailure} from '../action/viewer-action-relay.contract';
import {z} from 'zod';
import {registerDrawingActions} from './drawing-actions.controller';
import {saveDrawingCollection} from './drawing-collection.controller';
import type {AppActionContributor, AppActionRegistration} from '../action/action-contributor.model';
import {Injectable, OnDestroy, Optional} from '@angular/core';
import {Subject, Subscription} from 'rxjs';
import {EditorService} from '../editor/editor.service';
import {EditorWorkspaceService} from '../editor/editor-workspace.service';
import {MapViewService} from '../mapview/mapview.service';
import {MapViewState} from '../mapview/mapview.state';
import {VirtualSourceService} from './virtual-source.service';
import {DrawingStorageService, StoredDrawingDocument} from './drawing-storage.service';
import {EMPTY_DRAWING, type DrawingObjectEdit, type DrawingFileKind, type DrawingOperation, type DrawingWorkspaceTarget} from './drawing.model';

import {InfoMessageService} from '../diagnostics/info.service';
import type {InfoMessageRef} from '../diagnostics/info-message.model';

/** Browser-backed source document; invalid drafts never replace the accepted native model. */
export interface DrawingDocument {
    mapId: string; name: string; sessionId: string; staged?: boolean;
    draft: string; baseline: string; saved: boolean; busy: boolean; saving: boolean; structuredUpdating: boolean; error: string; notice: string;
    viewId: string;
    pendingObject?: StoredDrawingDocument['pendingObject'];
    revision: number; subscription: Subscription;
    stopInput?: () => Promise<void>;
    mutation?: Promise<void>;
    pending: Promise<void>; timer?: ReturnType<typeof setTimeout>;
    storagePending: boolean; storageError: string; structuredPending: boolean; storageTimer?: ReturnType<typeof setTimeout>;
}

/** Owns file text, validation, browser saves, and the retained Editor sessions. */
@Injectable({providedIn: 'root'})
export class DrawingDocumentsService implements OnDestroy, AppActionContributor {
    workingIds: string[] = [];
    private editingId = '';
    selectedObjectId = '';
    selectedPath = '';
    workspaceId = crypto.randomUUID();
    workspaceRevision = 0;
    workspaceBusy: 'saving' | 'discarding' | undefined;
    trayVisible = false;
    dialog: 'save' | 'close' | undefined;
    closeAfterSave = false;
    deleteTarget = '';
    saveTarget?: DrawingWorkspaceTarget;
    saveDocumentId = '';
    saveName = '';
    lastSaveError = '';
    saveLayout: 'one' | 'separate' = 'one';
    private readonly messages = new Map<string, {text: string; ref?: InfoMessageRef}>();
    readonly messageActions: Record<string, (() => void | Promise<void>) | undefined> = {};
    readonly documents = new Map<string, DrawingDocument>();
    readonly changed = new Subject<void>();
    importKind?: DrawingFileKind;
    importError = '';
    restoring = false;
    readonly restoreErrors: string[] = [];
    private restoration?: Promise<void>;
    private readonly importedCollections = new Map<string, {ids: Map<string, string>; count: number}>();
    private saveResult?: (saved: boolean) => void;
    private readonly subscriptions = new Subscription();

    /** Match history button availability to the same retained state used by Advanced and MCP. */
    canHistory(direction: 'undo' | 'redo'): boolean {
        const doc = this.documents.get(this.activeId);
        return !!doc && !doc.busy && !doc.saving && !this.workspaceBusy && this.editors.canHistory(doc.sessionId, direction);
    }
    get activeId(): string { return this.editingId; }
    get saveDialog(): boolean { return this.dialog === 'save'; }
    get closeDialog(): boolean { return this.dialog === 'close'; }

    /** All surfaces observe one editing identity; hover and keyboard focus never write it. */
    private activate(mapId: string, objectId = '', path = ''): void {
        if (this.editingId !== mapId || this.selectedObjectId !== objectId) this.selectedPath = '';
        this.editingId = mapId; this.selectedObjectId = objectId; this.selectedPath = path;
        this.changed.next();
    }

    /** Capture both accepted and raw revisions so an invalid concurrent draft also invalidates a command. */
    captureWorkspace(): DrawingWorkspaceTarget {
        return {workspaceId: this.workspaceId, workspaceRevision: this.workspaceRevision,
            members: this.workingDocuments.map(doc => ({mapId: doc.mapId,
                revision: this.sources.sources.get(doc.mapId)!.summary.revision, draftRevision: doc.revision}))};
    }

    /** Validate a captured working set before mutation and again after asynchronous preparation. */
    assertWorkspace(target: DrawingWorkspaceTarget, documents = true): void {
        if (target.workspaceId !== this.workspaceId || target.workspaceRevision !== this.workspaceRevision ||
            target.members.length !== this.workingIds.length || target.members.some((member, index) => member.mapId !== this.workingIds[index]))
            throw new Error('Stale workspace revision. The working set changed; review it before retrying.');
        if (documents && target.members.some(member => {
            const doc = this.documents.get(member.mapId);
            return !doc || doc.revision !== member.draftRevision || this.sources.sources.get(member.mapId)?.summary.revision !== member.revision;
        })) throw new Error('Stale document revision. A workspace member changed; review it before retrying.');
    }

    /** Native/catalog ownership remains independent of whether an Editor is open. */
    constructor(public readonly sources: VirtualSourceService, private readonly editors: EditorService,
                private readonly workspace: EditorWorkspaceService,
                private readonly views: MapViewService, private readonly viewState: MapViewState,
                private readonly storage: DrawingStorageService = new DrawingStorageService(),
                @Optional() private readonly info?: InfoMessageService) {
        this.subscriptions.add(sources.recovered.subscribe(mapId => {
            const doc = this.documents.get(mapId);
            if (!doc) return;
            doc.notice = 'Local data recovered after a worker restart.'; this.changed.next();
        }));
    }

    /** Rebuild native models after WASM/catalog startup, without reopening every Editor. */
    restore(): Promise<void> {
        return this.restoration ??= this.restoreDocuments();
    }

    /** A bad saved document does not prevent the viewer or other local maps from loading. */
    private async restoreDocuments(): Promise<void> {
        this.restoring = true; this.changed.next();
        try {
            const stored = this.storage.load();
            this.restoreErrors.push(...stored.errors);
            for (const record of stored.documents) {
                try {
                    const doc = await this.install(record);
                    if (doc.draft !== record.source) await this.validate(doc);
                } catch (error) {
                    this.restoreErrors.push('Could not restore “' + record.name + '”: ' + this.message(error) + '. Its browser copy was retained.');
                }
            }
        } catch (error) {
            this.restoreErrors.push('Could not read saved drawings: ' + this.message(error));
        } finally {
            const drafts = [...this.documents.values()].filter(doc => this.dirty(doc) || !!doc.pendingObject);
            if (drafts.length) this.openTray(drafts.map(doc => doc.mapId));
            for (const error of this.restoreErrors) this.notify('restore', error);
            this.restoring = false; this.changed.next();
        }
    }

    /** Opens the shared new/import choice from either File menu item. */
    begin(kind: DrawingFileKind): void { this.importKind = kind; this.importError = ''; this.changed.next(); }

    /** Read UTF-8 strictly, with the same pre-read limit as the native importer. */
    async importFile(file: File, kind?: DrawingFileKind): Promise<void> {
        try {
            if (file.size > 32 * 1024 * 1024) throw new Error('The file exceeds the 32 MiB limit.');
            const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(await file.arrayBuffer());
            const imported = await this.create(kind ?? (/\.(geojson|json)$/i.test(file.name) ? 'geojson' : 'coordinates'), file.name, text, true);
            this.groupImported(imported, text);
            this.importKind = undefined; this.importError = '';
        } catch (error) { this.importError = this.message(error); }
        this.notify('import', this.importError);
        this.changed.next();
    }

    /** Portable membership is advisory and copied to new local document identities. */
    groupImported(imported: DrawingDocument, text: string, open = true): void {
        const member = this.collectionMetadata(text);
        if (!member || !member.members.some(item => item.id === member.memberId)) return;
        const group = this.importedCollections.get(member.id) ?? {ids: new Map<string, string>(), count: member.members.length};
        group.ids.set(member.memberId, imported.mapId); this.importedCollections.set(member.id, group);
        if (open) this.openTray(member.members.map(item => group.ids.get(item.id) ?? '').filter(Boolean));
        this.notify('import-collection:' + member.id, group.ids.size < group.count
            ? 'Collection import: ' + group.ids.size + ' of ' + group.count + ' files available. Choose the remaining files to complete the group; no files are fetched automatically.' : '');
    }

    private collectionMetadata(text: string) {
        const schema=z.object({version:z.literal(1),id:z.string().max(128),name:z.string().max(256),memberId:z.string().max(128),layout:z.enum(['one','separate']),members:z.array(z.object({id:z.string().max(128),name:z.string().max(256)})).max(1000)});
        try { const parsed=schema.safeParse(JSON.parse(text)['erdblick:collection']); return parsed.success ? parsed.data : undefined; } catch { return undefined; }
    }
    async portableSource(doc: DrawingDocument): Promise<string> {
        const collection=this.collection(doc.mapId); if (!collection) return doc.draft;
        const metadata={version:1 as const,id:collection.id,name:collection.name,layout:collection.layout,members:collection.documents.map(member=>({id:member.mapId,name:member.name}))};
        const sources=collection.documents.map(member=>this.sources.sources.get(member.mapId)?.text ?? member.source);
        return (await this.sources.compose(sources,false,metadata))[collection.documents.findIndex(member=>member.mapId===doc.mapId)];
    }
    /** Convert coordinate input once, then use the same GeoJSON document/session path. */
    async create(kind: DrawingFileKind, name = 'Untitled.geojson',
                 text = kind === 'geojson' ? EMPTY_DRAWING : '', saved = false,
                 options: {openEditor?: boolean; stopInput?: () => Promise<void>; persist?: boolean; signal?: AbortSignal; staged?: boolean} = {}): Promise<DrawingDocument> {
        options.signal?.throwIfAborted();
        if (kind === 'coordinates') {
            text = await this.sources.convertCoordinates(text);
            name = this.geoJsonName(name); saved = false;
        }
        const mapId = 'drawing-' + crypto.randomUUID();
        const doc = await this.install({schemaVersion: 2, mapId, name, source: text, saved}, options.stopInput, options.signal, options.staged);
        if (options.persist !== false) this.persist(doc);
        if (options.openEditor !== false) await this.open(mapId);
        this.importKind = undefined; this.changed.next();
        return doc;
    }

    /** Coordinate files become new GeoJSON files; a previous extension is not retained. */
    private geoJsonName(name: string): string { return name.replace(/\.[^./\\]+$/, '') + '.geojson'; }

    /** Share native/session construction between import and restoration; retain the draft and last local-save baseline separately. */
    private async install(record: StoredDrawingDocument, stopInput?: () => Promise<void>, signal?: AbortSignal, staged = false): Promise<DrawingDocument> {
        const {mapId, name, source, saved} = record;
        await this.sources.create(mapId, source, name, false, signal, !staged);
        const doc: DrawingDocument = {mapId, name, sessionId: mapId, draft: record.draft ?? source, baseline: record.baseline ?? source,
            saved, staged, stopInput, busy: false, saving: false, structuredUpdating: false, error: '', notice: '', viewId: this.viewState.viewIdAt(this.viewState.focusedView),
            pendingObject: record.pendingObject, revision: 0, subscription: new Subscription(), pending: Promise.resolve(),
            storagePending: false, storageError: '', structuredPending: false};
        this.documents.set(mapId, doc);
        const session = this.editors.createSession({id: mapId, source: doc.draft, language: 'json', preserveLineEndings: true});
        doc.subscription.add(session.source$.subscribe(source => {
            if (source === doc.draft) return;
            doc.draft = source; ++doc.revision;
            if (!doc.structuredUpdating) void doc.stopInput?.();
            clearTimeout(doc.timer);
            if (!doc.structuredUpdating) doc.timer = setTimeout(() => { void this.validate(doc); }, 250);
            this.schedulePersistence(doc);
            this.changed.next();
        }));
        doc.subscription.add(session.saveRequested$.subscribe(() => { void this.saveWithDialog(doc); }));
        return doc;
    }

    /** Reveal one document without transferring its text to application persistence. */
    async open(mapId: string): Promise<void> {
        const doc = this.documents.get(mapId);
        if (!doc) return;
        if (this.activeId !== mapId) await this.documents.get(this.activeId)?.stopInput?.();
        await doc.stopInput?.();
        if (!this.documents.has(mapId)) return;
        if (!this.viewState.viewIds.includes(doc.viewId)) {
            doc.viewId = this.viewState.viewIdAt(this.viewState.focusedView); doc.notice = '';
        }
        this.activate(mapId, this.activeId === mapId ? this.selectedObjectId : '');
        this.workspace.open('drawing', mapId); this.changed.next();
    }
    /** Compare the exact current text with the last explicit local save. */
    dirty(doc: DrawingDocument): boolean { return !doc.saved || doc.draft !== doc.baseline; }

    /** Serialize validation and keep stale diagnostics from replacing current ones. */
    async validate(doc: DrawingDocument): Promise<void> {
        clearTimeout(doc.timer);
        const revision = doc.revision, text = doc.draft;
        doc.busy = true; this.changed.next();
        doc.pending = doc.pending.then(async () => {
            if (!this.documents.has(doc.mapId) || revision !== doc.revision) return;
            try {
                if (text !== this.sources.sources.get(doc.mapId)?.text) {
                    await this.sources.change({type: 'replace', mapId: doc.mapId, text});
                }
                if (revision === doc.revision) { doc.error = ''; this.notify(doc.mapId + ':validation', ''); }
            } catch (error) { if (revision === doc.revision) { doc.error = this.message(error); this.notify(doc.mapId + ':validation', doc.error); } }
        }).finally(() => {
            if (revision === doc.revision) doc.busy = false;
            this.persist(doc); this.changed.next();
        });
        await doc.pending;
    }

    /** Structured changes enter the same CodeMirror history as source edits. */
    async edit(doc: DrawingDocument, operation: Extract<DrawingOperation, {type: 'description' | 'append' | 'join' | 'tool' | 'objects'}>, producer = false, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        if (!producer && doc.stopInput) await doc.stopInput();
        if (!this.documents.has(doc.mapId) || doc.busy || doc.saving || doc.error || doc.draft !== this.sources.sources.get(doc.mapId)?.text) throw new Error('Wait for a valid, idle document before editing.');
        const mutation = this.applyEdit(doc, operation, signal);
        doc.mutation = mutation;
        try { await mutation; }
        finally { if (doc.mutation === mutation) doc.mutation = undefined; }
    }

    /** Track structured work independently of raw validation so deletion can drain both safely. */
    private async applyEdit(doc: DrawingDocument, operation: Extract<DrawingOperation, {type: 'description' | 'append' | 'join' | 'tool' | 'objects'}>, signal?: AbortSignal): Promise<void> {
        const revision = doc.revision;
        doc.busy = true; doc.structuredPending = true; this.changed.next();
        try {
            const reply = await this.sources.change(operation, signal, () => doc.revision === revision && this.documents.get(doc.mapId) === doc);
            // Raw typing remains available while the worker is busy. Its newer draft wins
            // over this operation's older input, even when that draft is currently invalid.
            if (revision !== doc.revision) { await this.validate(doc); throw new ViewerActionFailure({code:'busy',reason:'newer_draft',outcome:'applied',message:'The accepted edit committed, then a newer raw draft arrived. Read current revisions before retrying.'}); }
            if (reply.text !== undefined) {
                doc.structuredUpdating = true;
                try { this.editors.updateSessionSource(doc.sessionId, reply.text); }
                finally { doc.structuredUpdating = false; }
            }
            doc.error = ''; this.notify(doc.mapId + ':edit', '');
        } catch (error) { if(revision!==doc.revision)await this.validate(doc);doc.notice = this.message(error); this.notify(doc.mapId + ':edit', doc.notice); throw error; }
        finally { doc.busy = false; doc.structuredPending = false; this.persist(doc); this.changed.next(); }
    }

    /** Center the captured view, keeping camera orientation and scale unchanged. */
    center(doc: DrawingDocument): void {
        const targetView = this.viewState.viewIds.indexOf(doc.viewId);
        if (targetView < 0) { doc.notice = 'The target view was closed. Reopen the editor to choose a view.'; this.changed.next(); return; }
        const bounds = this.sources.sources.get(doc.mapId)?.summary.bounds;
        const south=Math.max(-85.0511287798066,bounds?.[1] ?? 0),north=Math.min(85.0511287798066,bounds?.[3] ?? 0);
        const position = (bounds && south<=north ? [(bounds[0] + bounds[2]) / 2, (south + north) / 2] : undefined);
        if (bounds && south>north) this.notify(doc.mapId+':projection','This document lies beyond the Web Mercator viewing limit. Its source coordinates and measurements are preserved.');
        if (!position) return;
        if (this.sources.sources.get(doc.mapId)?.summary.projectionLimited) {
            this.notify(doc.mapId + ':projection', 'Centering the visible portion. Coordinates beyond the Web Mercator latitude limit and their measurements are preserved.');
        }
        this.views.moveToWgs84PositionTopic.next({targetView, x: position[0], y: position[1]});
    }

    /** Save commits the current valid GeoJSON to browser storage, like an imported style. */
    async save(doc: DrawingDocument): Promise<boolean> {
        if (doc.saving) return false;
        await doc.stopInput?.(); await doc.mutation;
        if (doc.pendingObject) { this.notify('save','Finish or clear the incomplete object before saving.'); return false; }
        doc.saving = true; this.changed.next();
        try {
            await doc.mutation;
            const revision = doc.revision, text = doc.draft;
            await this.validate(doc);
            if (doc.error || revision !== doc.revision) return false;
            const baseline = doc.baseline, saved = doc.saved;
            doc.baseline = text; doc.saved = true;
            if (!this.persist(doc)) { doc.baseline = baseline; doc.saved = saved; return false; }
            doc.notice = 'Saved locally.';
            return true;
        } catch (error) {
            doc.notice = this.message(error); this.notify('save',doc.notice); return false;
        } finally { doc.saving = false; this.changed.next(); }
    }

    /** Export is an explicit download and does not mark the editor's local draft saved. */
    async exportFile(doc: DrawingDocument): Promise<void> {
        if (doc.saving) return;
        doc.saving = true; this.changed.next();
        try {
            await doc.mutation;
            const revision = doc.revision, text = doc.draft;
            await this.validate(doc);
            if (doc.error || revision !== doc.revision) return;
            const url = URL.createObjectURL(new Blob([await this.portableSource(doc)], {type: 'application/geo+json;charset=utf-8'}));
            const link = document.createElement('a'); link.href = url; link.download = doc.name; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            doc.notice = 'Exported ' + doc.name;
        } catch (error) { doc.notice = this.message(error); this.notify(doc.mapId + ':export', doc.notice); }
        finally { doc.saving = false; this.changed.next(); }
    }

    /** Discard restores map data as well as the visible editor buffer. */
    async discard(doc: DrawingDocument): Promise<boolean> {
        if (!doc.saved) { await this.remove(doc.mapId, false); return !this.documents.has(doc.mapId); }
        this.editors.updateSessionSource(doc.sessionId, doc.baseline);
        await this.validate(doc); return !doc.error;
    }

    /** Removing a map is explicit and releases its editor, source, and native ownership. */
    async remove(mapId: string, confirm = true, guard?: () => void): Promise<void> {
        const doc = this.documents.get(mapId);
        if (!doc) return;
        if (confirm) { this.deleteTarget = mapId; this.changed.next(); return; }
        await doc.stopInput?.();
        // Typing may enqueue another validation while an older operation is settling.
        // Drain the current owners until stable before synchronously removing storage/UI.
        let pending: Promise<void>, mutation: Promise<void> | undefined;
        do {
            pending = doc.pending; mutation = doc.mutation;
            await mutation?.catch(() => undefined);
            await pending;
        } while (pending !== doc.pending || mutation !== doc.mutation);
        guard?.();
        if (!this.documents.has(mapId)) return;
        if (doc.saving) { doc.notice = 'Finish saving or exporting before deleting this datasource.'; this.changed.next(); return; }
        try { this.storage.remove(mapId); }
        catch (error) { doc.storageError = 'Could not remove the browser copy: ' + this.message(error); this.notify(mapId + ':storage', doc.storageError); this.changed.next(); return; }
        clearTimeout(doc.timer); clearTimeout(doc.storageTimer);
        doc.busy = false; // All owners drained; a superseded raw revision may have left this UI flag set.
        for (const entry of this.workspace.entries.filter(entry => entry.descriptor.target === mapId)) {
            doc.saved = true; doc.baseline = doc.draft; this.workspace.requestClose(entry);
        }
        clearTimeout(doc.timer); clearTimeout(doc.storageTimer); doc.subscription.unsubscribe(); this.editors.closeSession(doc.sessionId);
        for (const scope of [...this.messages.keys()]) if (scope.startsWith(mapId + ':')) this.notify(scope, '');
        this.documents.delete(mapId);
        if (this.workingIds.includes(mapId)) { this.workingIds = this.workingIds.filter(id => id !== mapId); ++this.workspaceRevision; }
        if (this.activeId === mapId) this.activate(this.workingIds[0] ?? '');
        await this.sources.remove(mapId); this.changed.next();
    }

    registerActions(actions: AppActionRegistration): void { registerDrawingActions(this, actions); }
    collection(mapId: string) { return this.storage.collectionFor(mapId); }
    async replaceSource(doc: DrawingDocument, text: string, revision: number, convertInvalidDraft = false, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        await doc.stopInput?.(); await doc.mutation;
        if (doc.busy || doc.saving || (doc.error && !convertInvalidDraft) || this.sources.sources.get(doc.mapId)?.summary.revision !== revision) throw new Error('Stale or busy document.');
        const draftRevision = doc.revision;
        doc.busy = true;
        try { await this.sources.change({type: 'replace', mapId: doc.mapId, text}, signal, () => doc.revision === draftRevision && this.documents.has(doc.mapId)); } finally { doc.busy = false; }
        if (doc.revision !== draftRevision || !this.documents.has(doc.mapId)) { await this.validate(doc); throw new Error('Document changed during editing.'); }
        doc.error = ''; this.notify(doc.mapId + ':validation', '');
        doc.structuredUpdating = true;
        try { this.editors.updateSessionSource(doc.sessionId, text); } finally { doc.structuredUpdating = false; }
        this.persist(doc); this.changed.next();
    }

    /** Explicit recovery for raw sampled-geometry edits; native JSON retains unrelated fields and IDs. */
    async convertDraft(doc: DrawingDocument): Promise<void> {
        const revision = doc.revision, nativeRevision = this.sources.sources.get(doc.mapId)!.summary.revision;
        try {
            const [text] = await this.sources.compose([doc.draft], false, undefined, true);
            if (revision !== doc.revision) throw new Error('Document changed during conversion.');
            await this.replaceSource(doc, text, nativeRevision, true);
        } catch (error) { this.notify(doc.mapId + ':conversion', this.message(error)); }
    }

    /** Drain the captured input owner before explicitly changing the editing target. */
    async selectDocument(mapId: string): Promise<void> {
        if (!this.documents.has(mapId)) throw new Error('Drawing not found.');
        if (this.workspaceBusy) throw new Error('Finish the current workspace operation before changing its target.');
        if (this.activeId !== mapId) await this.documents.get(this.activeId)?.stopInput?.();
        if (!this.documents.has(mapId)) throw new Error('Drawing no longer exists.');
        this.activate(mapId, this.activeId === mapId ? this.selectedObjectId : '');
    }

    /** Select an object from the map, tray, Quick or MCP without maintaining component-local selections. */
    async selectObject(mapId: string, objectId: string, path = ''): Promise<void> {
        await this.selectDocument(mapId);
        this.activate(mapId, objectId, path);
    }

    /** One bounded working set, independent of whether its documents have been saved. */
    openTray(ids: string[]): void {
        if (this.workspaceBusy) throw new Error('Finish the current workspace operation before opening another workspace.');
        const members = ids.flatMap(id => this.storage.collectionFor(id)?.documents.map(doc => doc.mapId) ?? [id]);
        const next = [...new Set(members)].filter(id => this.documents.has(id));
        if (next.join('|') !== this.workingIds.join('|')) { this.workspaceId = crypto.randomUUID(); ++this.workspaceRevision; }
        this.workingIds = next;
        const active = next.includes(this.activeId) ? this.activeId : next[0] ?? '';
        this.activate(active, active === this.activeId ? this.selectedObjectId : '');
        this.trayVisible = true; this.changed.next();
    }

    /** Removing a document from this working set never deletes its saved or recovered data. */
    async removeFromWorkspace(mapId: string): Promise<void> {
        if (this.workspaceBusy) throw new Error('Finish the current workspace operation first.');
        await this.documents.get(mapId)?.stopInput?.();
        this.workingIds = this.workingIds.filter(id => id !== mapId); ++this.workspaceRevision;
        if (this.activeId === mapId) this.activate(this.workingIds[0] ?? '');
        this.changed.next();
    }
    get workingDocuments(): DrawingDocument[] { return this.workingIds.map(id => this.documents.get(id)).filter((d): d is DrawingDocument => !!d); }
    async objectEdit(doc: DrawingDocument, operations: DrawingObjectEdit[], revision?: number, producer = false, signal?: AbortSignal): Promise<void> {
        const source = this.sources.sources.get(doc.mapId);
        if (!source || doc.error || doc.busy || doc.saving) throw new Error('Wait for a valid, idle document before editing.');
        const expected = revision ?? source.summary.revision;
        if (expected !== source.summary.revision) throw new Error('The object changed. Refresh before editing.');
        await this.edit(doc, {type: 'objects', mapId: doc.mapId, request: {revision: expected, operations}}, producer, signal);
        if (this.activeId === doc.mapId && operations.some(operation => operation.type === 'delete' && operation.id === this.selectedObjectId))
            this.activate(doc.mapId);
    }
    async history(direction: 'undo' | 'redo', mapId = this.activeId, revision?: number, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        const doc = this.documents.get(mapId); if (!doc || doc.busy || doc.saving || this.workspaceBusy) throw new Error('Wait for an idle document before changing history.');
        const draftRevision = doc.revision;
        await doc.stopInput?.();
        signal?.throwIfAborted();
        if (doc.revision !== draftRevision || (revision !== undefined && this.sources.sources.get(mapId)?.summary.revision !== revision))
            throw new Error('Stale document revision. History target changed.');
        this.editors.history(doc.sessionId, direction); await this.validate(doc);
    }
    /** Editor Save commits only this document, including when its storage owner is a collection. */
    async saveWithDialog(doc: DrawingDocument): Promise<boolean> {
        if (doc.saved) return this.save(doc);
        if (this.dialog || this.saveResult) return false;
        await this.requestSave(doc);
        return new Promise(resolve => { this.saveResult = resolve; });
    }

    /** Cancel the one drawing modal and restore focus through the shared dialog owner. */
    cancelSave(): void {
        if (this.workspaceBusy) return;
        this.dialog = undefined; this.closeAfterSave = false; this.saveTarget = undefined;
        this.saveDocumentId = ''; this.saveResult?.(false); this.saveResult = undefined; this.changed.next();
    }

    /** Rename changes a display name, never a storage or object identity. */
    rename(doc: DrawingDocument, name: string): void {
        name = name.trim();
        if (!name || name.length > 256) throw new Error('Enter a name of 1–256 characters.');
        const previous = doc.name; doc.name = name;
        if (!this.persist(doc)) { doc.name = previous; throw new Error(doc.storageError); }
        this.sources.rename(doc.mapId, name); this.notify('rename', ''); this.changed.next();
    }

    /** Pause pending input before capturing the exact document/workspace shown by the Save form. */
    async requestSave(doc?: DrawingDocument): Promise<void> {
        if (this.workspaceBusy) return;
        const close = this.dialog === 'close' || this.closeAfterSave;
        for (const member of doc ? [doc] : this.workingDocuments) { await member.stopInput?.(); await member.mutation; }
        this.saveDocumentId = doc?.mapId ?? '';
        this.saveTarget = doc ? {workspaceId: this.workspaceId, workspaceRevision: this.workspaceRevision,
            members: [{mapId: doc.mapId, revision: this.sources.sources.get(doc.mapId)!.summary.revision, draftRevision: doc.revision}]} : this.captureWorkspace();
        const current = doc ? undefined : this.storage.collectionFor(this.workingIds[0] ?? '');
        this.saveName = current?.name ?? (doc?.name && !doc.name.startsWith('Untitled') ? doc.name : '');
        this.saveLayout = current?.layout ?? 'one'; this.closeAfterSave = close;
        this.dialog = 'save'; this.changed.next();
    }

    /** Save a named workspace directly; first Save and layout changes use the labeled form. */
    async saveWorkspace(): Promise<boolean> {
        const collection = this.storage.collectionFor(this.workingIds[0] ?? '');
        if (!collection || collection.documents.length !== this.workingIds.length ||
            collection.documents.some(member => !this.workingIds.includes(member.mapId))) {
            await this.requestSave(); return false;
        }
        for (const doc of this.workingDocuments) { await doc.stopInput?.(); await doc.mutation; }
        return this.saveWorkingSet(collection.name, collection.layout, this.captureWorkspace());
    }

    /** Commit the currently displayed Save form without reading a newly selected workspace. */
    async confirmSave(): Promise<boolean> {
        if (this.workspaceBusy || !this.saveTarget) return false;
        if (!this.saveDocumentId) return this.saveWorkingSet(this.saveName, this.saveLayout, this.saveTarget);
        const member = this.saveTarget.members[0], doc = this.documents.get(this.saveDocumentId);
        if (!doc || doc.revision !== member.draftRevision || this.sources.sources.get(doc.mapId)?.summary.revision !== member.revision) {
            this.notify('save', 'The document changed while Save was open. Cancel and review it before saving.'); return false;
        }
        const name = this.saveName.trim();
        if (!name || name.length > 256) return false;
        this.workspaceBusy = 'saving'; this.changed.next();
        const previousName = doc.name; doc.name = name;
        try {
            if (!await this.save(doc)) { doc.name = previousName; return false; }
            this.sources.rename(doc.mapId, name); this.finishSave(); return true;
        } finally { this.workspaceBusy = undefined; this.changed.next(); }
    }

    /** Resolve Editor save callers only after the requested local baseline was committed. */
    private finishSave(): void {
        this.dialog = undefined; this.saveTarget = undefined; this.saveDocumentId = '';
        this.lastSaveError = ''; this.notify('save', ''); this.saveResult?.(true); this.saveResult = undefined;
    }

    /** Repacking has one captured owner and one browser-storage commit point. */
    async saveWorkingSet(name = this.saveName, layout = this.saveLayout,
        target = this.saveTarget ?? this.captureWorkspace(), signal?: AbortSignal): Promise<boolean> {
        if (this.workspaceBusy) throw new Error('A workspace operation is already running.');
        name = name.trim();
        if (!name || name.length > 256) { this.notify('save', 'Enter a name of 1–256 characters.'); return false; }
        this.assertWorkspace(target); signal?.throwIfAborted();
        this.workspaceBusy = 'saving'; this.changed.next();
        try {
            const result = await saveDrawingCollection(this, this.storage, name, layout, target, signal);
            this.workspaceBusy = undefined;
            this.openTray(result.members.map(doc => doc.mapId));
            if(result.selection)this.activate(result.selection.mapId,result.selection.id,result.selection.path);
            this.finishSave(); return true;
        } catch (error) {
            if (error instanceof ViewerActionFailure) { this.notify('save',error.message); throw error; }
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            this.lastSaveError = this.message(error); this.notify('save', this.lastSaveError); return false;
        } finally { this.workspaceBusy = undefined; this.changed.next(); }
    }

    /** Closing uses the same modal flow as Save; collapsing never calls this method. */
    requestClose(): boolean {
        if (this.workspaceBusy) return false;
        if (this.workingDocuments.some(doc => this.dirty(doc) || !!doc.pendingObject)) {
            this.dialog = 'close'; this.changed.next(); return false;
        }
        this.trayVisible = false; this.changed.next(); return true;
    }

    /** Preflight the captured members; a failed discard stays open with its remaining work. */
    async discardWorkingSet(target = this.captureWorkspace(), signal?: AbortSignal): Promise<boolean> {
        if (this.workspaceBusy) throw new Error('A workspace operation is already running.');
        this.assertWorkspace(target); signal?.throwIfAborted();
        this.workspaceBusy = 'discarding'; this.changed.next();
        const members = target.members.map(member => this.documents.get(member.mapId)!);
        try {
            for (const doc of members) { await doc.stopInput?.(); await doc.mutation; await doc.pending; }
            this.assertWorkspace(target); signal?.throwIfAborted();
            // localStorage has no transaction spanning unrelated standalone records. Report
            // a partial failure honestly and retain the workspace for the remaining members.
            for (const doc of members) {
                if (!await this.discard(doc)) throw new Error('Could not discard “' + doc.name + '”. Its remaining work is retained.');
                doc.pendingObject = undefined;
                if (this.documents.has(doc.mapId)) this.persist(doc);
            }
            this.dialog = undefined; this.closeAfterSave = false; this.trayVisible = false; return true;
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            this.notify('discard', this.message(error)); return false;
        } finally { this.workspaceBusy = undefined; this.changed.next(); }
    }
    /** Scoped notifications recover when the owning condition clears. */
    notify(scope: string, text: string): void {
        const previous = this.messages.get(scope);
        if (previous?.text === text) return;
        previous?.ref?.dismiss(); this.messages.delete(scope);
        const actionId = 'drawing:' + scope; delete this.messageActions[actionId];
        if (text) {
            const mapId = scope.split(':')[0], doc = this.documents.get(mapId);
            let label: string | undefined;
            if (doc) {
                const storage = scope.endsWith(':storage'); label = storage ? 'Retry browser save' : 'Open editor';
                this.messageActions[actionId] = async () => { if (this.documents.get(mapId) !== doc) return; if (storage) this.persist(doc); else await this.open(mapId); };
            } else if (scope === 'save') {
                label = 'Retry save'; this.messageActions[actionId] = () => this.requestSave();
            }
            this.messages.set(scope, {text, ref: this.info?.showWarning(text, {scope: actionId, dedupeKey: actionId, life: 'sticky', ...(label ? {action: {id: actionId, label}} : {})})});
        }
    }

    /** Coalesce typing without making a native parse a prerequisite for draft recovery. */
    private schedulePersistence(doc: DrawingDocument): void {
        clearTimeout(doc.storageTimer); doc.storagePending = true;
        doc.storageTimer = setTimeout(() => this.persist(doc), 250);
    }

    /** Persist GeoJSON revisions and the last explicit local-save baseline. */
    persist(doc: DrawingDocument): boolean {
        clearTimeout(doc.storageTimer);
        const source = this.sources.sources.get(doc.mapId)?.text;
        if (!this.documents.has(doc.mapId) || source === undefined) return false;
        try {
            this.storage.save({schemaVersion: 2, mapId: doc.mapId, name: doc.name, source, ...(doc.pendingObject ? {pendingObject: doc.pendingObject} : {}),
                ...(doc.draft !== source ? {draft: doc.draft} : {}),
                ...(doc.baseline !== source ? {baseline: doc.baseline} : {}), saved: doc.saved});
            doc.storageError = '';
        } catch (error) {
            doc.storageError = 'Browser copy not updated. Copy the draft elsewhere or export a valid file before leaving. ' + this.message(error);
        }
        this.notify(doc.mapId + ':storage', doc.storageError);
        doc.storagePending = false; this.changed.next();
        return !doc.storageError;
    }

    /** Flush the typing debounce before page exit or background suspension, even if native validation is pending. */
    flushPersistence(): void {
        for (const doc of this.documents.values()) if (doc.storagePending) this.persist(doc);
    }

    /** Autosaved drafts remain recoverable independently of the explicit local-save baseline. */
    get unloadUnsafe(): boolean {
        return [...this.documents.values()].some(doc => doc.storagePending || !!doc.storageError || doc.saving || doc.structuredPending);
    }

    /** Normalize errors at the document boundary, never in a renderer callback. */
    private message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
    /** Session shutdown releases editor observers; the provider owns native teardown. */
    ngOnDestroy(): void {
        this.cancelSave(); this.flushPersistence();
        this.subscriptions.unsubscribe();
        for (const doc of this.documents.values()) { clearTimeout(doc.timer); clearTimeout(doc.storageTimer); doc.subscription.unsubscribe(); }
        this.changed.complete();
    }
}
