import {expect, test} from '../fixtures/test';
import type {Page} from '@playwright/test';
import {viewerActions} from '../../app/actions/viewer-action.contract';

// Exercise the actual browser implementation, never an injected modelContext polyfill.
// Chrome 153 supports document.modelContext behind the WebMCP flag and takes stringified input.
test.use({stateSnapshot: null, channel: 'chrome', launchOptions: {args: ['--enable-features=WebMCP', '--enable-blink-features=WebMCP']}});
test.skip(process.env['EB_WEBMCP_NATIVE'] !== '1' || process.env['EB_MAPGET_MCP_LOCAL'] !== '1',
    'Opt in with EB_WEBMCP_NATIVE=1 EB_MAPGET_MCP_LOCAL=1 and an installed WebMCP-capable Chrome');

type ModelContext = {
    getTools(): Promise<Array<{name: string; inputSchema: Record<string, unknown>}>>;
    executeTool(tool: {name: string}, input: string | Record<string, unknown>): Promise<string>;
};

/** Ask the browser to invoke the registered tool, including native schema and callback dispatch. */
async function call(page: Page, name: string, input: Record<string, unknown> = {}) {
    return page.evaluate(async ({name, input}) => {
        const context = (document as Document & {modelContext: ModelContext}).modelContext;
        const tool = (await context.getTools()).find(tool => tool.name === name);
        if (!tool) throw new Error(`Missing WebMCP tool ${name}`);
        const chromeMajor = Number(navigator.userAgent.match(/Chrome\/(\d+)/)?.[1]);
        return JSON.parse(await context.executeTool(tool, chromeMajor >= 155 ? input : JSON.stringify(input)));
    }, {name, input});
}

test('native WebMCP discovers all tools, controls only this document and calls real mapget', async ({page, context}) => {
    await page.goto('/?v2=1&n=1&lon=11&lat=48&alt=500&m2d=0&l=');
    await page.getByTestId('viewer-action-status').click();
    await expect(page.getByTestId('viewer-action-details')).toContainText('WebMCP ready for this tab and mapget');
    const names = await page.evaluate(async () =>
        (await (document as Document & {modelContext: ModelContext}).modelContext.getTools()).map(tool => tool.name));
    expect(names.filter(name => name.startsWith('viewer_')).sort()).toEqual(Object.keys(viewerActions).sort());
    expect(names).not.toContain('viewer_list_sessions');
    expect(names).toContain('mapget_docs');
    const native = await page.evaluate(async () => {
        const response = await fetch('/mcp/browser', {method: 'POST', headers: {
            'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25'
        }, body: JSON.stringify({jsonrpc: '2.0', id: 7, method: 'tools/list', params: {}})});
        return (await response.json()).result.tools.map((tool: {name: string}) => tool.name);
    });
    expect(names.filter(name => name.startsWith('mapget_')).sort()).toEqual(native.sort());
    const second = await context.newPage();
    try {
        await second.goto('/?v2=1&n=1&lon=20&lat=50&alt=1000&m2d=0&l=');
        await expect.poll(() => second.evaluate(async () =>
            (await (document as Document & {modelContext: ModelContext}).modelContext.getTools()).map(tool => tool.name)))
            .toContain('viewer_get_app_state');
        const before = await call(page, 'viewer_get_app_state', {targets: [{channel: 'view.projection', viewIndex: 0}]});
        const otherBefore = await call(second, 'viewer_get_app_state', {targets: [{channel: 'view.projection', viewIndex: 0}]});
        const applied = await call(page, 'viewer_set_app_state', {
            target: {channel: 'view.projection', viewIndex: 0}, value: '2d', viewLayoutRevision: before.viewLayoutRevision
        });
        expect(applied).toMatchObject({status: 'applied', value: '2d'});
        expect((await call(second, 'viewer_get_app_state', {targets: [{channel: 'view.projection', viewIndex: 0}]})).values)
            .toEqual(otherBefore.values);
        const sources = await call(page, 'mapget_list_sources', {details: false});
        expect(sources.isError).toBe(false);
        expect(sources.structuredContent.items.length).toBeGreaterThan(0);
        const badInput = await call(page, 'viewer_get_app_state', {clientId: 'not-this-document'});
        expect(badInput).toMatchObject({isError: true, error: {code: 'invalid_arguments'}});
        await expect(page.getByTestId('viewer-action-details')).toContainText('viewer_set_app_state');
        await page.reload();
        await expect.poll(async () => page.evaluate(async () =>
            (await (document as Document & {modelContext: ModelContext}).modelContext.getTools()).length)).toBe(names.length);
    } finally {
        await second.close();
    }
});
