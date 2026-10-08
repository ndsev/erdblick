import type {Page} from '@playwright/test';
import {bearer, proxyBrowserAuthority} from '../utils/mcp-auth';
import {expect, test} from '../fixtures/test';
import {mcpClient} from '../utils/mcp-client';
import {viewerActions} from '../../app/actions/viewer-action.contract';

test.use({stateSnapshot: null});
test.skip(process.env['EB_MAPGET_MCP_TEST_OAUTH'] !== '1', 'Requires the disposable native OAuth fixture');

const issuer = 'https://issuer.example/realm';
const audience = 'https://viewer.example/mcp';
const now = () => Math.floor(Date.now() / 1000);
const closeProxies: Array<() => Promise<void>> = [];
test.afterEach(async () => {
    await Promise.all(closeProxies.splice(0).map(close => close()));
});

async function openAuthenticatedViewer(page: Page, subject: string, baseURL: string) {
    closeProxies.push(await proxyBrowserAuthority(page, subject, baseURL));
    await page.goto('/?v2=1&n=1&m=1&f=0&lon=10&lat=40&alt=1000&h=0&p=-1&r=0&px=0&py=0&pz=0&m2d=0&bg=~10&l=');
    await page.getByTestId('viewer-action-status').click();
    await expect(page.getByTestId('viewer-action-details')).toContainText('MCP controls ready');
    await page.getByLabel('Tab label', {exact: true}).fill(subject);
    await page.getByLabel('Tab label', {exact: true}).press('Tab');
}

test('native OAuth scopes discovery/control to the authenticated principal', async ({page, browser, request, baseURL}) => {
    const owner = mcpClient(request, {Authorization: bearer()});
    const other = mcpClient(request, {Authorization: bearer({sub: 'user-2'})});
    await openAuthenticatedViewer(page, 'user-1', baseURL!);
    const otherContext = await browser.newContext({baseURL});
    try {
        const otherPage = await otherContext.newPage();
        await openAuthenticatedViewer(otherPage, 'user-2', baseURL!);
        await expect.poll(async () => (await owner.sessions()).map(value => value.label)).toEqual(['user-1']);
        await expect.poll(async () => (await other.sessions()).map(value => value.label)).toEqual(['user-2']);
        const clientId = (await owner.sessions())[0].clientId;
        const otherId = (await other.sessions())[0].clientId;
        const denied = await owner.call('viewer_get_app_state', {clientId: otherId});
        expect(denied.isError).toBe(true);
        // Trusted browser proxy claims are deliberately ignored for the bearer-authenticated MCP caller.
        const spoof = mcpClient(request, {Authorization: bearer(), 'test-subject': 'user-2'});
        expect((await spoof.sessions()).map(value => value.clientId)).toEqual([clientId]);

        const read = await owner.call('viewer_get_app_state', {clientId, targets: [{channel: 'view.camera', viewIndex: 0}]});
        expect(read.isError).not.toBe(true);
        const value = {destination: {lon: 11, lat: 41, alt: 700},
            orientation: {heading: 0, pitch: -1, roll: 0}, position: [0, 0, 0]};
        const write = {clientId, target: {channel: 'view.camera', viewIndex: 0}, value,
            viewLayoutRevision: read.structuredContent.viewLayoutRevision};
        const applied = await owner.call('viewer_set_app_state', write);
        expect(applied.isError).not.toBe(true);
        expect(applied.structuredContent.status).toBe('applied');
        const readonly = mcpClient(request, {Authorization: bearer({access: {roles: ['read']}})});
        const listed = await readonly.rpc('tools/list');
        const names = listed.message.result.tools.map((tool: {name: string}) => tool.name);
        for (const [name, action] of Object.entries(viewerActions)) {
            if (action.mutation) expect(names).not.toContain(name);
            else expect(names).toContain(name);
        }
        expect((await readonly.call('viewer_set_app_state', write)).isError).toBe(true);
    } finally {
        await otherContext.close();
    }
});

test('native OAuth rejects missing/invalid bearer identity and publishes resource metadata', async ({request}) => {
    const missing = await mcpClient(request).rpc('tools/list');
    expect(missing.response.status()).toBe(401);
    expect(missing.response.headers()['www-authenticate']).toContain('resource_metadata=');
    const metadata = await request.get('/.well-known/oauth-protected-resource/mcp');
    expect(metadata.ok()).toBe(true);
    expect(await metadata.json()).toMatchObject({resource: audience, authorization_servers: [issuer]});
    for (const claims of [{aud: 'https://wrong.example/mcp'}, {iss: 'https://wrong.example/realm'}, {exp: now() - 60}]) {
        const invalid = await mcpClient(request, {Authorization: bearer(claims)}).rpc('tools/list');
        expect(invalid.response.status()).toBe(401);
    }
    const scope = await mcpClient(request, {Authorization: bearer({scope: 'openid'})}).rpc('tools/list');
    expect(scope.response.status()).toBe(403);
});
