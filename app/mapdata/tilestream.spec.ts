import {describe, expect, it} from 'vitest';
import {
    MAP_TILE_STREAM_HEADER_SIZE,
    MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT,
    MAP_TILE_STREAM_TYPE_SOURCE_CATALOG_CHANGE,
    MapTileStreamClient
} from './tilestream';

function jsonFrame(type: number, payload: object): Uint8Array {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const frame = new Uint8Array(MAP_TILE_STREAM_HEADER_SIZE + payloadBytes.length);
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

    it('stores sourcesRevision from request-context frames', async () => {
        const client = new MapTileStreamClient('/interactive');
        const tileStream = client as any;
        try {
            await tileStream.handleFrame(jsonFrame(MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT, {
                type: 'mapget.tiles.request-context',
                requestId: 3,
                sourcesRevision: 43
            }), MAP_TILE_STREAM_TYPE_REQUEST_CONTEXT);

            expect(client.getSourcesRevision()).toBe(43);
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

    it('dispatches source catalog change control frames', async () => {
        const client = new MapTileStreamClient('/interactive');
        const tileStream = client as any;
        let change: unknown = null;
        try {
            client.withSourceCatalogChangedCallback(payload => {
                change = payload;
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
});
