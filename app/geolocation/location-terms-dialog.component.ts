import {Component} from "@angular/core";
import {CoordinatesPolicyService} from "../coordinates/coordinates-policy.service";
import {LOCATION_BOUNDARY_DISCLAIMER} from "./location-policy.model";
import {LocationPolicyService} from "./location-policy.service";

/** Presents the fixed boundary terms and applies both location preferences together. */
@Component({
    selector: "location-terms-dialog",
    template: `
        <app-dialog header="Location search terms"
                    [visible]="policy.dialogMode !== null && !coordinatesPolicy.legalDialogVisible"
                    (visibleChange)="onVisibleChange($event)"
                    [modal]="true" [draggable]="false" [resizable]="false"
                    [persistLayout]="false" [dismissableMask]="false"
                    [style]="{'width': 'min(42rem, 90vw)'}">
            <div data-testid="location-boundary-terms">
                <p>{{ disclaimer }}</p>
                <p>Data from <location-attribution />.</p>
                <div class="location-terms-setting">
                    <label for="location-terms-search-enabled">Enable location search</label>
                    <p-toggleswitch inputId="location-terms-search-enabled"
                                    [(ngModel)]="policy.pendingSearchEnabled" />
                </div>
                <div class="location-terms-setting">
                    <label for="location-terms-boundaries-enabled">Use location boundaries</label>
                    <p-toggleswitch inputId="location-terms-boundaries-enabled"
                                    [(ngModel)]="policy.pendingBoundariesEnabled"
                                    [disabled]="!policy.pendingSearchEnabled" />
                </div>
                <p>By applying with <strong>Use location boundaries</strong> selected, you accept these terms.</p>
                <p>You can change these settings later in <strong>Edit → Preferences → Inspect &amp; Search</strong>.</p>
                <div class="location-terms-actions">
                    <p-button label="Apply" data-testid="location-terms-apply" (click)="policy.apply()" />
                </div>
            </div>
        </app-dialog>
    `,
    styles: [`
        .location-terms-setting { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin: 1rem 0; }
        .location-terms-actions { display: flex; justify-content: flex-end; }
    `],
    standalone: false
})
export class LocationTermsDialogComponent {
    readonly disclaimer = LOCATION_BOUNDARY_DISCLAIMER;
    constructor(public readonly policy: LocationPolicyService,
                public readonly coordinatesPolicy: CoordinatesPolicyService) {}

    /** Discard draft edits; closing an acceptance prompt keeps boundaries disabled. */
    onVisibleChange(visible: boolean): void {
        if (!visible) this.policy.dismiss();
    }
}
