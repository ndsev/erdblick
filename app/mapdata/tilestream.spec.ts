import {describe, expect, it, vi} from 'vitest';
import {
    MAP_TILE_STREAM_HEADER_SIZE,
    MAP_TILE_STREAM_PROTOCOL_MAJOR,
    MAP_TILE_STREAM_PROTOCOL_MINOR,
    MAP_TILE_STREAM_TYPE_FIELDS,
    MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT,
    MAP_TILE_STREAM_TYPE_SOURCE_CATALOG_CHANGE,
    MapTileStreamClient
} from './tilestream';

function jsonFrame(type: number, payload: object, version = {
    major: MAP_TILE_STREAM_PROTOCOL_MAJOR,
    minor: MAP_TILE_STREAM_PROTOCOL_MINOR,
    patch: 0
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

describe('MapTileStreamClient', () => {
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

            const frame = jsonFrame(MAP_TILE_STREAM_TYPE_FIELDS, {nodeId: "stale-but-required"});
            await tileStream.handleFrame(frame, MAP_TILE_STREAM_TYPE_FIELDS);

            expect(parser.readFieldDictUpdate).toHaveBeenCalledOnce();
            expect(fieldsCallback).toHaveBeenCalledWith(frame);
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
                    sourceId: 'source-a',
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
                    sourceId: 'source-a',
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
                    sourceId: 'source-a',
                    status: 'initializing'
                }
            }), MAP_TILE_STREAM_TYPE_SOURCE_CATALOG_CHANGE);

            expect(change).toEqual({
                type: 'mapget.sources.changed',
                revision: 45,
                reason: 'status',
                source: {
                    sourceId: 'source-a',
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
                    major: MAP_TILE_STREAM_PROTOCOL_MAJOR,
                    minor: MAP_TILE_STREAM_PROTOCOL_MINOR
                }
            });
            expect(statusReceived).toBe(false);
        } finally {
            client.destroy();
        }
    });
});
