import {
    Component,
    EventEmitter,
    Injectable,
    Injector,
    Input,
    Output,
    ViewContainerRef
} from "@angular/core";
import {MessageService} from "primeng/api";


@Component({
    selector: 'alert-dialog',
    template: `
        <p-dialog [header]="headerText" [(visible)]="display" [modal]="true" [closable]="true" [dismissableMask]="true" (onHide)="close()">
            <textarea class="message-area" rows="25" cols="75" pTextarea [(ngModel)]="messageText" readonly>
            </textarea>
            <p-footer>
                <button type="button" pButton label="Ok" icon="pi pi-check" (click)="close()"></button>
            </p-footer>
        </p-dialog>
    `,
    styles: [``],
    standalone: false
})
export class AlertDialogComponent {
    @Input() headerText: string = 'Default Header';
    @Input() messageText: string = 'Default Body Text';
    display: boolean = false;

    @Output() displayChange = new EventEmitter<boolean>();

    close() {
        this.display = false;
        this.displayChange.emit(this.display);
    }
}

@Injectable({providedIn: 'root'})
export class InfoMessageService {
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

    showAlertDialog(viewContainerRef: ViewContainerRef, header: string, message: string) {
        const componentRef = viewContainerRef.createComponent(
            AlertDialogComponent, { injector: this.injector }
        );

        const instance = componentRef.instance;
        instance.headerText = header;
        instance.messageText = message;
        instance.display = true;

        instance.displayChange.subscribe(() => {
            componentRef.destroy();
        });
    }
}