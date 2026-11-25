import {Component, Inject, OnDestroy, OnInit} from '@angular/core';
import {Subscription} from 'rxjs';
import {AppStateService} from '../appstate/appstate.service';
import {EDITOR_DOCUMENT} from '../editor/editor-workspace.service';
import {EditorDocumentController, EditorDocumentRef} from '../editor/editor-document.model';
import {EditorService} from '../editor/editor.service';

@Component({
    selector: 'advanced-preferences', standalone: false,
    template: `
        @if (error) { <div class="editor-document-error advanced-preferences-validation-error" role="alert">{{ error }}</div> }
        <editor [sessionId]="document.id"/>
        <div class="editor-actions advanced-preferences-actions">
            <p-button [label]="saveLabel" icon="pi pi-check" [disabled]="!saveEnabled" (click)="save()"/>
            <p-button label="Import" icon="pi pi-file-import" (click)="snapshotFileInput.click()"/>
            <p-button label="Export" icon="pi pi-file-export" (click)="exportSnapshot()"/>
            <p-button [label]="dirty ? 'Discard' : 'Close'" (click)="document.close($event)"/>
            <input #snapshotFileInput type="file" accept=".json,application/json" hidden (change)="importFile($event)">
        </div>
    `
})
/** Edits a detached snapshot without persisting its own draft inside application state. */
export class AdvancedPreferencesComponent implements EditorDocumentController, OnInit, OnDestroy {
    readonly title = 'Advanced Preferences';
    busy = false;
    error = '';
    private baseline = '';
    private baselineState: Record<string, unknown> = {};
    private reviewToken = '';
    private destroyed = false;
    private fileGeneration = 0;
    private readonly subscriptions = new Subscription();

    /** Keeps application-state mutation in the existing persistence owner. */
    constructor(@Inject(EDITOR_DOCUMENT) public readonly document: EditorDocumentRef,
                private readonly state: AppStateService, private readonly editors: EditorService) {}

    get dirty(): boolean { return this.editors.getSessionSource(this.document.id).trimEnd() !== this.baseline.trimEnd(); }
    get saveLabel(): string { return this.reviewToken ? 'Apply reviewed snapshot' : 'Save'; }
    get saveEnabled(): boolean { return this.dirty && !this.busy; }

    /** Captures the baseline exactly once, independent of surface visibility. */
    ngOnInit(): void {
        this.baselineState = this.state.exportSnapshot();
        this.baseline = JSON.stringify(this.baselineState, null, 2);
        const session = this.editors.createSession({id: this.document.id, source: this.baseline, language: 'json'});
        this.subscriptions.add(session.source$.subscribe(() => { this.reviewToken = ''; this.document.changed(); }));
        this.subscriptions.add(session.saveRequested$.subscribe(() => { void this.save(); }));
    }

    /** Reviews stale values and applies a validated snapshot as one existing transaction. */
    async save(): Promise<boolean> {
        if (!this.saveEnabled) return false;
        const text = this.editors.getSessionSource(this.document.id);
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(text); } catch { this.error = 'Advanced preferences JSON syntax is invalid.'; this.document.changed(); return false; }
        const errors = this.state.validateSnapshot(parsed);
        if (errors.length) { this.error = errors[0]; this.document.changed(); return false; }
        const blockers = this.document.conflictingEditors(parsed);
        if (blockers.length) { this.error = `Save or close these unsaved editors before replacing their workspace: ${blockers.join(', ')}.`; this.document.changed(); return false; }
        const live = this.state.exportSnapshot();
        const changed = Object.keys(parsed).filter(key => JSON.stringify(live[key]) !== JSON.stringify(this.baselineState[key]) && JSON.stringify(live[key]) !== JSON.stringify(parsed[key]));
        const token = JSON.stringify([text, changed.map(key => [key, live[key]])]);
        if (changed.length && this.reviewToken !== token) {
            this.reviewToken = token;
            this.error = `The following state changed since this snapshot was opened and will be replaced: ${changed.join(', ')}. Review it, then choose Apply reviewed snapshot.`;
            this.document.changed(); return false;
        }
        this.busy = true; this.document.changed();
        try {
            const result = this.state.importSnapshot(parsed);
            if (result.length) { this.error = result[0]; return false; }
            this.baselineState = this.state.exportSnapshot();
            this.baseline = JSON.stringify(this.baselineState, null, 2);
            this.editors.updateSessionSource(this.document.id, this.baseline);
            this.error = ''; this.reviewToken = ''; return true;
        } finally { this.busy = false; this.document.changed(); }
    }

    /** Loads a bounded file into this draft; a late read cannot replace newer input. */
    async importFile(event: Event): Promise<void> {
        const input = event.target as HTMLInputElement, file = input.files?.[0];
        if (!file) return;
        const generation = ++this.fileGeneration;
        const before = this.editors.getSessionSource(this.document.id);
        if (file.size > this.state.getSnapshotImportLimits().maxFileSizeBytes) { this.error = 'The snapshot file exceeds the import size limit.'; input.value = ''; this.document.changed(); return; }
        try {
            const source = await file.text();
            if (this.destroyed || generation !== this.fileGeneration) return;
            if (this.editors.getSessionSource(this.document.id) !== before) { this.error = 'The draft changed while the file was loading. Import again to replace it.'; return; }
            this.editors.updateSessionSource(this.document.id, source); this.error = '';
        } catch { if (!this.destroyed) this.error = 'Could not read the snapshot file.'; }
        finally { input.value = ''; if (!this.destroyed) this.document.changed(); }
    }

    /** Downloads the actual draft without applying it to the running viewer. */
    exportSnapshot(): void {
        const url = URL.createObjectURL(new Blob([this.editors.getSessionSource(this.document.id)], {type: 'application/json;charset=utf-8'}));
        const link = document.createElement('a'); link.href = url; link.download = `mv_state_${new Date().toISOString().replace(/[:.]/g, '-')}.json`; link.click(); URL.revokeObjectURL(url);
    }

    /** Retires file reads and source subscriptions only on final document closure. */
    ngOnDestroy(): void { this.destroyed = true; this.fileGeneration++; this.subscriptions.unsubscribe(); this.editors.closeSession(this.document.id); }
}
