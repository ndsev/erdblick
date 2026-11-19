import {Injectable, OnDestroy} from '@angular/core';
import {Subject, Subscription} from 'rxjs';
import {EditorService} from '../editor/editor.service';
import {EditorWorkspaceService} from '../editor/editor-workspace.service';
import {MapViewService} from '../mapview/mapview.service';
import {MapViewState} from '../mapview/mapview.state';
import {VirtualSourceService} from './virtual-source.service';
import {DrawingStorageService, StoredDrawingDocument} from './drawing-storage.service';
import {EMPTY_DRAWING, type DrawingFileKind, type DrawingOperation} from './drawing.model';

/** Browser-backed source document; invalid drafts never replace the accepted native model. */
export interface DrawingDocument {
    mapId: string; name: string; sessionId: string;
    draft: string; baseline: string; saved: boolean; busy: boolean; saving: boolean; structuredUpdating: boolean; error: string; notice: string;
    viewId: string;
    revision: number; subscription: Subscription;
    stopInput?: () => Promise<void>;
    mutation?: Promise<void>;
    pending: Promise<void>; timer?: ReturnType<typeof setTimeout>;
    storagePending: boolean; storageError: string; structuredPending: boolean; storageTimer?: ReturnType<typeof setTimeout>;
}

/** Owns file text, validation, browser saves, and the retained Editor sessions. */
@Injectable({providedIn: 'root'})
export class DrawingDocumentsService implements OnDestroy {
    readonly documents = new Map<string, DrawingDocument>();
    readonly changed = new Subject<void>();
    importKind?: DrawingFileKind;
    importError = '';
    restoring = false;
    readonly restoreErrors: string[] = [];
    private restoration?: Promise<void>;
    private readonly subscriptions = new Subscription();

