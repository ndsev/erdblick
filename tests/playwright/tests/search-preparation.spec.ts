import {expect, test} from '../fixtures/test';
import {mcpClient} from '../utils/mcp-client';
import {enableMapLayer, waitForAppReady} from '../utils/ui-helpers';
import {TEST_MAP_NAMES, TEST_LAYER_NAMES} from '../utils/test-params';

test.use({stateSnapshot: null});
test.skip(process.env['EB_MAPGET_MCP_LOCAL'] !== '1', 'Uses the real native MCP/browser connection');

/** Generic enum predicates must not generate scales for unrelated numeric `value` fields. */
test('portable enum expression styles only compatible attribute owners', async ({page, request}) => {
    await page.goto('/?v2=1&vid=0&n=1&f=0&lon=11&lat=48&alt=1000&bg=~0&l=');
    await waitForAppReady(page);
    await enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
    const mcp = mcpClient(request);
    await expect.poll(async () => (await mcp.sessions()).length).toBe(1);
    const clientId = (await mcp.sessions())[0].clientId;
    const query = '(**.value == "SPEED_LIMIT") or (**.warningSign == "SPEED_LIMIT")';
    const started = await mcp.call('viewer_start_search', {
        clientId, query, scope: 'auto',
        mapLayers: [{mapId: TEST_MAP_NAMES[0], layerId: TEST_LAYER_NAMES[0]}],
        viewIds: ['0'], tileLevels: [13]
    });
    expect(started.isError, JSON.stringify(started.structuredContent)).not.toBe(true);
    const searchId = started.structuredContent.searchId;
    const read = async () => {
        const response = await mcp.call('viewer_get_search', {clientId, searchId});
        expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
        return response.structuredContent;
    };
    await expect.poll(async () => (await read()).preparation.status).toBe('ready');
    await expect.poll(async () => (await read()).searchComplete).toBe(true);
    const prepared = await read();
    expect(prepared.status.query).toBe(query);
    expect(prepared.status.resultCount).toBeGreaterThan(0);
    expect(prepared.settings.searchStyleRules).toHaveLength(2);
    expect(prepared.settings.searchStyleRules.every((rule: {color: {mode: string; field?: string}}) =>
        rule.color.mode === 'categories' && rule.color.field === 'attributeValue.warningSign')).toBe(true);
    await expect(page.getByText('Search preparation failed', {exact: true})).toHaveCount(0);
});

