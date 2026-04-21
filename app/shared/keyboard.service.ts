import {Directive, ElementRef, HostListener, Injectable, Renderer2, RendererFactory2} from "@angular/core";

@Directive({
    selector: '[onEnterClick]',
    standalone: false
})
/** Small directive that turns Enter into a click for button-like controls. */
export class OnEnterClickDirective {
    constructor(private el: ElementRef) {}

    /** Clicks the host element when Enter is pressed while it has focus. */
    @HostListener('keydown', ['$event'])
    handleKeyDown(event: KeyboardEvent) {
        if (event.key === 'Enter') {
            this.el.nativeElement.click();
        }
    }
}

@Injectable({providedIn: 'root'})
/** Global keyboard shortcut registry shared across dialogs and panels. */
export class KeyboardService {
    private renderer: Renderer2;
    private shortcuts = new Map<string, (event: KeyboardEvent) => void>();
    private preventOnInputShortcuts: Set<string> = new Set<string>();

    constructor(rendererFactory: RendererFactory2) {
        this.renderer = rendererFactory.createRenderer(null, null);
        this.listenToKeyboardEvents();
    }

    /** Installs the global keydown listener once for the application lifetime. */
    private listenToKeyboardEvents() {
        this.renderer.listen('window', 'keydown', (event: KeyboardEvent) => {
            const target = event.target as HTMLElement;
            const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
            const key = this.getKeyCombination(event);

            // TODO: Ensure that tab and escape, when pressed in a text area,
            //  result in a tab character/autocomplete cancelation rather than
            //  focusing another control/closing the enclosing dialog.
            // NOTE: This affects UX when editing text - currently these keys may trigger
            // unintended focus changes or dialog closures instead of normal text editing behavior.

            // Let non-ctrl key events or text editing shortcuts do their default things.
            if (isInput && this.preventOnInputShortcuts.has(key)) {
                return;
            }

            if (this.shortcuts.has(key)) {
                event.preventDefault();
                this.shortcuts.get(key)?.(event);
            }

            // TODO: Else-if Escape was hit, close the most recent dialog
            //  in the stack. (JB: Can we get rid of this? Things seem
            //  to work fine without the dialog stack).
        });
    }

    /** Normalizes a keyboard event into the shortcut key used by the registry. */
    private getKeyCombination(event: KeyboardEvent): string {
        let key = '';
        if (event.ctrlKey) {
            key += 'Ctrl+';
        }
        key += event.key;
        return key;
    }

    /** Registers a shortcut and optionally ignores it while the user edits text inputs. */
    registerShortcut(keys: string, callback: (event: KeyboardEvent) => void, preventOnInput: boolean = false): void {
        // TODO: If registered for the focused view, only apply shortcuts to the view which gets focused on
        this.shortcuts.set(keys, callback);
        if (preventOnInput) {
            this.preventOnInputShortcuts.add(keys);
        }
    }

    /** Clears shortcuts when the service is torn down in tests. */
    ngOnDestroy() {
        this.shortcuts.clear();
    }
}
