/** Exercise real schema completion together with the omnibar's separate action menu. */
import {expect, test} from '../fixtures/test';
import {mcpClient} from '../utils/mcp-client';
import {enableMapLayer, openOmnibar, waitForAppReady} from '../utils/ui-helpers';
import {TEST_MAP_NAMES, TEST_LAYER_NAMES} from '../utils/test-params';
import type {MapInfoItem} from '../../../app/mapdata/source-catalog.model';

declare global {
    interface Window {
        holdOmnibarCompletions: boolean;
        heldOmnibarCompletions: number;
        releaseOmnibarCompletions: () => void;
    }
}

test.use({stateSnapshot: null});
test.skip(process.env['EB_MAPGET_MCP_LOCAL'] !== '1', 'Uses the native MCP/browser connection');

test.beforeEach(async ({page, request}) => {
    const response = await request.get('/sources');
    expect(response.ok()).toBe(true);
    const catalog: MapInfoItem[] = await response.json();
    expect(catalog.length).toBeGreaterThan(0);
    // One failing source must not prevent suggestions from the real healthy
    // fixture. The worker still imports that fixture's actual schema bytes.
    const failed = {...catalog[0], mapId: 'Unavailable completion fixture', sourceId: 'unavailable',
        stringPoolId: 'unavailable', status: 'failed', statusMessage: 'Fixture offline', layers: {},
        configIndex: Math.max(-1, ...catalog.map(source => source.configIndex ?? -1)) + 1};
    await page.route('**/sources?*', route => route.fulfill({json: [...catalog, failed], headers: {
        'X-Mapget-Sources-Revision': String(Number(response.headers()['x-mapget-sources-revision'] ?? 0) + 100)
    }}));
});

test('ready maps provide plain attribute completions, and Enter runs the visible feature-search action', async ({page, request}) => {
    await page.goto('/?v2=1&vid=0&n=1&f=0&lon=11&lat=48&alt=1000&bg=~0&l=');
    await waitForAppReady(page);
    const mcp = mcpClient(request);
    await expect.poll(async () => (await mcp.sessions()).length).toBe(1);
    const clientId = (await mcp.sessions())[0].clientId;
    await openOmnibar(page, 'WARN'); // fill also exercises input/paste, without keyup.
    const input = page.getByTestId('omnibar-input');
    const popup = page.getByTestId('search-completion-popup').first();
    const attribute = popup.getByTestId('search-completion-candidate').filter({hasText: 'WARNING_SIGN attribute'});
    await expect(attribute).toHaveCount(1);
    await expect(attribute).toBeVisible();
    // Visibility alone does not prove that the body-mounted popup is above
    // the omnibar's outer stacking context. A real mouse click must reach it.
    await attribute.click({trial: true});
    await expect(attribute).not.toContainText('**.');
    await expect(popup.getByLabel('Loading completion candidates')).toBeHidden();
    await expect(attribute).toBeVisible();
    await input.press('Tab');
    await expect(input).toHaveValue('WARNING_SIGN');
    await expect(popup).toBeHidden();
    await expect(page.getByTestId('omnibar-menu-panel')).toBeVisible();
    await expect(page.getByTestId('omnibar-action').first()).toHaveAttribute('data-action-id', 'features');
    await expect(page.getByTestId('feature-search-panel')).toHaveCount(0);
    await input.press('Enter');
    await expect(page.getByTestId('omnibar-menu-panel')).toBeHidden();
    await expect(page.getByTestId('feature-search-panel')).toBeVisible();
    const searches = await mcp.call('viewer_get_controls', {clientId, targets: [{control: 'app.searches'}]});
    expect(searches.isError).not.toBe(true);
    const searchId = searches.structuredContent.values[0].value[0].searchId;
    await expect.poll(async () => {
        const search = await mcp.call('viewer_get_search', {clientId, searchId});
        expect(search.isError).not.toBe(true);
        expect(search.structuredContent.status.query).toBe('WARNING_SIGN');
        return search.structuredContent.searchComplete;
    }).toBe(true);
    expect(page.context().pages()).toHaveLength(1);
});