/** The synthetic map deliberately declares an attribute and an enum named SPEED_LIMIT. */
test('confirmed input chooses its meaning before dispatch and prepares category styling', async ({page, request}) => {
    await page.addInitScript(() => {
        const BrowserWorker = window.Worker;
        window.Worker = class extends BrowserWorker {
            constructor(...args: ConstructorParameters<typeof Worker>) {
                super(...args);
                const delayed = new WeakSet<Event>();
                this.addEventListener('message', event => {
                    if (!['SearchScopeAnalysisResult', 'SearchStyleFieldsResult'].includes(event.data?.type) || delayed.has(event)) return;
                    event.stopImmediatePropagation();
                    const response = new MessageEvent('message', {data: event.data});
                    delayed.add(response);
                    setTimeout(() => this.dispatchEvent(response), 500);
                });
            }
        };
    });
    await page.goto('/?v2=1&vid=0&n=1&f=0&lon=11&lat=48&alt=1000&bg=~0&l=');
    await waitForAppReady(page);
    await enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
    const mcp = mcpClient(request);
    await expect.poll(async () => (await mcp.sessions()).length).toBe(1);
    const clientId = (await mcp.sessions())[0].clientId;
    const started = await mcp.call('viewer_start_search', {clientId, query: 'true', scope: 'auto',
        mapLayers: [{mapId: TEST_MAP_NAMES[0], layerId: TEST_LAYER_NAMES[0]}], viewIds: ['0'], tileLevels: [13]});
    expect(started.isError, JSON.stringify(started.structuredContent)).not.toBe(true);
    const searchId = started.structuredContent.searchId;
    const read = async () => {
        const response = await mcp.call('viewer_get_search', {clientId, searchId});
        expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
        return response.structuredContent;
    };
    await expect.poll(async () => (await read()).searchComplete).toBe(true);
    const previous = await read();
    const editor = page.locator('simfil-expression-input .cm-content[contenteditable="true"]').first();
    await editor.fill('SPEED_LIMIT');
    // A draft may request completions; it must not prepare or replace a search.
    await expect.poll(async () => (await read()).status.query).toBe('true');
    await expect(page.getByTestId('search-interpretation')).toHaveCount(0);
    await editor.press('Escape');
    await editor.press('Enter');
    await expect(page.getByTestId('search-preparation-spinner')).toHaveText('Finding query interpretations');
    await expect(page.getByTestId('search-interpretation')).toHaveCount(2);
    await expect(page.getByRole('heading', {name: 'Choose one interpretation'})).toBeVisible();
    await expect(page.getByTestId('search-interpretations-all')).toHaveCount(0);
    await expect(page.getByTestId('feature-search-panel')).toHaveCount(0);
    await expect(page.locator('.feature-search-progress-meter')).toHaveCount(0);
    let pending = await read();
    expect(pending.preparation.status).toBe('needs-choice');
    expect(pending.preparation.activeQuery).toBe('true');
    expect(pending.status.resultCount).toBe(previous.status.resultCount);
    expect(pending.searchComplete).toBe(false);
    const enumChoice = pending.preparation.interpretations.find((meaning: {kind: string}) => meaning.kind === 'enum');
    expect(enumChoice).toBeDefined();
    await page.getByTestId('search-interpretation').filter({hasText: 'SPEED_LIMIT enum value'}).click();
    await expect(page.getByTestId('search-preparation-spinner')).toHaveText('Preparing visualization');
    await expect(page.getByTestId('feature-search-panel')).toHaveCount(0);
    await expect.poll(async () => (await read()).searchComplete).toBe(true);
    const chosen = await read();
    expect(chosen.status.query).toBe(enumChoice.query);
    expect(chosen.settings.interpretationIds).toBeUndefined();
    await expect(editor).toHaveText(enumChoice.query);
    expect(chosen.status.resultCount).toBeGreaterThan(0);
    expect(chosen.settings.searchStyleRules).toHaveLength(2);
    expect(chosen.settings.searchStyleRules[0].opacity).toBe(0.6);
    expect(chosen.settings.searchStyleRules.every((rule: {color: {mode: string; field?: string}}) =>
        rule.color.mode === 'categories' && rule.color.field === 'attributeValue.warningSign')).toBe(true);
    expect(chosen.schemaAnalysis.normalizedQuery).toBe(enumChoice.query);
    expect(chosen.schemaAnalysis.normalizedQuery).not.toContain('hasSymbol');
    await expect(page.getByTestId('feature-search-panel')).toBeVisible();
    // Changing result scope evaluates the accepted expression; it must not
    // revive the ambiguity of the original SPEED_LIMIT shorthand.
    await page.getByTestId('feature-search-scope').click();
    await page.getByRole('option', {name: 'Feature', exact: true}).click();
    await expect.poll(async () => (await read()).searchComplete).toBe(true);
    await expect(page.getByTestId('search-interpretation')).toHaveCount(0);
    expect((await read()).status.query).toBe(enumChoice.query);
    await page.getByTestId('feature-search-scope').click();
    await page.getByRole('option', {name: 'Auto', exact: true}).click();
    await expect.poll(async () => (await read()).searchComplete).toBe(true);
    // Refresh and viewport changes reuse the explicit choice.
    await mcp.call('viewer_control_search', {clientId, searchId, operation: 'refresh'});
    await expect.poll(async () => (await read()).searchComplete).toBe(true);
    pending = await read();
    expect(pending.status.query).toBe(enumChoice.query);

    // Completion proposes that same ordinary expression. Accepting it only
    // edits the draft; Enter is still the search preparation boundary.
    await editor.fill('SPEED_LIM');
    await editor.press('I');
    const popup = page.locator('.completion-popup:not(.completion-popup-hidden)');
    const qualified = popup.locator('.hint').filter({hasText: 'SPEED_LIMIT enum value'}).first();
    await expect(qualified).toBeVisible({timeout: 15000});
    await qualified.click();
    expect((await read()).status.query).toBe(enumChoice.query);
    await editor.press('Enter');
    await expect.poll(async () => (await read()).searchComplete).toBe(true);
    const completed = await read();
    expect(completed.status.query).toBe(enumChoice.query);
    expect(completed.settings.interpretationIds).toBeUndefined();
    await expect(page.getByTestId('search-interpretation')).toHaveCount(0);
});

