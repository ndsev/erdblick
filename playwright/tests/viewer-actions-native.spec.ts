import type {Page} from '@playwright/test';
import {expect, test} from '../fixtures/test';
import {viewerActions} from '../../app/actions/viewer-action.contract';
import {enableMapLayer} from '../utils/ui-helpers';
import {mcpClient} from '../utils/mcp-client';
import {TEST_LAYER_NAMES, TEST_MAP_NAMES} from '../utils/test-params';

test.use({stateSnapshot: null});
test.skip(process.env['EB_MAPGET_MCP_LOCAL'] !== '1', 'Requires the native local MCP fixture, not a mocked relay');

const twoViews = '/?v2=1&n=2&m=1&f=0&sync=&lon=10,20&lat=40,50&alt=500,1000&h=0,0&p=-1,-1&r=0,0&px=0,0&py=0,0&pz=0,0&m2d=0,0&bg=~10,~10&l=';

/** Labels a real tab through the product UI, so discovery also proves WS registration/update. */
async function openViewer(page: Page, label: string, sync = false, origin?: string) {
    const path = sync ? twoViews.replace('sync=&', 'sync=pos&') : twoViews;
    await page.goto(origin ? new URL(path, origin).href : path);
    await page.getByTestId('viewer-action-status').click();
    await expect(page.getByTestId('viewer-action-details')).toContainText('MCP controls ready');
    await page.getByLabel('Tab label', {exact: true}).fill(label);
    await page.getByLabel('Tab label', {exact: true}).press('Tab');
}

test('native MCP controls the selected live tab/view, retires stale UUIDs, and preserves map interaction', async ({page, context, request}) => {
    const mcp = mcpClient(request);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const discovery = await mcp.rpc('tools/list');
    expect(discovery.response.ok()).toBe(true);
    expect(discovery.message.result.tools.map((tool: {name: string}) => tool.name).sort()).toEqual([
        'viewer_describe_app_state', 'viewer_get_app_state', 'viewer_list_sessions', 'viewer_set_app_state'
    ]);
    await openViewer(page, 'first-native-tab');
    const second = await context.newPage();
    try {
        const secondOrigin = new URL(page.url());
        secondOrigin.hostname = secondOrigin.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
        await openViewer(second, 'second-native-tab', true, secondOrigin.origin);
        await expect.poll(async () => (await mcp.sessions()).map(tab => tab.label).sort())
            .toEqual(['first-native-tab', 'second-native-tab']);
        const sessions = await mcp.sessions();
        const firstId = sessions.find(tab => tab.label === 'first-native-tab')!.clientId;
        const secondId = sessions.find(tab => tab.label === 'second-native-tab')!.clientId;
        expect(firstId).not.toEqual(secondId);
        const targets = [{channel: 'view.camera', viewIndex: 0}, {channel: 'view.camera', viewIndex: 1}];
        async function read(clientId: string) {
            const result = await mcp.call('viewer_get_app_state', {clientId, targets});
            expect(result.isError).not.toBe(true);
            return viewerActions.viewer_get_app_state.outputSchema.parse(result.structuredContent);
        }
        const description = await mcp.call('viewer_describe_app_state', {clientId: firstId});
        expect(description.isError).not.toBe(true);
        viewerActions.viewer_describe_app_state.outputSchema.parse(description.structuredContent);
        let before = await read(firstId);
        await expect.poll(async () => {
            before = await read(firstId);
            return before.values.every(value => 'value' in value);
        }).toBe(true);
        const otherBefore = await read(secondId);
        const value = {destination: {lon: 11.5374, lat: 48.1584, alt: 700}, orientation: {heading: 0, pitch: -1, roll: 0}, position: [0, 0, 0]};
        const result = await mcp.call('viewer_set_app_state', {
            clientId: firstId, target: targets[1], value, viewLayoutRevision: before.viewLayoutRevision
        });
        expect(result.isError).not.toBe(true);
        const applied = viewerActions.viewer_set_app_state.outputSchema.parse(result.structuredContent);
        expect(applied).toMatchObject({status: 'applied', focusedView: 1, affectedViews: [1], changed: true});
        expect(applied.value.destination.lon).toBeCloseTo(value.destination.lon, 5);
        expect((await read(firstId)).values[0]).toEqual(before.values[0]);
        expect((await read(secondId)).values).toEqual(otherBefore.values);
        await expect(page.getByTestId('viewer-action-details').getByRole('listitem').filter({hasText: 'viewer_set_app_state'}))
            .toContainText('applied');

        const synced = await mcp.call('viewer_set_app_state', {
            clientId: secondId, target: targets[1], value, viewLayoutRevision: otherBefore.viewLayoutRevision
        });
        expect(synced.isError).not.toBe(true);
        expect(synced.structuredContent.affectedViews.sort()).toEqual([0, 1]);

        // Navigation closes the old interactive connection; no target is silently rebound.
        await page.reload();
        await expect.poll(async () => (await mcp.sessions()).some(tab => tab.clientId === firstId)).toBe(false);
        const stale = await mcp.call('viewer_get_app_state', {clientId: firstId, targets});
        expect(stale.isError).toBe(true);
        await expect.poll(async () => (await mcp.sessions()).length).toBe(2);
        const replacement = (await mcp.sessions()).find(tab => tab.clientId !== secondId)!;
        expect(replacement.clientId).not.toBe(firstId);

        // Exercise a human camera gesture after remote control, not just a canvas screenshot.
        await page.bringToFront();
        const canvas = page.locator('#mapViewContainer-0 canvas').first();
        await expect(canvas).toBeVisible();
        const cameraBefore = await read(replacement.clientId);
        const box = (await canvas.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, {steps: 8});
        const duringGesture = await mcp.call('viewer_set_app_state', {
            clientId: replacement.clientId, target: targets[0], value,
            viewLayoutRevision: cameraBefore.viewLayoutRevision
        });
        expect(duringGesture.isError).toBe(true);
        expect(duringGesture.structuredContent.error).toMatchObject({code: 'busy', outcome: 'not_applied'});
        await page.mouse.up();
        await expect.poll(async () => (await read(replacement.clientId)).values[0]).not.toEqual(cameraBefore.values[0]);

        // The same connection must still deliver/render real subsets alongside controls.
        const enableLayer = enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
        expect((await mcp.call('viewer_get_app_state', {clientId: replacement.clientId})).isError).not.toBe(true);
        await enableLayer;
        await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions))
            .toBeGreaterThan(0);
        expect(await page.evaluate(() => window.ebDebug!.subsetRenderQueue().failed)).toBe(0);
        expect((await mcp.call('viewer_get_app_state', {clientId: replacement.clientId})).isError).not.toBe(true);
        expect(errors).toEqual([]);
    } finally {
        await second.close();
    }
    await expect.poll(async () => (await mcp.sessions()).length).toBe(1);
});

test('native local MCP rejects untrusted origins/hosts and requires an explicit browser target', async ({request}) => {
    const mcp = mcpClient(request);
    for (const headers of [{Origin: 'https://untrusted.invalid'}, {Host: 'untrusted.invalid'}]) {
        const reply = await mcp.rpc('tools/list', {}, headers);
        expect(reply.response.status()).toBe(403);
    }
    const missingTarget = await mcp.rpc('tools/call', {name: 'viewer_get_app_state', arguments: {}});
    expect(missingTarget.response.status()).toBe(400);
    expect((await missingTarget.response.json()).error.code).toBe(-32602);
});
