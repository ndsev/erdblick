import {Renderer2} from "@angular/core";

export interface DockedPanelDragState<TId> {
    draggedId?: TId;
    dropBeforeId?: TId;
    dropAfterId?: TId;
    isReordering: boolean;
}

export interface DockedPanelDragOffset {
    x: number;
    y: number;
}

interface DockedPanelDragControllerOptions<TId> {
    renderer: Renderer2;
    baseFontSize: () => number;
    container: () => HTMLElement | null | undefined;
    itemSelector: string;
    readId: (element: HTMLElement) => TId | undefined;
    previewClass: string;
    previewHeaderClass: string;
    previewFillClass: string;
    applyReorder: (nextDisplayOrder: TId[], previousDisplayOrder: TId[]) => void;
    undock?: (id: TId, event: PointerEvent, offset: DockedPanelDragOffset) => void;
}

type DockedPanelDragMode = "reorder" | "undock";

/** Shared drag controller for AppPanel-backed dock entries. */
export class DockedPanelDragController<TId> {
    readonly state: DockedPanelDragState<TId> = {
        isReordering: false
    };

    private dragStart?: {x: number; y: number};
    private dragPointerId?: number;
    private dragMode?: DockedPanelDragMode;
    private dragActive = false;
    private dropIndex?: number;
    private detachMove?: () => void;
    private detachUp?: () => void;
    private detachCancel?: () => void;
    private dragPreviewElement?: HTMLDivElement;
    private dragPreviewOffset: DockedPanelDragOffset = {x: 0, y: 0};

    constructor(private readonly options: DockedPanelDragControllerOptions<TId>) {}

    /** Starts tracking a docked AppPanel drag gesture from its header. */
    start(id: TId, event: PointerEvent): void {
        if (this.dragActive || event.button !== 0) {
            return;
        }
        this.state.draggedId = id;
        this.dragPointerId = event.pointerId;
        this.dragStart = {x: event.clientX, y: event.clientY};
        this.dragMode = undefined;
        this.dragActive = false;
        this.dropIndex = undefined;
        this.clearDropTarget();
        this.clearDragPreview();
        this.detachMove?.();
        this.detachUp?.();
        this.detachCancel?.();
        this.detachMove = this.options.renderer.listen(
            "window",
            "pointermove",
            (ev: PointerEvent) => this.onDockDragMove(ev)
        );
        this.detachUp = this.options.renderer.listen(
            "window",
            "pointerup",
            (ev: PointerEvent) => this.onDockDragEnd(ev)
        );
        this.detachCancel = this.options.renderer.listen(
            "window",
            "pointercancel",
            (ev: PointerEvent) => this.onDockDragEnd(ev)
        );
    }

    /** Clears listeners and temporary drag state. */
    destroy(): void {
        this.reset();
    }

    private onDockDragMove(event: PointerEvent): void {
        if (!this.dragStart || event.pointerId !== this.dragPointerId) {
            return;
        }
        const distance = Math.hypot(event.clientX - this.dragStart.x, event.clientY - this.dragStart.y);
        if (!this.dragActive && distance < this.options.baseFontSize() * 0.5) {
            return;
        }
        if (!this.dragActive) {
            this.dragActive = true;
            document.body.classList.add("dialog-dragging");
        }
        this.ensureDragPreview(event);
        this.positionDragPreview(event.clientX, event.clientY);
        if (!this.dragMode) {
            this.dragMode = this.isPointInContainer(event.clientX, event.clientY) ? "reorder" : "undock";
            this.state.isReordering = this.dragMode === "reorder";
        }
        if (this.dragMode === "reorder") {
            if (this.isPointInContainer(event.clientX, event.clientY)) {
                this.updateDropTarget(event.clientY);
            } else {
                this.dropIndex = undefined;
                this.clearDropTarget();
            }
        }
    }

    private onDockDragEnd(event: PointerEvent): void {
        if (event.pointerId !== this.dragPointerId) {
            return;
        }
        const draggedId = this.state.draggedId;
        const dragActive = this.dragActive;
        const dragMode = this.dragMode;
        const inContainer = this.isPointInContainer(event.clientX, event.clientY);

        if (dragActive && draggedId !== undefined) {
            if (!inContainer) {
                this.options.undock?.(draggedId, event, this.currentDragOffset());
            } else if (dragMode === "reorder") {
                this.updateDropTarget(event.clientY);
                this.applyReorder(draggedId);
            }
        }

        this.reset();
    }

    private applyReorder(draggedId: TId): void {
        const displayOrder = this.currentDisplayOrder();
        if (displayOrder.length < 2) {
            return;
        }
        const filtered = displayOrder.filter(id => !Object.is(id, draggedId));
        const dropIndex = Math.min(Math.max(this.dropIndex ?? filtered.length, 0), filtered.length);
        const nextDisplayOrder = filtered.slice();
        nextDisplayOrder.splice(dropIndex, 0, draggedId);
        if (displayOrder.some((id, index) => !Object.is(id, nextDisplayOrder[index]))) {
            this.options.applyReorder(nextDisplayOrder, displayOrder);
        }
    }

