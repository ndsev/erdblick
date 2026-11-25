import {HttpClient} from '@angular/common/http';
import {Component, Inject, OnDestroy, OnInit} from '@angular/core';
import {Subscription, firstValueFrom, timeout} from 'rxjs';
import {MapDataService} from './mapdata.service';
import {EDITOR_DOCUMENT} from '../editor/editor-workspace.service';
import {EditorDocumentController, EditorDocumentRef} from '../editor/editor-document.model';
import {EditorService} from '../editor/editor.service';

@Component({
    selector: 'datasources', standalone: false,
    template: `
        @if (loading) { <div class="spinner"><p-progressSpinner ariaLabel="Loading datasource configuration"/></div> }
        @if (error) { <div class="editor-document-error" role="alert">{{ error }}</div> }
        @if (readOnly) { <p>Datasource configuration is read-only.</p> }
        @if (hiddenWritable) { <p>Datasource configuration is hidden but writable. Applying changes replaces the hidden configuration.</p> }
        <editor [sessionId]="document.id"/>
        <div class="editor-actions">
            @if (!readOnly) { <p-button label="Apply" icon="pi pi-check" [disabled]="!saveEnabled" (click)="save()"/> }
            <p-button label="Reload configuration" [disabled]="busy || loading" (click)="reload()"/>
            <p-button [label]="dirty ? 'Discard' : 'Close'" (click)="document.close($event)"/>
        </div>
    `
})
/** Owns one datasource configuration draft and its load/write lifecycle. */
export class DatasourcesComponent implements EditorDocumentController, OnInit, OnDestroy {
    readonly title = 'Datasource Configuration';
    readonly saveLabel = 'Apply';
    loading = false;
    busy = false;
    readOnly = true;
    hiddenWritable = false;
    error = '';
    private baseline = '';
    private failedWrite = false;
    private destroyed = false;
    private loadSubscription?: Subscription;
    private sourceSubscription?: Subscription;
    private saveSubscription?: Subscription;

    /** Captures the stable session and existing backend/catalog owners. */
    constructor(@Inject(EDITOR_DOCUMENT) public readonly document: EditorDocumentRef,
                private readonly editors: EditorService, private readonly http: HttpClient,
                private readonly maps: MapDataService) {}

    get dirty(): boolean { return this.failedWrite || this.editors.getSessionSource(this.document.id) !== this.baseline; }
    get saveEnabled(): boolean { return this.dirty && !this.busy && !this.loading && !this.readOnly; }

    /** Starts exactly one initial read for this document. */
    ngOnInit(): void { this.load(); }

    /** Explicitly reloads after the user decides what to do with a draft. */
    reload(): void {
        if (this.dirty && !window.confirm('Discard the unsaved Datasources draft and reload configuration?')) return;
        this.load();
    }

    /** Cancels prior reads and accepts only the current document's configuration. */
    private load(): void {
        this.loadSubscription?.unsubscribe();
        this.loading = true; this.readOnly = true; this.error = ''; this.document.changed();
        this.editors.setReadOnly(this.document.id, true);
        this.loadSubscription = this.http.get<{model?: unknown; schema?: unknown; readOnly?: boolean; datasourceConfigUnavailable?: boolean}>('config')
            .pipe(timeout(30000)).subscribe({
                next: data => {
                    this.loading = false;
                    this.readOnly = data.readOnly ?? true;
                    this.hiddenWritable = data.datasourceConfigUnavailable === true && !this.readOnly;
                    if (!data.model || !data.schema || (data.datasourceConfigUnavailable && this.readOnly)) {
                        this.error = 'Datasource configuration is unavailable or disabled by the server.';
                        this.document.changed(); return;
                    }
                    this.sourceSubscription?.unsubscribe(); this.saveSubscription?.unsubscribe();
                    this.baseline = JSON.stringify(data.model, null, 2); this.failedWrite = false;
                    const session = this.editors.createSession({id: this.document.id, source: this.baseline, language: 'json', readOnly: this.readOnly});
                    this.sourceSubscription = session.source$.subscribe(() => this.document.changed());
                    this.saveSubscription = session.saveRequested$.subscribe(() => { void this.save(); });
                    this.document.changed();
                },
                error: () => { this.loading = false; this.error = 'Could not load datasource configuration.'; this.document.changed(); }
            });
    }

    /** Advances the baseline only after an acknowledged write and retains newer edits. */
    async save(): Promise<boolean> {
        if (!this.saveEnabled) return false;
        const source = this.editors.getSessionSource(this.document.id);
        try { JSON.parse(source); } catch { this.error = 'Datasource configuration must be valid JSON.'; this.document.changed(); return false; }
        this.busy = true; this.error = ''; this.document.changed();
        try {
            await firstValueFrom(this.http.post('config', source, {responseType: 'text'}).pipe(timeout(30000)));
            if (this.destroyed) return false;
            this.baseline = source; this.failedWrite = false;
            await this.maps.reloadDataSources();
            return true;
        } catch {
            if (!this.destroyed) {
                this.failedWrite = true;
                this.error = 'The configuration write or reload failed. The server may have accepted the write; check its state before retrying. Your draft is retained.';
            }
            return false;
        } finally { this.busy = false; if (!this.destroyed) this.document.changed(); }
    }

    /** Cancels reads and prevents late responses from updating another session. */
    ngOnDestroy(): void {
        this.destroyed = true; this.loadSubscription?.unsubscribe(); this.sourceSubscription?.unsubscribe(); this.saveSubscription?.unsubscribe();
        this.editors.closeSession(this.document.id);
    }
}
