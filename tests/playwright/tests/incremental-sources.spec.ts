import type {WebSocketRoute} from '@playwright/test';
import {expect, test} from '../fixtures/test';
import {enableMapLayer, navigateToRoot, openLayerDialog} from '../utils/ui-helpers';
import {TEST_LAYER_NAMES, TEST_MAP_NAMES} from '../utils/test-params';
import type { MapInfoItem } from "../../../app/mapdata/source-catalog.model";

test.use({stateSnapshot: null});

test('catalog additions and retirements preserve an unchanged rendered viewport', async ({page, request}) => {
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
    /** Inject catalog notifications while all data still comes from the real server. */
    const notifyCatalog = (source?: {configIndex: number; status: string}) => {
        const body = Buffer.from(JSON.stringify({type: 'mapget.sources.changed', revision,
            reason: source ? 'ready' : 'config', ...(source ? {source} : {})}));
        const frame = Buffer.alloc(11 + body.length);
        protocol.forEach((part, index) => frame.writeUInt16LE(part, index * 2));
        frame[6] = 8;
        frame.writeUInt32LE(body.length, 7);
        body.copy(frame, 11);
        sockets[sockets.length - 1].send(frame);
    };
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
        const refreshed = page.waitForResponse(response => response.url().includes('/sources?'));
        notifyCatalog({configIndex: source.configIndex, status: 'ready'});
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
    for (const change of ['replace', 'remove']) {
        if (change === 'replace') lateMaps[0].stringPoolId += '-replacement';
        else lateMaps.shift();
        ++revision;
        const connectionsBefore = sockets.length;
        const refreshed = page.waitForResponse(response => response.url().includes('/sources?'));
        notifyCatalog();
        await refreshed;
        // Metadata retirement fences old payloads with a new session, but an
        // unchanged map must keep its installed scene and completed render work.
        await expect.poll(() => sockets.length).toBe(connectionsBefore + 1);
        await expect.poll(() => page.evaluate(() => {
            const queue = window.ebDebug!.subsetRenderQueue();
            return queue.queued + queue.inFlight + queue.ready;
        })).toBe(0);
        await page.waitForTimeout(500);
        expect(await page.evaluate(() => ({
            completed: window.ebDebug!.subsetRenderQueue().completed,
            contributions: window.ebDebug!.subsetRenderPresentation().activeContributions,
            uploadedBytes: window.ebDebug!.subsetRenderPresentation().uploadedBytes
        }))).toEqual(before);
    }
    expect(errors).toEqual([]);
    await expect(page.getByText('Backend disconnected', {exact: true})).toHaveCount(0);
});
