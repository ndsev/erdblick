import {patchAppState, withPersistedState} from "../shared/persisted-state";
import {computed} from "@angular/core";
import {signalStoreFeature, withComputed, withMethods} from "@ngrx/signals";
import {AppStateOptions, Boolish} from "../shared/state-value";
import {
    DEFAULT_CONNECTION_RETRY_POLICY,
    ConnectionRetryPolicy,
    connectionRetryPolicySchema,
    retryDelaySchema,
    retryMultiplierSchema
} from "../shared/connection-retry-policy";

export interface ConnectionValues {
    tilePullCompressionEnabled: boolean;
    connectionRetryEnabled: boolean;
    connectionRetryInitialDelayMs: number;
    connectionRetryBackoffMultiplier: number;
    connectionRetryMaxDelayMs: number;
}

/** These five deployed keys keep compression and retry preferences across browser sessions. */
export const ownerState = {
    tilePullCompressionEnabled: {
        name: "tilePullCompressionEnabled",
        defaultValue: false,
        schema: Boolish
    } satisfies AppStateOptions<ConnectionValues["tilePullCompressionEnabled"]>,

    connectionRetryEnabled: {
        name: "connectionRetryEnabled",
        defaultValue: DEFAULT_CONNECTION_RETRY_POLICY.enabled,
        schema: Boolish
    } satisfies AppStateOptions<ConnectionValues["connectionRetryEnabled"]>,

    connectionRetryInitialDelayMs: {
        name: "connectionRetryInitialDelayMs",
        defaultValue: DEFAULT_CONNECTION_RETRY_POLICY.initialDelayMs,
        schema: retryDelaySchema
    } satisfies AppStateOptions<ConnectionValues["connectionRetryInitialDelayMs"]>,

    connectionRetryBackoffMultiplier: {
        name: "connectionRetryBackoffMultiplier",
        defaultValue: DEFAULT_CONNECTION_RETRY_POLICY.backoffMultiplier,
        schema: retryMultiplierSchema
    } satisfies AppStateOptions<ConnectionValues["connectionRetryBackoffMultiplier"]>,

    connectionRetryMaxDelayMs: {
        name: "connectionRetryMaxDelayMs",
        defaultValue: DEFAULT_CONNECTION_RETRY_POLICY.maxDelayMs,
        schema: retryDelaySchema
    } satisfies AppStateOptions<ConnectionValues["connectionRetryMaxDelayMs"]>
};

/**
 * Preferences read these signals directly. MapTileStreamService observes the
 * derived retry policy to reschedule pending connection attempts, while keeping
 * socket creation, request ownership and expiry timers in the transport engine.
 */
export function withMapTileStream() {
    return signalStoreFeature(
        withPersistedState<"connection", ConnectionValues>("connection", ownerState),
        withComputed(store => ({
            connectionRetryPolicy: computed<ConnectionRetryPolicy>(() => {
                const policy = {
                    enabled: store.connection.connectionRetryEnabled(),
                    initialDelayMs: store.connection.connectionRetryInitialDelayMs(),
                    backoffMultiplier: store.connection.connectionRetryBackoffMultiplier(),
                    maxDelayMs: store.connection.connectionRetryMaxDelayMs()
                };
                const parsed = connectionRetryPolicySchema.safeParse(policy);
                // Imported timing slots may disagree. Keep an explicit opt-out
                // while the stream uses safe default timing for this snapshot.
                return parsed.success ? parsed.data : {...DEFAULT_CONNECTION_RETRY_POLICY, enabled: policy.enabled};
            })
        })),
        withMethods(store => ({
            /** Validate the complete form before the transport sees any of its new timing values. */
            setConnectionRetryPolicy(value: ConnectionRetryPolicy): void {
                const policy = connectionRetryPolicySchema.parse(value);
                patchAppState(store, {
                    connection: {
                        ...store.connection(),
                        connectionRetryEnabled: policy.enabled,
                        connectionRetryInitialDelayMs: policy.initialDelayMs,
                        connectionRetryBackoffMultiplier: policy.backoffMultiplier,
                        connectionRetryMaxDelayMs: policy.maxDelayMs
                    }
                });
            },
            setTilePullCompressionEnabled(value: boolean): void {
                patchAppState(store, {
                    connection: {...store.connection(), tilePullCompressionEnabled: value}
                });
            },
            setConnectionRetryEnabled(value: boolean): void {
                patchAppState(store, {
                    connection: {...store.connection(), connectionRetryEnabled: value}
                });
            },
            setConnectionRetryInitialDelayMs(value: number): void {
                const connectionRetryInitialDelayMs = retryDelaySchema.parse(value);
                patchAppState(store, {
                    connection: {...store.connection(), connectionRetryInitialDelayMs}
                });
            },
            setConnectionRetryBackoffMultiplier(value: number): void {
                const connectionRetryBackoffMultiplier = retryMultiplierSchema.parse(value);
                patchAppState(store, {
                    connection: {...store.connection(), connectionRetryBackoffMultiplier}
                });
            },
            setConnectionRetryMaxDelayMs(value: number): void {
                const connectionRetryMaxDelayMs = retryDelaySchema.parse(value);
                patchAppState(store, {
                    connection: {...store.connection(), connectionRetryMaxDelayMs}
                });
            }
        }))
    );
}
