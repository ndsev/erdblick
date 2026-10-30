import {Component} from "@angular/core";
import {CoordinatesPolicyService} from "../coordinates/coordinates-policy.service";
import {LOCATION_BOUNDARY_DISCLAIMER} from "./location-policy.model";
import {LocationPolicyService} from "./location-policy.service";

/** Presents fixed boundary terms, or the same text without an acceptance action. */
@Component({
    selector: "location-terms-dialog",
    template: `
        <app-dialog header="Location boundaries"
                    [visible]="policy.dialogMode !== null && !coordinatesPolicy.legalDialogVisible"
                    (visibleChange)="onVisibleChange($event)"
                    [modal]="true" [draggable]="false" [resizable]="false"
                    [persistLayout]="false" [dismissableMask]="false"
                    [style]="{'width': 'min(42rem, 90vw)'}">
            <div data-testid="location-boundary-terms">
                <p>{{ disclaimer }}</p>
                <p>Data from <location-attribution />.</p>
                <div class="location-terms-actions">
                    @if (policy.dialogMode === 'accept') {
                        <p-button label="Keep disabled" severity="secondary"
                                  data-testid="location-boundaries-refuse" (click)="policy.refuse()" />
                        <p-button label="Accept and enable"
                                  data-testid="location-boundaries-accept" (click)="policy.accept()" />
                    } @else {
                        <p-button label="Close" data-testid="location-terms-close" (click)="policy.dismiss()" />
                    }
                </div>
            </div>
        </app-dialog>
    `,
    styles: [`.location-terms-actions { display: flex; gap: .75rem; justify-content: flex-end; }`],
    standalone: false
})
export class LocationTermsDialogComponent {
    readonly disclaimer = LOCATION_BOUNDARY_DISCLAIMER;
    constructor(public readonly policy: LocationPolicyService,
                public readonly coordinatesPolicy: CoordinatesPolicyService) {}

    /** Treat a user close as refusal without affecting read-only access. */
    onVisibleChange(visible: boolean): void {
        if (!visible) this.policy.dismiss();
    }
}
