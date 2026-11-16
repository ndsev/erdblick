import {Component, Inject, OnDestroy, OnInit} from '@angular/core';
import {Subscription} from 'rxjs';
import {EDITOR_DOCUMENT} from '../editor/editor-workspace.service';
import {EditorDocumentController, EditorDocumentRef} from '../editor/editor-document.model';
import {EditorService} from '../editor/editor.service';
import {MapPresetService} from './map-preset.service';

@Component({
    selector: 'map-preset-editor', standalone: false,
    template: `
        @if (error) { <div class="editor-document-error" role="alert">{{ error }}</div> }
        @if (!presets.canWrite) { <p>{{ presets.readOnlyReason || 'A preset update is in progress.' }}</p> }
        <editor [sessionId]="document.id"/>
        <div class="editor-actions">
            <p-button data-testid="style-preset-editor-apply-button" label="Apply" icon="pi pi-check" [disabled]="!saveEnabled" (click)="save()"/>
            <p-button label="Reload catalog" [disabled]="busy" (click)="reload()"/>
            <p-button data-testid="style-preset-editor-close-button" [label]="dirty ? 'Discard' : 'Close'" (click)="document.close($event)"/>
        </div>
    `
})
/** Owns one complete preset-catalog draft and the revision from which it was loaded. */
export class MapPresetEditorComponent implements EditorDocumentController, OnInit, OnDestroy {
    readonly title = 'Map Presets';
    readonly saveLabel = 'Apply';
    busy = false;
    error = '';
    private baseline = '';
    private revision = '';
    private readonly subscriptions = new Subscription();

    /** Retains the existing catalog service as the sole persistence owner. */
    constructor(@Inject(EDITOR_DOCUMENT) public readonly document: EditorDocumentRef,
                private readonly editors: EditorService, public readonly presets: MapPresetService) {}

    get dirty(): boolean { return this.editors.getSessionSource(this.document.id) !== this.baseline; }
    get saveEnabled(): boolean { return this.dirty && !this.busy && this.presets.canWrite; }

    /** Creates the draft once; moving its view never reloads the catalog. */
    ngOnInit(): void {
        this.baseline = this.presets.source;
        this.revision = this.presets.revision;
        const session = this.editors.createSession({id: this.document.id, source: this.baseline, language: 'yaml', readOnly: !this.presets.writable});
        this.subscriptions.add(session.source$.subscribe(() => this.document.changed()));
        this.subscriptions.add(session.saveRequested$.subscribe(() => { void this.save(); }));
        this.subscriptions.add(this.presets.presets$.subscribe(() => {
            this.editors.setReadOnly(this.document.id, !this.presets.writable); this.document.changed();
        }));
        this.subscriptions.add(this.presets.writePending$.subscribe(() => this.document.changed()));
    }

    /** Writes the submitted draft against its captured revision and retains subsequent edits. */
    async save(): Promise<boolean> {
        if (!this.saveEnabled) return false;
        const source = this.editors.getSessionSource(this.document.id);
        this.busy = true; this.error = ''; this.document.changed();
        try {
            if (!await this.presets.applyOverrideSource(source, this.revision)) {
                this.error = 'The catalog could not be saved. It may have changed or become read-only. Your draft is retained; review the catalog before retrying.';
                return false;
            }
            this.baseline = source;
            this.revision = this.presets.revision;
            return true;
        } finally { this.busy = false; this.document.changed(); }
    }

    /** Replaces a stale draft only after an explicit discard decision. */
    reload(): void {
        if (this.dirty && !window.confirm('Discard the unsaved Map Presets draft and load the current catalog?')) return;
        this.baseline = this.presets.source; this.revision = this.presets.revision; this.error = '';
        this.editors.updateSessionSource(this.document.id, this.baseline); this.document.changed();
    }

    /** Releases session subscriptions when this document finally closes. */
    ngOnDestroy(): void { this.subscriptions.unsubscribe(); this.editors.closeSession(this.document.id); this.presets.restoreEffectiveIssues(); }
}
