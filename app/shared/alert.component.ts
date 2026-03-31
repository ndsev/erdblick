import {AfterViewInit, Component, ElementRef, EventEmitter, ViewChild, input, output} from "@angular/core";
import {FormsModule} from "@angular/forms";
import {ButtonModule} from "primeng/button";
import {Textarea} from "primeng/textarea";
import {AppDialogComponent} from "./app-dialog.component";

@Component({
    selector: 'alert-dialog',
    template: `
        <app-dialog class="alert-dialog" [header]="headerText()" [(visible)]="display" [modal]="true" [closable]="true" 
                  [dismissableMask]="true" (onHide)="close()">
            @if (hint()) {
                <p>{{ hint() }}</p>
            }
            <textarea class="message-area" rows="25" cols="75" pTextarea [ngModel]="messageText()" readonly #textarea>
            </textarea>
            <ng-template pTemplate="footer">
                <p-button type="button" label="Ok" icon="pi pi-check" (click)="close()"></p-button>
            </ng-template>
        </app-dialog>
    `,
    styles: [``],
    standalone: true,
    imports: [AppDialogComponent, ButtonModule, Textarea, FormsModule]
})
export class AlertDialogComponent implements AfterViewInit {
    headerText = input<string>('Default Header');
    messageText = input<string>('Default Body Text');
    hint = input<string | undefined>();
    selected = input<boolean>(false);
    display: boolean = false;

    displayChange = output<boolean>();
    @ViewChild('textarea', { static: true }) txtRef!: ElementRef<HTMLTextAreaElement>;

    close() {
        this.display = false;
        this.displayChange.emit(this.display);
    }

    ngAfterViewInit() {
        if (this.selected()) {
            this.txtRef.nativeElement.select();
        }
    }
}
