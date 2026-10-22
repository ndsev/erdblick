import {patchAppState, withPersistedState} from "./persisted-state";
import {signalStoreFeature, withMethods} from "@ngrx/signals";
import {z} from "zod";
import type {Versions} from "./app-config.service";
import {AppStateOptions} from "./state-value";

export interface AppConfigValues {
    distributionVersions: Versions[];
    erdblickVersion: string;
}

/** Cached version fields retain their storage names and empty startup defaults. */
export const ownerState = {
    distributionVersions: {
        name: "distributionVersions",
        defaultValue: [],
        schema: z.array(z.record(z.string(), z.string()))
    } satisfies AppStateOptions<AppConfigValues["distributionVersions"]>,

    erdblickVersion: {
        name: "erdblickVersion",
        defaultValue: "",
        schema: z.string()
    } satisfies AppStateOptions<AppConfigValues["erdblickVersion"]>
};

/**
 * The About dialog and diagnostic exports read these version signals.
 * Startup supplies the discovered versions after loading the application;
 * constructing this feature does not fetch configuration or contact a server.
 */
export function withAppConfig() {
    return signalStoreFeature(
        withPersistedState<"config", AppConfigValues>("config", ownerState),
        withMethods(store => ({
            setDistributionVersions(value: Versions[]): void {
                const distributionVersions = value.map(version => ({...version}));
                patchAppState(store, {
                    config: {...store.config(), distributionVersions}
                });
            },
            setErdblickVersion(value: string): void {
                patchAppState(store, {
                    config: {...store.config(), erdblickVersion: value}
                });
            }
        }))
    );
}
