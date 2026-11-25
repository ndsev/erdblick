import {AfterViewInit, Directive, ElementRef, Input, OnDestroy} from '@angular/core';
import {EditorWorkspaceEntry, EditorWorkspaceService} from './editor-workspace.service';

@Directive({selector: '[editorContentOutlet]', standalone: false})
/** Places a retained Angular root view in a disposable dialog/panel content slot. */
export class EditorContentOutletDirective implements AfterViewInit, OnDestroy {
    @Input({required: true}) entry!: EditorWorkspaceEntry;

    private destroyed = false;

    /** Captures the native slot without making it the owner of the document view. */
    constructor(private readonly element: ElementRef<HTMLElement>, private readonly workspace: EditorWorkspaceService) {}

    /** Moves the one document view into this slot after Angular has created it. */
    ngAfterViewInit(): void {
        // Dynamic root creation must happen after the shell's current view check.
        queueMicrotask(() => {
            if (!this.destroyed) { this.workspace.attach(this.entry, this.element.nativeElement); this.workspace.notify(); }
        });
    }

    /** Parks content only if this outgoing slot still owns its native element. */
    ngOnDestroy(): void { this.destroyed = true; this.workspace.detach(this.entry, this.element.nativeElement); }
}
