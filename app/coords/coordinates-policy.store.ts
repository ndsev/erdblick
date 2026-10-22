/**
 * The coordinate feature switch and the user's acceptance of its legal terms.
 * These preferences survive reloads but are excluded from shared snapshots.
 * CoordinatesPolicyService combines them with deployment configuration.
 */
import { Injectable } from "@angular/core";
import { Boolish } from "../state/app-state";
import { AppStateService } from "../state/app-state.service";

@Injectable({ providedIn: "root" })
export class CoordinatesPolicyStore {
    constructor(private readonly persistence: AppStateService) { }

    readonly coordinatesEnabledState = this.persistence.registerState<boolean>({
        name: "coordinatesEnabled",
        defaultValue: true,
        schema: Boolish,
        snapshotPersist: false,
        configDefault: true
    });

    readonly coordinatesLegalTermsAcceptedState = this.persistence.registerState<boolean>({
        name: "coordinatesLegalTermsAccepted",
        defaultValue: false,
        schema: Boolish,
        snapshotPersist: false
    });
}
