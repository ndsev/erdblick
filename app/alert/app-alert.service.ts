import {ComponentRef, Injectable, Injector, OnDestroy, ViewContainerRef} from '@angular/core';
import {InfoMessageService} from '../diagnostics/info.service';
import {AlertDialogComponent} from './alert.component';
import {ConfirmDialogComponent} from './confirm-dialog.component';

@Injectable({providedIn: 'root'})
/** Owns dynamic modal dialogs separately from lightweight notifications and their low-level callers. */
export class AppAlertService implements OnDestroy {
    private defaultContainer?: ViewContainerRef;
    private readonly dialogs = new Map<ComponentRef<unknown>, ViewContainerRef>();

    /** Retains only the injector and lightweight fallback; containers are explicitly registered. */
    constructor(private readonly injector: Injector, private readonly messages: InfoMessageService) {}

    /** Registers a host with an explicit release function; stale root containers cannot survive teardown. */
    registerDefaultContainer(container: ViewContainerRef): () => void {
        this.defaultContainer = container;
        return () => {
            if (this.defaultContainer === container) this.defaultContainer = undefined;
            for (const [dialog, owner] of this.dialogs) if (owner === container) dialog.destroy();
        };
    }

    /** Opens full selectable text in the registered host, preserving the existing toast fallback. */
    showAlertDialogDefault(header: string, message: string, selectText = false, hint?: string): void {
        if (!this.defaultContainer) {
            this.messages.showError(message);
            return;
        }
        this.showAlertDialog(this.defaultContainer, header, message, selectText, hint);
    }

    /** Creates an alert owned by the supplied container and releases its subscription on either close path. */
    showAlertDialog(container: ViewContainerRef, header: string, message: string, selectText = false, hint?: string): void {
        const ref = container.createComponent(AlertDialogComponent, {injector: this.injector});
        this.track(ref, container);
        ref.setInput('headerText', header);
        ref.setInput('messageText', message);
        ref.setInput('hint', hint);
        ref.setInput('selected', selectText);
        ref.instance.display = true;
        const subscription = ref.instance.displayChange.subscribe(() => ref.destroy());
        ref.onDestroy(() => subscription.unsubscribe());
    }

    /** Resolves only explicit acceptance as true; destroying the owner cancels an outstanding confirmation. */
    showConfirmDialog(container: ViewContainerRef, header: string, message: string): Promise<boolean> {
        const ref = container.createComponent(ConfirmDialogComponent, {injector: this.injector});
        this.track(ref, container);
        ref.setInput('headerText', header);
        ref.setInput('messageText', message);
        ref.instance.display = true;
        return new Promise(resolve => {
            let settled = false;
            const subscription = ref.instance.result.subscribe(result => {
                if (settled) return;
                settled = true;
                resolve(result);
                ref.destroy();
            });
            ref.onDestroy(() => {
                subscription.unsubscribe();
                if (!settled) {
                    settled = true;
                    resolve(false);
                }
            });
        });
    }

    /** Destroys any outstanding dynamic children when the application injector retires. */
    ngOnDestroy(): void {
        this.defaultContainer = undefined;
        for (const dialog of [...this.dialogs.keys()]) dialog.destroy();
    }

    /** Tracks both owner-driven and explicit child destruction without retaining dead component refs. */
    private track(ref: ComponentRef<unknown>, container: ViewContainerRef): void {
        this.dialogs.set(ref, container);
        ref.onDestroy(() => this.dialogs.delete(ref));
    }
}
