import {describe, expect, it, vi} from 'vitest';
import {coreLib} from '../integrations/wasm';
import {
    MAP_TILE_STREAM_HEADER_SIZE,
    MAP_TILE_STREAM_TYPE_FIELDS,
    MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT,
    MAP_TILE_STREAM_TYPE_SOURCE_CATALOG_CHANGE,
    MAP_TILE_STREAM_TYPE_STATUS,
    MAP_TILE_STREAM_TYPE_SUBSETS,
    MapTileStreamClient
} from './tilestream';

function currentProtocolVersion() {
    return {
        major: coreLib.tileLayerStreamProtocolMajor(),
        minor: coreLib.tileLayerStreamProtocolMinor(),
        patch: 0
    };
}

function jsonFrame(type: number, payload: object, version = {
    ...currentProtocolVersion()
}): Uint8Array {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const frame = new Uint8Array(MAP_TILE_STREAM_HEADER_SIZE + payloadBytes.length);
    const header = new DataView(frame.buffer, 0, MAP_TILE_STREAM_HEADER_SIZE);
    header.setUint16(0, version.major, true);
    header.setUint16(2, version.minor, true);
    header.setUint16(4, version.patch, true);
    frame[6] = type;
    new DataView(frame.buffer, 7, 4).setUint32(0, payloadBytes.length, true);
    frame.set(payloadBytes, MAP_TILE_STREAM_HEADER_SIZE);
    return frame;
}

function packedFrames(...frames: Uint8Array[]): ArrayBuffer {
    const result = new Uint8Array(
        frames.reduce((size, frame) => size + frame.byteLength, 0)
    );
    let offset = 0;
    for (const frame of frames) {
        result.set(frame, offset);
        offset += frame.byteLength;
    }
    return result.buffer;
}

