/**
 * Saved tile transport settings and the retry policy observed by tile streams.
 * Validation and policy projection require only these AppStates, so streams do
 * not need to construct the ConnectionPreferencesService controller.
 */

import { Injectable } from "@angular/core";
import {
    ConnectionRetryPolicy,
    connectionRetryPolicySchema,
    DEFAULT_CONNECTION_RETRY_POLICY,
    retryDelaySchema,
    retryMultiplierSchema
} from "../shared/connection-retry-policy";
import { Boolish, deepEquals } from "../state/app-state";
import { AppStateService } from "../state/app-state.service";

@Injectable({ providedIn: "root" })
export class ConnectionPreferencesStore {
    constructor(private readonly persistence: AppStateService) { }

    readonly tilePullCompressionEnabledState = this.persistence.registerState<boolean>({
        name: 'tilePullCompressionEnabled',
        defaultValue: false,
        schema: Boolish
    });

    private invalidConnectionPolicy = "";

    readonly connectionRetryEnabledState = this.persistence.registerState<boolean>({
        name: 'connectionRetryEnabled', defaultValue: DEFAULT_CONNECTION_RETRY_POLICY.enabled, schema: Boolish
    });

    readonly connectionRetryInitialDelayMsState = this.persistence.registerState<number>({
        name: 'connectionRetryInitialDelayMs', defaultValue: DEFAULT_CONNECTION_RETRY_POLICY.initialDelayMs,
        schema: retryDelaySchema
    });

    readonly connectionRetryBackoffMultiplierState = this.persistence.registerState<number>({
        name: 'connectionRetryBackoffMultiplier', defaultValue: DEFAULT_CONNECTION_RETRY_POLICY.backoffMultiplier,
        schema: retryMultiplierSchema
    });

    readonly connectionRetryMaxDelayMsState = this.persistence.registerState<number>({
        name: 'connectionRetryMaxDelayMs', defaultValue: DEFAULT_CONNECTION_RETRY_POLICY.maxDelayMs,
        schema: retryDelaySchema
    });

    /** Combines validated slots; inconsistent imported bounds fall back without disabling an explicit opt-out. */
    get connectionRetryPolicy(): ConnectionRetryPolicy {
        const policy = {
            enabled: this.connectionRetryEnabledState.getValue(),
            initialDelayMs: this.connectionRetryInitialDelayMsState.getValue(),
            backoffMultiplier: this.connectionRetryBackoffMultiplierState.getValue(),
            maxDelayMs: this.connectionRetryMaxDelayMsState.getValue()
        };
        const result = connectionRetryPolicySchema.safeParse(policy);
        const invalid = result.success ? "" : JSON.stringify(policy);
        if (invalid && invalid !== this.invalidConnectionPolicy) {
            console.warn("Ignoring inconsistent connection retry settings; using default timing.");
        }
        this.invalidConnectionPolicy = invalid;
        return result.success ? result.data : { ...DEFAULT_CONNECTION_RETRY_POLICY, enabled: policy.enabled };
    }

    readonly connectionRetryPolicyChanges = this.persistence.observe(() => this.connectionRetryPolicy, deepEquals);

    get tilePullCompressionEnabled() { return this.tilePullCompressionEnabledState.getValue(); }

    set tilePullCompressionEnabled(val: boolean) { this.tilePullCompressionEnabledState.next(val); }
}
