import {Injectable, Injector, ViewContainerRef} from "@angular/core";
import {MessageService} from "primeng/api";
import {AlertDialogComponent} from "./alert.component";


@Injectable({providedIn: 'root'})
export class InfoMessageService {
    private defaultViewContainerRef: ViewContainerRef | null = null;

    constructor(private messageService: MessageService,
                private injector: Injector) { };

    showError(message: string) {
        this.messageService.add({ key: 'tc', severity: 'error', summary: 'Error', detail: message });
        return;
    }

    showSuccess(message: string) {
        this.messageService.add({ key: 'tc', severity: 'success', summary: 'Success', detail: message });
        return;
    }

    registerDefaultContainer(ref: ViewContainerRef) {
        this.defaultViewContainerRef = ref;
    }

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

    showAlertDialogDefault(header: string, message: string, selectText: boolean = false, hint?: string) {
        if (!this.defaultViewContainerRef) {
            // Fallback to toast if no container is registered
            this.showError(message);
            return;
        }
        this.showAlertDialog(this.defaultViewContainerRef, header, message, selectText, hint);
    }
}
