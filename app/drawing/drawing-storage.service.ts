import {Injectable} from '@angular/core';
import {z} from 'zod';

const COLLECTION_PREFIX = 'drawingCollectionData:';
const collectionSchema = z.object({
    schemaVersion: z.literal(1), id: z.string().uuid(), name: z.string().min(1).max(256),
    layout: z.enum(['one', 'separate']), documents: z.array(z.lazy(() => storedDrawingSchema)).max(1000)
}).strict();
export type StoredDrawingCollection = z.infer<typeof collectionSchema>;
const STORAGE_PREFIX = 'drawingDocumentData:';
const storedDrawingSchema = z.object({
    schemaVersion: z.literal(2),
    mapId: z.string().regex(/^drawing-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    name: z.string(),
    source: z.string(),
    draft: z.string().optional(),
    baseline: z.string().optional(),
    pendingObject: z.object({mode: z.enum(['polyline','distance','area','angle','pen','point','polygon','ellipse','annotation']), color: z.string(), identity: z.string(), authoring: z.object({version: z.literal(1), kind: z.string(), space: z.enum(['2d','3d']), points: z.array(z.array(z.number().finite()).min(2).max(3)).max(10000)}).passthrough()}).optional(),
    saved: z.boolean()
}).strict();

/** Exact source revisions; identical draft/baseline text is omitted to conserve browser quota. */
export type StoredDrawingDocument = z.infer<typeof storedDrawingSchema>;

/** Per-document atomic localStorage records, independent of exported viewer snapshots. */
@Injectable({providedIn: 'root'})
export class DrawingStorageService {
    readonly collections = new Map<string, StoredDrawingCollection>();
    private readonly owners = new Map<string, string>();
    private readonly observedCollections = new Map<string, string | null>();
    private readonly observed = new Map<string, string | null>();

    /** Isolate malformed records without deleting them or blocking other saved drawings. */
    load(): {documents: StoredDrawingDocument[]; errors: string[]} {
        const documents: StoredDrawingDocument[] = [], errors: string[] = [];
        const storage = window.localStorage;
        this.owners.clear(); this.collections.clear();
        // Committed envelopes own their members even if cleanup was interrupted.
        for (let index = 0; index < storage.length; ++index) {
            const key = storage.key(index);
            if (!key?.startsWith(COLLECTION_PREFIX)) continue;
            const value = storage.getItem(key);
            if (!value) continue;
            try {
                const record = collectionSchema.parse(JSON.parse(value));
                if (key !== COLLECTION_PREFIX + record.id || new Set(record.documents.map(d => d.mapId)).size !== record.documents.length)
                    throw new Error('Invalid collection identity.');
                if (record.documents.some(d => this.owners.has(d.mapId))) throw new Error('Conflicting collection ownership.');
                this.collections.set(record.id, record); this.observedCollections.set(record.id, value);
                for (const doc of record.documents) { this.owners.set(doc.mapId, record.id); documents.push(doc); }
            } catch (error) { errors.push('Collection retained but unavailable: ' + key + '. ' + String(error)); }
        }
        for (let index = 0; index < storage.length; ++index) {
            const key = storage.key(index);
            if (!key?.startsWith(STORAGE_PREFIX)) continue;
            const value = storage.getItem(key);
            if (value === null) continue;
            try {
                const record = storedDrawingSchema.parse(JSON.parse(value));
                if (key !== STORAGE_PREFIX + record.mapId) throw new Error('Document identity does not match its storage key.');
                this.observed.set(record.mapId, value);
                if (!this.owners.has(record.mapId)) documents.push(record);
            } catch {
                errors.push('A saved drawing could not be read (invalid or unsupported format). Its browser copy was retained: ' + key);
            }
        }
        return {documents, errors};
    }

    /** A failed write retains the prior copy; detect other-tab changes already visible before this write. */
    save(document: StoredDrawingDocument): void {
        const owner = this.owners.get(document.mapId);
        if (owner) {
            const previous = this.collections.get(owner)!;
            this.saveCollection({...previous, documents: previous.documents.map(d => d.mapId === document.mapId ? document : d)});
            return;
        }
        const key = STORAGE_PREFIX + document.mapId, value = JSON.stringify(document);
        this.checkRevision(document.mapId);
        if (value !== this.observed.get(document.mapId)) window.localStorage.setItem(key, value);
        this.observed.set(document.mapId, value);
    }

    /** Delete storage before releasing the live document, so a failed removal cannot silently return on reload. */
    remove(mapId: string): void {
        const owner = this.owners.get(mapId);
        if (owner) {
            const record = this.collections.get(owner)!;
            this.saveCollection({...record, documents: record.documents.filter(d => d.mapId !== mapId)});
            this.owners.delete(mapId);
        }
        this.checkRevision(mapId);
        window.localStorage.removeItem(STORAGE_PREFIX + mapId);
        this.observed.set(mapId, null);
    }

    collectionFor(mapId: string): StoredDrawingCollection | undefined { return this.collections.get(this.owners.get(mapId) ?? ''); }

    /** Validate all members, then commit the collection in one atomic browser write. */
    saveCollection(input: StoredDrawingCollection): void {
        const record = collectionSchema.parse(input), key = COLLECTION_PREFIX + record.id;
        const value = JSON.stringify(record);
        if (new TextEncoder().encode(value).length > 32 * 1024 * 1024) throw new Error('Collection exceeds 32 MiB.');
        if (new Set(record.documents.map(d => d.mapId)).size !== record.documents.length) throw new Error('Duplicate collection member.');
        if (window.localStorage.getItem(key) !== (this.observedCollections.get(record.id) ?? null))
            throw new Error('This collection changed in another tab. Export your draft before reloading.');
        for (const doc of record.documents) {
            const owner = this.owners.get(doc.mapId);
            if (owner && owner !== record.id) throw new Error('A document already belongs to another collection.');
            if (!owner) this.checkRevision(doc.mapId);
        }
        window.localStorage.setItem(key, value);
        const previous = this.collections.get(record.id);
        for (const member of previous?.documents ?? []) if (!record.documents.some(doc => doc.mapId === member.mapId)) this.owners.delete(member.mapId);
        this.observedCollections.set(record.id, value); this.collections.set(record.id, record);
        for (const doc of record.documents) {
            this.owners.set(doc.mapId, record.id);
            // The envelope is authoritative. Leftovers after failed cleanup are ignored on load.
            try { window.localStorage.removeItem(STORAGE_PREFIX + doc.mapId); this.observed.set(doc.mapId, null); } catch { /* retained safely */ }
        }
    }

    /** Best-effort stale-writer check; localStorage has no transaction spanning this read and the following write. */
    private checkRevision(mapId: string): void {
        if (window.localStorage.getItem(STORAGE_PREFIX + mapId) !== (this.observed.get(mapId) ?? null)) {
            throw new Error('The browser copy changed in another tab. Copy this draft or save a valid file before reloading to use the other tab’s copy.');
        }
    }
}
