import {Injectable} from '@angular/core';
import {Dialog} from 'primeng/dialog';

@Injectable({providedIn: 'root'})
export class DialogStackService {
    private zIndex = 20000;
    private readonly topZIndex = 100002;

    bringToFront(dialog: Dialog | undefined | null) {
        this.applyZIndex(dialog?.container, dialog?.wrapper);
    }

    bringToTop(dialog: Dialog | undefined | null) {
        this.applyZIndex(dialog?.container, dialog?.wrapper, this.topZIndex);
    }

    bringElementToFront(element: HTMLElement | null | undefined) {
        this.applyZIndex(element, undefined);
    }

    bringElementToTop(element: HTMLElement | null | undefined) {
        this.applyZIndex(element, undefined, this.topZIndex);
    }

    private applyZIndex(container?: HTMLElement | null, wrapper?: HTMLElement | null, zIndex?: number) {
        if (!container) {
            return;
        }
        const nextZIndex = zIndex ?? (this.zIndex += 2);
        container.style.setProperty('z-index', String(nextZIndex), 'important');
        const wrapperElement = wrapper ?? container.parentElement;
        if (wrapperElement && (wrapperElement.classList.contains('p-dialog-mask') ||
            wrapperElement.classList.contains('p-overlay-mask'))) {
            wrapperElement.style.setProperty('z-index', String(nextZIndex - 1), 'important');
        }
    }
}
