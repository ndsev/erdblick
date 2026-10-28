/**
 * Delivery errors with expiry information used by retained inspection values.
 * The error carries data only; request scheduling and retry decisions remain
 * with the transport and inspection owners.
 */
/** A failed tile value retains its ordinary absolute expiry for inspection owners. */
export class TileDeliveryError extends Error {
    constructor(message: string, readonly expiresAtMs: number | null) {
        super(message);
    }
}
