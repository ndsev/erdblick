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

    ngOnChanges(changes: SimpleChanges): void {
        if (changes['style'] || changes['layoutId'] || changes['persistLayout'] || changes['persistOpenState'] || changes['resizable'] || changes['visible']) {
            this.refreshEffectiveStyle(this.visible);
        }
    }

    ngOnDestroy(): void {
        this.cancelRevealPersistedLayout();
    }

    container(): HTMLElement | undefined {
        return this.dialog?.container() ?? undefined;
    }

    close(event?: Event): void {
        this.dialog?.close(event ?? new Event('close'));
    }

    get wrapper() {
        return this.dialog?.wrapper;
    }

    get dragging(): boolean {
        return this.dialog?.dragging ?? false;
    }

    protected handleVisibleChange(value: boolean): void {
        this.visible = value;
        this.syncPersistedOpenState(value);
        this.refreshEffectiveStyle(value);
        this.visibleChange.emit(value);
    }

    protected handleOnShow(event: any): void {
        this.syncPersistedOpenState(true);
        this.applyOrCapturePersistedLayout();
        this.onShow.emit(event);
    }

    protected handleOnHide(event: any): void {
        this.cancelRevealPersistedLayout();
        this.syncPersistedOpenState(false);
        this.refreshEffectiveStyle(false);
        this.onHide.emit(event);
    }

    protected handleOnDragEnd(event: any): void {
        this.persistCurrentLayout();
        this.onDragEnd.emit(event);
    }

    protected handleOnResizeEnd(event: any): void {
        this.persistCurrentLayout();
        this.onResizeEnd.emit(event);
    }

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

    private applyLayout(container: HTMLElement, layout: AppDialogLayout): void {
        this.applyPosition(container, layout.position);
        container.style.width = `${layout.size.width}px`;
        container.style.height = `${layout.size.height}px`;
    }

    private applyPosition(container: HTMLElement, position: {left: number; top: number}): void {
        container.style.position = 'fixed';
        container.style.left = `${position.left}px`;
        container.style.top = `${position.top}px`;
        container.style.margin = '0';
    }

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

    private scheduleRevealPersistedLayout(container: HTMLElement): void {
        this.cancelRevealPersistedLayout();
        this.revealPersistedLayoutFrame = window.requestAnimationFrame(() => {
            this.revealPersistedLayoutFrame = undefined;
            container.style.visibility = '';
        });
    }

    private cancelRevealPersistedLayout(): void {
        if (this.revealPersistedLayoutFrame === undefined) {
            return;
        }
        window.cancelAnimationFrame(this.revealPersistedLayoutFrame);
        this.revealPersistedLayoutFrame = undefined;
    }

    private syncPersistedOpenState(open: boolean): void {
        if (!this.persistLayout || !this.layoutId || !this.persistOpenState) {
            return;
        }
        this.stateService.setDialogLayoutOpen(this.layoutId, open);
    }
}
