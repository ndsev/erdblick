/** A failed tile with an explicit producer retry hint; HTTP-looking codes alone are insufficient. */
export class TileDeliveryError extends Error {
    readonly retryAfterMs: number | null;

    constructor(message: string, retryAfterMs?: number, readonly serviceError = false,
                readonly mapId?: string) {
        super(message);
        this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs! > 0
            ? retryAfterMs! : null;
    }
}