    /** Native/catalog ownership remains independent of whether an Editor is open. */
    constructor(public readonly sources: VirtualSourceService, private readonly editors: EditorService,
                private readonly workspace: EditorWorkspaceService,
                private readonly views: MapViewService, private readonly viewState: MapViewState,
                private readonly storage: DrawingStorageService = new DrawingStorageService()) {
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
        } finally { this.restoring = false; this.changed.next(); }
    }

    /** Opens the shared new/import choice from either File menu item. */
    begin(kind: DrawingFileKind): void { this.importKind = kind; this.importError = ''; this.changed.next(); }

    /** Read UTF-8 strictly, with the same pre-read limit as the native importer. */
    async importFile(file: File, kind?: DrawingFileKind): Promise<void> {
        try {
            if (file.size > 32 * 1024 * 1024) throw new Error('The file exceeds the 32 MiB limit.');
            const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(await file.arrayBuffer());
            await this.create(kind ?? (/\.(geojson|json)$/i.test(file.name) ? 'geojson' : 'coordinates'), file.name, text, true);
            this.importKind = undefined; this.importError = '';
        } catch (error) { this.importError = this.message(error); }
        this.changed.next();
    }

    /** Convert coordinate input once, then use the same GeoJSON document/session path. */
    async create(kind: DrawingFileKind, name = 'Untitled.geojson',
                 text = kind === 'geojson' ? EMPTY_DRAWING : '', saved = false,
                 options: {openEditor?: boolean; stopInput?: () => Promise<void>} = {}): Promise<DrawingDocument> {
        if (kind === 'coordinates') {
            text = await this.sources.convertCoordinates(text);
            name = this.geoJsonName(name); saved = false;
        }
        const mapId = 'drawing-' + crypto.randomUUID();
        const doc = await this.install({schemaVersion: 2, mapId, name, source: text, saved}, options.stopInput);
        this.persist(doc);
        if (options.openEditor !== false) await this.open(mapId);
        this.importKind = undefined; this.changed.next();
        return doc;
    }

    /** Coordinate files become new GeoJSON files; a previous extension is not retained. */
    private geoJsonName(name: string): string { return name.replace(/\.[^./\\]+$/, '') + '.geojson'; }

    /** Share native/session construction between import and restoration; retain the draft and last local-save baseline separately. */
    private async install(record: StoredDrawingDocument, stopInput?: () => Promise<void>): Promise<DrawingDocument> {
        const {mapId, name, source, saved} = record;
        await this.sources.create(mapId, source, name);
        const doc: DrawingDocument = {mapId, name, sessionId: mapId, draft: record.draft ?? source, baseline: record.baseline ?? source,
            saved, stopInput, busy: false, saving: false, structuredUpdating: false, error: '', notice: '', viewId: this.viewState.viewIdAt(this.viewState.focusedView),
            revision: 0, subscription: new Subscription(), pending: Promise.resolve(),
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
        doc.subscription.add(session.saveRequested$.subscribe(() => { void this.save(doc); }));
        return doc;
    }

    /** Reveal one document without transferring its text to application persistence. */
    async open(mapId: string): Promise<void> {
        const doc = this.documents.get(mapId);
        if (!doc) return;
        await doc.stopInput?.();
        if (!this.documents.has(mapId)) return;
        if (!this.viewState.viewIds.includes(doc.viewId)) {
            doc.viewId = this.viewState.viewIdAt(this.viewState.focusedView); doc.notice = '';
        }
        this.workspace.open('drawing', mapId);
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
                if (revision === doc.revision) { doc.error = ''; }
            } catch (error) { if (revision === doc.revision) doc.error = this.message(error); }
        }).finally(() => {
            if (revision === doc.revision) doc.busy = false;
            this.persist(doc); this.changed.next();
        });
        await doc.pending;
    }

    /** Structured changes enter the same CodeMirror history as source edits. */
    async edit(doc: DrawingDocument, operation: Extract<DrawingOperation, {type: 'description' | 'append' | 'join' | 'tool'}>, producer = false): Promise<void> {
        if (!producer && doc.stopInput) await doc.stopInput();
        if (!this.documents.has(doc.mapId) || doc.busy || doc.saving || doc.error || doc.draft !== this.sources.sources.get(doc.mapId)?.text) return;
        const mutation = this.applyEdit(doc, operation, producer);
        doc.mutation = mutation;
        try { await mutation; }
        finally { if (doc.mutation === mutation) doc.mutation = undefined; }
    }

    /** Track structured work independently of raw validation so deletion can drain both safely. */
    private async applyEdit(doc: DrawingDocument, operation: Extract<DrawingOperation, {type: 'description' | 'append' | 'join' | 'tool'}>, producer: boolean): Promise<void> {
        const revision = doc.revision;
        doc.busy = true; doc.structuredPending = true; this.changed.next();
        try {
            const reply = await this.sources.change(operation);
            // Raw typing remains available while the worker is busy. Its newer draft wins
            // over this operation's older input, even when that draft is currently invalid.
            if (revision !== doc.revision) { await this.validate(doc); return; }
            if (reply.text !== undefined) {
                doc.structuredUpdating = true;
                try { this.editors.updateSessionSource(doc.sessionId, reply.text); }
                finally { doc.structuredUpdating = false; }
            }
            doc.error = '';
        } catch (error) { doc.notice = this.message(error); if (producer) throw error; }
        finally { doc.busy = false; doc.structuredPending = false; this.persist(doc); this.changed.next(); }
    }

    /** Center the captured view, keeping camera orientation and scale unchanged. */
    center(doc: DrawingDocument): void {
        const targetView = this.viewState.viewIds.indexOf(doc.viewId);
        if (targetView < 0) { doc.notice = 'The target view was closed. Reopen the editor to choose a view.'; this.changed.next(); return; }
        const bounds = this.sources.sources.get(doc.mapId)?.summary.bounds;
        const position = (bounds ? [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2] : undefined);
        if (!position) return;
        this.views.moveToWgs84PositionTopic.next({targetView, x: position[0], y: Math.max(-85.0511287, Math.min(85.0511287, position[1]))});
    }

    /** Save commits the current valid GeoJSON to browser storage, like an imported style. */
    async save(doc: DrawingDocument): Promise<boolean> {
        if (doc.saving) return false;
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
            doc.notice = this.message(error); return false;
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
            const url = URL.createObjectURL(new Blob([text], {type: 'application/geo+json;charset=utf-8'}));
            const link = document.createElement('a'); link.href = url; link.download = doc.name; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            doc.notice = 'Exported ' + doc.name;
        } catch (error) { doc.notice = this.message(error); }
        finally { doc.saving = false; this.changed.next(); }
    }

    /** Discard restores map data as well as the visible editor buffer. */
    async discard(doc: DrawingDocument): Promise<boolean> {
        this.editors.updateSessionSource(doc.sessionId, doc.baseline);
        await this.validate(doc); return !doc.error;
    }

    /** Removing a map is explicit and releases its editor, source, and native ownership. */
    async remove(mapId: string): Promise<void> {
        const doc = this.documents.get(mapId);
        if (!doc || !window.confirm('Delete ' + doc.name + ' and its saved browser data?')) return;
        await doc.stopInput?.();
        // Typing may enqueue another validation while an older operation is settling.
        // Drain the current owners until stable before synchronously removing storage/UI.
        let pending: Promise<void>, mutation: Promise<void> | undefined;
        do {
            pending = doc.pending; mutation = doc.mutation;
            await mutation?.catch(() => undefined);
            await pending;
        } while (pending !== doc.pending || mutation !== doc.mutation);
        if (!this.documents.has(mapId)) return;
        if (doc.saving) { doc.notice = 'Finish saving or exporting before deleting this datasource.'; this.changed.next(); return; }
        try { this.storage.remove(mapId); }
        catch (error) { doc.storageError = 'Could not remove the browser copy: ' + this.message(error); this.changed.next(); return; }
        clearTimeout(doc.timer); clearTimeout(doc.storageTimer);
        doc.busy = false; // All owners drained; a superseded raw revision may have left this UI flag set.
        for (const entry of this.workspace.entries.filter(entry => entry.descriptor.target === mapId)) {
            doc.saved = true; doc.baseline = doc.draft; this.workspace.requestClose(entry);
        }
        clearTimeout(doc.timer); clearTimeout(doc.storageTimer); doc.subscription.unsubscribe(); this.editors.closeSession(doc.sessionId);
        this.documents.delete(mapId); await this.sources.remove(mapId); this.changed.next();
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
            this.storage.save({schemaVersion: 2, mapId: doc.mapId, name: doc.name, source,
                ...(doc.draft !== source ? {draft: doc.draft} : {}),
                ...(doc.baseline !== source ? {baseline: doc.baseline} : {}), saved: doc.saved});
            doc.storageError = '';
        } catch (error) {
            doc.storageError = 'Browser copy not updated. Copy the draft elsewhere or export a valid file before leaving. ' + this.message(error);
        }
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
        this.flushPersistence();
        this.subscriptions.unsubscribe();
        for (const doc of this.documents.values()) { clearTimeout(doc.timer); clearTimeout(doc.storageTimer); doc.subscription.unsubscribe(); }
        this.changed.complete();
    }
}
