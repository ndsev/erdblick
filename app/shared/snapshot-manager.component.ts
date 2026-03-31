import {Component, ElementRef, HostListener, ViewChild} from '@angular/core';
import {Subscription} from 'rxjs';
import {AppStateService} from './appstate.service';
import {EditorService} from './editor.service';
import {AppDialogComponent} from './app-dialog.component';
import {DialogStackService} from './dialog-stack.service';

@Component({
    selector: 'snapshot-manager',
    template: `
        <app-dialog header="State Snapshots"
                    class="editor-dialog snapshot-manager-dialog"
                    [(visible)]="stateService.snapshotManagerDialogVisible"
                    [modal]="false"
                    [closable]="false"
                    [closeOnEscape]="false"
                    [persistLayout]="true"
                    [layoutId]="'snapshot-manager-dialog'"
                    #snapshotDialog
                    (onShow)="onDialogShow()"
                    (onHide)="onDialogHide()">
            @if (validationError.length > 0) {
                <div class="snapshot-validation-error">{{ validationError }}</div>
            }
            <editor [sessionId]="snapshotEditorSessionId"></editor>
            <div class="snapshot-manager-actions">
                <div class="snapshot-manager-actions-left">
                    <p-button (click)="saveSnapshot()"
                              label="Save"
                              icon="pi pi-check"
                              [disabled]="!dirty"></p-button>
                    <p-button (click)="triggerImport()"
                              label="Import"
                              icon="pi pi-file-import"></p-button>
                    <p-button (click)="exportSnapshot()"
                              label="Export"
                              icon="pi pi-file-export"></p-button>
                    <input #snapshotFileInput
                           type="file"
                           accept=".json,application/json"
                           style="display: none;"
                           (change)="onImportFileSelected($event)">
                </div>
                <p-button (click)="closeDialog($event)"
                          [label]="dirty ? 'Discard' : 'Close'"
                          icon="pi pi-times"></p-button>
            </div>
        </app-dialog>
        <app-dialog header="Warning!"
                    [(visible)]="discardWarningVisible"
                    [modal]="true"
                    [closeOnEscape]="false"
                    #discardWarningDialog
                    (onShow)="onDiscardWarningShow()">
            <p>You have unsaved snapshot changes. Do you want to save before closing?</p>
            <div style="margin: 0.5em 0; display: flex; flex-direction: row; align-content: center; gap: 0.5em;">
                <p-button (click)="saveSnapshot(true)" label="Save"></p-button>
                <p-button (click)="discardWarningVisible = false" label="Cancel"></p-button>
                <p-button (click)="discardAndClose()" label="Discard"></p-button>
            </div>
        </app-dialog>
    `,
    styles: [`
        .snapshot-validation-error {
            color: #d32f2f;
            margin-bottom: 0.5em;
        }

        .snapshot-manager-actions {
            margin-top: 0.5em;
            display: flex;
            flex-direction: row;
            justify-content: space-between;
            gap: 0.5em;
        }

        .snapshot-manager-actions-left {
            display: flex;
            flex-direction: row;
            gap: 0.5em;
        }
    `],
    standalone: false
})
export class SnapshotManagerComponent {
    readonly snapshotEditorSessionId = 'snapshot-manager-editor';
    dirty = false;
    discardWarningVisible = false;
    validationError = '';

    @ViewChild('snapshotDialog') snapshotDialog?: AppDialogComponent;
    @ViewChild('discardWarningDialog') discardWarningDialog?: AppDialogComponent;
    @ViewChild('snapshotFileInput') snapshotFileInput?: ElementRef<HTMLInputElement>;

    private baselineSnapshotText = '';
    private sourceSubscription: Subscription = new Subscription();
    private saveSubscription: Subscription = new Subscription();

    constructor(public readonly stateService: AppStateService,
                private readonly editorService: EditorService,
                private readonly dialogStack: DialogStackService) {}