    private updateDropTarget(clientY: number): void {
        const draggedId = this.state.draggedId;
        if (draggedId === undefined) {
            return;
        }
        const elements = this.dockItems()
            .map(el => ({el, id: this.options.readId(el)}))
            .filter((entry): entry is {el: HTMLElement; id: TId} =>
                entry.id !== undefined && !Object.is(entry.id, draggedId)
            );
        if (!elements.length) {
            this.dropIndex = 0;
            this.clearDropTarget();
            return;
        }
        let dropIndex = elements.length;
        for (let i = 0; i < elements.length; i++) {
            const rect = elements[i].el.getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) {
                dropIndex = i;
                break;
            }
        }
        this.dropIndex = dropIndex;
        this.state.dropBeforeId = dropIndex < elements.length ? elements[dropIndex].id : undefined;
        this.state.dropAfterId = dropIndex >= elements.length ? elements[elements.length - 1].id : undefined;
    }

    private currentDisplayOrder(): TId[] {
        return this.dockItems()
            .map(el => this.options.readId(el))
            .filter((id): id is TId => id !== undefined);
    }

    private dockItems(): HTMLElement[] {
        return Array.from(this.options.container()?.querySelectorAll<HTMLElement>(this.options.itemSelector) ?? []);
    }

    private isPointInContainer(x: number, y: number): boolean {
        const rect = this.options.container()?.getBoundingClientRect();
        return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }

    private ensureDragPreview(event: PointerEvent): void {
        if (this.dragPreviewElement || this.state.draggedId === undefined) {
            return;
        }
        const panelElement = this.dockItems()
            .find(element => Object.is(this.options.readId(element), this.state.draggedId));
        if (!panelElement) {
            return;
        }
        const panelRect = panelElement.getBoundingClientRect();
        const pointerStartX = this.dragStart?.x ?? event.clientX;
        const pointerStartY = this.dragStart?.y ?? event.clientY;
        this.dragPreviewOffset = {
            x: Math.min(Math.max(pointerStartX - panelRect.left, 0), panelRect.width),
            y: Math.min(Math.max(pointerStartY - panelRect.top, 0), panelRect.height)
        };

        const previewElement = this.options.renderer.createElement("div") as HTMLDivElement;
        this.options.renderer.addClass(previewElement, this.options.previewClass);
        this.options.renderer.setStyle(previewElement, "width", `${Math.round(panelRect.width)}px`);
        this.options.renderer.setStyle(previewElement, "height", `${Math.round(panelRect.height)}px`);

        const headerElement = panelElement.querySelector<HTMLElement>(".p-accordionheader");
        if (headerElement) {
            const headerClone = headerElement.cloneNode(true) as HTMLElement;
            this.options.renderer.addClass(headerClone, this.options.previewHeaderClass);
            this.options.renderer.appendChild(previewElement, headerClone);
        }
        const fillElement = this.options.renderer.createElement("div") as HTMLDivElement;
        this.options.renderer.addClass(fillElement, this.options.previewFillClass);
        this.options.renderer.appendChild(previewElement, fillElement);

        this.options.renderer.appendChild(document.body, previewElement);
        this.dragPreviewElement = previewElement;
    }

    private positionDragPreview(clientX: number, clientY: number): void {
        if (!this.dragPreviewElement) {
            return;
        }
        this.options.renderer.setStyle(
            this.dragPreviewElement,
            "left",
            `${Math.round(clientX - this.dragPreviewOffset.x)}px`
        );
        this.options.renderer.setStyle(
            this.dragPreviewElement,
            "top",
            `${Math.round(clientY - this.dragPreviewOffset.y)}px`
        );
    }

    private currentDragOffset(): DockedPanelDragOffset {
        if (this.dragPreviewElement) {
            return this.dragPreviewOffset;
        }
        const fallbackOffset = this.options.baseFontSize();
        return {x: fallbackOffset, y: fallbackOffset};
    }

    private clearDropTarget(): void {
        this.state.dropBeforeId = undefined;
        this.state.dropAfterId = undefined;
    }

    private clearDragPreview(): void {
        this.dragPreviewElement?.remove();
        this.dragPreviewElement = undefined;
        this.dragPreviewOffset = {x: 0, y: 0};
    }

    private reset(): void {
        this.detachMove?.();
        this.detachUp?.();
        this.detachCancel?.();
        this.detachMove = undefined;
        this.detachUp = undefined;
        this.detachCancel = undefined;
        this.clearDragPreview();
        this.dragStart = undefined;
        this.dragPointerId = undefined;
        this.dragMode = undefined;
        this.dragActive = false;
        this.state.draggedId = undefined;
        this.dropIndex = undefined;
        this.clearDropTarget();
        this.state.isReordering = false;
        document.body.classList.remove("dialog-dragging");
    }
}
