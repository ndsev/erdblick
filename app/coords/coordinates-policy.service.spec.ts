import {ownerTestInjector} from "../../test/owner-test-injector";
import {runInInjectionContext} from "@angular/core";
import {AppStore} from "../shared/app.store";
import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import type {AppConfigService, CoordinatesConfig} from "../shared/app-config.service";
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
    const messageService = {showError: vi.fn()};
    const injector = ownerTestInjector();
    const policy = runInInjectionContext(injector, () => new CoordinatesPolicyService(
        configService as unknown as AppConfigService,
        messageService as unknown as InfoMessageService
    ));
    const store = injector.get(AppStore);
    store.setCoordinatesEnabled(enabled);
    store.setCoordinatesLegalTermsAccepted(accepted);
    return {policy, store, messageService};
}

describe("CoordinatesPolicyService", () => {
    it("uses the local preference immediately when no legal document is configured", () => {
        const {policy, store} = createPolicy({}, false);

        policy.initialize();
        expect(policy.effectiveEnabled).toBe(false);

        policy.requestEnabled(true);
        expect(store.coordinatePolicy.coordinatesEnabled()).toBe(true);
        expect(policy.effectiveEnabled).toBe(true);

    });

    it("forces a previously enabled preference off until configured terms are accepted", () => {
        const {policy, store} = createPolicy({
            legalTermsUrl: "/coordinates-legal-terms/terms.yaml",
            legalTerms: "Terms"
        });

        policy.initialize();

        expect(store.coordinatePolicy.coordinatesEnabled()).toBe(false);
        expect(policy.effectiveEnabled).toBe(false);
        expect(policy.legalDialogVisible).toBe(false);

        policy.requestEnabled(true);
        expect(policy.legalDialogVisible).toBe(true);
        expect(store.coordinatePolicy.coordinatesEnabled()).toBe(false);

    });

    it("accepts terms, persists acceptance, and enables the panel", () => {
        const {policy, store} = createPolicy({
            legalTermsUrl: "/coordinates-legal-terms/terms.json",
            legalTerms: "Legal text"
        });
        policy.initialize();
        policy.requestEnabled(true);

        policy.accept();

        expect(store.coordinatePolicy.coordinatesLegalTermsAccepted()).toBe(true);
        expect(store.coordinatePolicy.coordinatesEnabled()).toBe(true);
        expect(policy.effectiveEnabled).toBe(true);
        expect(policy.legalDialogVisible).toBe(false);

    });

    it("restores an enabled preference when the configured terms were already accepted", () => {
        const {policy, store} = createPolicy({
            legalTermsUrl: "/coordinates-legal-terms/terms.json",
            legalTerms: "Legal text"
        }, true, true);

        policy.initialize();

        expect(store.coordinatePolicy.coordinatesEnabled()).toBe(true);
        expect(policy.effectiveEnabled).toBe(true);
        expect(policy.legalDialogVisible).toBe(false);

    });

    it("refuses without recording acceptance and prompts again on the next enable", () => {
        const {policy, store} = createPolicy({
            legalTermsUrl: "/coordinates-legal-terms/terms.yaml",
            legalTerms: "Legal text"
        });
        policy.initialize();
        policy.requestEnabled(true);

        policy.refuse();

        expect(store.coordinatePolicy.coordinatesLegalTermsAccepted()).toBe(false);
        expect(store.coordinatePolicy.coordinatesEnabled()).toBe(false);
        expect(policy.effectiveEnabled).toBe(false);
        expect(policy.legalDialogVisible).toBe(false);

        policy.requestEnabled(true);
        expect(policy.legalDialogVisible).toBe(true);

    });

    it("fails closed and reports the configured document load error", () => {
        const {policy, store, messageService} = createPolicy({
            legalTermsUrl: "/coordinates-legal-terms/missing.yaml",
            legalTermsError: "Could not load coordinate legal terms."
        });
        policy.initialize();

        policy.requestEnabled(true);

        expect(store.coordinatePolicy.coordinatesEnabled()).toBe(false);
        expect(policy.legalDialogVisible).toBe(false);
        expect(messageService.showError).toHaveBeenCalledWith("Could not load coordinate legal terms.");

    });
});
