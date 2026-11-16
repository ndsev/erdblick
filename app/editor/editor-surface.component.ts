import {ChangeDetectorRef, Component, DoCheck, EventEmitter, Input, OnDestroy, Output, ViewChild} from '@angular/core';
import {Subscription} from 'rxjs';
import {AppDialogComponent} from '../layout/app-dialog.component';
import {DialogStackService} from '../layout/dialog-stack.service';
import {EditorWorkspaceEntry, EditorWorkspaceService} from './editor-workspace.service';

@Component({
    selector: 'editor-surface', standalone: false,
    host: {'[attr.data-editor-id]': 'entry.descriptor.id', '[attr.data-editor-kind]': 'entry.descriptor.kind'},
    template: `
        @if (docked) {
            <app-panel class="editor-panel" data-testid="editor-docked-panel" [layoutId]="entry.layoutId" [persistLayout]="true"
                       [dockedPanelCount]="panelCount" [expanded]="expanded" [collapsed]="collapsed"
                       (expandedChange)="setExpanded($event)" (collapsedChange)="setCollapsed($event)">
                <ng-template #header><ng-container *ngTemplateOutlet="editorHeader"/></ng-template>
                <ng-template #content><ng-container *ngTemplateOutlet="editorContent"/></ng-template>
            </app-panel>
        } @else {
            <app-dialog #dialog class="editor-dialog" [attr.data-testid]="testId" [visible]="true" [modal]="false"
                        [closable]="false" [closeOnEscape]="false" [persistLayout]="true" [persistOpenState]="false"
                        [minWidthPx]="320" [minHeightPx]="400"
                        [layoutId]="entry.layoutId" [dockDropCue]="true" (onShow)="onShow()" (onDragEnd)="dragEnded()"
                        (pointerdown)="focusSurface()" (focusin)="focusSurface()">
                <ng-template #header><ng-container *ngTemplateOutlet="editorHeader"/></ng-template>
                <ng-template #content><ng-container *ngTemplateOutlet="editorContent"/></ng-template>
            </app-dialog>
        }
        <ng-template #editorHeader>
            <app-surface-header [title]="controller?.title || entry.descriptor.target || entry.descriptor.kind"
                                [attr.data-testid]="entry.descriptor.kind === 'style' ? 'style-editor-header' : 'editor-header'"
                                [dragEnabled]="true" [dockMode]="docked ? 'undock' : 'dock'"
                                [sizeToggleVisible]="docked" [sizeToggleDisabled]="panelCount < 2" [expanded]="expanded"
                                [hasSmartControl]="controller?.enabled !== undefined"
                                (dragPointerDown)="startDrag($event)" (focusRequest)="focusSurface()"
                                (dockRequest)="workspace.dock(entry, !docked)" (sizeToggleRequest)="setExpanded(!expanded)"
                                (closeRequest)="workspace.requestClose(entry)">
                @if (controller?.enabled !== undefined) {
                    <p-toggleswitch surfaceHeaderSmartControl [inputId]="entry.descriptor.id + '-enabled'"
                                    data-testid="style-editor-enabled" [ngModel]="controller?.enabled"
                                    (ngModelChange)="controller?.setEnabled?.($event)" aria-label="Enable style sheet"/>
                }
                @if (controller?.dirty) { <p-tag surfaceHeaderAfterTitle severity="warn" value="Unsaved"/> }
            </app-surface-header>
        </ng-template>
        <ng-template #editorContent>
            <div class="editor-content-slot" editorContentOutlet [entry]="entry" (keydown)="onKeydown($event)" (pointerdown)="focusSurface()" (focusin)="focusSurface()"></div>
        </ng-template>
    `
})
/** Shares editor chrome while the workspace retains the document beneath it. */
export class EditorSurfaceComponent implements DoCheck, OnDestroy {
    @Input({required: true}) entry!: EditorWorkspaceEntry;
    @Input() docked = false;
    @Input() panelCount = 1;
    @Output() panelDragRequest = new EventEmitter<{entry: EditorWorkspaceEntry; event: PointerEvent}>();
    @ViewChild('dialog') private dialog?: AppDialogComponent;
    private readonly subscription: Subscription;
    private lastActivation = -1;
    private activationFrame?: number;

