import {Component} from "@angular/core";
import {CoordinatesPolicyService} from "./coordinates-policy.service";

@Component({
    selector: "coordinates-legal-terms-dialog",
    template: `
        <app-dialog header="Accept Legal Terms"
                    [visible]="policy.legalDialogVisible"
                    [modal]="true"
                    [closable]="false"
                    [closeOnEscape]="false"
                    [dismissableMask]="false"
                    [draggable]="false"
                    [resizable]="false"
                    [style]="{'width': 'min(42rem, 90vw)'}">
            <div class="coordinates-legal-terms" data-testid="coordinates-legal-terms-text">{{ policy.legalTerms }}</div>
            <div class="coordinates-legal-terms-actions">
                <p-button label="Accept" data-testid="coordinates-legal-terms-accept" (click)="policy.accept()"/>
                <p-button label="Refuse" severity="danger" data-testid="coordinates-legal-terms-refuse" (click)="policy.refuse()"/>
            </div>
        </app-dialog>
    `,
    styles: [`
        .coordinates-legal-terms {
            max-height: 55vh;
            overflow: auto;
            white-space: pre-wrap;
        }

        .coordinates-legal-terms-actions {
            display: flex;
            gap: 0.75rem;
            justify-content: flex-end;
            margin-top: 1rem;
        }
    `],
    standalone: false
})
/** Displays configured coordinate legal text and the explicit consent decision. */
export class CoordinatesLegalTermsDialogComponent {
    constructor(public readonly policy: CoordinatesPolicyService) {}
}
