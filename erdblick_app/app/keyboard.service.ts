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

            if (!isInput || key.includes("Ctrl")) {
                if (key === 'Escape' || key === 'Esc') {
                    // TODO: make this work!
                    // if (this.dialogStack.length > 0) {
                    //     event.preventDefault();
                    //     const topDialog = this.dialogStack.pop();
                    //     if (topDialog) {
                    //         topDialog.close(new MouseEvent("mousedown"));
                    //     }
                    // }
                } else if (this.shortcuts.has(key)) {
                    event.preventDefault();
                    this.shortcuts.get(key)?.(event);
                }
            }
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