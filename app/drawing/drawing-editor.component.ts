import {DrawingToolsService} from './drawing-tools.service';
import {Component, Inject, OnDestroy} from '@angular/core';
import {Subscription} from 'rxjs';
import {EDITOR_DOCUMENT} from '../editor/editor-workspace.service';
import {EditorDocumentController, EditorDocumentRef} from '../editor/editor-document.model';
import {DrawingDocument, DrawingDocumentsService} from './drawing-documents.service';

@Component({selector: 'drawing-editor', standalone: false, template: `
    @if (doc; as d) {
        @if (d.error) { <div class="editor-document-error" role="alert">{{d.error}} — the map shows the last valid revision.
            @if (d.error.includes('Sampled geometry differs')) { <button type="button" [disabled]="busy" (click)="documents.convertDraft(d)">Use edited geometry as ordinary objects</button> }</div> }
        @if (d.notice) { <div class="drawing-notice" role="status">{{d.notice}}</div> }
        <p-tabs [(value)]="tab" class="style-editor-tabs" aria-label="GeoJSON editor mode">
            <p-tablist><p-tab value="quick">Quick</p-tab><p-tab value="advanced">Advanced</p-tab></p-tablist>
            <p-tabpanels>
                <p-tabpanel value="quick" class="style-editor-quick-panel"><drawing-quick [mapId]="d.mapId"/></p-tabpanel>
                <p-tabpanel value="advanced" class="style-editor-advanced-panel"><editor [sessionId]="d.sessionId"/></p-tabpanel>
            </p-tabpanels>
        </p-tabs>
        <div class="editor-actions style-editor-actions">
            <div class="editor-actions-left">
                <p-button data-testid="drawing-save" label="Save" ariaLabel="Save" icon="pi pi-save" [disabled]="!saveEnabled" (click)="save()"/>
                <p-button [label]="dirty ? 'Discard' : 'Close'" [ariaLabel]="dirty ? 'Discard' : 'Close'" icon="pi pi-times" severity="secondary" [text]="true" (click)="ref.close($event)"/>
                <div class="editor-shortcuts">
                    <span><kbd>Ctrl/Cmd+S</kbd> to save locally</span>
                    <span data-testid="drawing-persistence">{{d.storageError ? 'Browser copy not updated' : d.storagePending ? 'Saving draft…' : 'Draft kept in this browser'}}</span>
                </div>
            </div>
            <div class="editor-actions-right">
                <p-button label="Objects tray" ariaLabel="Open collection in Objects tray" icon="pi pi-list" severity="secondary" [text]="true" (click)="documents.openTray([d.mapId])"/>
                <p-button label="Center" ariaLabel="Center" icon="pi pi-map-marker" severity="secondary" [text]="true" (click)="documents.center(d)"/>
                <p-button data-testid="drawing-export" label="Export" ariaLabel="Export" icon="pi pi-file-export" severity="secondary" [text]="true"
                    [disabled]="busy || !!d.error" (click)="documents.exportFile(d)"/>
            </div>
        </div>
    }
`, styles: [`:host{display:flex;flex-direction:column;min-height:0;flex:1}drawing-quick{display:block;height:100%;min-height:0;overflow:hidden}.drawing-notice{flex:0 0 auto;color:var(--p-text-muted-color);padding:.25rem .5rem;font-size:.8rem}`]})
/** A GeoJSON source editor using the same retained content and action layout as Style Editor. */
export class DrawingEditorComponent implements EditorDocumentController, OnDestroy {
    tab = 'quick';
    readonly doc?: DrawingDocument;
    private readonly subscription: Subscription;
    constructor(@Inject(EDITOR_DOCUMENT) public readonly ref: EditorDocumentRef,
                public readonly documents: DrawingDocumentsService, public readonly tools: DrawingToolsService) {
        this.doc = documents.documents.get(ref.descriptor.target ?? '');
        this.subscription = documents.changed.subscribe(() => ref.changed());
    }
    get title(): string { return this.doc?.name ?? 'Local drawing'; }
    get dirty(): boolean { return !!this.doc && this.documents.dirty(this.doc); }
    get busy(): boolean { return !!this.doc && (this.doc.busy || this.doc.saving); }
    get saveLabel(): string { return 'Save'; }
    get saveEnabled(): boolean { return !!this.doc && !this.busy && !this.doc.error && (this.dirty || !!this.doc.storageError); }
    get error(): string { return this.doc?.error ?? ''; }
    save(): Promise<boolean> { return this.doc ? this.documents.saveWithDialog(this.doc) : Promise.resolve(false); }
    discard(): Promise<boolean> { return this.doc ? this.documents.discard(this.doc) : Promise.resolve(true); }
    ngOnDestroy(): void { this.subscription.unsubscribe(); }
}
