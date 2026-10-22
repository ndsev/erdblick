import { Injectable } from "@angular/core";
import { z } from "zod";
import { ActionRegistry } from "../actions/action-registry.service";
import { AppActionContributor } from "../actions/app-action-contributor";
import { ConnectionRetryPolicy, connectionRetryPolicySchema } from "./connection-retry-policy";
import { AppStateService } from "../state/app-state.service";
import { ConnectionModel } from "./connection.model";

/**
 * Validates combined retry bounds and contributes transport preference controls.
 * Tile streams observe ConnectionModel directly, without constructing
 * this controller or depending on the action registry.
 */
@Injectable({ providedIn: "root" })
export class ConnectionPreferencesService implements AppActionContributor {
    constructor(private readonly persistence: AppStateService,
        public readonly model: ConnectionModel) { }

    /** Validate the complete preference edit before publishing any persisted values. */
    setConnectionRetryPolicy(policy: ConnectionRetryPolicy): void {
        const parsed = connectionRetryPolicySchema.parse(policy);
        this.persistence.transaction(() => {
            this.model.connectionRetryEnabledState.next(parsed.enabled);
            this.model.connectionRetryInitialDelayMsState.next(parsed.initialDelayMs);
            this.model.connectionRetryBackoffMultiplierState.next(parsed.backoffMultiplier);
            this.model.connectionRetryMaxDelayMsState.next(parsed.maxDelayMs);
        });
    }

    /** Registers typed state readers and writers without exposing persistence keys. */
    registerControls(actions: ActionRegistry): void {
        actions.registerControl(
            {
                name: "app.preferences.connection",
                description: "Browser tile-stream transport compression preference.",
                selectorSchema: z.strictObject({}),
                valueSchema: z.strictObject({ tilePullCompression: z.boolean() }),
                readable: true,
                writable: true,
                persistence: "local-storage",
                synchronization: "none"
            },
            {
                read: () => ({ tilePullCompression: this.model.tilePullCompressionEnabled }),
                write: (_selector, value) => {
                    this.model.tilePullCompressionEnabled = value.tilePullCompression;
                }
            }
        );
    }


}
