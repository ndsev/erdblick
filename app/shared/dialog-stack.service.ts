import {Injectable} from '@angular/core';
import {Dialog} from 'primeng/dialog';

interface StackEntry {
    container: HTMLElement;
    wrapper?: HTMLElement;
}

@Injectable({providedIn: 'root'})
export class DialogStackService {
    private static readonly STACK_BASE_Z_INDEX = 200;
    private static readonly STACK_STEP = 2;
    private static readonly MAX_TRACKED_ELEMENTS = 100;
    private readonly stack: StackEntry[] = [];

    bringToFront(target: Dialog | HTMLElement | undefined | null) {
        const entry = this.resolveEntry(target);
        if (!entry) {
            return;
        }
        this.pruneStack();
        const existingEntryIndex = this.stack.findIndex(stackEntry => stackEntry.container === entry.container);
        if (existingEntryIndex !== -1) {
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

    private resolveEntry(target: Dialog | HTMLElement | undefined | null): StackEntry | undefined {
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
            wrapper: this.resolveMaskElement(target.wrapper ?? container.parentElement)
        };
    }

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

    private resolveMaskElement(element: HTMLElement | null | undefined): HTMLElement | undefined {
        if (!element) {
            return undefined;
        }
        if (element.classList.contains('p-dialog-mask') || element.classList.contains('p-overlay-mask')) {
            return element;
        }
        return undefined;
    }

    private clearEntryZIndex(entry: StackEntry) {
        this.clearZIndex(entry.container);
        if (entry.wrapper) {
            this.clearZIndex(entry.wrapper);
        }
    }

    private clearZIndex(element: HTMLElement) {
        element.style.removeProperty('z-index');
    }
}
