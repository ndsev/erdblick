import type {WebSocketRoute} from '@playwright/test';
import {expect, test} from '../fixtures/test';
import {enableMapLayer, navigateToRoot, openLayerDialog} from '../utils/ui-helpers';
import {TEST_LAYER_NAMES, TEST_MAP_NAMES} from '../utils/test-params';
import type {MapInfoItem} from '../../app/mapdata/map.tree.model';

test.use({stateSnapshot: null});

test('newly ready maps preserve the live connection and already rendered viewport', async ({page, request}) => {
    const response = await request.get('/sources');
    expect(response.ok()).toBe(true);
    const catalog: MapInfoItem[] = await response.json();
    const original = catalog.find(source => source.mapId === TEST_MAP_NAMES[0]);
    expect(original).toBeDefined();
    const nextIndex = Math.max(-1, ...catalog.map(source => source.configIndex ?? -1)) + 1;
    const lateMaps = ['LateOne', 'LateTwo', 'LateThree'].map((mapId, index) => ({
        ...original!, mapId, sourceId: mapId, stringPoolId: mapId,
        configIndex: nextIndex + index, status: 'initializing', layers: {}
    }));
    let revision = Number(response.headers()['x-mapget-sources-revision'] ?? 0) + 100;
    await page.route('**/sources?*', route => route.fulfill({
        json: [...catalog, ...lateMaps], headers: {'X-Mapget-Sources-Revision': String(revision)}
    }));

    const sockets: WebSocketRoute[] = [];
    const tileRequests: object[] = [];
    await page.routeWebSocket('**/interactive', socket => {
        sockets.push(socket);
        const server = socket.connectToServer();
        socket.onMessage(raw => {
            const message = JSON.parse(raw.toString());
            if (message.requests?.some((group: {mapId?: string}) => group.mapId === original!.mapId)) {
                tileRequests.push(message);
            }
            server.send(raw);
        });
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await navigateToRoot(page);
    await enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
    await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions))
        .toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => {
        const queue = window.ebDebug!.subsetRenderQueue();
        return queue.queued + queue.inFlight + queue.ready;
    })).toBe(0);
    await openLayerDialog(page);
    const protocol = await page.evaluate(() => {
        const core = window.ebDebug!.coreLib();
        return [core.tileLayerStreamProtocolMajor(), core.tileLayerStreamProtocolMinor(), 0];
    });
    const before = await page.evaluate(() => ({
        completed: window.ebDebug!.subsetRenderQueue().completed,
        contributions: window.ebDebug!.subsetRenderPresentation().activeContributions,
        uploadedBytes: window.ebDebug!.subsetRenderPresentation().uploadedBytes
    }));
    const requestsBefore = tileRequests.length;
    expect(sockets).toHaveLength(1);
    expect(requestsBefore).toBeGreaterThan(0);

    for (const source of lateMaps) {
        source.status = 'ready';
        source.layers = original!.layers;
        ++revision;
        // Inject only the catalog control event; real tile traffic keeps flowing.
        const body = Buffer.from(JSON.stringify({type: 'mapget.sources.changed', revision, reason: 'ready', source: {
            configIndex: source.configIndex, status: 'ready'
        }}));
        const frame = Buffer.alloc(11 + body.length);
        protocol.forEach((part, index) => frame.writeUInt16LE(part, index * 2));
        frame[6] = 8;
        frame.writeUInt32LE(body.length, 7);
        body.copy(frame, 11);
        const refreshed = page.waitForResponse(response => response.url().includes('/sources?'));
        sockets[0].send(frame);
        await refreshed;
        await expect(page.getByTestId('map-tree-0').getByRole('checkbox', {name: source.mapId, exact: true})).toBeEnabled();
    }

    // Give scheduled reconciliation, acknowledgement and diagnostics sampling a
    // turn; queued work must not hide a transient teardown behind eventual recovery.
    await page.waitForTimeout(1500);
    expect(sockets).toHaveLength(1);
    expect(tileRequests).toHaveLength(requestsBefore);
    expect(await page.evaluate(() => ({
        completed: window.ebDebug!.subsetRenderQueue().completed,
        contributions: window.ebDebug!.subsetRenderPresentation().activeContributions,
        uploadedBytes: window.ebDebug!.subsetRenderPresentation().uploadedBytes
    }))).toEqual(before);
    expect(errors).toEqual([]);
    await expect(page.getByText('Backend disconnected', {exact: true})).toHaveCount(0);
});
