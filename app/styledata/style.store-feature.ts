import {patchAppState, withPersistedState} from "../shared/persisted-state";
import {signalStoreFeature, withMethods} from "@ngrx/signals";
import {z} from "zod";
import {AppStateOptions} from "../shared/state-value";

export interface StyleValues {
    styleVisibility: Record<string, boolean>;
}

/** The misspelled storage key is deployed and remains unchanged for existing browser profiles. */
export const ownerState = {
    styleVisibility: {
        name: "styleVisiblity",
        schema: z.record(z.string(), z.coerce.boolean()),
        defaultValue: {}
    } satisfies AppStateOptions<StyleValues["styleVisibility"]>
};

/**
 * styleVisibility() supplies the saved checkbox choices in the style tree.
 * StyleService owns parsed YAML and live style resources; it consults this map
 * when a style loads and records visibility edits through the methods below.
 */
export function withStyle() {
    return signalStoreFeature(
        withPersistedState<"styles", StyleValues>("styles", ownerState),
        withMethods(store => ({
            setStyleVisibility(value: Record<string, boolean>): void {
                patchAppState(store, {
                    styles: {...store.styles(), styleVisibility: {...value}}
                });
            },
            /** Styles without a saved choice use the default declared by their YAML. */
            isStyleVisible(styleId: string, fallback = true): boolean {
                const visibility = store.styles.styleVisibility();
                return Object.prototype.hasOwnProperty.call(visibility, styleId) ? visibility[styleId] : fallback;
            },
            setStyleVisible(styleId: string, visible: boolean): void {
                patchAppState(store, {
                    styles: {
                        ...store.styles(),
                        styleVisibility: {...store.styles.styleVisibility(), [styleId]: visible}
                    }
                });
            },
            /** Forget the choice when a locally imported style is removed. */
            removeStyleVisibility(styleId: string): void {
                const visibility = store.styles.styleVisibility();
                if (!Object.prototype.hasOwnProperty.call(visibility, styleId)) return;
                const next = {...visibility};
                delete next[styleId];
                patchAppState(store, {
                    styles: {...store.styles(), styleVisibility: next}
                });
            },
            /** A complete catalog refresh retires obsolete entries as a system edit. */
            pruneStyleVisibility(presentStyleIds: readonly string[]): void {
                const present = new Set(presentStyleIds);
                const visibility = store.styles.styleVisibility();
                const next = Object.fromEntries(Object.entries(visibility).filter(([id]) => present.has(id)));
                if (Object.keys(next).length === Object.keys(visibility).length) return;
                patchAppState(store, {
                    styles: {...store.styles(), styleVisibility: next}
                }, "system");
            }
        }))
    );
}
