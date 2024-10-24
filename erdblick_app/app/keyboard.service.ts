import {Directive, ElementRef, HostListener, Injectable, Renderer2, RendererFactory2} from "@angular/core";
import {Dialog} from "primeng/dialog";

@Directive({
    selector: '[onEnterClick]'
})
export class OnEnterClickDirective {
    constructor(private el: ElementRef) {}

    @HostListener('keydown', ['$event'])
    handleKeyDown(event: KeyboardEvent) {
        if (event.key === 'Enter') {
            this.el.nativeElement.click();
        }
    }
}

@Injectable({providedIn: 'root'})
export class KeyboardService {
    private renderer: Renderer2;
    private dialogStack: Array<Dialog> = [];
    private shortcuts = new Map<string, (event: KeyboardEvent) => void>();

    constructor(rendererFactory: RendererFactory2) {
        this.renderer = rendererFactory.createRenderer(null, null);
        this.listenToKeyboardEvents();
    }

    dialogOnShow(event: Dialog) {
        this.dialogStack.push(event);
    }

    dialogOnHide(event: Dialog) {
        this.dialogStack = this.dialogStack.filter(dialog => event !== dialog);
    }

    private listenToKeyboardEvents() {
        this.renderer.listen('window', 'keydown', (event: KeyboardEvent) => {
            const target = event.target as HTMLElement;
            const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
            const key = this.getKeyCombination(event);

            // TODO: Ensure that tab and escape, when pressed in a text area,
            //  result in a tab character/autocomplete cancelation rather than
            //  focusing another control/closing the enclosing dialog.

            // Let non-ctrl key events or text editing shortcuts do their default things.
            if (isInput && (!key.includes("Ctrl") || ["ctrl+x", "ctrl+c", "ctrl+v"].includes(key.toLowerCase()))) {
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

    private getKeyCombination(event: KeyboardEvent): string {
        let key = '';
        if (event.ctrlKey) {
            key += 'Ctrl+';
        }
        key += event.key;
        return key;
    }

    registerShortcuts(keys: string[], callback: (event: KeyboardEvent) => void) {
        keys.forEach(keys_ => this.registerShortcut(keys_, callback));
    }

    registerShortcut(keys: string, callback: (event: KeyboardEvent) => void) {
        this.shortcuts.set(keys, callback);
    }

    ngOnDestroy() {
        this.shortcuts.clear();
    }
}