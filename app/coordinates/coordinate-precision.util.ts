/**
 * The decimal precision used when committing geographic coordinates to state.
 * Coordinate settings and map cameras share this rounding policy so saved
 * values and URLs do not change from insignificant floating-point differences.
 */
export const COORDINATE_STATE_DECIMAL_PLACES = 8;

export const COORDINATE_STATE_PRECISION = 10 ** COORDINATE_STATE_DECIMAL_PLACES;

/** Rounds persisted coordinates so URLs remain stable and reasonably short. */
export function roundCoordinateStateValue(value: number): number {
    if (!Number.isFinite(value)) {
        return value;
    }
    return Math.round(value * COORDINATE_STATE_PRECISION) / COORDINATE_STATE_PRECISION;
}
