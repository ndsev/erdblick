import {Component, EventEmitter, input, Output} from "@angular/core";
import {ButtonModule} from "primeng/button";
import {AppDialogComponent} from "./app-dialog.component";

@Component({
    selector: "confirm-dialog",
    template: `
        <app-dialog class="confirm-dialog"
                    [header]="headerText()"
                    [(visible)]="display"
                    [modal]="true"
                    [closable]="true"
                    [dismissableMask]="true"
                    (onHide)="reject()">
            <div class="confirm-dialog-message">{{ messageText() }}</div>
            <ng-template pTemplate="footer">
                <p-button type="button"
                          label="Cancel"
                          severity="secondary"
                          [outlined]="true"
                          (click)="reject()">
                </p-button>
                <p-button type="button"
                          label="Close"
                          severity="danger"
                          icon="pi pi-check"
                          (click)="accept()">
                </p-button>
            </ng-template>
        </app-dialog>
    `,
    standalone: true,
    imports: [AppDialogComponent, ButtonModule]
})
export class ConfirmDialogComponent {
    headerText = input<string>("Confirm");
    messageText = input<string>("");
    display = false;

    @Output() result = new EventEmitter<boolean>();
    private settled = false;

    accept(): void {
        if (this.settled) {
            return;
        }
        this.settled = true;
        this.display = false;
        this.result.emit(true);
    }

    reject(): void {
        if (this.settled) {
            return;
        }
        this.settled = true;
        this.display = false;
        this.result.emit(false);
    }
}
