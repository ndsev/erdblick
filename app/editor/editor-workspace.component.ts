import {DrawingEditorComponent} from "../drawing/drawing-editor.component";
import {ChangeDetectorRef, Component, OnDestroy, OnInit} from '@angular/core';
import {Subscription} from 'rxjs';
import {DatasourcesComponent} from '../mapdata/datasources.component';
import {StyleEditorDocumentComponent} from '../mapstyle/style-editor-document.component';
import {MapPresetEditorComponent} from '../mapstyle/map-preset-editor.component';
import {AdvancedPreferencesComponent} from '../preferences/advanced-preferences.component';
import {EditorWorkspaceService} from './editor-workspace.service';

@Component({
    selector: 'editor-workspace', standalone: false,
    template: `
        @for (entry of workspace.floating(); track entry.descriptor.id) { <editor-surface [entry]="entry"/> }
        <app-dialog header="Unsaved editor changes" [visible]="!!workspace.closing" [modal]="true" [closable]="false"
                    [closeOnEscape]="false" appendTo="body" data-testid="editor-close-confirmation">
            @if (workspace.closing?.content?.instance; as controller) {
                <p>{{ controller.title }}</p>
                @if (controller.busy) { <p>A write is in progress. Wait for its result before closing.</p> }
                @else { <p>Save the changes, discard this draft, or return to the editor.</p> }
                @if (controller.error) { <p role="alert">{{ controller.error }}</p> }
                <div class="dialog-controls">
                    <p-button [label]="controller.saveLabel" [disabled]="!controller.saveEnabled" (click)="workspace.saveAndClose()"/>
                    <p-button label="Discard" severity="danger" [disabled]="controller.busy" (click)="workspace.discard()"/>
                    <p-button label="Cancel" (click)="workspace.cancelClose()"/>
                </div>
            }
        </app-dialog>
    `
})
/** Composes the four supported document types and the floating editor surfaces. */
export class EditorWorkspaceComponent implements OnInit, OnDestroy {
    private readonly subscription: Subscription;

    /** Subscribes to structural updates without exposing document buffers to AppState. */
    constructor(public readonly workspace: EditorWorkspaceService, cdr: ChangeDetectorRef) {
        this.subscription = workspace.changed.subscribe(() => cdr.markForCheck());
    }

    /** Registers content types only in the full browser UI, after application initialization. */
    ngOnInit(): void {
        this.workspace.initialize({style: StyleEditorDocumentComponent, presets: MapPresetEditorComponent, datasources: DatasourcesComponent, preferences: AdvancedPreferencesComponent, drawing: DrawingEditorComponent});
    }

    /** Releases the host subscription without treating it as a document-close command. */
    ngOnDestroy(): void { this.subscription.unsubscribe(); }
}
