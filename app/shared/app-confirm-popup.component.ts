import {NgClass, NgTemplateOutlet} from "@angular/common";
import {Component, ContentChild, Input, TemplateRef} from "@angular/core";
import {ButtonModule} from "primeng/button";
import {ConfirmPopupModule} from "primeng/confirmpopup";
import {AppConfirmation, AppConfirmPopupService, AppConfirmPopupSeverity} from "./app-confirm-popup.service";

@Component({
    selector: "app-confirm-popup",
    template: `
        <p-confirmpopup [key]="key"
                        appendTo="body"
                        [baseZIndex]="baseZIndex"
                        [styleClass]="styleClass">
            <ng-template pTemplate="headless" let-confirmation>
                <div class="app-confirm-popup" [ngClass]="severityClass(confirmation)">
                    <span class="material-symbols-outlined app-confirm-popup-icon">
                        {{ severityIcon(confirmation) }}
                    </span>
                    <div class="app-confirm-popup-header">{{ confirmation?.header }}</div>
                    <div class="app-confirm-popup-message">{{ confirmation?.message }}</div>
                    <div class="app-confirm-popup-actions">
                        @if (extraActionsTemplate) {
                            <ng-container *ngTemplateOutlet="extraActionsTemplate; context: {$implicit: confirmation}"></ng-container>
                        }
                        <p-button label="Cancel"
                                  size="small"
                                  severity="secondary"
                                  [text]="true"
                                  (click)="reject(confirmation)">
                        </p-button>
                        <p-button label="Yes"
                                  size="small"
                                  [severity]="acceptButtonSeverity(confirmation)"
                                  (click)="accept(confirmation)">
                        </p-button>
                    </div>
                </div>
            </ng-template>
        </p-confirmpopup>
    `,
    standalone: true,
    imports: [ButtonModule, ConfirmPopupModule, NgClass, NgTemplateOutlet]
})
/** Standard app-styled wrapper for keyed PrimeNG confirmation popups. */
export class AppConfirmPopupComponent {
    @Input({required: true}) key = "";
    @Input() baseZIndex = 30000;
    @Input() styleClass = "";

    @ContentChild('extraActions', {read: TemplateRef}) extraActionsTemplate?: TemplateRef<unknown>;

    constructor(private readonly confirmPopup: AppConfirmPopupService) {}

    protected accept(confirmation: AppConfirmation | null | undefined): void {
        confirmation?.accept?.();
        this.confirmPopup.close();
    }

    protected reject(confirmation: AppConfirmation | null | undefined): void {
        confirmation?.reject?.();
        this.confirmPopup.close();
    }

    protected severityIcon(confirmation: AppConfirmation | null | undefined): string {
        switch (this.severity(confirmation)) {
            case "success":
                return "check_circle";
            case "warn":
                return "warning";
            case "error":
                return "dangerous";
            case "info":
            default:
                return "info";
        }
    }

    protected severityClass(confirmation: AppConfirmation | null | undefined): string {
        return `app-confirm-popup-${this.severity(confirmation)}`;
    }

    protected acceptButtonSeverity(confirmation: AppConfirmation | null | undefined): "primary" | "danger" {
        return this.severity(confirmation) === "error" ? "danger" : "primary";
    }

    private severity(confirmation: AppConfirmation | null | undefined): AppConfirmPopupSeverity {
        return confirmation?.severity ?? "info";
    }
}
