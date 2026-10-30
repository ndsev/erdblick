import type {Page} from '@playwright/test';
import {expect, test} from '../fixtures/test';
import {mcpClient} from '../utils/mcp-client';
import {enableMapLayer, waitForAppReady} from '../utils/ui-helpers';
import {TEST_LAYER_NAMES, TEST_MAP_NAMES} from '../utils/test-params';

/**
 * Exercise the owner-declared catalog through a real mapget process and browser.
 *
 * The starting link uses the existing positional camera format and has no view
 * IDs. After hydration, every operation uses the IDs discovered from app.views.
 * This checks both the old link importer and the new public ownership boundary;
 * no service, store, action handler, or WebSocket response is mocked here.
 */
test.use({stateSnapshot: null});
test.skip(
    process.env['EB_MAPGET_MCP_LOCAL'] !== '1',
    'Requires the native local MCP fixture'
);

const legacyTwoViews = '/?v2=1&n=2&m=1&f=0&sync=&lon=10,20&lat=40,50'
    + '&alt=500,1000&h=0,0&p=-1,-1&r=0,0&px=0,0&py=0,0&pz=0,0'
    + '&m2d=0,0&bg=~10,~10&l=';

interface ControlTarget {
    control: string;
    viewId?: string;
}

interface ControlEntry {
    target: ControlTarget;
    value?: unknown;
    unavailable?: string;
}

interface ViewsSummary {
    focusedViewId: string;
    sync: string[];
    views: Array<{
        viewId: string;
        projection: '2d' | '3d';
        navigationMode: 'map' | 'first_person' | 'unavailable';
    }>;
}

interface Camera {
    destination: {lon: number; lat: number; alt: number};
    orientation: {heading: number; pitch: number; roll: number};
    position?: number[];
}

/** Label through the visible UI, proving that session updates reach native discovery. */
async function openViewer(page: Page, label: string, origin?: string): Promise<void> {
    await page.goto(origin ? new URL(legacyTwoViews, origin).href : legacyTwoViews);
    await waitForAppReady(page);
    await page.getByTestId('viewer-action-status').click();
    await expect(page.getByTestId('viewer-action-details')).toContainText('MCP controls ready');
    await page.getByLabel('Tab label', {exact: true}).fill(label);
    await page.getByLabel('Tab label', {exact: true}).press('Tab');
}

