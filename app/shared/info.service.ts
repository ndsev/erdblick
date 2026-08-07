import {Injectable, Injector, ViewContainerRef} from "@angular/core";
import {MessageService} from "primeng/api";
import {AlertDialogComponent} from "./alert.component";
import {ConfirmDialogComponent} from "./confirm-dialog.component";


@Injectable({providedIn: 'root'})
/** Centralizes toast and modal alert presentation for the Angular frontend. */
export class InfoMessageService {
    private defaultViewContainerRef: ViewContainerRef | null = null;

    constructor(private messageService: MessageService,
                private injector: Injector) { };

    /** Emits an error toast through PrimeNG's global message service. */
    showError(message: string) {
        this.messageService.add({ key: 'tc', severity: 'error', summary: 'Error', detail: message });
    }

    /** Shows one sticky backend connection error, replacing any previous connection-status toast. */
    showBackendConnectionError(message: string) {
        this.messageService.clear('backend-connection');
        this.messageService.add({
            key: 'backend-connection',
            severity: 'error',
            summary: 'Backend Error',
            detail: message,
            sticky: true
        });
    }

    /** Clears the sticky backend connection toast after the backend connection recovers. */
    clearBackendConnectionError() {
        this.messageService.clear('backend-connection');
    }

    /** Shows one sticky backend protocol error, replacing any previous protocol-status toast. */
    showBackendProtocolError(message: string) {
        this.messageService.clear('backend-protocol');
        this.messageService.add({
            key: 'backend-protocol',
            severity: 'error',
            summary: 'Backend Protocol Mismatch',
            detail: message,
            sticky: true
        });
    }

    /** Clears the sticky backend protocol toast after a compatible connection is established. */
    clearBackendProtocolError() {
        this.messageService.clear('backend-protocol');
    }

    /** Shows the persistent warning that browser saves can overwrite source-tree style files. */
    showSourceStyleEditingWarning(directory: string | null) {
        this.messageService.clear("source-style-editing");
        this.messageService.add({
            key: "source-style-editing",
            severity: "warn",
            summary: "Source Style Editing Enabled",
            detail: directory
                ? `Saving a style will overwrite YAML files below ${directory}.`
                : "Saving a style will overwrite mapviewer source files.",
            sticky: true
        });
    }

    /** Emits a warning toast through PrimeNG's global message service. */
    showWarning(message: string) {
        this.messageService.add({ key: 'tc', severity: 'warn', summary: 'Warning', detail: message });
    }

    /** Emits a success toast through PrimeNG's global message service. */
    showSuccess(message: string) {
        this.messageService.add({ key: 'tc', severity: 'success', summary: 'Success', detail: message });
    }

    /** Emits an informational toast through PrimeNG's global message service. */
    showInfo(message: string) {
        this.messageService.add({ key: 'tc', severity: 'info', summary: 'Info', detail: message });
    }

    /** Stores the default host container used for dynamically created alert dialogs. */
    registerDefaultContainer(ref: ViewContainerRef) {
        this.defaultViewContainerRef = ref;
    }

    /** Creates a modal alert dialog in the supplied host container. */
    showAlertDialog(viewContainerRef: ViewContainerRef, header: string, message: string, selectText: boolean = false, hint?: string) {
        const componentRef = viewContainerRef.createComponent(
            AlertDialogComponent, { injector: this.injector }
        );

        componentRef.setInput('headerText', header);
        componentRef.setInput('messageText', message);
        componentRef.setInput('hint', hint);
        componentRef.setInput('selected', selectText);
        const instance = componentRef.instance;
        instance.display = true;

        instance.displayChange.subscribe(() => {
            componentRef.destroy();
        });
    }

    /** Shows an alert dialog in the registered default host or falls back to an error toast. */
    showAlertDialogDefault(header: string, message: string, selectText: boolean = false, hint?: string) {
        if (!this.defaultViewContainerRef) {
            // Fallback to toast if no container is registered
            this.showError(message);
            return;
        }
        this.showAlertDialog(this.defaultViewContainerRef, header, message, selectText, hint);
    }

    /** Creates a modal confirmation dialog and resolves true only for explicit acceptance. */
    showConfirmDialog(viewContainerRef: ViewContainerRef, header: string, message: string): Promise<boolean> {
        const componentRef = viewContainerRef.createComponent(
            ConfirmDialogComponent, { injector: this.injector }
        );
        componentRef.setInput('headerText', header);
        componentRef.setInput('messageText', message);
        const instance = componentRef.instance;
        instance.display = true;

        return new Promise(resolve => {
            const subscription = instance.result.subscribe(result => {
                subscription.unsubscribe();
                componentRef.destroy();
                resolve(result);
            });
        });
    }
}