describe('MapTileStreamClient', () => {
    it('chunks one very large filter group at tile boundaries with aligned epochs', () => {
        const client = new MapTileStreamClient('/interactive');
        const tileStream = client as any;
        try {
            const tileIds = Array.from({length: 100_000}, (_, index) => index + 1);
            const request = {
                mapId: "Map",
                layerId: "Layer",
                filterId: "large",
                generation: 1,
                deliveryEpoch: 1,
                channels: [{channelId: "all", scope: "feature"}],
                tileIds,
                priorityTileIds: tileIds.slice(0, 200),
                deliveryEpochs: tileIds.map(tileId => ({tileId, epoch: 2}))
            };

            const payloads = tileStream.buildRequestPayloads([request], {}, 17);
            const decoded = payloads.map((payload: string) => JSON.parse(payload));
            const pieces = decoded.flatMap((payload: any) => payload.requests);

            expect(payloads.length).toBeGreaterThan(1);
            expect(payloads.every((payload: string) =>
                new TextEncoder().encode(payload).byteLength <= 9 * 1024 * 1024
            )).toBe(true);
            expect(decoded.map((payload: any) => payload.chunk.index)).toEqual(
                decoded.map((_: any, index: number) => index)
            );
            expect(decoded.at(-1).chunk.isLast).toBe(true);
            expect(pieces.flatMap((piece: any) => piece.tileIds)).toEqual(tileIds);
            for (const piece of pieces) {
                const membership = new Set(piece.tileIds);
                expect(piece.deliveryEpochs.every((item: any) =>
                    membership.has(item.tileId)
                )).toBe(true);
                expect(piece.priorityTileIds.every((tileId: number) =>
                    membership.has(tileId)
                )).toBe(true);
            }
        } finally {
            client.destroy();
        }
    });

    it('bounds sparse renewal envelopes without losing tile ids', () => {
        const client = new MapTileStreamClient('/interactive');
        const tileStream = client as any;
        try {
            const tileIds = Array.from({length: 250_000}, (_, index) => index + 1);
            const renewal = {
                mapId: "Map",
                layerId: "Layer",
                filterId: "large",
                generation: 1,
                deliveryEpoch: 2,
                channels: [{
                    channelId: "all",
                    scope: "feature",
                    featureFilter: "x".repeat(4_096)
                }],
                tileIds
            };

            const payloads = tileStream.buildRenewalPayloads([renewal]);
            const renewed = payloads.flatMap((payload: string) =>
                JSON.parse(payload).renewals
            );

            expect(payloads.length).toBeGreaterThan(1);
            expect(payloads.every((payload: string) =>
                new TextEncoder().encode(payload).byteLength <= 9 * 1024 * 1024
            )).toBe(true);
            expect(payloads.every((payload: string) =>
                JSON.parse(payload).renewals.reduce(
                    (count: number, item: any) => count + item.tileIds.length,
                    0
                ) <= 2_048
            )).toBe(true);
            expect(renewed.every((item: any) =>
                item.tileIds.length <= 512
            )).toBe(true);
            expect(renewed.flatMap((item: any) => item.tileIds)).toEqual(tileIds);
        } finally {
            client.destroy();
        }
    });

    it('budgets packed payloads at ordered VTLV frame boundaries', async () => {
        const client = new MapTileStreamClient('/interactive');
        const tileStream = client as any;
        const observedTypes: number[] = [];
        vi.useFakeTimers();
        const now = vi.spyOn(performance, "now");
        try {
            client.onFrame = (_frame, type) => observedTypes.push(type);
            tileStream.enqueueFrame(packedFrames(
                jsonFrame(41, {ordinal: 1}),
                jsonFrame(42, {ordinal: 2}),
                jsonFrame(43, {ordinal: 3})
            ));
            while (tileStream.pendingFrameMessages > 0) {
                await Promise.resolve();
            }

            expect(client.getPendingFrameQueueSize()).toBe(3);
            expect(vi.getTimerCount()).toBe(1);

            now
                .mockReturnValueOnce(0)
                .mockReturnValueOnce(0)
                .mockReturnValueOnce(5);
            vi.runOnlyPendingTimers();
            expect(observedTypes).toEqual([41]);
            expect(client.getPendingFrameQueueSize()).toBe(2);

            now.mockReturnValue(0);
            vi.runOnlyPendingTimers();
            expect(observedTypes).toEqual([41, 42, 43]);
            expect(client.getPendingFrameQueueSize()).toBe(0);
        } finally {
            client.destroy();
            now.mockRestore();
            vi.useRealTimers();
        }
    });

    it('grows the /interactive/payload batch budget without shrinking it on slow samples', () => {
        const client = new MapTileStreamClient('/interactive');
        const tileStream = client as any;
        try {
            expect(tileStream.currentPullMaxBytes()).toBe(512 * 1024);

            tileStream.recordDownstreamSample(1024, 1000);
            expect(tileStream.currentPullMaxBytes()).toBe(512 * 1024);

            tileStream.recordDownstreamSample(100 * 1024 * 1024, 1000);
            const grownBudget = tileStream.currentPullMaxBytes();
            expect(grownBudget).toBeGreaterThan(512 * 1024);

            tileStream.recordDownstreamSample(1024, 1000);
            expect(tileStream.currentPullMaxBytes()).toBe(grownBudget);

            tileStream.recordDownstreamSample(512 * 1024 * 1024, 1000);
            expect(tileStream.currentPullMaxBytes()).toBe(64 * 1024 * 1024);
        } finally {
            client.destroy();
        }
    });

    it('uses /interactive/payload for pull batches', () => {
        const client = new MapTileStreamClient('/interactive');
        const tileStream = client as any;
        try {
            const url = new URL(tileStream.resolvePullUrl(7));
            expect(url.pathname).toBe('/interactive/payload');
            expect(url.searchParams.get('clientId')).toBe('7');
        } finally {
            client.destroy();
        }
    });

    it('falls back from /interactive to /tiles when the websocket fails before opening', async () => {
        const originalWebSocket = globalThis.WebSocket;
        const openedUrls: string[] = [];

        class MockWebSocket {
            static readonly CONNECTING = 0;
            static readonly OPEN = 1;
            static readonly CLOSING = 2;
            static readonly CLOSED = 3;
            readyState = MockWebSocket.CONNECTING;
            binaryType = "";
            onopen: ((event: Event) => void) | null = null;
            onerror: ((event: Event) => void) | null = null;
            onclose: ((event: CloseEvent) => void) | null = null;
            onmessage: ((event: MessageEvent) => void) | null = null;
            send = vi.fn();

            constructor(url: string) {
                openedUrls.push(url);
                queueMicrotask(() => {
                    if (new URL(url).pathname === "/interactive") {
                        this.onerror?.(new Event("error"));
                        return;
                    }
                    this.readyState = MockWebSocket.OPEN;
                    this.onopen?.(new Event("open"));
                });
            }

            close() {
                this.readyState = MockWebSocket.CLOSED;
            }
        }

        globalThis.WebSocket = MockWebSocket as any;
        const client = new MapTileStreamClient('/interactive');
        try {
            await client.connect();

            expect(openedUrls.map(url => new URL(url).pathname)).toEqual([
                "/interactive",
                "/tiles"
            ]);
            expect(client.isOpen()).toBe(true);
            expect(client.getDebugState()).toMatchObject({
                activeWebSocketPath: "/tiles",
                activePullPath: "/tiles/next",
                usingLegacyWebSocketFallback: true,
                usingLegacyPullFallback: true
            });
        } finally {
            client.destroy();
            globalThis.WebSocket = originalWebSocket;
        }
    });

    it('falls back from /interactive/payload to /tiles/next when the payload route is missing', () => {
        const client = new MapTileStreamClient('/interactive');
        const tileStream = client as any;
        try {
            expect(new URL(tileStream.resolvePullUrl(7)).pathname).toBe('/interactive/payload');

            expect(tileStream.activateLegacyPullFallbackForStatus(404)).toBe(true);

            const url = new URL(tileStream.resolvePullUrl(7));
            expect(url.pathname).toBe('/tiles/next');
            expect(url.searchParams.get('clientId')).toBe('7');
            expect(client.getDebugState()).toMatchObject({
                activeWebSocketPath: "/interactive",
                activePullPath: "/tiles/next",
                usingLegacyWebSocketFallback: false,
                usingLegacyPullFallback: true
            });
        } finally {
            client.destroy();
        }
    });

    it('stores sourcesRevision from request-context frames', async () => {
        const client = new MapTileStreamClient('/interactive');
        const tileStream = client as any;
        const observedRevisions: number[] = [];
        try {
            client.withSourcesRevisionChangedCallback(revision => {
                observedRevisions.push(revision);
            });

            await tileStream.handleFrame(jsonFrame(MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT, {
                type: 'mapget.tiles.request-context',
                requestId: 3,
                sourcesRevision: 43
            }), MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT);

            expect(client.getSourcesRevision()).toBe(43);
            expect(observedRevisions).toEqual([43]);

            await tileStream.handleFrame(jsonFrame(MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT, {
                type: 'mapget.tiles.request-context',
                requestId: 4,
                sourcesRevision: 43
            }), MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT);

            expect(observedRevisions).toEqual([43]);
        } finally {
            client.destroy();
        }
    });

    it('reports a repeated revision after reconnecting to a restarted backend', async () => {
        const client = new MapTileStreamClient('/interactive');
        const tileStream = client as any;
        const observedRevisions: Array<{revision: number; reconnected: boolean}> = [];
        try {
            client.withSourcesRevisionChangedCallback((revision, reconnected) => {
                observedRevisions.push({revision, reconnected});
            });

            tileStream.prepareForOpenedSocket();
            await tileStream.handleFrame(jsonFrame(MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT, {
                type: 'mapget.tiles.request-context',
                requestId: 3,
                sourcesRevision: 49
            }), MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT);

            tileStream.prepareForOpenedSocket();
            expect(client.getSourcesRevision()).toBeNull();
            await tileStream.handleFrame(jsonFrame(MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT, {
                type: 'mapget.tiles.request-context',
                requestId: 4,
                sourcesRevision: 49
            }), MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT);

            expect(observedRevisions).toEqual([
                {revision: 49, reconnected: false},
                {revision: 49, reconnected: true}
            ]);
        } finally {
            client.destroy();
        }
    });

    it('rejects stale payload frames after datasource metadata changes', async () => {
        const client = new MapTileStreamClient('/interactive');
        const tileStream = client as any;
        try {
            tileStream.latestRequestedRequestId = 3;
            await tileStream.handleFrame(jsonFrame(MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT, {
                type: 'mapget.tiles.request-context',
                requestId: 3
            }), MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT);
            expect(tileStream.acceptsCurrentPayloadFrame()).toBe(true);

            tileStream.resetAfterDataSourceInfoChange();
            await tileStream.handleFrame(jsonFrame(MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT, {
                type: 'mapget.tiles.request-context',
                requestId: 3
            }), MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT);

            expect(tileStream.acceptsCurrentPayloadFrame()).toBe(false);
        } finally {
            client.destroy();
        }
    });

    it('accepts field dictionaries after request supersession', async () => {
        const parser = {
            readFieldDictUpdate: vi.fn(),
        };
        const client = new MapTileStreamClient('/interactive', parser as any);
        const tileStream = client as any;
        const fieldsCallback = vi.fn();
        try {
            client.withFieldsCallback(fieldsCallback);
            tileStream.latestRequestedRequestId = 5;
            await tileStream.handleFrame(jsonFrame(MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT, {
                type: 'mapget.tiles.request-context',
                requestId: 4
            }), MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT);

            expect(tileStream.acceptsCurrentPayloadFrame()).toBe(false);

            const frame = jsonFrame(MAP_TILE_STREAM_TYPE_FIELDS, {stringPoolId: "stale-but-required"});
            await tileStream.handleFrame(frame, MAP_TILE_STREAM_TYPE_FIELDS);

            expect(parser.readFieldDictUpdate).toHaveBeenCalledOnce();
            expect(fieldsCallback).toHaveBeenCalledWith(frame);
        } finally {
            client.destroy();
        }
    });

    it('accepts self-identifying subset frames across request-context supersession', async () => {
        const client = new MapTileStreamClient('/interactive');
        const tileStream = client as any;
        const subsetsCallback = vi.fn();
        try {
            client.withSubsetsCallback(subsetsCallback);
            tileStream.latestRequestedRequestId = 5;
            await tileStream.handleFrame(jsonFrame(MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT, {
                type: 'mapget.tiles.request-context',
                requestId: 4
            }), MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT);

            expect(tileStream.acceptsCurrentPayloadFrame()).toBe(false);

            const frame = jsonFrame(MAP_TILE_STREAM_TYPE_SUBSETS, {
                filterId: "styled:0/map/layer",
                generation: 1,
                tileId: 42
            });
            await tileStream.handleFrame(frame, MAP_TILE_STREAM_TYPE_SUBSETS);

            expect(subsetsCallback).toHaveBeenCalledOnce();
            expect(subsetsCallback).toHaveBeenCalledWith(
                frame.slice(MAP_TILE_STREAM_HEADER_SIZE)
            );
        } finally {
            client.destroy();
        }
    });

    it('rejects untagged statuses after observing protocol-3 request contexts', async () => {
        const client = new MapTileStreamClient('/interactive');
        const tileStream = client as any;
        const statusCallback = vi.fn();
        try {
            client.withStatusCallback(statusCallback);
            tileStream.latestRequestedRequestId = 3;
            await tileStream.handleFrame(jsonFrame(
                MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT,
                {
                    type: 'mapget.tiles.request-context',
                    requestId: 3
                }
            ), MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT);

            await tileStream.handleFrame(jsonFrame(
                MAP_TILE_STREAM_TYPE_STATUS,
                {
                    type: 'mapget.tiles.status',
                    allDone: true,
                    requests: [],
                    message: 'untagged control frame'
                }
            ), MAP_TILE_STREAM_TYPE_STATUS);

            expect(statusCallback).not.toHaveBeenCalled();
            expect(client.getDebugState().lastStatusPayload).toBeNull();
        } finally {
            client.destroy();
        }
    });

    it('dispatches source catalog change control frames', async () => {
        const client = new MapTileStreamClient('/interactive');
        const tileStream = client as any;
        let change: unknown = null;
        const observedRevisions: number[] = [];
        try {
            client.withSourceCatalogChangedCallback(payload => {
                change = payload;
            });
            client.withSourcesRevisionChangedCallback(revision => {
                observedRevisions.push(revision);
            });

            await tileStream.handleFrame(jsonFrame(MAP_TILE_STREAM_TYPE_SOURCE_CATALOG_CHANGE, {
                type: 'mapget.sources.changed',
                revision: 44,
                reason: 'status',
                source: {
                    configIndex: 7,
                    status: 'initializing',
                    statusMessage: 'Loading layers',
                    progress: 0.5
                }
            }), MAP_TILE_STREAM_TYPE_SOURCE_CATALOG_CHANGE);

            expect(change).toEqual({
                type: 'mapget.sources.changed',
                revision: 44,
                reason: 'status',
                source: {
                    configIndex: 7,
                    status: 'initializing',
                    statusMessage: 'Loading layers',
                    progress: 0.5
                }
            });
            expect(client.getSourcesRevision()).toBe(44);
            expect(observedRevisions).toEqual([]);
        } finally {
            client.destroy();
        }
    });

    it('treats missing source progress as unavailable', async () => {
        const client = new MapTileStreamClient('/interactive');
        const tileStream = client as any;
        let change: unknown = null;
        try {
            client.withSourceCatalogChangedCallback(payload => {
                change = payload;
            });

            await tileStream.handleFrame(jsonFrame(MAP_TILE_STREAM_TYPE_SOURCE_CATALOG_CHANGE, {
                type: 'mapget.sources.changed',
                revision: 45,
                reason: 'status',
                source: {
                    configIndex: 7,
                    status: 'initializing'
                }
            }), MAP_TILE_STREAM_TYPE_SOURCE_CATALOG_CHANGE);

            expect(change).toEqual({
                type: 'mapget.sources.changed',
                revision: 45,
                reason: 'status',
                source: {
                    configIndex: 7,
                    status: 'initializing',
                    statusMessage: undefined,
                    progress: null
                }
            });
        } finally {
            client.destroy();
        }
    });

    it('reports incompatible VTLV frame versions before dispatching payloads', async () => {
        const client = new MapTileStreamClient('/interactive');
        const tileStream = client as any;
        let mismatch: unknown = null;
        let statusReceived = false;
        try {
            client.withProtocolMismatchCallback(payload => {
                mismatch = payload;
            });
            client.withStatusCallback(() => {
                statusReceived = true;
            });

            await tileStream.handleMessage(jsonFrame(MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT, {
                type: 'mapget.tiles.request-context',
                requestId: 3
            }, {major: 1, minor: 9, patch: 0}).buffer);

            expect(mismatch).toEqual({
                actual: {major: 1, minor: 9, patch: 0},
                expected: {
                    major: currentProtocolVersion().major,
                    minor: currentProtocolVersion().minor
                }
            });
            expect(statusReceived).toBe(false);
        } finally {
            client.destroy();
        }
    });
});
