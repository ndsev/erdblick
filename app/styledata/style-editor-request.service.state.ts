import {signalStoreFeature, withState} from "@ngrx/signals";
import {z} from "zod";
import {AppStateOptions, deepCopy} from "../shared/state-value";

export interface StyleEditorRequestServiceValues {
    styleEditorTarget: string | null;
}

/** Named codec declarations are also the single source of SignalStore defaults. */
export const ownerState = {
    styleEditorTarget: {
        name: "styleEditorTarget",
        defaultValue: null,
        schema: z.string().nullable()
    } satisfies AppStateOptions<StyleEditorRequestServiceValues["styleEditorTarget"]>
};

/** The application composes this feature; its owner binds codecs to these same declarations. */
export function withStyleEditorRequest() {
    return signalStoreFeature(
        withState(() => {
            const initial: StyleEditorRequestServiceValues = {
                styleEditorTarget: deepCopy(ownerState.styleEditorTarget.defaultValue)
            };
            return {styleEditor: initial};
        })
    );
}
