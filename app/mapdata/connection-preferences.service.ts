import { AppActionService } from "../actions/app-action.service";
import { connectionControls } from "./connection-preferences.service.declarations";

import { Injectable } from "@angular/core";
import { Boolish, deepEquals } from "../shared/app-state";
import { AppStateService } from "../shared/appstate.service";
import {
    ConnectionRetryPolicy,
    connectionRetryPolicySchema,
    DEFAULT_CONNECTION_RETRY_POLICY,
    retryDelaySchema,
    retryMultiplierSchema
} from "../shared/connection-retry-policy";

/** Owns transport retry and compression preferences, including validation of combined retry bounds. */
@Injectable({ providedIn: "root" })
export class ConnectionPreferencesService {
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

    /** Validate the complete preference edit before publishing any persisted values. */
    setConnectionRetryPolicy(policy: ConnectionRetryPolicy): void {
        const parsed = connectionRetryPolicySchema.parse(policy);
        this.persistence.transaction(() => {
            this.connectionRetryEnabledState.next(parsed.enabled);
            this.connectionRetryInitialDelayMsState.next(parsed.initialDelayMs);
            this.connectionRetryBackoffMultiplierState.next(parsed.backoffMultiplier);
            this.connectionRetryMaxDelayMsState.next(parsed.maxDelayMs);
        });
    }

    get tilePullCompressionEnabled() { return this.tilePullCompressionEnabledState.getValue(); }

    set tilePullCompressionEnabled(val: boolean) { this.tilePullCompressionEnabledState.next(val); }

    registerActions(actions: AppActionService): void {
        actions.registerControl(connectionControls.compression, {
            read: () => ({ tilePullCompression: this.tilePullCompressionEnabled }),
            write: (_selector, value) => { this.tilePullCompressionEnabled = value.tilePullCompression; }
        });
    }

}
