import {Component, ElementRef, Renderer2, ViewChild} from '@angular/core';
import {environment} from "./environments/environment";
import {AppStateService} from "./shared/appstate.service";

@Component({
    selector: 'dockable-layout',
    template: `
        <div class="main-layout">
            <div class="viewer-layout" [ngClass]="{'open': !stateService.isDockOpen, 'collapsed': stateService.isDockOpen}">
                <mapview-container></mapview-container>
                @if (!environment.visualizationOnly) {
                    <main-bar></main-bar>
                    <coordinates-panel></coordinates-panel>
                    <div class="dock-toggle" (click)="toggleDock()">
                        @if (stateService.isDockOpen) {
                            <span class="material-symbols-outlined" pTooltip="Collapse dock">
                                chevron_forward
                            </span>
                        } @else {
                            <span class="material-symbols-outlined" pTooltip="Open dock">
                                chevron_backward
                            </span>
                        }
                    </div>
                }
            </div>
            @if (!environment.visualizationOnly) {
                <div #dock class="collapsible-dock" [ngClass]="{'collapsed': !this.stateService.isDockOpen, 'open': stateService.isDockOpen}">
                    @if (stateService.isDockOpen) {
                        <div class="resize-handle" (pointerdown)="onResizeStart($event)"></div>
                    }
                    <div class="drop-hint"></div>
                    <inspection-container [ngClass]="{'hidden': !stateService.isDockOpen}"></inspection-container>
                </div>
            }
        </div>
    `,
    styles: [``],
    standalone: false
})
export class DockableLayoutComponent {

    @ViewChild('dock') private dockRef?: ElementRef<HTMLDivElement>;
    private detachMove?: () => void;
    private detachUp?: () => void;
    private dockRight = 0;
    private dragging = false;

    constructor(public stateService: AppStateService, private renderer: Renderer2) {}

    protected readonly environment = environment;

    protected toggleDock() {
        this.stateService.isDockOpen = !this.stateService.isDockOpen;
    }
    
    onResizeStart(ev: PointerEvent) {
        if (!this.stateService.isDockOpen || !this.dockRef) return;
        ev.preventDefault();
        ev.stopPropagation();
        const el = this.dockRef.nativeElement;
        const rect = el.getBoundingClientRect();
        this.dockRight = rect.right;
        this.dragging = true;
        // Improve UX while dragging
        document.body.style.cursor = 'col-resize';
        (document.body.style as any)['userSelect'] = 'none';
        // Listen on window to capture outside the element
        this.detachMove = this.renderer.listen('window', 'pointermove', (e: PointerEvent) => this.onPointerMove(e));
        this.detachUp = this.renderer.listen('window', 'pointerup', () => this.onPointerUp());
    }

    private onPointerMove(ev: PointerEvent) {
        if (!this.dragging || !this.dockRef) return;
        // Compute new width from left edge drag: width = rightEdge - pointerX
        const newWidth = Math.max(0, this.dockRight - ev.clientX);
        this.dockRef.nativeElement.style.width = `${Math.round(newWidth)}px`;
    }

    private onPointerUp() {
        if (!this.dragging) return;
        this.dragging = false;
        // Cleanup listeners and body styles
        this.detachMove?.();
        this.detachUp?.();
        this.detachMove = undefined;
        this.detachUp = undefined;
        document.body.style.cursor = '';
        (document.body.style as any)['userSelect'] = '';
    }
}