/** Both input spellings must resolve to the same typed attribute membership. */
test('bare and quoted enum searches share membership and exclude unrelated features', async ({page, request}) => {
    await page.goto('/?v2=1&vid=0&n=1&f=0&lon=11&lat=48&alt=1000&bg=~0&l=');
    await waitForAppReady(page);
    const mcp = mcpClient(request);
    await expect.poll(async () => (await mcp.sessions()).length).toBe(1);
    const clientId = (await mcp.sessions())[0].clientId;
    const counts: number[] = [];
    for (const [query, scope] of [['ANIMALS', 'auto'], ['"ANIMALS"', 'auto'], ['any("ANIMALS")', 'auto'], ['ANIMALS', 'feature']]) {
        const response = await mcp.call('viewer_start_search', {clientId, query, scope,
            mapLayers: [{mapId: TEST_MAP_NAMES[0], layerId: TEST_LAYER_NAMES[0]}], viewIds: ['0'], tileLevels: [13]});
        expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
        const searchId = response.structuredContent.searchId;
        let status: any;
        await expect.poll(async () => {
            const result = await mcp.call('viewer_get_search', {clientId, searchId});
            expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
            status = result.structuredContent;
            return status.searchComplete;
        }).toBe(true);
        expect(status.schemaAnalysis.concreteScope).toBe(scope === 'feature' ? 'feature' : 'attribute');
        counts.push(status.status.resultCount);
        const rows = await mcp.call('viewer_get_search_results', {clientId, searchId, limit: 100});
        expect(rows.structuredContent.results.length).toBeGreaterThan(0);
        expect(rows.structuredContent.results.every((row: {featureId: string; attributeIndex?: number}) =>
            row.featureId === 'Way.1' && (scope === 'feature' ? row.attributeIndex === undefined : row.attributeIndex !== undefined))).toBe(true);
        await mcp.call('viewer_control_search', {clientId, searchId, operation: 'close'});
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts).toEqual([counts[0], counts[0], counts[0], counts[0]]);
});

/** Restored disabled searches have no preparation; their saved tabs must still work. */
test('a unique attribute keeps its name and disabled searches remain inspectable after reload', async ({page, request}) => {
    await page.goto('/?v2=1&vid=0&n=1&f=0&lon=11&lat=48&alt=1000&bg=~0&l=');
    await waitForAppReady(page);
    const mcp = mcpClient(request);
    await expect.poll(async () => (await mcp.sessions()).length).toBe(1);
    let clientId = (await mcp.sessions())[0].clientId;
    const started = await mcp.call('viewer_start_search', {clientId, query: 'true', scope: 'auto',
        mapLayers: [{mapId: TEST_MAP_NAMES[0], layerId: TEST_LAYER_NAMES[0]}], viewIds: ['0'], tileLevels: [13]});
    expect(started.isError, JSON.stringify(started.structuredContent)).not.toBe(true);
    const searchId = started.structuredContent.searchId;
    const read = async () => {
        const response = await mcp.call('viewer_get_search', {clientId, searchId});
        expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
        return response.structuredContent;
    };
    await expect.poll(async () => (await read()).searchComplete).toBe(true);

    // Finish a visible attribute suggestion by typing. An exact plain-name
    // suggestion disappears; Enter must still submit that name unchanged.
    const editor = page.locator('simfil-expression-input .cm-content[contenteditable="true"]').first();
    await editor.fill('WARNING_SIG');
    const popup = page.locator('.completion-popup:not(.completion-popup-hidden)');
    await expect(popup.locator('.hint').filter({hasText: 'WARNING_SIGN attribute'}).first()).toBeVisible();
    await editor.press('N');
    await expect(popup).toBeHidden();
    await editor.press('Enter');
    await expect.poll(async () => (await read()).status.query).toBe('WARNING_SIGN');
    await expect.poll(async () => (await read()).searchComplete).toBe(true);
    await expect(editor).toHaveText('WARNING_SIGN');
    expect((await read()).status.resultCount).toBeGreaterThan(0);
    const originalRules = (await read()).settings.searchStyleRules;
    expect(originalRules.length).toBeGreaterThan(0);

    await page.getByTestId('feature-search-enabled-toggle').click();
    await expect.poll(async () => (await read()).settings.enabled).toBe(false);
    await page.reload();
    await waitForAppReady(page);
    await expect.poll(async () => {
        const sessions = await mcp.sessions();
        return sessions.length === 1 && sessions[0].clientId !== clientId;
    }).toBe(true);
    clientId = (await mcp.sessions())[0].clientId;
    await expect(page.getByTestId('search-preparation')).toHaveCount(0);
    await expect(page.locator('.feature-search-progress-label')).toHaveText('Search disabled');
    const tabs = page.getByTestId('feature-search-panel');
    await expect(tabs).toBeVisible();
    await tabs.getByRole('tab', {name: /Visualization/}).click();
    await expect(tabs.getByRole('tab', {name: /Visualization/})).toHaveAttribute('aria-selected', 'true');
    await tabs.getByRole('tab', {name: /Diagnostics/}).click();
    await expect(tabs.getByRole('tab', {name: /Diagnostics/})).toHaveAttribute('aria-selected', 'true');
    const disabled = await read();
    expect(disabled.settings.enabled).toBe(false);
    expect(disabled.status.query).toBe('WARNING_SIGN');
    expect(disabled.settings.searchStyleRules).toEqual(originalRules);

    await page.getByTestId('feature-search-enabled-toggle').click();
    await expect.poll(async () => (await read()).settings.enabled).toBe(true);
    await expect.poll(async () => (await read()).searchComplete).toBe(true);
    expect((await read()).status.query).toBe('WARNING_SIGN');
    expect((await read()).status.resultCount).toBeGreaterThan(0);
});
