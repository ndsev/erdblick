import {Injectable} from '@angular/core';
import {z} from 'zod';
import {AppStateService} from '../appstate/appstate.service';
import {EditorDocumentDescriptor} from './editor-document.model';

/** Persists document references, never draft text, credentials or runtime editor state. */
@Injectable({providedIn: 'root'})
export class EditorWorkspaceState {
    readonly documents;

    /** Registers restoration metadata before application-state hydration is sealed. */
    constructor(persistence: AppStateService) {
        this.documents = persistence.registerState<EditorDocumentDescriptor[]>({
            name: 'editorDocuments', defaultValue: [], snapshotPersist: true, configDefault: false,
            schema: z.array(z.object({
                id: z.string().min(1).max(160),
                kind: z.enum(['style', 'presets', 'datasources', 'preferences']),
                target: z.string().max(4096).optional(),
                sourceUrl: z.string().max(4096).optional()
            })).max(128).refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length,
                'Editor IDs must be unique')
        });
    }
}
