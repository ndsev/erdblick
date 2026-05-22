import {NgTemplateOutlet} from '@angular/common';
import {Component, ContentChild, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges, TemplateRef, ViewChild} from '@angular/core';
import {Dialog, DialogModule} from 'primeng/dialog';
import {AppDialogLayout, AppStateService} from './appstate.service';

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
                  [resizable]="resizable"
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
                  (onResizeInit)="onResizeInit.emit($event)"
                  (onDragEnd)="handleOnDragEnd($event)"
                  (onResizeEnd)="handleOnResizeEnd($event)">
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

    constructor(private readonly stateService: AppStateService) {
        this.refreshEffectiveStyle();
    }

    /** Refreshes dialog layout style when inputs change. */
    ngOnChanges(changes: SimpleChanges): void {
        if (changes['style'] || changes['layoutId'] || changes['persistLayout'] || changes['persistOpenState'] || changes['resizable'] || changes['visible']) {
            const becameVisible = changes['visible']?.currentValue === true;
            this.refreshEffectiveStyle(becameVisible);
        }
    }

    /** Cancels pending layout reveal work when the wrapper is destroyed. */
    ngOnDestroy(): void {
        this.cancelRevealPersistedLayout();
    }

    /** Returns the underlying PrimeNG dialog container element. */
    container(): HTMLElement | undefined {
        return this.dialog?.container() ?? undefined;
    }

    /** Closes the wrapped PrimeNG dialog. */
    close(event?: Event): void {
        this.dialog?.close(event ?? new Event('close'));
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
        this.onShow.emit(event);
    }

    /** Stores closed state and forwards the hide event. */
    protected handleOnHide(event: any): void {
        this.cancelRevealPersistedLayout();
        this.syncPersistedOpenState(false);
        this.refreshEffectiveStyle(false);
        this.onHide.emit(event);
    }

    /** Persists layout after a dialog drag finishes. */
    protected handleOnDragEnd(event: any): void {
        this.persistCurrentLayout();
        this.onDragEnd.emit(event);
    }

    /** Persists layout after a dialog resize finishes. */
    protected handleOnResizeEnd(event: any): void {
        this.persistCurrentLayout();
        this.onResizeEnd.emit(event);
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
}
