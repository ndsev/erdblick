import {patchAppState, withPersistedState} from "../shared/persisted-state";
import {signalStoreFeature, withMethods} from "@ngrx/signals";
import {z} from "zod";
import {AppStateOptions} from "../shared/state-value";

export interface StyleEditorValues {
    styleEditorTarget: string | null;
}

/** The editor target keeps its deployed key so reopening the viewer restores the selected style. */
export const ownerState = {
    styleEditorTarget: {
        name: "styleEditorTarget",
        defaultValue: null,
        schema: z.string().nullable()
    } satisfies AppStateOptions<StyleEditorValues["styleEditorTarget"]>
};

/**
 * The style editor reads styleEditorTarget() for the selected style id.
 * Opening or focusing the live editor remains a UI request owned by
 * StyleEditorRequestService; this feature only remembers the selected target.
 */
export function withStyleEditorRequest() {
    return signalStoreFeature(
        withPersistedState<"styleEditor", StyleEditorValues>("styleEditor", ownerState),
        withMethods(store => ({
            setStyleEditorTarget(value: string | null): void {
                patchAppState(store, {
                    styleEditor: {...store.styleEditor(), styleEditorTarget: value}
                });
            }
        }))
    );
}
