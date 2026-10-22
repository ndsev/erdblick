import {patchAppState, withPersistedState} from "../shared/persisted-state";
import {signalStoreFeature, withMethods} from "@ngrx/signals";
import {z} from "zod";
import {AppStateOptions} from "../shared/state-value";

export interface CoordinatesValues {
    enabledCoordsTileIds: string[];
}

/** Coordinate format choices keep the storage key used by existing browser profiles. */
export const ownerState = {
    enabledCoordsTileIds: {
        name: "enabledCoordsTileIds",
        defaultValue: ["WGS84"],
        schema: z.array(z.string())
    } satisfies AppStateOptions<CoordinatesValues["enabledCoordsTileIds"]>
};

/**
 * The coordinate panel reads enabledCoordsTileIds() to decide which readouts to
 * show. This signal holds the selected format ids; CoordinatesService continues
 * to calculate the displayed coordinates and load optional coordinate plugins.
 */
export function withCoordinates() {
    return signalStoreFeature(
        withPersistedState<"coordinates", CoordinatesValues>("coordinates", ownerState),
        withMethods(store => ({
            /** Publish one complete selection after a format checkbox changes. */
            setEnabledCoordsTileIds(value: string[]): void {
                patchAppState(store, {
                    coordinates: {...store.coordinates(), enabledCoordsTileIds: [...value]}
                });
            }
        }))
    );
}
