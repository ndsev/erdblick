import {Injectable, Renderer2, RendererFactory2} from "@angular/core";

@Injectable({providedIn: 'root'})
export class KeyboardService {
    private renderer: Renderer2;
    private shortcuts = new Map<string, (event: KeyboardEvent) => void>();

    constructor(rendererFactory: RendererFactory2) {
        this.renderer = rendererFactory.createRenderer(null, null);
        this.listenToKeyboardEvents();
    }

    private listenToKeyboardEvents() {
        this.renderer.listen('window', 'keydown', (event: KeyboardEvent) => {
            const key = this.getKeyCombination(event);
            if (this.shortcuts.has(key)) {
                event.preventDefault();
                this.shortcuts.get(key)?.(event);
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

    registerShortcut(keys: string, callback: (event: KeyboardEvent) => void) {
        this.shortcuts.set(keys, callback);
    }

    ngOnDestroy() {
        this.shortcuts.clear();
    }
}