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
        <input type="file" multiple [accept]="documents.importKind === 'geojson' ? '.geojson,.json' : '.txt,.csv,.coordinates'" (change)="choose($event)" aria-label="Choose drawing file"/>
        <p-button label="Create empty" (click)="empty()"/>
    </app-dialog>
    @if (documents.restoring) { <div class="drawing-storage-status" data-testid="drawing-storage-status" aria-live="polite">Restoring saved drawings…</div> }
    <app-dialog [visible]="!!documents.dialog" [modal]="true" [header]="documents.saveDialog ? (documents.saveDocumentId ? 'Save document' : 'Save workspace') : 'Unsaved drawing'"
        [closable]="!documents.workspaceBusy" [closeOnEscape]="!documents.workspaceBusy" (visibleChange)="!$event && documents.cancelSave()">
        @if (documents.saveDialog) {
            <form (submit)="save($event)" class="drawing-save-form">
                <label for="drawing-save-name">Name</label>
                <input pInputText id="drawing-save-name" name="name" [(ngModel)]="documents.saveName" maxlength="256" required [disabled]="!!documents.workspaceBusy"/>
                @if (!documents.saveDocumentId) {
                    <fieldset><legend>Save layout · {{documents.workingDocuments.length}} documents</legend>
                        <label><p-radiobutton name="layout" value="one" [(ngModel)]="documents.saveLayout" inputId="drawing-layout-one" [disabled]="!!documents.workspaceBusy"/> One unified GeoJSON document</label>
                        <label><p-radiobutton name="layout" value="separate" [(ngModel)]="documents.saveLayout" inputId="drawing-layout-separate" [disabled]="!!documents.workspaceBusy"/> Collection · one document per object</label>
                    </fieldset>
                }
                <p>Saved locally in this browser. Export downloads a separate GeoJSON copy.</p>
                <div class="drawing-dialog-actions"><p-button type="submit" data-testid="drawing-save-confirm" label="Save" [loading]="documents.workspaceBusy === 'saving'" [disabled]="!documents.saveName.trim() || !!documents.workspaceBusy"/>
                    <p-button label="Cancel" severity="secondary" [disabled]="!!documents.workspaceBusy" (onClick)="documents.cancelSave()"/></div>
            </form>
        } @else {
            <p>Save your changes, discard them, or continue drawing.</p>
            <div class="drawing-dialog-actions"><p-button label="Save…" [disabled]="!!documents.workspaceBusy" (onClick)="documents.requestSave()"/>
                <p-button label="Discard" severity="danger" [loading]="documents.workspaceBusy === 'discarding'" [disabled]="!!documents.workspaceBusy" (onClick)="discard()"/>
                <p-button label="Keep drawing" severity="secondary" [disabled]="!!documents.workspaceBusy" (onClick)="documents.cancelSave()"/></div>
        }
    </app-dialog>
    <app-dialog [visible]="!!documents.deleteTarget" [modal]="true" header="Delete local document?" [closable]="!deleting" (visibleChange)="!$event && !deleting && cancelDelete()">
        <p>Delete “{{documents.documents.get(documents.deleteTarget)?.name}}” and its browser copy? Export a copy first if you need to keep it.</p>
        <div class="drawing-dialog-actions"><p-button label="Delete document" severity="danger" [loading]="deleting" [disabled]="deleting" (onClick)="deleteDocument()"/>
            <p-button label="Cancel" severity="secondary" [disabled]="deleting" (onClick)="cancelDelete()"/></div>
    </app-dialog>
    <drawing-toolbar/>
`, styles: [`.drawing-save-form{display:flex;flex-direction:column;gap:.75rem;max-width:32rem}.drawing-save-form fieldset{display:flex;flex-direction:column;gap:.75rem;border:1px solid var(--p-content-border-color);border-radius:6px}.drawing-save-form fieldset label{display:flex;align-items:center;gap:.5rem}.drawing-dialog-actions{display:flex;gap:.5rem;flex-wrap:wrap}.drawing-error{position:fixed;bottom:2rem;left:50%;transform:translateX(-50%);z-index:10000;background:var(--p-content-background,#fff);padding:1rem;box-shadow:0 2px 12px #0006}
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
    deleting = false;
    /** Save the captured form target; close only after a successful durable commit. */
    async save(event?: Event): Promise<void> { event?.preventDefault(); try {const close=this.documents.closeAfterSave; if(await this.documents.confirmSave()) {this.documents.closeAfterSave=false;if(close)await this.tools.close();}}catch(error){this.documents.notify('save',String(error));} }
    /** A failed discard leaves the modal and remaining work available for recovery. */
    async discard(): Promise<void> { try {if(await this.documents.discardWorkingSet())await this.tools.close();}catch(error){this.documents.notify('discard',String(error));} }
    /** Dismiss only this document's managed delete confirmation. */
    cancelDelete(): void {this.documents.deleteTarget='';this.documents.changed.next();}
    /** Capture the confirmed identity so subsequent selection cannot change the delete target. */
    async deleteDocument(): Promise<void> {if(this.deleting)return;this.deleting=true;const id=this.documents.deleteTarget;try{await this.documents.remove(id,false);if(!this.documents.documents.has(id))this.cancelDelete();}finally{this.deleting=false;this.documents.changed.next();}}

    /** Import only selected local bytes, never URLs or HTML drag payloads. */
    async choose(event: Event): Promise<void> {
        const input = event.target as HTMLInputElement, files = Array.from(input.files ?? []), kind = this.documents.importKind;
        input.value = '';
        for (const file of files) await this.documents.importFile(file, kind);
    }
    /** Share empty-document initialization with ordinary file imports. */
    async empty(): Promise<void> {
        if (this.documents.importKind) try { await this.documents.create(this.documents.importKind); }
        catch (error) { this.documents.importError = error instanceof Error ? error.message : String(error); this.documents.notify('import', this.documents.importError); this.documents.changed.next(); }
    }
    /** Prevent browser file navigation only for actual file drags. */
    @HostListener('window:dragover', ['$event']) dragOver(event: DragEvent): void {
        if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
    }
    /** Each dropped file is an independent virtual source and editor. */
    @HostListener('window:drop', ['$event']) async drop(event: DragEvent): Promise<void> {
        if (!event.dataTransfer?.files.length) return;
        event.preventDefault();
        for (const file of Array.from(event.dataTransfer.files)) await this.documents.importFile(file);
    }
    /** Tool keys are consumed only outside editors and modal dialogs, in the captured view. */
    @HostListener('window:keydown', ['$event']) key(event: KeyboardEvent): void {
        const target = event.target as HTMLElement | null;
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey ||
            target?.closest('input,textarea,select,[contenteditable="true"],.cm-editor,[aria-modal="true"]')) return;
        if (event.key === 'Shift') this.tools.setShift(true);
        if ((!this.tools.active && !this.tools.editing) || this.views.viewIdAt(this.views.focusedView) !== this.tools.viewId) return;
        if(event.key==='Delete'&&this.tools.canDeleteFocusedVertex&&!target?.closest('button,[role="tree"],[role="grid"],[role="dialog"]')){
            event.preventDefault();event.stopPropagation();void this.tools.deleteSelectedVertex();return;
        }
        if (event.key === 'Escape' || event.key === 'Backspace') {
            event.preventDefault(); event.stopPropagation();
            if (event.key === 'Escape') this.tools.cancelGesture(); else this.tools.backspace();
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