    /** Requests explicit rendering for document events in the zoneless application. */
    constructor(public readonly workspace: EditorWorkspaceService, private readonly stack: DialogStackService, cdr: ChangeDetectorRef) {
        this.subscription = workspace.changed.subscribe(() => cdr.markForCheck());
    }

    get controller() { return this.entry.content?.instance; }
    get expanded(): boolean { return this.workspace.layout.getDialogLayout(this.entry.layoutId)?.panelExpanded ?? false; }
    get collapsed(): boolean { return this.workspace.layout.getDialogLayout(this.entry.layoutId)?.panelCollapsed ?? false; }
    get testId(): string { return ({style: 'style-editor-dialog', presets: 'style-preset-editor-dialog', datasources: 'datasources-editor-dialog', preferences: 'advanced-preferences-dialog'})[this.entry.descriptor.kind]; }

    /** Raises only this dialog, registering its guarded close callback with the stack. */
    focusSurface(): void {
        const dialog = this.dialog;
        if (dialog) this.stack.bringToFront({container: () => dialog.container(), wrapper: dialog.wrapper, close: () => this.workspace.requestClose(this.entry)});
    }

    /** Completes an activation once the dialog is measurable. */
    onShow(): void { this.focusSurface(); this.scheduleActivation(); }

    /** Handles pending open/focus requests even when the existing shell is reused. */
    ngDoCheck(): void {
        if (this.lastActivation !== this.entry.activationSerial) {
            this.lastActivation = this.entry.activationSerial; this.scheduleActivation();
        }
    }

    /** Defers focus until the content has moved into the newly rendered slot. */
    private scheduleActivation(): void {
        if (this.activationFrame !== undefined) cancelAnimationFrame(this.activationFrame);
        this.activationFrame = requestAnimationFrame(() => {
            this.activationFrame = undefined;
            if (this.docked && (!this.workspace.layout.state.isDockOpen || this.workspace.layout.state.dockActiveTab !== 'editors')) return;
            this.focusSurface();
            this.entry.host?.scrollIntoView({block: 'nearest'});
            this.entry.content?.instance.activate?.(this.entry.activation);
            if (!this.entry.activation) this.entry.host?.querySelector<HTMLElement>('.cm-content, input, button')?.focus({preventScroll: true});
            this.entry.activation = undefined;
        });
    }

    /** Keeps keyboard ownership local and lets nested completion/menu handlers consume first. */
    onKeydown(event: KeyboardEvent): void {
        if (event.defaultPrevented || this.workspace.closing) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault(); event.stopPropagation(); void this.controller?.save();
        } else if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation(); this.workspace.requestClose(this.entry);
        }
    }

    /** Starts the standard floating or docked drag interaction. */
    startDrag(event: PointerEvent): void {
        if (this.docked) this.panelDragRequest.emit({entry: this.entry, event});
        else this.dialog?.startDrag(event);
    }

    /** Docks after a floating header drop overlaps the existing dock cue. */
    dragEnded(): void { if (this.dialog?.overlapsDockDropTarget()) this.workspace.dock(this.entry, true); }

    /** Persists expansion without changing the document's state. */
    setExpanded(value: boolean): void { this.workspace.layout.setPanelLayout(this.entry.layoutId, {panelExpanded: value}); }
    /** Persists collapse without closing the document. */
    setCollapsed(value: boolean): void { this.workspace.layout.setPanelLayout(this.entry.layoutId, {panelCollapsed: value}); }

    /** Cancels shell-owned work; content destruction belongs exclusively to the workspace. */
    ngOnDestroy(): void { this.subscription.unsubscribe(); if (this.activationFrame !== undefined) cancelAnimationFrame(this.activationFrame); }
}
