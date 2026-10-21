import {signalStoreFeature, withState} from "@ngrx/signals";
import {z} from "zod";
import type {Versions} from "./app-config.service";
import {AppStateOptions, deepCopy} from "./state-value";

export interface AppConfigServiceValues {
    distributionVersions: Versions[];
    erdblickVersion: string;
}

/** Named codec declarations are also the single source of SignalStore defaults. */
export const ownerState = {
    distributionVersions: {
        name: "distributionVersions",
        defaultValue: [],
        schema: z.array(z.record(z.string(), z.string()))
    } satisfies AppStateOptions<AppConfigServiceValues["distributionVersions"]>,

    erdblickVersion: {
        name: "erdblickVersion",
        defaultValue: "",
        schema: z.string()
    } satisfies AppStateOptions<AppConfigServiceValues["erdblickVersion"]>
};

/** The application composes this feature; its owner binds codecs to these same declarations. */
export function withAppConfig() {
    return signalStoreFeature(
        withState(() => {
            const initial: AppConfigServiceValues = {
                distributionVersions: deepCopy(ownerState.distributionVersions.defaultValue),
                erdblickVersion: deepCopy(ownerState.erdblickVersion.defaultValue)
            };
            return {config: initial};
        })
    );
}
