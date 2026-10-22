import {inject, Injectable} from "@angular/core";
import {AppConfigService} from "../shared/app-config.service";
import {AppStore} from "../shared/app.store";
import {InfoMessageService} from "../shared/info.service";

@Injectable({providedIn: "root"})
/** Enforces the local coordinate-readout preference and its optional legal gate. */
export class CoordinatesPolicyService {
    private readonly store = inject(AppStore);
    private initialized = false;
    legalDialogVisible = false;

    constructor(
        private readonly configService: AppConfigService,
        private readonly messageService: InfoMessageService
    ) {}

    /** Applies the legal gate after configuration and local AppState hydration are complete. */
    initialize(): void {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        this.enforceLegalGate();
    }

    /** Returns whether coordinate values may currently be displayed. */
    get effectiveEnabled(): boolean {
        const coordinatesConfig = this.configService.snapshot.coordinates;
        const legalGateOpen = !coordinatesConfig.legalTermsUrl ||
            (!coordinatesConfig.legalTermsError && this.store.coordinatePolicy.coordinatesLegalTermsAccepted());
        return this.initialized && !!legalGateOpen && this.store.coordinatePolicy.coordinatesEnabled();
    }

    /** Returns the legal text loaded during application configuration. */
    get legalTerms(): string {
        return this.configService.snapshot.coordinates.legalTerms ?? "";
    }

    /** Handles one preference-toggle request without enabling before consent. */
    requestEnabled(enabled: boolean): void {
        if (!enabled) {
            this.store.setCoordinatesEnabled(false);
            return;
        }
        const coordinatesConfig = this.configService.snapshot.coordinates;
        if (!coordinatesConfig.legalTermsUrl) {
            this.store.setCoordinatesEnabled(true);
            return;
        }
        if (coordinatesConfig.legalTermsError) {
            this.messageService.showError(coordinatesConfig.legalTermsError);
            return;
        }
        if (this.store.coordinatePolicy.coordinatesLegalTermsAccepted()) {
            this.store.setCoordinatesEnabled(true);
            return;
        }
        this.legalDialogVisible = true;
    }

    /** Records acceptance, enables the coordinate readout, and closes the legal dialog. */
    accept(): void {
        this.store.setCoordinatesConsent(true);
        this.legalDialogVisible = false;
    }

    /** Records no acceptance, keeps coordinates disabled, and closes the legal dialog. */
    refuse(): void {
        this.store.setCoordinatesConsent(false);
        this.legalDialogVisible = false;
    }

    /** Forces the raw preference off when configured terms have not been accepted or failed to load. */
    private enforceLegalGate(): void {
        const coordinatesConfig = this.configService.snapshot.coordinates;
        if (
            coordinatesConfig.legalTermsUrl &&
            (coordinatesConfig.legalTermsError || !this.store.coordinatePolicy.coordinatesLegalTermsAccepted())
        ) {
            this.store.setCoordinatesEnabled(false);
        }
    }
}
