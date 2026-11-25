import {ChangeDetectorRef, Component, HostListener, OnDestroy} from '@angular/core';
import {Subscription} from 'rxjs';
import {DrawingDocumentsService} from './drawing-documents.service';
import {DrawingToolsService} from './drawing-tools.service';
import {MapViewState} from '../mapview/mapview.state';

@Component({selector: 'drawing-workspace', standalone: false, template: `
    <app-dialog [visible]="!!documents.importKind" [modal]="true" header="New local drawing" [closable]="true"
                (visibleChange)="documents.importKind = undefined" [closeOnEscape]="true">
        <p>{{documents.importKind === 'geojson' ? 'GeoJSON' : 'UTF-8 coordinates: longitude latitude [height in cm] description'}}</p>
        @if (documents.importKind === 'coordinates') { <p>Coordinates are converted to GeoJSON for editing, browser storage, and export.</p> }
        <p>Files and edits are kept in this browser and restored on reload. Use Export in the Editor to download a separate copy.</p>
        <input type="file" [accept]="documents.importKind === 'geojson' ? '.geojson,.json' : '.txt,.csv,.coordinates'" (change)="choose($event)" aria-label="Choose drawing file"/>
        <p-button label="Create empty" (click)="empty()"/>
        @if (documents.importError) { <p role="alert">{{documents.importError}}</p> }
    </app-dialog>
    @if (documents.importError && !documents.importKind) { <div role="alert" class="drawing-error">{{documents.importError}} <button (click)="documents.importError = ''">Dismiss</button></div> }
    @if (documents.restoring || documents.restoreErrors.length || documents.unloadUnsafe) {
        <div class="drawing-storage-status" data-testid="drawing-storage-status" aria-live="polite">
            @if (documents.restoring) { <p>Restoring saved drawings…</p> }
            @for (error of documents.restoreErrors; track $index) { <p role="alert">{{error}}</p> }
            @for (doc of documents.documents.values(); track doc.mapId) {
                @if (doc.storageError) {
                    <p role="alert">{{doc.name}}: {{doc.storageError}}
                        <button (click)="documents.open(doc.mapId)">Open in Editor</button>
                        <button (click)="documents.persist(doc)">Retry browser save</button>
                    </p>
                }
            }
        </div>
    }
    <drawing-toolbar/>
`, styles: [`.drawing-error{position:fixed;bottom:2rem;left:50%;transform:translateX(-50%);z-index:10000;background:var(--p-content-background,#fff);padding:1rem;box-shadow:0 2px 12px #0006}
.drawing-storage-status{position:fixed;bottom:.5rem;left:.5rem;max-width:min(36rem,90vw);max-height:30vh;overflow:auto;z-index:10000;background:var(--p-content-background,#fff);padding:0 .75rem;box-shadow:0 2px 12px #0006}`]})
/** Full-UI file import, drag/drop, and floating measurement surfaces. */
export class DrawingWorkspaceComponent implements OnDestroy {
    private readonly subscriptions = new Subscription();
    /** Subscribe explicitly for zoneless async worker and file-picker updates. */
    constructor(public readonly documents: DrawingDocumentsService, public readonly tools: DrawingToolsService,
                private readonly views: MapViewState, cdr: ChangeDetectorRef) {
        this.subscriptions.add(documents.changed.subscribe(() => cdr.markForCheck()));
        this.subscriptions.add(tools.changed.subscribe(() => cdr.markForCheck()));
    }
    /** Import only selected local bytes, never URLs or HTML drag payloads. */
    choose(event: Event): void {
        const input = event.target as HTMLInputElement, file = input.files?.[0];
        if (file) void this.documents.importFile(file, this.documents.importKind); input.value = '';
    }
    /** Share empty-document initialization with ordinary file imports. */
    async empty(): Promise<void> {
        if (this.documents.importKind) try { await this.documents.create(this.documents.importKind); }
        catch (error) { this.documents.importError = error instanceof Error ? error.message : String(error); this.documents.changed.next(); }
    }
    /** Prevent browser file navigation only for actual file drags. */
    @HostListener('window:dragover', ['$event']) dragOver(event: DragEvent): void {
        if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
    }
    /** Each dropped file is an independent virtual source and editor. */
    @HostListener('window:drop', ['$event']) drop(event: DragEvent): void {
        if (!event.dataTransfer?.files.length) return;
        event.preventDefault();
        for (const file of Array.from(event.dataTransfer.files)) void this.documents.importFile(file);
    }
    /** Tool keys are consumed only outside editors and modal dialogs, in the captured view. */
    @HostListener('window:keydown', ['$event']) key(event: KeyboardEvent): void {
        const target = event.target as HTMLElement | null;
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey ||
            target?.closest('input,textarea,select,[contenteditable="true"],.cm-editor,[aria-modal="true"]')) return;
        if (event.key === 'Shift') this.tools.setShift(true);
        if (!this.tools.active || this.views.viewIdAt(this.views.focusedView) !== this.tools.viewId) return;
        if (event.key === 'Escape' || event.key === 'Backspace') {
            event.preventDefault(); event.stopPropagation();
            if (event.key === 'Escape') this.tools.finish(); else this.tools.backspace();
        }
    }
    @HostListener('window:keyup', ['$event']) keyUp(event: KeyboardEvent): void { if (event.key === 'Shift') this.tools.setShift(false); }
    @HostListener('window:blur') blur(): void { this.tools.blur(); }
    /** Flush raw drafts before navigation; warn only when browser recovery or a pending save is unsafe. */
    @HostListener('window:beforeunload', ['$event']) beforeUnload(event: BeforeUnloadEvent): void {
        this.documents.flushPersistence();
        if (this.documents.unloadUnsafe || this.tools.pendingUpdates) { event.preventDefault(); event.returnValue = ''; }
    }
    /** Background transitions also flush pending text on browsers that omit beforeunload. */
    @HostListener('document:visibilitychange') visibilityChanged(): void {
        if (document.visibilityState === 'hidden') this.documents.flushPersistence();
    }
    /** Preserve drafts when the browser freezes a page into its back/forward cache. */
    @HostListener('window:pagehide') pageHide(): void { this.documents.flushPersistence(); }
    /** UI teardown does not itself remove source documents. */
    ngOnDestroy(): void { this.subscriptions.unsubscribe(); }
}
