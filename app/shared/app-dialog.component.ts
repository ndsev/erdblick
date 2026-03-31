import {Component, EventEmitter, Input, Output, ViewChild} from '@angular/core';
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
                  [style]="style"
                  [position]="position"
                  [showHeader]="showHeader"
                  [appendTo]="appendTo"
                  [baseZIndex]="baseZIndex"
                  [autoZIndex]="autoZIndex"
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
            <ng-content></ng-content>
        </p-dialog>
    `,
    standalone: true,
    imports: [DialogModule]
})
export class AppDialogComponent {
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
    @Input() closeOnEscape = true;
    @Input() dismissableMask = false;
    @Input() keepInViewport = true;
    @Input() contentStyle: {[key: string]: any} = {};
    @Input() contentStyleClass = '';
    @Input() styleClass = '';
    @Input() maskStyleClass = '';

    @Input() layoutId?: string;
    @Input() persistLayout = false;

    @Output() onShow = new EventEmitter<any>();
    @Output() onHide = new EventEmitter<any>();
    @Output() onResizeInit = new EventEmitter<any>();
    @Output() onDragEnd = new EventEmitter<any>();
    @Output() onResizeEnd = new EventEmitter<any>();

    @ViewChild('dialog') private dialog?: Dialog;

    constructor(private readonly stateService: AppStateService) {}

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
        this.visibleChange.emit(value);
    }

    protected handleOnShow(event: any): void {
        this.applyOrCapturePersistedLayout();
        this.onShow.emit(event);
    }

    protected handleOnHide(event: any): void {
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
        window.requestAnimationFrame(() => {
            const updatedContainer = this.container();
            if (!updatedContainer) {
                return;
            }
            const existing = this.stateService.getDialogLayout(this.layoutId!);
            if (existing) {
                const normalized = this.normalizeLayout(existing);
                this.applyLayout(updatedContainer, normalized);
                this.stateService.upsertDialogLayout(this.layoutId!, normalized);
                return;
            }
            const initialLayout = this.readLayoutFromContainer(updatedContainer);
            this.stateService.ensureDialogLayout(this.layoutId!, () => initialLayout);
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
        const layout = this.readLayoutFromContainer(container);
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
            size: {width, height}
        };
    }

    private applyLayout(container: HTMLElement, layout: AppDialogLayout): void {
        container.style.position = 'fixed';
        container.style.left = `${layout.position.left}px`;
        container.style.top = `${layout.position.top}px`;
        container.style.width = `${layout.size.width}px`;
        container.style.height = `${layout.size.height}px`;
        container.style.margin = '0';
    }
}
