import {ChangeDetectorRef, Component, ElementRef, OnDestroy, Renderer2, ViewChild} from '@angular/core';
import {Subscription} from 'rxjs';
import {DockedPanelDragController} from '../layout/docked-panel-drag.controller';
import {EDITORS_DOCK_TAB_ID} from '../layout/layout.model';
import {EditorWorkspaceService} from './editor-workspace.service';

@Component({
    selector: 'editor-dock', standalone: false,
    template: `
        <div #container class="editor-dock-container" [class.single-panel]="workspace.docked().length === 1"
             [class.multi-panel]="workspace.docked().length > 1" [class.reordering]="drag.state.isReordering">
            @for (entry of workspace.docked(); track entry.descriptor.id) {
                <editor-surface [entry]="entry" [docked]="true" [panelCount]="workspace.docked().length"
                    [class.dragging]="drag.state.draggedId === entry.descriptor.id"
                    [class.drop-before]="drag.state.dropBeforeId === entry.descriptor.id"
                    [class.drop-after]="drag.state.dropAfterId === entry.descriptor.id"
                    (panelDragRequest)="drag.start($event.entry.descriptor.id, $event.event)"/>
            }
        </div>
    `
})
/** Uses the existing dock drag/reorder contract for document surfaces. */
export class EditorDockComponent implements OnDestroy {
    @ViewChild('container') private container?: ElementRef<HTMLElement>;
    readonly drag: DockedPanelDragController<string>;
    private readonly subscription: Subscription;

    /** Wires live document order and undocking to the shared drag controller. */
    constructor(public readonly workspace: EditorWorkspaceService, renderer: Renderer2, cdr: ChangeDetectorRef) {
        this.subscription = workspace.changed.subscribe(() => cdr.markForCheck());
        this.drag = new DockedPanelDragController({
            renderer, baseFontSize: () => workspace.layout.baseFontSize,
            container: () => this.container?.nativeElement, itemSelector: 'editor-surface',
            readId: element => element.dataset['editorId'],
            previewClass: 'app-dock-drag-preview', previewHeaderClass: 'app-dock-drag-preview-header', previewFillClass: 'app-dock-drag-preview-fill',
            applyReorder: order => {
                workspace.layout.reorderDockedSurfaces(EDITORS_DOCK_TAB_ID, order.map(id => `editor:${id}`));
                workspace.notify();
            },
            undock: (id, event, offset) => {
                const entry = workspace.entries.find(item => item.descriptor.id === id);
                if (!entry) return;
                workspace.layout.setDialogPosition(entry.layoutId, {left: Math.max(0, event.clientX - offset.x), top: Math.max(0, event.clientY - offset.y)});
                workspace.dock(entry, false);
            }
        });
    }

    /** Cancels pointer tracking without disposing any document. */
    ngOnDestroy(): void { this.subscription.unsubscribe(); this.drag.destroy(); }
}
