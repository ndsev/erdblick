import { Injectable, OnDestroy } from "@angular/core";
import { BehaviorSubject, Subscription } from "rxjs";
import { AppConfigService } from "../config/app-config.service";
import { InfoMessageService } from "../shared/info.service";
import { AppStateService } from "../state/app-state.service";
import { CoordinatesModel } from "./coordinates.model";

@Injectable({ providedIn: "root" })
/** Enforces the local coordinate-readout preference and its optional legal gate. */
export class CoordinatesPolicyService implements OnDestroy {

    private readonly effectiveEnabledSubject = new BehaviorSubject(false);
    private readonly subscriptions = new Subscription();
    private initialized = false;
    legalDialogVisible = false;

    constructor(
        private readonly configService: AppConfigService,
        private readonly stateService: AppStateService,
        private readonly messageService: InfoMessageService,
        public readonly model: CoordinatesModel
    ) { }

    /** Applies the legal gate after configuration and local AppState hydration are complete. */
    initialize(): void {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        this.enforceLegalGate();
        this.subscriptions.add(
            this.model.coordinatesEnabledState.subscribe(() => this.refreshEffectiveState())
        );
        this.subscriptions.add(
            this.model.coordinatesLegalTermsAcceptedState.subscribe(() => this.refreshEffectiveState())
        );
        this.refreshEffectiveState();
    }

    /** Returns whether coordinate values may currently be displayed. */
    get effectiveEnabled(): boolean {
        return this.effectiveEnabledSubject.getValue();
    }

    /** Returns the legal text loaded during application configuration. */
    get legalTerms(): string {
        return this.configService.snapshot.coordinates.legalTerms ?? "";
    }

    /** Handles one preference-toggle request without enabling before consent. */
    requestEnabled(enabled: boolean): void {
        if (!enabled) {
            this.model.coordinatesEnabledState.next(false);
            return;
        }
        const coordinatesConfig = this.configService.snapshot.coordinates;
        if (!coordinatesConfig.legalTermsUrl) {
            this.model.coordinatesEnabledState.next(true);
            return;
        }
        if (coordinatesConfig.legalTermsError) {
            this.messageService.showError(coordinatesConfig.legalTermsError);
            return;
        }
        if (this.model.coordinatesLegalTermsAcceptedState.getValue()) {
            this.model.coordinatesEnabledState.next(true);
            return;
        }
        this.legalDialogVisible = true;
    }

    /** Records acceptance, enables the coordinate readout, and closes the legal dialog. */
    accept(): void {
        this.model.coordinatesLegalTermsAcceptedState.next(true);
        this.model.coordinatesEnabledState.next(true);
        this.legalDialogVisible = false;
    }

    /** Records no acceptance, keeps coordinates disabled, and closes the legal dialog. */
    refuse(): void {
        this.model.coordinatesLegalTermsAcceptedState.next(false);
        this.model.coordinatesEnabledState.next(false);
        this.legalDialogVisible = false;
    }

    /** Releases AppState subscriptions held by the application-scoped policy. */
    ngOnDestroy(): void {
        this.subscriptions.unsubscribe();
        this.effectiveEnabledSubject.complete();
    }

    /** Forces the raw preference off when configured terms have not been accepted or failed to load. */
    private enforceLegalGate(): void {
        const coordinatesConfig = this.configService.snapshot.coordinates;
        if (
            coordinatesConfig.legalTermsUrl &&
            (coordinatesConfig.legalTermsError || !this.model.coordinatesLegalTermsAcceptedState.getValue())
        ) {
            this.model.coordinatesEnabledState.next(false);
        }
    }

    /** Publishes the effective readout state after applying the loaded legal configuration. */
    private refreshEffectiveState(): void {
        const coordinatesConfig = this.configService.snapshot.coordinates;
        const legalGateOpen =
            !coordinatesConfig.legalTermsUrl ||
            (!coordinatesConfig.legalTermsError && this.model.coordinatesLegalTermsAcceptedState.getValue());
        this.effectiveEnabledSubject.next(
            this.initialized && legalGateOpen && this.model.coordinatesEnabledState.getValue()
        );
    }
}
