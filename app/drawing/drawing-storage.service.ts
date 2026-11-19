import {Injectable} from '@angular/core';
import {z} from 'zod';

const STORAGE_PREFIX = 'drawingDocumentData:';
const storedDrawingSchema = z.object({
    schemaVersion: z.literal(2),
    mapId: z.string().regex(/^drawing-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    name: z.string(),
    source: z.string(),
    draft: z.string().optional(),
    baseline: z.string().optional(),
    saved: z.boolean()
}).strict();

/** Exact source revisions; identical draft/baseline text is omitted to conserve browser quota. */
export type StoredDrawingDocument = z.infer<typeof storedDrawingSchema>;

/** Per-document atomic localStorage records, independent of exported viewer snapshots. */
@Injectable({providedIn: 'root'})
export class DrawingStorageService {
    private readonly observed = new Map<string, string | null>();

    /** Isolate malformed records without deleting them or blocking other saved drawings. */
    load(): {documents: StoredDrawingDocument[]; errors: string[]} {
        const documents: StoredDrawingDocument[] = [], errors: string[] = [];
        const storage = window.localStorage;
        for (let index = 0; index < storage.length; ++index) {
            const key = storage.key(index);
            if (!key?.startsWith(STORAGE_PREFIX)) continue;
            const value = storage.getItem(key);
            if (value === null) continue;
            try {
                const record = storedDrawingSchema.parse(JSON.parse(value));
                if (key !== STORAGE_PREFIX + record.mapId) throw new Error('Document identity does not match its storage key.');
                this.observed.set(record.mapId, value);
                documents.push(record);
            } catch {
                errors.push('A saved drawing could not be read (invalid or unsupported format). Its browser copy was retained: ' + key);
            }
        }
        return {documents, errors};
    }

    /** A failed write retains the prior copy; detect other-tab changes already visible before this write. */
    save(document: StoredDrawingDocument): void {
        const key = STORAGE_PREFIX + document.mapId, value = JSON.stringify(document);
        this.checkRevision(document.mapId);
        if (value !== this.observed.get(document.mapId)) window.localStorage.setItem(key, value);
        this.observed.set(document.mapId, value);
    }

    /** Delete storage before releasing the live document, so a failed removal cannot silently return on reload. */
    remove(mapId: string): void {
        this.checkRevision(mapId);
        window.localStorage.removeItem(STORAGE_PREFIX + mapId);
        this.observed.set(mapId, null);
    }

    /** Best-effort stale-writer check; localStorage has no transaction spanning this read and the following write. */
    private checkRevision(mapId: string): void {
        if (window.localStorage.getItem(STORAGE_PREFIX + mapId) !== (this.observed.get(mapId) ?? null)) {
            throw new Error('The browser copy changed in another tab. Copy this draft or save a valid file before reloading to use the other tab’s copy.');
        }
    }
}
