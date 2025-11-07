import {Component, ElementRef, Renderer2, ViewChild} from '@angular/core';
import {environment} from "./environments/environment";
import {AppStateService} from "./shared/appstate.service";

@Component({
    selector: 'dockable-layout',
    template: `
        <div class="main-layout">
            <div style="width: 100%; position: relative; height: 100vh;">
                <mapview-container></mapview-container>
                @if (!environment.visualizationOnly) {
                    <pref-components></pref-components>
                    <coordinates-panel></coordinates-panel>
                    <div class="dock-toggle" (click)="toggleDock()">
                        <span class="material-symbols-outlined">
                            @if (isDockOpen) {
                                chevron_forward
                            } @else {
                                chevron_backward
                            }
                        </span>
                    </div>
                }
            </div>
            @if (!environment.visualizationOnly) {
                <div #dock class="collapsible-dock" [ngClass]="{'collapsed': !isDockOpen, 'open': isDockOpen}">
                    @if (isDockOpen) {
                        <div class="resize-handle" (pointerdown)="onResizeStart($event)"></div>
                    }
                    <inspection-container [ngClass]="{'hidden': !isDockOpen}"></inspection-container>
                </div>
            }
        </div>
    `,
    styles: [`
        .main-layout {
            display: flex;
            flex-direction: row;
            align-items: center;
            gap: 0;
        }
        
        .collapsible-dock {
            padding: 0;
            height: 100vh;
            max-width: 50vw;
            min-width: 0;
            overflow: hidden;
            display: flex;
            flex-direction: row;
            align-items: center;
            gap: 0;
            position: relative;
            /* Hide native resizer */
            resize: none;
        }
        
        .collapsed {
            width: 0 !important;
        }
        
        .open {
            /* Let user resize override this default width */
            width: 40em;
        }
        
        .resize-handle {
            position: absolute;
            left: 0;
            top: 0;
            bottom: 0;
            width: 6px;
            cursor: col-resize;
            /* Large hit area, subtle visuals */
            background: transparent;
            z-index: 2;
            touch-action: none;
        }
        .resize-handle:hover {
            background: rgba(0,0,0,0.05);
        }
        
        .hidden {
            display: none;
        }
    `],
    standalone: false
})
export class DockableLayoutComponent {

    isDockOpen: boolean = false;
    @ViewChild('dock') private dockRef?: ElementRef<HTMLDivElement>;
    private detachMove?: () => void;
    private detachUp?: () => void;
    private dockRight = 0;
    private dragging = false;

    constructor(private stateService: AppStateService, private renderer: Renderer2) {
        this.stateService.dockOpenState.subscribe(isDockOpen => this.isDockOpen = isDockOpen);
    }

    protected readonly environment = environment;

    protected toggleDock() {
        this.stateService.dockOpenState.next(!this.isDockOpen);
    }
    
    onResizeStart(ev: PointerEvent) {
        if (!this.isDockOpen || !this.dockRef) return;
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
