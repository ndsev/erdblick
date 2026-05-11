import {Injectable, Injector, ViewContainerRef} from "@angular/core";
import {MessageService} from "primeng/api";
import {AlertDialogComponent} from "./alert.component";


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
}
