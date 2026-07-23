import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {BehaviorSubject} from "rxjs";
import type {AppConfigService, CoordinatesConfig} from "../shared/app-config.service";
import type {AppStateService} from "../shared/appstate.service";
import type {InfoMessageService} from "../shared/info.service";
import {CoordinatesPolicyService} from "./coordinates-policy.service";

/** Builds a coordinate policy around mutable local state and one normalized config. */
function createPolicy(coordinates: Partial<CoordinatesConfig> = {}, enabled = true, accepted = false) {
    const normalized: CoordinatesConfig = {
        enabledByDefault: true,
        legalTermsUrl: null,
        legalTerms: null,
        legalTermsError: null,
        ...coordinates
    };
    const configService = {snapshot: {coordinates: normalized}};
    const stateService = {
        coordinatesEnabledState: new BehaviorSubject(enabled),
        coordinatesLegalTermsAcceptedState: new BehaviorSubject(accepted)
    };
    const messageService = {showError: vi.fn()};
    const policy = new CoordinatesPolicyService(
        configService as unknown as AppConfigService,
        stateService as unknown as AppStateService,
        messageService as unknown as InfoMessageService
    );
    return {policy, stateService, messageService};
}

describe("CoordinatesPolicyService", () => {
    it("uses the local preference immediately when no legal document is configured", () => {
        const {policy, stateService} = createPolicy({}, false);

        policy.initialize();
        expect(policy.effectiveEnabled).toBe(false);

        policy.requestEnabled(true);
        expect(stateService.coordinatesEnabledState.getValue()).toBe(true);
        expect(policy.effectiveEnabled).toBe(true);

        policy.ngOnDestroy();
    });

    it("forces a previously enabled preference off until configured terms are accepted", () => {
        const {policy, stateService} = createPolicy({
            legalTermsUrl: "/coordinates-legal-terms/terms.yaml",
            legalTerms: "Terms"
        });

        policy.initialize();

        expect(stateService.coordinatesEnabledState.getValue()).toBe(false);
        expect(policy.effectiveEnabled).toBe(false);
        expect(policy.legalDialogVisible).toBe(false);

        policy.requestEnabled(true);
        expect(policy.legalDialogVisible).toBe(true);
        expect(stateService.coordinatesEnabledState.getValue()).toBe(false);

        policy.ngOnDestroy();
    });

    it("accepts terms, persists acceptance, and enables the panel", () => {
        const {policy, stateService} = createPolicy({
            legalTermsUrl: "/coordinates-legal-terms/terms.json",
            legalTerms: "Legal text"
        });
        policy.initialize();
        policy.requestEnabled(true);

        policy.accept();

        expect(stateService.coordinatesLegalTermsAcceptedState.getValue()).toBe(true);
        expect(stateService.coordinatesEnabledState.getValue()).toBe(true);
        expect(policy.effectiveEnabled).toBe(true);
        expect(policy.legalDialogVisible).toBe(false);

        policy.ngOnDestroy();
    });

    it("restores an enabled preference when the configured terms were already accepted", () => {
        const {policy, stateService} = createPolicy({
            legalTermsUrl: "/coordinates-legal-terms/terms.json",
            legalTerms: "Legal text"
        }, true, true);

        policy.initialize();

        expect(stateService.coordinatesEnabledState.getValue()).toBe(true);
        expect(policy.effectiveEnabled).toBe(true);
        expect(policy.legalDialogVisible).toBe(false);

        policy.ngOnDestroy();
    });

    it("refuses without recording acceptance and prompts again on the next enable", () => {
        const {policy, stateService} = createPolicy({
            legalTermsUrl: "/coordinates-legal-terms/terms.yaml",
            legalTerms: "Legal text"
        });
        policy.initialize();
        policy.requestEnabled(true);

        policy.refuse();

        expect(stateService.coordinatesLegalTermsAcceptedState.getValue()).toBe(false);
        expect(stateService.coordinatesEnabledState.getValue()).toBe(false);
        expect(policy.effectiveEnabled).toBe(false);
        expect(policy.legalDialogVisible).toBe(false);

        policy.requestEnabled(true);
        expect(policy.legalDialogVisible).toBe(true);

        policy.ngOnDestroy();
    });

    it("fails closed and reports the configured document load error", () => {
        const {policy, stateService, messageService} = createPolicy({
            legalTermsUrl: "/coordinates-legal-terms/missing.yaml",
            legalTermsError: "Could not load coordinate legal terms."
        });
        policy.initialize();

        policy.requestEnabled(true);

        expect(stateService.coordinatesEnabledState.getValue()).toBe(false);
        expect(policy.legalDialogVisible).toBe(false);
        expect(messageService.showError).toHaveBeenCalledWith("Could not load coordinate legal terms.");

        policy.ngOnDestroy();
    });
});
