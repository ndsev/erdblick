import {
    MapTileRequestStatus,
    type MapTileStreamStatusPayload
} from "../mapdata/tilestream";

/**
 * Waits for both halves of a one-shot SourceData stream request.
 *
 * Terminal status is sent over the WebSocket while tile bytes use a parallel
 * pull channel, so neither event is ordered relative to the other in the
 * browser. A failed status rejects immediately and does not wait for bytes
 * which the server will never produce.
 */
export async function waitForSourceDataRequest(
    completion: Promise<MapTileStreamStatusPayload>,
    sourceDataReceived: Promise<void>
): Promise<MapTileStreamStatusPayload> {
    const successfulCompletion = completion.then(status => {
        const requests = status.requests || [];
        if (!requests.length) {
            throw new Error(status.message ||
                "Tile request completed without a request status.");
        }
        const failures = requests.filter(
            request => request.status !== MapTileRequestStatus.Success
        );
        if (failures.length) {
            const summary = failures
                .map(request =>
                    `${request.mapId}/${request.layerId}: ${request.statusText}`)
                .join(", ");
            throw new Error(`Tile request failed: ${summary}`);
        }
        return status;
    });
    const [status] = await Promise.all([
        successfulCompletion,
        sourceDataReceived
    ]);
    return status;
}
