import {NgTemplateOutlet} from '@angular/common';
import {
    Component,
    ContentChild,
    EventEmitter,
    Input,
    OnChanges,
    OnDestroy,
    Output,
    Renderer2,
    SimpleChanges,
    TemplateRef,
    ViewChild
} from '@angular/core';
import {Dialog, DialogModule} from 'primeng/dialog';
import {AppDialogLayout, AppStateService} from './appstate.service';
import {
    AppDialogBounds,
    AppDialogResizeCorner,
    AppDialogResizeLimits,
    resizeAppDialogBounds
} from './app-dialog-resize';

interface AppDialogResizeSession {
    pointerId: number;
    corner: AppDialogResizeCorner;
    startPointerX: number;
    startPointerY: number;
    startBounds: AppDialogBounds;
    limits: AppDialogResizeLimits;
    handle: HTMLElement;
    bodyCursor: string;
    bodyUserSelect: string;
}

@Component({
    selector: 'app-dialog',
    host: {
        class: 'app-dialog'
    },
    template: `
        <p-dialog #dialog
                  [visible]="visible"
                  (visibleChange)="handleVisibleChange($event)"
                  [header]="header"
                  [modal]="modal"
                  [closable]="closable"
                  [draggable]="draggable"
                  [resizable]="false"
                  [style]="effectiveStyle"
                  [position]="position"
                  [showHeader]="showHeader"
                  [appendTo]="appendTo"
                  [baseZIndex]="baseZIndex"
                  [autoZIndex]="autoZIndex"
                  [focusOnShow]="focusOnShow"
                  [closeOnEscape]="closeOnEscape"
                  [dismissableMask]="dismissableMask"
                  [keepInViewport]="keepInViewport"
                  [contentStyle]="contentStyle"
                  [contentStyleClass]="contentStyleClass"
                  [styleClass]="styleClass"
                  [maskStyleClass]="maskStyleClass"
                  (onShow)="handleOnShow($event)"
                  (onHide)="handleOnHide($event)"
                  (onDragEnd)="handleOnDragEnd($event)"
                  >
            @if (projectedHeaderTemplate) {
                <ng-template #header>
                    <ng-container *ngTemplateOutlet="projectedHeaderTemplate"></ng-container>
                </ng-template>
            }
            @if (projectedContentTemplate) {
                <ng-template #content>
                    <ng-container *ngTemplateOutlet="projectedContentTemplate"></ng-container>
                </ng-template>
            }
            @if (projectedFooterTemplate) {
                <ng-template #footer>
                    <ng-container *ngTemplateOutlet="projectedFooterTemplate"></ng-container>
                </ng-template>
            }
            <ng-content></ng-content>
        </p-dialog>
    `,
    standalone: true,
    imports: [DialogModule, NgTemplateOutlet]
})
/** Wraps PrimeNG dialogs with shared layout persistence behavior. */
export class AppDialogComponent implements OnChanges, OnDestroy {
    @ContentChild('header', {descendants: true, read: TemplateRef}) projectedHeaderTemplate?: TemplateRef<unknown>;
    @ContentChild('content', {descendants: true, read: TemplateRef}) projectedContentTemplate?: TemplateRef<unknown>;
    @ContentChild('footer', {descendants: true, read: TemplateRef}) projectedFooterTemplate?: TemplateRef<unknown>;

    @Input() visible = false;
    @Output() visibleChange = new EventEmitter<boolean>();

    @Input() header = '';
    @Input() modal = false;
    @Input() closable = true;
    @Input() draggable = true;
    @Input() resizable = true;
    @Input() style: {[key: string]: any} = {};
    @Input() position: any = null;
    @Input() showHeader = true;
    @Input() appendTo: any = null;
    @Input() baseZIndex = 0;
    @Input() autoZIndex = true;
    @Input() focusOnShow = true;
    @Input() closeOnEscape = true;
    @Input() dismissableMask = false;
    @Input() keepInViewport = true;
    @Input() contentStyle: {[key: string]: any} = {};
    @Input() contentStyleClass = '';
    @Input() styleClass = '';
    @Input() maskStyleClass = '';
    @Input() dockDropCue = false;
    @Input() dockDropTargetSelector = '.collapsible-dock';
    @Input() dockDropThresholdEm = 2;

    @Input() layoutId?: string;
    @Input() persistLayout = false;
    @Input() persistOpenState = true;

    @Output() onShow = new EventEmitter<any>();
    @Output() onHide = new EventEmitter<any>();
    @Output() onResizeInit = new EventEmitter<any>();
    @Output() onDragEnd = new EventEmitter<any>();
    @Output() onResizeEnd = new EventEmitter<any>();

