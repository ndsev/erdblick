import {Directive, ElementRef, HostListener, Injectable, Renderer2, RendererFactory2} from "@angular/core";
import {DialogStackService} from "./dialog-stack.service";

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
    private readonly shortcuts = new Map<string, (event: KeyboardEvent) => void>();
    private readonly preventOnInputShortcuts = new Set<string>();

    constructor(rendererFactory: RendererFactory2,
                private readonly dialogStack: DialogStackService) {
        this.renderer = rendererFactory.createRenderer(null, null);
        this.listenToKeyboardEvents();
    }

    /** Installs the global keydown listener once for the application lifetime. */
    private listenToKeyboardEvents() {
        this.renderer.listen('window', 'keydown', (event: KeyboardEvent) => {
            const target = event.target as HTMLElement;
            const isTextEditingSurface = this.isTextEditingSurface(target);
            const key = this.getKeyCombination(event);

            // Let editors and text inputs keep Tab/Escape for indentation, completion,
            // or local dialog logic instead of routing them through the global shortcut layer.
            if (isTextEditingSurface && (event.key === 'Tab' || event.key === 'Escape')) {
                return;
            }

            // Let non-ctrl key events or text editing shortcuts do their default things.
            if (isTextEditingSurface && this.preventOnInputShortcuts.has(key)) {
                return;
            }

            if (this.shortcuts.has(key)) {
                event.preventDefault();
                this.shortcuts.get(key)?.(event);
                return;
            }

            if (event.key === 'Escape') {
                window.setTimeout(() => {
                    if (event.defaultPrevented) {
                        return;
                    }
                    this.dialogStack.closeTopDialog(event);
                }, 0);
            }
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

    /** Identifies DOM targets that should keep local text-editing keyboard semantics. */
    private isTextEditingSurface(target: HTMLElement | null): boolean {
        if (!target) {
            return false;
        }
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
            return true;
        }
        return target.closest('.cm-editor,[contenteditable=\"true\"]') !== null;
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