test('accepting a completion from another source keeps the active map as the search scope', async ({page, request}) => {
    // Two schema versions may produce the same portable suggestion while
    // reporting different origins. Exercise that boundary without replacing
    // either the native completion text or the real search preparation.
    await page.addInitScript(() => {
        const BrowserWorker = window.Worker;
        window.Worker = class extends BrowserWorker {
            constructor(...args: ConstructorParameters<typeof Worker>) {
                super(...args);
                const forwarded = new WeakSet<Event>();
                this.addEventListener('message', event => {
                    if (event.data?.type !== 'SearchCompletionResult' || forwarded.has(event)) return;
                    event.stopImmediatePropagation();
                    const response = new MessageEvent('message', {data: {...event.data,
                        candidates: event.data.candidates.map((candidate: object) => ({...candidate,
                            originLayers: [{mapId: 'Another schema version', layerId: 'Road'}]}))}});
                    forwarded.add(response);
                    this.dispatchEvent(response);
                });
            }
        };
    });
    await page.goto('/?v2=1&vid=0&n=1&f=0&lon=11&lat=48&alt=1000&bg=~0&l=');
    await waitForAppReady(page);
    await enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
    await openOmnibar(page, 'ANIM');
    const input = page.getByTestId('omnibar-input');
    const candidate = page.getByTestId('search-completion-popup').first()
        .getByTestId('search-completion-candidate').filter({hasText: 'ANIMALS enum value'});
    await expect(candidate).toHaveCount(1);
    await candidate.click();
    await expect(input).toHaveValue('**.warningSign == "ANIMALS"');
    await input.press('Enter');
    const mcp = mcpClient(request);
    await expect.poll(async () => (await mcp.sessions()).length).toBe(1);
    const clientId = (await mcp.sessions())[0].clientId;
    await expect(page.getByTestId('feature-search-panel')).toBeVisible();
    const searches = await mcp.call('viewer_get_controls', {clientId, targets: [{control: 'app.searches'}]});
    const searchId = searches.structuredContent.values[0].value[0].searchId;
    await expect.poll(async () => {
        const response = await mcp.call('viewer_get_search', {clientId, searchId});
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent.settings.selectedMapLayers)
            .toEqual([{mapId: TEST_MAP_NAMES[0], layerId: TEST_LAYER_NAMES[0]}]);
        return response.structuredContent.searchComplete;
    }).toBe(true);
    // Hidden enum palettes used to construct hundreds of PrimeNG controls
    // during preparation. Neither an unopened tab nor a collapsed rule should
    // create those editors; opening one must still expose its saved categories.
    await expect(page.locator('search-style-rule-editor')).toHaveCount(0);
    await page.getByRole('tab', {name: /Visualization/}).click();
    await expect(page.locator('search-style-rule-editor')).toHaveCount(1);
    await expect(page.locator('search-style-color')).toHaveCount(0);
    const header = page.locator('search-style-rule-editor p-accordion-header').first();
    // The header's centre contains an editable name that intentionally does
    // not toggle the rule. Activate the header itself through its keyboard API.
    await header.press('Enter');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('search-style-color')).toHaveCount(1);
    await header.press('Enter');
    await expect(page.locator('search-style-color')).toHaveCount(0);
});