    @ViewChild('dialog') private dialog?: Dialog;
    protected effectiveStyle: {[key: string]: any} = {};
    private revealPersistedLayoutFrame?: number;
    private detachDockCueHeaderDown?: () => void;
    private detachDockCueMove?: () => void;
    private detachDockCuePointerMove?: () => void;
    private detachDockCueUp?: () => void;
    private detachDockCuePointerUp?: () => void;
    private resizeHandles: HTMLElement[] = [];
    private detachResizeHandleListeners: Array<() => void> = [];
    private resizeSession?: AppDialogResizeSession;

    constructor(private readonly stateService: AppStateService,
                private readonly renderer: Renderer2) {
        this.refreshEffectiveStyle();
    }

    /** Refreshes dialog layout style when inputs change. */
    ngOnChanges(changes: SimpleChanges): void {
        if (changes['style'] || changes['layoutId'] || changes['persistLayout'] || changes['persistOpenState'] || changes['resizable'] || changes['visible']) {
            const becameVisible = changes['visible']?.currentValue === true;
            this.refreshEffectiveStyle(becameVisible);
        }
        if (changes['resizable'] && this.visible) {
            this.syncResizeHandles();
        }
    }

    /** Cancels pending layout reveal work when the wrapper is destroyed. */
    ngOnDestroy(): void {
        this.cancelRevealPersistedLayout();
        this.removeResizeHandles();
        this.detachDockDropCueTracking();
        this.clearDockDropCue();
    }

    /** Returns the underlying PrimeNG dialog container element. */
    container(): HTMLElement | undefined {
        return this.dialog?.container() ?? undefined;
    }

    /** Closes the wrapped PrimeNG dialog. */
    close(event?: Event): void {
        this.dialog?.close(event ?? new Event('close'));
    }

    /** Starts PrimeNG's built-in dialog dragging from a projected header drag handle. */
    startDrag(event: MouseEvent | PointerEvent): void {
        this.startDockDropCueTracking();
        this.dialog?.initDrag(event);
    }

    /** Returns the underlying PrimeNG dialog wrapper element. */
    get wrapper() {
        return this.dialog?.wrapper;
    }

    /** Returns whether the wrapped dialog is currently being dragged. */
    get dragging(): boolean {
        return this.dialog?.dragging ?? false;
    }

    /** Synchronizes visible state after PrimeNG emits a visibility change. */
    protected handleVisibleChange(value: boolean): void {
        this.visible = value;
        this.syncPersistedOpenState(value);
        this.refreshEffectiveStyle(value);
        this.visibleChange.emit(value);
    }

    /** Applies persisted layout before forwarding the show event. */
    protected handleOnShow(event: any): void {
        this.syncPersistedOpenState(true);
        this.applyOrCapturePersistedLayout();
        this.syncResizeHandles();
        this.bindDockDropCue();
        this.onShow.emit(event);
    }

    /** Stores closed state and forwards the hide event. */
    protected handleOnHide(event: any): void {
        this.cancelRevealPersistedLayout();
        this.removeResizeHandles();
        this.syncPersistedOpenState(false);
        this.refreshEffectiveStyle(false);
        this.detachDockDropCueTracking();
        this.clearDockDropCue();
        this.onHide.emit(event);
    }

    /** Persists layout after a dialog drag finishes. */
    protected handleOnDragEnd(event: any): void {
        this.persistCurrentLayout();
        this.detachDockDropCueTracking();
        this.clearDockDropCue();
        this.onDragEnd.emit(event);
    }

    /** Persists layout after a dialog resize finishes. */
    protected handleOnResizeEnd(event: any): void {
        this.persistCurrentLayout();
        this.onResizeEnd.emit(event);
    }

    /** Installs or removes the custom four-corner resize handles for the current dialog state. */
    private syncResizeHandles(): void {
        this.removeResizeHandles();
        const container = this.container();
        if (!this.resizable || !container) {
            return;
        }

        for (const corner of ["nw", "ne", "sw", "se"] as const) {
            const handle = this.renderer.createElement("div") as HTMLElement;
            this.renderer.addClass(handle, "app-dialog-resize-handle");
            this.renderer.addClass(handle, `app-dialog-resize-${corner}`);
            this.renderer.setAttribute(handle, "data-resize-corner", corner);
            this.renderer.setAttribute(handle, "aria-hidden", "true");
            this.renderer.appendChild(container, handle);
            this.resizeHandles.push(handle);
            this.detachResizeHandleListeners.push(
                this.renderer.listen(handle, "pointerdown", (event: PointerEvent) => {
                    this.beginResize(event, corner, handle);
                }),
                this.renderer.listen(handle, "pointermove", (event: PointerEvent) => {
                    this.continueResize(event);
                }),
                this.renderer.listen(handle, "pointerup", (event: PointerEvent) => {
                    this.finishResize(event);
                }),
                this.renderer.listen(handle, "pointercancel", (event: PointerEvent) => {
                    this.finishResize(event);
                }),
                this.renderer.listen(handle, "lostpointercapture", (event: PointerEvent) => {
                    this.finishResize(event);
                })
            );
        }
    }

