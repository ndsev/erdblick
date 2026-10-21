import {signalStoreFeature, withState} from "@ngrx/signals";
import {z} from "zod";
import {AppStateOptions, deepCopy} from "../shared/state-value";

export interface StyleServiceValues {
    styleVisibility: Record<string, boolean>;
}

/** Named codec declarations are also the single source of SignalStore defaults. */
export const ownerState = {
    styleVisibility: {
        name: "styleVisiblity",
        schema: z.record(z.string(), z.coerce.boolean()),
        defaultValue: {}
    } satisfies AppStateOptions<StyleServiceValues["styleVisibility"]>
};

/** The application composes this feature; its owner binds codecs to these same declarations. */
export function withStyle() {
    return signalStoreFeature(
        withState(() => {
            const initial: StyleServiceValues = {
                styleVisibility: deepCopy(ownerState.styleVisibility.defaultValue)
            };
            return {styles: initial};
        })
    );
}
