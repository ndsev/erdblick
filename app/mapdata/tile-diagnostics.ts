/** A failed tile value retains its ordinary absolute expiry for inspection owners. */
export class TileDeliveryError extends Error {
    constructor(message: string, readonly expiresAtMs: number | null) {
        super(message);
    }
}
