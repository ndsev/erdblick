import {expect, test} from '../fixtures/test';
import {mcpClient} from '../utils/mcp-client';
import {openSearchPalette, waitForAppReady} from '../utils/ui-helpers';
import {TEST_LAYER_NAMES, TEST_MAP_NAMES} from '../utils/test-params';

/**
 * Follow visible command choices into the same owner state read by native MCP.
 *
 * Coordinate history stores the user's input and stable command identity.
 * Closing an inspection instead needs a live, recognizable panel choice and
 * must never leave a reusable destructive entry in search history.
 */
test.use({stateSnapshot: null});
test.skip(
    process.env['EB_MAPGET_MCP_LOCAL'] !== '1',
    'Requires the native local MCP fixture'
);

test('owner commands navigate, replay history and close the chosen live inspection', async ({page, request}) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.unroute('**/locate');

    const mcp = mcpClient(request);
    await page.goto('/?v2=1&n=1&vid=omnibar&f=0&sync=&lon=10&lat=40&alt=500'
        + '&h=0&p=-1&r=0&px=0&py=0&pz=0&m2d=0&bg=~10&l=');
    await waitForAppReady(page);
    await expect.poll(async () => (await mcp.sessions()).length).toBe(1);
    const clientId = (await mcp.sessions())[0].clientId;

    async function call(name: string, input: Record<string, unknown> = {}) {
        const result = await mcp.call(name, {clientId, ...input});
        expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
        return result.structuredContent;
    }

    async function camera() {
        const result = await call('viewer_get_controls', {
            targets: [{control: 'view.camera', viewId: 'omnibar'}]
        });
        return result.values[0]?.value;
    }

    await expect.poll(async () => (await camera())?.destination?.lon).toBe(10);
    await openSearchPalette(page, '48,11');
    const coordinateChoice = page.getByTestId('search-action')
        .and(page.locator('[data-action-id="j:wgs84-lat-lon"]'));
    await expect(coordinateChoice).toBeVisible();
    await coordinateChoice.click();

    await expect.poll(async () => (await camera())?.destination?.lon).toBeCloseTo(11, 5);
    await expect.poll(async () => (await camera())?.destination?.lat).toBeCloseTo(48, 5);
    const marker = await call('viewer_get_controls', {targets: [{control: 'app.marker'}]});
    expect(marker.values[0].value).toMatchObject({
        enabled: true,
        position: {lon: 11, lat: 48}
    });

    const history = await page.evaluate(() => JSON.parse(localStorage.getItem('searchHistory') ?? '[]'));
    expect(history).toEqual(expect.arrayContaining([
        expect.objectContaining({actionId: 'j:wgs84-lat-lon', input: '48,11'})
    ]));

    // Move through MCP, then replay the ordinary UI history item. Reading the
    // control again proves that replay updates the durable owner, not just Deck.
    const previous = await camera();
    await call('viewer_set_control', {
        target: {control: 'view.camera', viewId: 'omnibar'},
        value: {...previous, destination: {lon: 10, lat: 40, alt: 500}}
    });
    await openSearchPalette(page, '');
    await page.getByTestId('search-history-action')
        .filter({has: page.getByText('48,11', {exact: true})}).click();
    await expect.poll(async () => (await camera())?.destination?.lon).toBeCloseTo(11, 5);

    // Use the real synthetic datasource and search service to obtain a feature.
    // The inspection therefore has the same lifecycle as an ordinary map pick.
    const layer = {mapId: TEST_MAP_NAMES[0], layerId: TEST_LAYER_NAMES[0]};
    await call('viewer_set_control', {
        target: {control: 'view.layer', viewId: 'omnibar', ...layer},
        value: {visible: true, level: 13, autoLevel: false}
    });
    const started = await call('viewer_start_search', {
        query: 'true',
        scope: 'feature',
        mapLayers: [layer],
        viewIds: ['omnibar'],
        tileLevels: [13],
        autoUpdate: false
    });
    await expect.poll(async () => {
        const search = await call('viewer_get_search', {searchId: started.searchId});
        return search.status.resultCount;
    }).toBeGreaterThan(0);
    const results = await call('viewer_get_search_results', {searchId: started.searchId, limit: 1});
    const feature = results.results[0];
    expect(feature).toBeDefined();
    const inspected = await call('viewer_inspect', {
        features: [{mapTileKey: feature.mapTileKey, featureId: feature.featureId}],
        lock: true,
        newPanel: true
    });
    expect(inspected.panelIds).toHaveLength(1);
    await expect(page.getByTestId('inspection-panel')).toHaveCount(1);

    const beforeClose = await page.evaluate(() => localStorage.getItem('searchHistory'));
    await openSearchPalette(page, 'close ' + feature.featureId);
    const closeChoice = page.getByTestId('search-action')
        .and(page.locator('[data-action-id^="close-inspection:"]'));
    await expect(closeChoice).toHaveCount(1);
    await expect(closeChoice).toContainText('Close ' + feature.featureId);
    await closeChoice.click();

    await expect(page.getByTestId('inspection-panel')).toHaveCount(0);
    const selections = await call('viewer_get_controls', {targets: [{control: 'app.selections'}]});
    expect(selections.values[0].value).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('searchHistory'))).toBe(beforeClose);
    expect(errors).toEqual([]);
});