    /** Starts one pointer-captured corner-resize gesture from the current rendered bounds. */
    private beginResize(event: PointerEvent, corner: AppDialogResizeCorner, handle: HTMLElement): void {
        if (event.button !== 0 || this.resizeSession) {
            return;
        }
        const container = this.container();
        if (!container) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        const rect = container.getBoundingClientRect();
        const computedStyle = window.getComputedStyle(container);
        const body = document.body;
        this.resizeSession = {
            pointerId: event.pointerId,
            corner,
            startPointerX: event.clientX,
            startPointerY: event.clientY,
            startBounds: {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height
            },
            limits: this.resizeLimits(computedStyle),
            handle,
            bodyCursor: body.style.cursor,
            bodyUserSelect: body.style.userSelect
        };

        this.applyPosition(container, {left: rect.left, top: rect.top});
        container.style.width = `${rect.width}px`;
        container.style.height = `${rect.height}px`;
        body.style.cursor = window.getComputedStyle(handle).cursor;
        body.style.userSelect = "none";
        handle.setPointerCapture(event.pointerId);
        this.onResizeInit.emit(event);
    }

    /** Applies the latest pointer delta to the active resize session. */
    private continueResize(event: PointerEvent): void {
        const session = this.resizeSession;
        if (!session || session.pointerId !== event.pointerId) {
            return;
        }
        const container = this.container();
        if (!container) {
            return;
        }

        event.preventDefault();
        const bounds = resizeAppDialogBounds(
            session.startBounds,
            event.clientX - session.startPointerX,
            event.clientY - session.startPointerY,
            session.corner,
            {
                ...session.limits,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight
            }
        );
        container.style.left = `${bounds.left}px`;
        container.style.top = `${bounds.top}px`;
        container.style.width = `${bounds.width}px`;
        container.style.height = `${bounds.height}px`;
    }

    /** Completes or cancels the active resize gesture and preserves the final valid rectangle. */
    private finishResize(event: PointerEvent): void {
        const session = this.resizeSession;
        if (!session || session.pointerId !== event.pointerId) {
            return;
        }
        this.resizeSession = undefined;
        if (session.handle.hasPointerCapture(session.pointerId)) {
            session.handle.releasePointerCapture(session.pointerId);
        }
        document.body.style.cursor = session.bodyCursor;
        document.body.style.userSelect = session.bodyUserSelect;
        this.handleOnResizeEnd(event);
    }

    /** Reads finite CSS resize constraints and clamps them to the current viewport. */
    private resizeLimits(computedStyle: CSSStyleDeclaration): AppDialogResizeLimits {
        const minWidth = this.cssPixelValue(computedStyle.minWidth, 1);
        const minHeight = this.cssPixelValue(computedStyle.minHeight, 1);
        const maxWidth = this.cssPixelValue(computedStyle.maxWidth, window.innerWidth);
        const maxHeight = this.cssPixelValue(computedStyle.maxHeight, window.innerHeight);
        return {
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            minWidth,
            minHeight,
            maxWidth: Math.max(minWidth, Math.min(maxWidth, window.innerWidth)),
            maxHeight: Math.max(minHeight, Math.min(maxHeight, window.innerHeight))
        };
    }

