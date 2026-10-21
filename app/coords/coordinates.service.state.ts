import {signalStoreFeature, withState} from "@ngrx/signals";
import {z} from "zod";
import {AppStateOptions, deepCopy} from "../shared/state-value";

export interface CoordinatesServiceValues {
    enabledCoordsTileIds: string[];
}

/** Named codec declarations are also the single source of SignalStore defaults. */
export const ownerState = {
    enabledCoordsTileIds: {
        name: "enabledCoordsTileIds",
        defaultValue: ["WGS84"],
        schema: z.array(z.string())
    } satisfies AppStateOptions<CoordinatesServiceValues["enabledCoordsTileIds"]>
};

/** The application composes this feature; its owner binds codecs to these same declarations. */
export function withCoordinates() {
    return signalStoreFeature(
        withState(() => {
            const initial: CoordinatesServiceValues = {
                enabledCoordsTileIds: deepCopy(ownerState.enabledCoordsTileIds.defaultValue)
            };
            return {coordinates: initial};
        })
    );
}
