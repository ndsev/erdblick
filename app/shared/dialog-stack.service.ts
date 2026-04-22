import {Injectable} from '@angular/core';

/** Stores the DOM elements that participate in one floating-dialog stack entry. */
interface StackEntry {
    container: HTMLElement;
    wrapper?: HTMLElement;
    close?: (event?: Event) => void;
}

/** Minimal shape required to bring an app dialog to the top of the z-index stack. */
interface DialogLike {
    container: () => HTMLElement | undefined;
    wrapper?: HTMLElement | null;
    close?: (event?: Event) => void;
}

@Injectable({providedIn: 'root'})
/**
 * Maintains a predictable z-index ordering for non-modal floating dialogs that would
 * otherwise fight over stacking via PrimeNG defaults.
 */
export class DialogStackService {
    private static readonly STACK_BASE_Z_INDEX = 200;
    private static readonly STACK_STEP = 2;
    private static readonly MAX_TRACKED_ELEMENTS = 100;
    private readonly stack: StackEntry[] = [];

    /** Moves the given dialog or element to the top of the managed z-index stack. */
    bringToFront(target: DialogLike | HTMLElement | undefined | null) {
        const entry = this.resolveEntry(target);
        if (!entry) {
            return;
        }
        this.pruneStack();
        const existingEntryIndex = this.stack.findIndex(stackEntry => stackEntry.container === entry.container);
        if (existingEntryIndex !== -1) {
            const existingEntry = this.stack[existingEntryIndex];
            if (!entry.close) {
                entry.close = existingEntry.close;
            }
            this.stack.splice(existingEntryIndex, 1);
        }
        this.stack.push(entry);
        while (this.stack.length > DialogStackService.MAX_TRACKED_ELEMENTS) {
            const removedEntry = this.stack.shift();
            if (removedEntry) {
                this.clearEntryZIndex(removedEntry);
            }
        }
        this.applyStackZIndex();
    }

    /** Normalizes supported dialog targets into a tracked stack entry. */
    private resolveEntry(target: DialogLike | HTMLElement | undefined | null): StackEntry | undefined {
        if (!target) {
            return undefined;
        }
        if (target instanceof HTMLElement) {
            return {
                container: target,
                wrapper: target.classList.contains('p-dialog') ?
                    this.resolveMaskElement(target.parentElement) :
                    undefined
            };
        }
        const container = target.container();
        if (!container) {
            return undefined;
        }
        return {
            container,
            wrapper: this.resolveMaskElement(target.wrapper ?? container.parentElement),
            close: typeof target.close === 'function' ? target.close.bind(target) : undefined
        };
    }

    /** Closes the topmost tracked dialog when it exposes a close path or close button. */
    closeTopDialog(event?: Event): boolean {
        this.pruneStack();
        for (let index = this.stack.length - 1; index >= 0; index--) {
            const entry = this.stack[index];
            if (entry.close) {
                entry.close(event);
                return true;
            }
            const closeButton = entry.container.querySelector<HTMLElement>('.p-dialog-header-close-button');
            if (closeButton) {
                closeButton.click();
                return true;
            }
        }
        return false;
    }

    /** Applies monotonically increasing z-indices to the retained stack entries. */
    private applyStackZIndex() {
        for (let index = 0; index < this.stack.length; index++) {
            const entry = this.stack[index];
            const wrapperZIndex = DialogStackService.STACK_BASE_Z_INDEX + (index * DialogStackService.STACK_STEP);
            const containerZIndex = wrapperZIndex + 1;
            entry.container.style.setProperty('z-index', String(containerZIndex), 'important');
            const wrapper = this.resolveMaskElement(entry.wrapper ?? entry.container.parentElement);
            if (wrapper && wrapper.isConnected) {
                wrapper.style.setProperty('z-index', String(wrapperZIndex), 'important');
                entry.wrapper = wrapper;
            } else if (entry.wrapper) {
                this.clearZIndex(entry.wrapper);
                entry.wrapper = undefined;
            }
        }
    }

    /** Drops entries whose DOM nodes are gone or no longer visible. */
    private pruneStack() {
        const retainedEntries: StackEntry[] = [];
        for (const entry of this.stack) {
            if (entry.container.isConnected && entry.container.getClientRects().length > 0) {
                retainedEntries.push(entry);
                continue;
            }
            this.clearEntryZIndex(entry);
        }
        this.stack.length = 0;
        this.stack.push(...retainedEntries);
    }

    /** Returns the overlay mask wrapper for supported PrimeNG dialog containers. */
    private resolveMaskElement(element: HTMLElement | null | undefined): HTMLElement | undefined {
        if (!element) {
            return undefined;
        }
        if (element.classList.contains('p-dialog-mask') || element.classList.contains('p-overlay-mask')) {
            return element;
        }
        return undefined;
    }

    /** Clears stacking styles for one removed stack entry. */
    private clearEntryZIndex(entry: StackEntry) {
        this.clearZIndex(entry.container);
        if (entry.wrapper) {
            this.clearZIndex(entry.wrapper);
        }
    }

    /** Removes the z-index override from one element. */
    private clearZIndex(element: HTMLElement) {
        element.style.removeProperty('z-index');
    }
}