    /** Converts one computed CSS pixel value to a finite number or returns its fallback. */
    private cssPixelValue(value: string, fallback: number): number {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    /** Removes custom handles and restores body interaction styles if a resize was interrupted. */
    private removeResizeHandles(): void {
        const session = this.resizeSession;
        if (session) {
            this.resizeSession = undefined;
            document.body.style.cursor = session.bodyCursor;
            document.body.style.userSelect = session.bodyUserSelect;
        }
        this.detachResizeHandleListeners.forEach(detach => detach());
        this.detachResizeHandleListeners = [];
        for (const handle of this.resizeHandles) {
            this.renderer.removeChild(handle.parentNode, handle);
        }
        this.resizeHandles = [];
    }

    /** Applies an existing layout or captures the first rendered layout. */
    private applyOrCapturePersistedLayout(): void {
        if (!this.persistLayout || !this.layoutId) {
            return;
        }
        const container = this.container();
        if (!container) {
            return;
        }
        container.style.visibility = 'hidden';
        window.requestAnimationFrame(() => {
            const updatedContainer = this.container();
            if (!updatedContainer) {
                return;
            }
            const existing = this.stateService.getDialogLayout(this.layoutId!);
            if (existing) {
                const normalized = {
                    ...this.normalizeLayout(existing),
                    open: this.persistOpenState ? true : false
                };
                if (this.resizable) {
                    this.applyLayout(updatedContainer, normalized);
                    this.stateService.upsertDialogLayout(this.layoutId!, normalized);
                    this.refreshEffectiveStyle(false, normalized);
                } else {
                    this.applyPosition(updatedContainer, normalized.position);
                    const current = this.readLayoutFromContainer(updatedContainer);
                    this.stateService.upsertDialogLayout(this.layoutId!, {
                        position: {...normalized.position},
                        size: {...current.size},
                        open: this.persistOpenState ? true : false
                    });
                    this.refreshEffectiveStyle(false, {
                        position: {...normalized.position},
                        size: {...current.size},
                        open: this.persistOpenState ? true : false
                    });
                }
                this.scheduleRevealPersistedLayout(updatedContainer);
                return;
            }
            const initialLayout = this.readLayoutFromContainer(updatedContainer);
            this.stateService.ensureDialogLayout(this.layoutId!, () => ({
                ...initialLayout,
                open: this.persistOpenState ? true : false
            }));
            this.refreshEffectiveStyle(false, {
                ...initialLayout,
                open: this.persistOpenState ? true : false
            });
            this.scheduleRevealPersistedLayout(updatedContainer);
        });
    }

    /** Persists the current dialog bounds and open state. */
    private persistCurrentLayout(): void {
        if (!this.persistLayout || !this.layoutId) {
            return;
        }
        const container = this.container();
        if (!container) {
            return;
        }
        const layout = {
            ...this.readLayoutFromContainer(container),
            open: this.persistOpenState ? this.visible : false
        };
        this.refreshEffectiveStyle(false, layout);
        this.stateService.upsertDialogLayout(this.layoutId, layout);
    }

    /** Reads rounded dialog bounds from a container element. */
    private readLayoutFromContainer(container: HTMLElement): AppDialogLayout {
        const rect = container.getBoundingClientRect();
        return {
            position: {
                left: Math.round(rect.left),
                top: Math.round(rect.top)
            },
            size: {
                width: Math.round(rect.width),
                height: Math.round(rect.height)
            }
        };
    }

    /** Clamps a persisted dialog layout to the current viewport. */
    private normalizeLayout(layout: AppDialogLayout): AppDialogLayout {
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const width = Math.max(1, Math.min(Math.round(layout.size.width), viewportWidth));
        const height = Math.max(1, Math.min(Math.round(layout.size.height), viewportHeight));
        const maxLeft = Math.max(0, viewportWidth - width);
        const maxTop = Math.max(0, viewportHeight - height);
        const left = Math.min(Math.max(0, Math.round(layout.position.left)), maxLeft);
        const top = Math.min(Math.max(0, Math.round(layout.position.top)), maxTop);
        return {
            position: {left, top},
            size: {width, height},
            open: layout.open ?? false
        };
    }

    /** Applies persisted position and size to a dialog container. */
    private applyLayout(container: HTMLElement, layout: AppDialogLayout): void {
        this.applyPosition(container, layout.position);
        container.style.width = `${layout.size.width}px`;
        container.style.height = `${layout.size.height}px`;
    }

    /** Applies persisted fixed positioning to a dialog container. */
    private applyPosition(container: HTMLElement, position: {left: number; top: number}): void {
        container.style.position = 'fixed';
        container.style.left = `${position.left}px`;
        container.style.top = `${position.top}px`;
        container.style.margin = '0';
    }

    /** Rebuilds the style object passed to the wrapped dialog. */
    private refreshEffectiveStyle(hideUntilApplied: boolean = false, layoutOverride?: AppDialogLayout): void {
        const nextStyle = {...this.style};
        const layout = layoutOverride ?? (this.persistLayout && this.layoutId
            ? this.stateService.getDialogLayout(this.layoutId)
            : undefined);
        if (!layout) {
            this.effectiveStyle = nextStyle;
            return;
        }

        const normalized = this.normalizeLayout(layout);
        nextStyle['position'] = 'fixed';
        nextStyle['left'] = `${normalized.position.left}px`;
        nextStyle['top'] = `${normalized.position.top}px`;
        nextStyle['margin'] = '0';
        if (this.resizable) {
            nextStyle['width'] = `${normalized.size.width}px`;
            nextStyle['height'] = `${normalized.size.height}px`;
        }
        if (hideUntilApplied) {
            nextStyle['visibility'] = 'hidden';
        }
        this.effectiveStyle = nextStyle;
    }

    /** Schedules a hidden dialog to become visible after persisted layout applies. */
    private scheduleRevealPersistedLayout(container: HTMLElement): void {
        this.cancelRevealPersistedLayout();
        this.revealPersistedLayoutFrame = window.requestAnimationFrame(() => {
            this.revealPersistedLayoutFrame = undefined;
            container.style.visibility = '';
        });
    }

    /** Cancels any pending persisted-layout reveal frame. */
    private cancelRevealPersistedLayout(): void {
        if (this.revealPersistedLayoutFrame === undefined) {
            return;
        }
        window.cancelAnimationFrame(this.revealPersistedLayoutFrame);
        this.revealPersistedLayoutFrame = undefined;
    }

    /** Stores open state for dialogs with persisted layout ids. */
    private syncPersistedOpenState(open: boolean): void {
        if (!this.persistLayout || !this.layoutId || !this.persistOpenState) {
            return;
        }
        this.stateService.setDialogLayoutOpen(this.layoutId, open);
    }

    /** Returns whether this floating dialog overlaps the configured dock target enough to dock. */
    overlapsDockDropTarget(): boolean {
        const container = this.container();
        const target = this.dockDropTarget();
        if (!container || !target) {
            return false;
        }
        const dialogRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const overlapWidth = Math.max(
            0,
            Math.min(dialogRect.right, targetRect.right) - Math.max(dialogRect.left, targetRect.left)
        );
        const overlapHeight = Math.max(
            0,
            Math.min(dialogRect.bottom, targetRect.bottom) - Math.max(dialogRect.top, targetRect.top)
        );
        return overlapWidth >= this.stateService.baseFontSize * this.dockDropThresholdEm && overlapHeight > 0;
    }

    private bindDockDropCue(): void {
        this.detachDockCueHeaderDown?.();
        this.detachDockCueHeaderDown = undefined;
        if (!this.dockDropCue) {
            return;
        }
        const header = this.container()?.querySelector<HTMLElement>('.p-dialog-header');
        if (!header) {
            return;
        }
        this.detachDockCueHeaderDown = this.renderer.listen(header, 'mousedown', () => this.startDockDropCueTracking());
    }

    private startDockDropCueTracking(): void {
        if (!this.dockDropCue) {
            return;
        }
        this.detachDockDropCueTracking(false);
        this.detachDockCueMove = this.renderer.listen('window', 'mousemove', () => this.updateDockDropCue());
        this.detachDockCuePointerMove = this.renderer.listen('window', 'pointermove', () => this.updateDockDropCue());
        this.detachDockCueUp = this.renderer.listen('window', 'mouseup', () => {
            this.detachDockDropCueTracking(false);
            this.clearDockDropCue();
        });
        this.detachDockCuePointerUp = this.renderer.listen('window', 'pointerup', () => {
            this.detachDockDropCueTracking(false);
            this.clearDockDropCue();
        });
    }

    private updateDockDropCue(): void {
        if (!this.dragging || !this.dockDropCue) {
            this.clearDockDropCue();
            return;
        }
        this.setDockDropCue(this.overlapsDockDropTarget());
    }

    private setDockDropCue(active: boolean): void {
        const target = this.dockDropTarget();
        if (!target) {
            return;
        }
        if (active) {
            this.renderer.addClass(target, 'dock-drop-active');
        } else {
            this.renderer.removeClass(target, 'dock-drop-active');
        }
    }

    private clearDockDropCue(): void {
        this.setDockDropCue(false);
    }

    private dockDropTarget(): HTMLElement | null {
        return document.querySelector(this.dockDropTargetSelector) as HTMLElement | null;
    }

    private detachDockDropCueTracking(clearHeader = true): void {
        if (clearHeader) {
            this.detachDockCueHeaderDown?.();
            this.detachDockCueHeaderDown = undefined;
        }
        this.detachDockCueMove?.();
        this.detachDockCuePointerMove?.();
        this.detachDockCueUp?.();
        this.detachDockCuePointerUp?.();
        this.detachDockCueMove = undefined;
        this.detachDockCuePointerMove = undefined;
        this.detachDockCueUp = undefined;
        this.detachDockCuePointerUp = undefined;
    }
}
