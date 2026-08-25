import {describe, expect, it} from "vitest";
import type {MapTileStreamStatusPayload} from "../mapdata/tilestream";
import {waitForSourceDataRequest} from "./source-data-request";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(next => {
        resolve = next;
    });
    return {promise, resolve};
}

function status(statusCode = 1): MapTileStreamStatusPayload {
    return {
        type: "mapget.tiles.status",
        allDone: true,
        requests: [{
            index: 0,
            mapId: "Map",
            layerId: "SourceData",
            status: statusCode,
            statusText: statusCode === 1 ? "Success" : "Aborted"
        }]
    };
}

describe("waitForSourceDataRequest", () => {
    it("waits for pulled bytes when terminal status arrives first", async () => {
        const completion = deferred<MapTileStreamStatusPayload>();
        const payload = deferred<void>();
        let settled = false;
        const result = waitForSourceDataRequest(
            completion.promise,
            payload.promise
        ).then(value => {
            settled = true;
            return value;
        });

        completion.resolve(status());
        await Promise.resolve();
        expect(settled).toBe(false);

        payload.resolve();
        await expect(result).resolves.toMatchObject({allDone: true});
    });

    it("waits for terminal status when pulled bytes arrive first", async () => {
        const completion = deferred<MapTileStreamStatusPayload>();
        const payload = deferred<void>();
        let settled = false;
        const result = waitForSourceDataRequest(
            completion.promise,
            payload.promise
        ).then(value => {
            settled = true;
            return value;
        });

        payload.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);

        completion.resolve(status());
        await expect(result).resolves.toMatchObject({allDone: true});
    });

    it("rejects failed requests without waiting for a missing payload", async () => {
        const payload = deferred<void>();

        await expect(waitForSourceDataRequest(
            Promise.resolve(status(4)),
            payload.promise
        )).rejects.toThrow(
            "Tile request failed: Map/SourceData: Aborted"
        );
    });

    it("rejects terminal control errors which contain no request rows", async () => {
        const payload = deferred<void>();

        await expect(waitForSourceDataRequest(
            Promise.resolve({
                type: "mapget.tiles.status",
                allDone: true,
                requests: [],
                message: "Invalid request."
            }),
            payload.promise
        )).rejects.toThrow("Invalid request.");
    });
});
