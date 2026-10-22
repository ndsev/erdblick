import { CoordinatesPolicyStore } from "./coordinates-policy.store";
import { testPersistence } from "../../test/state-owners";
import "@angular/compiler";
import { describe, expect, it, vi } from "vitest";
import { BehaviorSubject } from "rxjs";
import type { AppConfigService, CoordinatesConfig } from "../config/app-config.service";
import type { AppStateService } from "../state/app-state.service";
import type { InfoMessageService } from "../shared/info.service";
import { CoordinatesPolicyService } from "./coordinates-policy.service";

/** Builds a coordinate policy around mutable local state and one normalized config. */
function createPolicy(coordinates: Partial<CoordinatesConfig> = {}, enabled = true, accepted = false) {
    const normalized: CoordinatesConfig = {
        enabledByDefault: true,
        legalTermsUrl: null,
        legalTerms: null,
        legalTermsError: null,
        ...coordinates
    };
    const configService = { snapshot: { coordinates: normalized } };
    const stateService = testPersistence();
    const messageService = { showError: vi.fn() };
    const policy = new CoordinatesPolicyService(
        configService as unknown as AppConfigService,
        stateService as unknown as AppStateService,
        messageService as unknown as InfoMessageService, new CoordinatesPolicyStore(stateService as unknown as AppStateService)
    );
    policy.store.coordinatesEnabledState.next(enabled);
    policy.store.coordinatesLegalTermsAcceptedState.next(accepted);
    return { policy, messageService };
}

describe("CoordinatesPolicyService", () => {
    it("uses the local preference immediately when no legal document is configured", () => {
        const { policy } = createPolicy({}, false);

        policy.initialize();
        expect(policy.effectiveEnabled).toBe(false);

        policy.requestEnabled(true);
        expect(policy.store.coordinatesEnabledState.getValue()).toBe(true);
        expect(policy.effectiveEnabled).toBe(true);

        policy.ngOnDestroy();
    });

    it("forces a previously enabled preference off until configured terms are accepted", () => {
        const { policy } = createPolicy({
            legalTermsUrl: "/coordinates-legal-terms/terms.yaml",
            legalTerms: "Terms"
        });

        policy.initialize();

        expect(policy.store.coordinatesEnabledState.getValue()).toBe(false);
        expect(policy.effectiveEnabled).toBe(false);
        expect(policy.legalDialogVisible).toBe(false);

        policy.requestEnabled(true);
        expect(policy.legalDialogVisible).toBe(true);
        expect(policy.store.coordinatesEnabledState.getValue()).toBe(false);

        policy.ngOnDestroy();
    });

    it("accepts terms, persists acceptance, and enables the panel", () => {
        const { policy } = createPolicy({
            legalTermsUrl: "/coordinates-legal-terms/terms.json",
            legalTerms: "Legal text"
        });
        policy.initialize();
        policy.requestEnabled(true);

        policy.accept();

        expect(policy.store.coordinatesLegalTermsAcceptedState.getValue()).toBe(true);
        expect(policy.store.coordinatesEnabledState.getValue()).toBe(true);
        expect(policy.effectiveEnabled).toBe(true);
        expect(policy.legalDialogVisible).toBe(false);

        policy.ngOnDestroy();
    });

    it("restores an enabled preference when the configured terms were already accepted", () => {
        const { policy } = createPolicy({
            legalTermsUrl: "/coordinates-legal-terms/terms.json",
            legalTerms: "Legal text"
        }, true, true);

        policy.initialize();

        expect(policy.store.coordinatesEnabledState.getValue()).toBe(true);
        expect(policy.effectiveEnabled).toBe(true);
        expect(policy.legalDialogVisible).toBe(false);

        policy.ngOnDestroy();
    });

    it("refuses without recording acceptance and prompts again on the next enable", () => {
        const { policy } = createPolicy({
            legalTermsUrl: "/coordinates-legal-terms/terms.yaml",
            legalTerms: "Legal text"
        });
        policy.initialize();
        policy.requestEnabled(true);

        policy.refuse();

        expect(policy.store.coordinatesLegalTermsAcceptedState.getValue()).toBe(false);
        expect(policy.store.coordinatesEnabledState.getValue()).toBe(false);
        expect(policy.effectiveEnabled).toBe(false);
        expect(policy.legalDialogVisible).toBe(false);

        policy.requestEnabled(true);
        expect(policy.legalDialogVisible).toBe(true);

        policy.ngOnDestroy();
    });

    it("fails closed and reports the configured document load error", () => {
        const { policy, messageService } = createPolicy({
            legalTermsUrl: "/coordinates-legal-terms/missing.yaml",
            legalTermsError: "Could not load coordinate legal terms."
        });
        policy.initialize();

        policy.requestEnabled(true);

        expect(policy.store.coordinatesEnabledState.getValue()).toBe(false);
        expect(policy.legalDialogVisible).toBe(false);
        expect(messageService.showError).toHaveBeenCalledWith("Could not load coordinate legal terms.");

        policy.ngOnDestroy();
    });
});