test('Escape, menu navigation and mouse selection retire late completion without losing the draft', async ({page}) => {
    await page.addInitScript(() => {
        const held: Array<() => void> = [];
        window.holdOmnibarCompletions = false;
        window.heldOmnibarCompletions = 0;
        window.releaseOmnibarCompletions = () => {
            window.holdOmnibarCompletions = false;
            held.splice(0).forEach(deliver => deliver());
            window.heldOmnibarCompletions = 0;
        };
        const BrowserWorker = window.Worker;
        window.Worker = class extends BrowserWorker {
            constructor(...args: ConstructorParameters<typeof Worker>) {
                super(...args);
                this.addEventListener('message', event => {
                    if (!window.holdOmnibarCompletions || event.data?.type !== 'SearchCompletionResult') return;
                    event.stopImmediatePropagation();
                    const response = new MessageEvent('message', {data: event.data});
                    held.push(() => this.dispatchEvent(response));
                    window.heldOmnibarCompletions = held.length;
                });
            }
        };
    });
    await page.goto('/?v2=1&vid=0&n=1&f=0&lon=11&lat=48&alt=1000&bg=~0&l=');
    await waitForAppReady(page);
    await openOmnibar(page, 'WARN');
    const input = page.getByTestId('omnibar-input');
    const popup = page.getByTestId('search-completion-popup').first();
    await expect(popup.getByTestId('search-completion-candidate').first()).toBeVisible();
    await input.press('Escape');
    await expect(popup).toBeHidden();
    await expect(input).toHaveValue('WARN');
    await expect(page.getByTestId('omnibar-menu-panel')).toBeVisible();
    const actions = page.getByTestId('omnibar-action');
    await input.press('ArrowDown');
    await expect(actions.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(actions.nth(1)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('WARN');

    // Leave the input while a reply is pending. Its eventual delivery must
    // neither reopen completion nor steal focus back from the action menu.
    await page.evaluate(() => {window.holdOmnibarCompletions = true;});
    await input.fill('SPEED_L');
    await expect.poll(() => page.evaluate(() => window.heldOmnibarCompletions)).toBeGreaterThan(0);
    await expect(popup.getByLabel('Loading completion candidates')).toBeVisible();
    await input.press('Tab');
    await expect(actions.first()).toBeFocused();
    const focusedActionId = await actions.first().getAttribute('data-action-id');
    await page.evaluate(() => window.releaseOmnibarCompletions());
    await expect(popup).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-action-id'))).toBe(focusedActionId);

    await input.click();
    await input.fill('SPEED_LI');
    const attribute = popup.getByTestId('search-completion-candidate').filter({hasText: 'SPEED_LIMIT attribute'});
    await expect(popup.getByTestId('search-completion-candidate').filter({hasText: '**.warningSign == "SPEED_LIMIT"'})).toBeVisible();
    await attribute.click();
    await expect(input).toHaveValue('SPEED_LIMIT');
    await expect(input).toBeFocused();
    await expect(popup).toBeHidden();
    await expect(actions.first()).toHaveAttribute('data-action-id', 'features');
    await actions.first().click();
    await expect(page.getByTestId('omnibar-menu-panel')).toBeHidden();
    await expect(popup).toBeHidden();
    // Bare attribute completion defers the colliding enum meaning to the
    // existing confirmed-search choice, without an implicit combined query.
    await expect(page.getByTestId('search-interpretation')).toHaveCount(2);
});

test('compact action parameters and keyboard navigation include history while skipping unavailable actions', async ({page}) => {
    await page.setViewportSize({width: 1000, height: 500});
    await page.goto('/?v2=1&vid=0&n=1&f=0&lon=10&lat=40&alt=1000&bg=~0&l=');
    await waitForAppReady(page);
    await openOmnibar(page, '(');
    const input = page.getByTestId('omnibar-input');
    const menu = page.getByTestId('omnibar-menu-panel');
    await expect(menu.locator('[data-action-id="features"]')).toHaveAttribute('aria-disabled', 'true');
    await expect(menu.locator('[data-action-id="features"] .bubble-error')).toBeVisible();
    await expect(menu.locator('[data-action-id^="fj:"]')).toHaveCount(0);

    await input.fill('Way');
    const incomplete = page.getByTestId('omnibar-inactive-action').filter({hasText: 'Jump to Way'});
    await expect(incomplete).toHaveCount(1);
    await expect(incomplete).toHaveAttribute('aria-disabled', 'true');
    await expect(incomplete).toHaveAttribute('tabindex', '-1');
    await expect(incomplete.getByTestId('omnibar-bubble')).toContainText('?');
    await expect(incomplete.locator('.omnibar-option-description')).toHaveCount(0);
    await expect(menu).not.toContainText('Insufficient parameters');

    await input.fill('Way.1');
    const jump = page.getByTestId('omnibar-action').filter({hasText: 'Jump to Way'});
    await expect(jump).toBeVisible();
    await expect(jump.locator('[data-parameter-name="wayId"] .omnibar-bubble-value')).toHaveText('1');
    expect((await jump.boundingBox())!.height).toBeLessThan(60);
    await input.fill('WARNING_SIGN');
    await expect(menu.locator('[data-action-id^="fj:"]')).toHaveCount(0);
    await expect(menu.locator('[data-action-id="features"]')).toBeVisible();

    // Tab and arrows use the same enabled actions. Returning to the input
    // after Tab also confirms that a cancelled completion stays dismissed.
    await input.fill('48,11');
    const actions = page.getByTestId('omnibar-action');
    await input.press('Tab');
    await expect(actions.first()).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(input).toBeFocused();
    await input.press('ArrowDown');
    await expect(actions.first()).toBeFocused();
    const ids = await actions.evaluateAll(rows => rows.map(row => row.getAttribute('data-action-id')));
    const coordinateIndex = ids.indexOf('j:wgs84-lat-lon');
    expect(coordinateIndex).toBeGreaterThanOrEqual(0);
    for (let index = 0; index < coordinateIndex; index++) await page.keyboard.press('ArrowDown');
    await expect(actions.nth(coordinateIndex)).toBeFocused();
    await expect(actions.nth(coordinateIndex).locator('[data-parameter-name="lat"] .omnibar-bubble-value')).toHaveText('48');
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect.poll(() => Number(new URL(page.url()).searchParams.get('lon'))).toBeCloseTo(11, 5);
    await expect.poll(() => Number(new URL(page.url()).searchParams.get('lat'))).toBeCloseTo(48, 5);

    // Reload at another location, then replay the persisted command entirely
    // with the keyboard. The last row must be revealed in this short viewport.
    await page.goto('/?v2=1&vid=0&n=1&f=0&lon=10&lat=40&alt=1000&bg=~0&l=');
    await waitForAppReady(page);
    await openOmnibar(page, '');
    const history = page.getByTestId('omnibar-history-action');
    await expect(history).toHaveCount(1);
    await expect(history.locator('.action-icon .pi-history')).toBeVisible();
    await expect(history.locator('.omnibar-option-name')).not.toBeEmpty();
    await expect(history.locator('[data-parameter-name="lat"] .omnibar-bubble-value')).toHaveText('48');
    await expect(history.getByRole('button', {name: 'Remove from history'})).toBeVisible();
    expect((await history.boundingBox())!.height).toBeLessThan(60);
    await input.press('ArrowUp');
    await expect(history).toBeFocused();
    const bounds = (await history.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(500);
    await page.keyboard.press('ArrowUp');
    await expect(actions.last()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(history).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect.poll(() => Number(new URL(page.url()).searchParams.get('lon'))).toBeCloseTo(11, 5);
    await expect.poll(() => Number(new URL(page.url()).searchParams.get('lat'))).toBeCloseTo(48, 5);
});


test('long drafts stay on one detail line below the action name and retain their full text in a tooltip', async ({page}) => {
    await page.setViewportSize({width: 1600, height: 900});
    await page.goto('/?v2=1&vid=0&n=1&f=0&lon=11&lat=48&alt=1000&bg=~0&l=');
    await waitForAppReady(page);
    const query = 'typeId == "' + 'VeryLongFeatureType'.repeat(15) + '"';
    await openOmnibar(page, query);
    const menu = page.getByTestId('omnibar-menu-panel');
    const search = menu.locator('[data-action-id="features"]');
    await expect(search).toBeVisible();
    const handle = page.getByTestId('omnibar-resize-handle');
    const handleBounds = (await handle.boundingBox())!;
    const initialWidth = (await menu.boundingBox())!.width;
    // Only the corner's thin border arms accept a drag; its centre is clipped
    // so it cannot swallow clicks on the last action's parameters.
    const startX = handleBounds.x + handleBounds.width - 2;
    const startY = handleBounds.y + handleBounds.height - 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - (initialWidth - 384), startY, {steps: 5});
    await page.mouse.up();
    await expect.poll(async () => (await menu.boundingBox())!.width, {timeout: 5000}).toBeLessThanOrEqual(400);
    const bubble = search.getByTestId('omnibar-bubble');
    await expect(bubble).toHaveAttribute('title', 'Filter: ' + query);
    await expect(bubble.locator('.omnibar-bubble-name')).toBeHidden();
    expect((await search.boundingBox())!.height).toBeLessThan(60);
    const bounds = (await menu.boundingBox())!;
    const nameBounds = (await search.locator('.omnibar-option-name').boundingBox())!;
    const bubbleBounds = (await bubble.boundingBox())!;
    expect(bubbleBounds.y).toBeGreaterThanOrEqual(nameBounds.y + nameBounds.height);
    expect(bubbleBounds.x).toBeCloseTo(nameBounds.x, 0);
    expect(bubbleBounds.x + bubbleBounds.width).toBeLessThan(bounds.x + bounds.width - 15);
    expect(await menu.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await bubble.locator('.omnibar-bubble-value').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);

    // Closing the wide panel must also shrink its hit area. The input remains
    // available, and the adjacent main-bar controls must receive pointer input.
    await page.getByTestId('maps-toggle').click();
    await page.getByTestId('maps-toggle').click();
    await expect(menu).toBeHidden();
    await page.locator('.main-bar').first().getByRole('menuitem', {name: /Edit$/}).first().hover({trial: true});
});
