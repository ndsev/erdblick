import {
    AfterViewInit,
    Component, ElementRef,
    EventEmitter,
    Injectable,
    Injector, input,
    Input,
    Output, ViewChild,
    ViewContainerRef
} from "@angular/core";
import {MessageService} from "primeng/api";


@Component({
    selector: 'alert-dialog',
    template: `
        <p-dialog class="alert-dialog" [header]="headerText" [(visible)]="display" [modal]="true" [closable]="true" 
                  [dismissableMask]="true" (onHide)="close()">
            @if (hint) {
                <p>{{ hint }}</p>
            }
            <textarea class="message-area" rows="25" cols="75" pTextarea [(ngModel)]="messageText" readonly #textarea>
            </textarea>
            <p-footer>
                <button type="button" pButton label="Ok" icon="pi pi-check" (click)="close()"></button>
            </p-footer>
        </p-dialog>
    `,
    styles: [``],
    standalone: false
})
export class AlertDialogComponent implements AfterViewInit {
    @Input() headerText: string = 'Default Header';
    @Input() messageText: string = 'Default Body Text';
    @Input() hint: string | undefined;
    @Input() selected: boolean = false;
    display: boolean = false;

    @Output() displayChange = new EventEmitter<boolean>();
    @ViewChild('textarea', { static: true }) txtRef!: ElementRef<HTMLTextAreaElement>;


    close() {
        this.display = false;
        this.displayChange.emit(this.display);
    }

    ngAfterViewInit() {
        if (this.selected) {
            this.txtRef.nativeElement.select();
        }
    }
}

@Injectable({providedIn: 'root'})
export class InfoMessageService {
    private defaultViewContainerRef: ViewContainerRef | null = null;

    constructor(private messageService: MessageService,
                private injector: Injector) { };

    showError(message: string) {
        this.messageService.add({ key: 'tc', severity: 'error', summary: 'Error', detail: message });
    }

    showWarning(message: string) {
        this.messageService.add({ key: 'tc', severity: 'warn', summary: 'Warning', detail: message });
    }

    showSuccess(message: string) {
        this.messageService.add({ key: 'tc', severity: 'success', summary: 'Success', detail: message });
    }

    registerDefaultContainer(ref: ViewContainerRef) {
        this.defaultViewContainerRef = ref;
    }

    showAlertDialog(viewContainerRef: ViewContainerRef, header: string, message: string, selectText: boolean = false, hint?: string) {
        const componentRef = viewContainerRef.createComponent(
            AlertDialogComponent, { injector: this.injector }
        );

        const instance = componentRef.instance;
        instance.headerText = header;
        instance.messageText = message;
        instance.hint = hint;
        instance.selected = selectText;
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