    onDialogShow() {
        const snapshotText = JSON.stringify(this.stateService.exportSnapshot(), null, 2);
        this.baselineSnapshotText = snapshotText;
        this.validationError = '';
        this.dirty = false;
        this.editorService.createSession({
            id: this.snapshotEditorSessionId,
            source: snapshotText,
            language: 'json',
            readOnly: false
        });
        const session = this.editorService.getSession(this.snapshotEditorSessionId);
        if (session) {
            this.sourceSubscription.unsubscribe();
            this.sourceSubscription = session.source$.subscribe(source => {
                this.dirty = source.trimEnd() !== this.baselineSnapshotText.trimEnd();
            });
            this.saveSubscription.unsubscribe();
            this.saveSubscription = this.editorService.onSaveRequested(this.snapshotEditorSessionId)?.subscribe(() => {
                this.saveSnapshot();
            }) ?? new Subscription();
        }
        this.dialogStack.bringToFront(this.snapshotDialog);
    }

    onDialogHide() {
        this.sourceSubscription.unsubscribe();
        this.saveSubscription.unsubscribe();
        this.sourceSubscription = new Subscription();
        this.saveSubscription = new Subscription();
        this.editorService.closeSession(this.snapshotEditorSessionId);
        this.validationError = '';
        this.dirty = false;
        this.discardWarningVisible = false;
    }

    closeDialog(event: Event) {
        event.stopPropagation();
        if (this.dirty) {
            this.discardWarningVisible = true;
            return;
        }
        this.stateService.snapshotManagerDialogVisible = false;
    }

    saveSnapshot(closeAfterSave: boolean = false) {
        const editorText = this.editorService.getSessionSource(this.snapshotEditorSessionId);
        let parsed: unknown;
        try {
            parsed = JSON.parse(editorText);
        } catch {
            this.validationError = 'Snapshot JSON syntax is invalid.';
            return;
        }

        const errors = this.stateService.importSnapshot(parsed);
        if (errors.length) {
            this.validationError = errors[0];
            return;
        }

        const nextText = JSON.stringify(this.stateService.exportSnapshot(), null, 2);
        this.baselineSnapshotText = nextText;
        this.editorService.updateSessionSource(this.snapshotEditorSessionId, nextText);
        this.validationError = '';
        this.dirty = false;
        this.discardWarningVisible = false;
        if (closeAfterSave) {
            this.stateService.snapshotManagerDialogVisible = false;
        }
    }

    triggerImport() {
        this.snapshotFileInput?.nativeElement.click();
    }

    async onImportFileSelected(event: Event) {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) {
            return;
        }
        const limits = this.stateService.getSnapshotImportLimits();
        if (file.size > limits.maxFileSizeBytes) {
            this.validationError = `Snapshot file exceeds ${limits.maxFileSizeBytes} bytes.`;
            input.value = '';
            return;
        }
        const text = await file.text();
        this.editorService.updateSessionSource(this.snapshotEditorSessionId, text);
        this.validateSnapshotText(text);
        input.value = '';
    }

    exportSnapshot() {
        const source = this.editorService.getSessionSource(this.snapshotEditorSessionId);
        const blob = new Blob([source], {type: 'application/json;charset=utf-8'});
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `mv_state_${this.snapshotTimestamp()}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
    }

    discardAndClose() {
        this.discardWarningVisible = false;
        this.validationError = '';
        this.stateService.snapshotManagerDialogVisible = false;
    }

    @HostListener('window:keydown', ['$event'])
    onWindowKeyDown(event: KeyboardEvent) {
        if (event.key !== 'Escape' || !this.stateService.snapshotManagerDialogVisible) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (this.discardWarningVisible) {
            this.discardWarningVisible = false;
            return;
        }
        this.closeDialog(event);
    }

    onDiscardWarningShow() {
        this.dialogStack.bringToFront(this.discardWarningDialog);
    }

    private validateSnapshotText(source: string) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(source);
        } catch {
            this.validationError = 'Snapshot JSON syntax is invalid.';
            return;
        }
        const errors = this.stateService.validateSnapshot(parsed);
        this.validationError = errors.length ? errors[0] : '';
    }

    private snapshotTimestamp(): string {
        return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
    }
}
