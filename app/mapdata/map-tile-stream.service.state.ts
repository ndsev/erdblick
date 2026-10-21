import {signalStoreFeature, withState} from "@ngrx/signals";
import {Boolish} from "../shared/app-state";
import {
    DEFAULT_CONNECTION_RETRY_POLICY,
    retryDelaySchema,
    retryMultiplierSchema
} from "../shared/connection-retry-policy";
import {AppStateOptions, deepCopy} from "../shared/state-value";

export interface MapTileStreamServiceValues {
    tilePullCompressionEnabled: boolean;
    connectionRetryEnabled: boolean;
    connectionRetryInitialDelayMs: number;
    connectionRetryBackoffMultiplier: number;
    connectionRetryMaxDelayMs: number;
}

/** Named codec declarations are also the single source of SignalStore defaults. */
export const ownerState = {
    tilePullCompressionEnabled: {
        name: "tilePullCompressionEnabled",
        defaultValue: false,
        schema: Boolish
    } satisfies AppStateOptions<MapTileStreamServiceValues["tilePullCompressionEnabled"]>,

    connectionRetryEnabled: {
        name: "connectionRetryEnabled",
        defaultValue: DEFAULT_CONNECTION_RETRY_POLICY.enabled,
        schema: Boolish
    } satisfies AppStateOptions<MapTileStreamServiceValues["connectionRetryEnabled"]>,

    connectionRetryInitialDelayMs: {
        name: "connectionRetryInitialDelayMs",
        defaultValue: DEFAULT_CONNECTION_RETRY_POLICY.initialDelayMs,
        schema: retryDelaySchema
    } satisfies AppStateOptions<MapTileStreamServiceValues["connectionRetryInitialDelayMs"]>,

    connectionRetryBackoffMultiplier: {
        name: "connectionRetryBackoffMultiplier",
        defaultValue: DEFAULT_CONNECTION_RETRY_POLICY.backoffMultiplier,
        schema: retryMultiplierSchema
    } satisfies AppStateOptions<MapTileStreamServiceValues["connectionRetryBackoffMultiplier"]>,

    connectionRetryMaxDelayMs: {
        name: "connectionRetryMaxDelayMs",
        defaultValue: DEFAULT_CONNECTION_RETRY_POLICY.maxDelayMs,
        schema: retryDelaySchema
    } satisfies AppStateOptions<MapTileStreamServiceValues["connectionRetryMaxDelayMs"]>
};

/** The application composes this feature; its owner binds codecs to these same declarations. */
export function withMapTileStream() {
    return signalStoreFeature(
        withState(() => {
            const initial: MapTileStreamServiceValues = {
                tilePullCompressionEnabled: deepCopy(ownerState.tilePullCompressionEnabled.defaultValue),
                connectionRetryEnabled: deepCopy(ownerState.connectionRetryEnabled.defaultValue),
                connectionRetryInitialDelayMs: deepCopy(ownerState.connectionRetryInitialDelayMs.defaultValue),
                connectionRetryBackoffMultiplier: deepCopy(ownerState.connectionRetryBackoffMultiplier.defaultValue),
                connectionRetryMaxDelayMs: deepCopy(ownerState.connectionRetryMaxDelayMs.defaultValue)
            };
            return {connection: initial};
        })
    );
}
