import { Injectable } from "@angular/core";
import { z } from "zod";
import { ActionRegistry } from "../actions/action-registry.service";
import { AppActionContributor } from "../actions/app-action-contributor";
import { ConnectionRetryPolicy, connectionRetryPolicySchema } from "../shared/connection-retry-policy";
import { AppStateService } from "../state/app-state.service";
import { ConnectionPreferencesStore } from "./connection-preferences.store";

/**
 * Validates combined retry bounds and contributes transport preference controls.
 * Tile streams observe ConnectionPreferencesStore directly, without constructing
 * this controller or depending on the action registry.
 */
@Injectable({ providedIn: "root" })
export class ConnectionPreferencesService implements AppActionContributor {
    constructor(private readonly persistence: AppStateService,
        public readonly store: ConnectionPreferencesStore) { }

    /** Validate the complete preference edit before publishing any persisted values. */
    setConnectionRetryPolicy(policy: ConnectionRetryPolicy): void {
        const parsed = connectionRetryPolicySchema.parse(policy);
        this.persistence.transaction(() => {
            this.store.connectionRetryEnabledState.next(parsed.enabled);
            this.store.connectionRetryInitialDelayMsState.next(parsed.initialDelayMs);
            this.store.connectionRetryBackoffMultiplierState.next(parsed.backoffMultiplier);
            this.store.connectionRetryMaxDelayMsState.next(parsed.maxDelayMs);
        });
    }

    /** Registers typed state readers and writers without exposing persistence keys. */
    registerControls(actions: ActionRegistry): void {
        actions.registerControl(connectionControls.compression, {
            read: () => ({ tilePullCompression: this.store.tilePullCompressionEnabled }),
            write: (_selector, value) => { this.store.tilePullCompressionEnabled = value.tilePullCompression; }
        });
    }


}


/**
 * Public actions and controls implemented by this controller. Their schemas stay
 * beside the handlers; both app startup and the Node catalog build register them.
 */
export const connectionControls = {
    compression: {
        name: "app.preferences.connection",
        description: "Browser tile-stream transport compression preference.",
        selectorSchema: z.strictObject({}),
        valueSchema: z.strictObject({ tilePullCompression: z.boolean() }),
        readable: true,
        writable: true,
        persistence: "local-storage",
        synchronization: "none"
    }
} as const;
