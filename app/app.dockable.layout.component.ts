import {Component, ElementRef, OnDestroy, Renderer2, ViewChild} from '@angular/core';
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
export class DockableLayoutComponent implements OnDestroy {
    private static readonly DOCK_RESIZE_PAUSE_START_EVENT = "erdblick-dock-resize-start";
    private static readonly DOCK_RESIZE_PAUSE_END_EVENT = "erdblick-dock-resize-end";

    @ViewChild('dock') private dockRef?: ElementRef<HTMLDivElement>;
    private detachMove?: () => void;
    private detachUp?: () => void;
    private detachCancel?: () => void;
    private dockRight = 0;
    private dragging = false;
    private dockPauseEndRafFirst?: number;
    private dockPauseEndRafSecond?: number;
    private dockResizePauseActive = false;

    constructor(public stateService: AppStateService, private renderer: Renderer2) {}

    protected readonly environment = environment;

    protected toggleDock() {
        this.dispatchDockResizePauseStart();
        this.stateService.isDockOpen = !this.stateService.isDockOpen;
        this.scheduleDockResizePauseEnd();
    }

    ngOnDestroy(): void {
        this.detachMove?.();
        this.detachUp?.();
        this.detachCancel?.();
        this.clearScheduledDockResizePauseEnd();
        this.dispatchDockResizePauseEnd();
    }
    
    onResizeStart(ev: PointerEvent) {
        if (!this.stateService.isDockOpen || !this.dockRef) {
            return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        const el = this.dockRef.nativeElement;
        const rect = el.getBoundingClientRect();
        this.dockRight = rect.right;
        this.dragging = true;
        this.dispatchDockResizePauseStart();
        // Improve UX while dragging
        document.body.style.cursor = 'col-resize';
        (document.body.style as any)['userSelect'] = 'none';
        // Listen on window to capture outside the element
        this.detachMove = this.renderer.listen('window', 'pointermove', (e: PointerEvent) => this.onPointerMove(e));
        this.detachUp = this.renderer.listen('window', 'pointerup', () => this.onPointerUp());
        this.detachCancel = this.renderer.listen('window', 'pointercancel', () => this.onPointerUp());
    }

    private onPointerMove(ev: PointerEvent) {
        if (!this.dragging || !this.dockRef) return;
        // Compute new width from left edge drag: width = rightEdge - pointerX
        const newWidth = Math.max(0, this.dockRight - ev.clientX);
        this.dockRef.nativeElement.style.width = `${newWidth}px`;
    }

    private onPointerUp() {
        if (!this.dragging) return;
        this.dragging = false;
        // Cleanup listeners and body styles
        this.detachMove?.();
        this.detachUp?.();
        this.detachCancel?.();
        this.detachMove = undefined;
        this.detachUp = undefined;
        this.detachCancel = undefined;
        this.dispatchDockResizePauseEnd();
        document.body.style.cursor = '';
        (document.body.style as any)['userSelect'] = '';
    }

    private dispatchDockResizePauseStart() {
        if (this.dockResizePauseActive || typeof window === "undefined") {
            return;
        }
        this.dockResizePauseActive = true;
        window.dispatchEvent(new Event(DockableLayoutComponent.DOCK_RESIZE_PAUSE_START_EVENT));
    }

    private dispatchDockResizePauseEnd() {
        if (!this.dockResizePauseActive || typeof window === "undefined") {
            return;
        }
        this.dockResizePauseActive = false;
        window.dispatchEvent(new Event(DockableLayoutComponent.DOCK_RESIZE_PAUSE_END_EVENT));
    }

    private scheduleDockResizePauseEnd() {
        if (typeof window === "undefined") {
            return;
        }
        this.clearScheduledDockResizePauseEnd();
        this.dockPauseEndRafFirst = window.requestAnimationFrame(() => {
            this.dockPauseEndRafFirst = undefined;
            this.dockPauseEndRafSecond = window.requestAnimationFrame(() => {
                this.dockPauseEndRafSecond = undefined;
                this.dispatchDockResizePauseEnd();
            });
        });
    }

    private clearScheduledDockResizePauseEnd() {
        if (typeof window === "undefined") {
            return;
        }
        if (this.dockPauseEndRafFirst !== undefined) {
            window.cancelAnimationFrame(this.dockPauseEndRafFirst);
            this.dockPauseEndRafFirst = undefined;
        }
        if (this.dockPauseEndRafSecond !== undefined) {
            window.cancelAnimationFrame(this.dockPauseEndRafSecond);
            this.dockPauseEndRafSecond = undefined;
        }
    }
}