test('owner controls preserve view identity, tab isolation, retained cameras and share links', async ({page, context, request}) => {
    const mcp = mcpClient(request);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    async function call(clientId: string, name: string, input: Record<string, unknown> = {}) {
        const result = await mcp.call(name, {clientId, ...input});
        expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
        return result.structuredContent;
    }

    async function entries(clientId: string, targets: ControlTarget[]): Promise<ControlEntry[]> {
        const result = await call(clientId, 'viewer_get_controls', {targets});
        expect(result.values).toHaveLength(targets.length);
        expect(result.omissions).toEqual([]);
        expect(result.values.map((entry: ControlEntry) => entry.target)).toEqual(targets);
        return result.values;
    }

    async function views(clientId: string): Promise<ViewsSummary> {
        const [entry] = await entries(clientId, [{control: 'app.views'}]);
        expect(entry.unavailable).toBeUndefined();
        const value = entry.value as ViewsSummary;
        const ids = value.views.map(view => view.viewId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toContain(value.focusedViewId);
        for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
        return value;
    }

    /** Renderers initialize asynchronously; availability is reported by the control itself. */
    async function cameras(clientId: string, ids: string[]): Promise<Camera[]> {
        const targets = ids.map(viewId => ({control: 'view.camera', viewId}));
        let result: ControlEntry[] = [];
        await expect.poll(async () => {
            result = await entries(clientId, targets);
            return result.every(entry => entry.value !== undefined);
        }).toBe(true);
        return result.map(entry => entry.value as Camera);
    }

    const discovery = await mcp.rpc('tools/list');
    expect(discovery.response.ok()).toBe(true);
    const names = discovery.message.result.tools.map((tool: {name: string}) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
        'viewer_describe_controls', 'viewer_get_controls', 'viewer_set_control',
        'viewer_list_maps', 'viewer_list_layers', 'viewer_list_backgrounds',
        'viewer_list_styles', 'viewer_list_style_options', 'viewer_list_presets'
    ]));
    expect(names).not.toEqual(expect.arrayContaining(['viewer_get_catalog']));
    expect(names).not.toEqual(expect.arrayContaining(['viewer_get_app_state']));

    await openViewer(page, 'owner-first');
    const second = await context.newPage();
    second.on('pageerror', error => pageErrors.push(error.message));
    try {
        // A second origin gives this tab independent localStorage, as a separate
        // browser would have, while both tabs use the same native MCP endpoint.
        const secondOrigin = new URL(page.url());
        secondOrigin.hostname = secondOrigin.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
        await openViewer(second, 'owner-second', secondOrigin.origin);
        await expect.poll(async () => (await mcp.sessions()).map(tab => tab.label).sort())
            .toEqual(['owner-first', 'owner-second']);
        const sessions = await mcp.sessions();
        const firstClient = sessions.find(tab => tab.label === 'owner-first')!.clientId;
        const secondClient = sessions.find(tab => tab.label === 'owner-second')!.clientId;
        expect(firstClient).not.toBe(secondClient);

        const firstViews = await views(firstClient);
        const secondViews = await views(secondClient);
        expect(firstViews.views).toHaveLength(2);
        expect(secondViews.views).toHaveLength(2);
        const firstIds = firstViews.views.map(view => view.viewId);
        const secondIds = secondViews.views.map(view => view.viewId);
        const before = await cameras(firstClient, firstIds);
        const otherBefore = await cameras(secondClient, secondIds);

        const description = await call(firstClient, 'viewer_describe_controls', {controls: ['view.camera']});
        expect(description.complete).toBe(true);
        expect(description.controls).toHaveLength(1);
        expect(description.controls[0].selectorSchema.properties).toHaveProperty('viewId');
        expect(description.controls[0].selectorSchema.properties).not.toHaveProperty('viewIndex');

        const camera: Camera = {
            destination: {lon: 11.5374, lat: 48.1584, alt: 700},
            orientation: {heading: 0, pitch: -1, roll: 0},
            position: [0, 0, 0]
        };
        const target = {control: 'view.camera', viewId: firstIds[1]};
        const changed = await call(firstClient, 'viewer_set_control', {target, value: camera});
        expect(changed).toMatchObject({status: 'applied', target, changed: true});
        expect(changed.value.destination.lon).toBeCloseTo(camera.destination.lon, 5);
        expect((await views(firstClient)).focusedViewId).toBe(firstIds[1]);
        expect((await cameras(firstClient, firstIds))[0]).toEqual(before[0]);
        expect(await cameras(secondClient, secondIds)).toEqual(otherBefore);

        await call(secondClient, 'viewer_set_control', {
            target: {control: 'app.viewSync'}, value: ['pos']
        });
        await call(secondClient, 'viewer_set_control', {
            target: {control: 'view.camera', viewId: secondIds[1]}, value: camera
        });
        for (const value of await cameras(secondClient, secondIds)) {
            expect(value.destination.lon).toBeCloseTo(camera.destination.lon, 5);
            expect(value.destination.lat).toBeCloseTo(camera.destination.lat, 5);
        }

        // Removing the first positional view must retain the second logical view
        // and its camera. An old ID must never begin targeting its replacement.
        await call(firstClient, 'viewer_manage_view', {operation: 'remove', viewId: firstIds[0]});
        expect((await views(firstClient)).views.map(view => view.viewId)).toEqual([firstIds[1]]);
        expect((await cameras(firstClient, [firstIds[1]]))[0].destination.lon)
            .toBeCloseTo(camera.destination.lon, 5);
        const missing = await entries(firstClient, [{control: 'view.camera', viewId: firstIds[0]}]);
        expect(missing[0].unavailable).toBe('view_unavailable');
        const staleWrite = await mcp.call('viewer_set_control', {
            clientId: firstClient, target: {control: 'view.camera', viewId: firstIds[0]}, value: camera
        });
        expect(staleWrite.isError).toBe(true);
        expect(staleWrite.structuredContent.error).toMatchObject({code: 'not_available', outcome: 'not_applied'});

        await call(firstClient, 'viewer_manage_view', {operation: 'create', viewId: firstIds[1]});
        const currentIds = (await views(firstClient)).views.map(view => view.viewId);
        expect(currentIds).toHaveLength(2);
        expect(currentIds[0]).toBe(firstIds[1]);
        expect(currentIds).not.toContain(firstIds[0]);
        await cameras(firstClient, currentIds);

        const shared = await call(firstClient, 'viewer_get_share_link');
        const sharedUrl = new URL(shared.url);
        expect(sharedUrl.searchParams.get('vid')?.split(',')).toEqual(currentIds);
        expect(sharedUrl.searchParams.get('n')).toBe('2');
        await page.goto(sharedUrl.href);
        await expect.poll(async () => (await mcp.sessions()).some(tab => tab.clientId === firstClient)).toBe(false);
        await expect.poll(async () => (await mcp.sessions()).length).toBe(2);
        const replacement = (await mcp.sessions()).find(tab => tab.clientId !== secondClient)!;
        expect((await views(replacement.clientId)).views.map(view => view.viewId)).toEqual(currentIds);
        expect((await cameras(replacement.clientId, currentIds))[0].destination.lon)
            .toBeCloseTo(camera.destination.lon, 5);

        // Normal data streaming/rendering must still work after repeated control
        // operations and a full link reload through the real native connection.
        await page.bringToFront();
        await enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
        await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions))
            .toBeGreaterThan(0);
        expect(await page.evaluate(() => window.ebDebug!.subsetRenderQueue().failed)).toBe(0);
        expect(pageErrors).toEqual([]);
    } finally {
        await second.close();
    }
});
