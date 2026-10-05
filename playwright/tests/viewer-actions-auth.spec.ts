import {readFileSync} from 'node:fs';
import {sign} from 'node:crypto';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import type {Duplex} from 'node:stream';
import type {Page} from '@playwright/test';
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

/** Real upgrade-only test proxy: inject authority at the trusted peer, never in browser messages. */
async function proxyBrowserAuthority(page: Page, subject: string, baseURL: string) {
    const backend = new URL(baseURL);
    const sockets = new Set<Duplex>();
    const server = createServer((_request, response) => { response.writeHead(404).end(); });
    server.on('upgrade', (request, socket, head) => {
        const upstream = connect({host: '127.0.0.1', port: Number(backend.port)}, () => {
            const headers = {...request.headers, host: backend.host,
                'test-issuer': issuer, 'test-subject': subject, 'test-expiry': String(now() + 600),
                'test-permissions': 'viewer-read viewer-control'};
            upstream.write(`GET ${request.url} HTTP/1.1\r\n` + Object.entries(headers)
                .filter(([, value]) => value !== undefined)
                .map(([key, value]) => `${key}: ${value}`).join('\r\n') + '\r\n\r\n');
            if (head.length) upstream.write(head);
            socket.pipe(upstream).pipe(socket);
        });
        for (const connection of [socket, upstream]) {
            sockets.add(connection);
            connection.on('close', () => sockets.delete(connection));
        }
        socket.on('error', () => upstream.destroy());
        upstream.on('error', () => socket.destroy());
        socket.on('close', () => upstream.destroy());
        upstream.on('close', () => socket.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    closeProxies.push(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test proxy address');
    // Chromium's extraHTTPHeaders do not cover WebSocket handshakes. Route only
    // the connection URL; all real WS bytes/controls still travel to native mapget.
    await page.addInitScript(port => {
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = class extends NativeWebSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
                const target = new URL(url, document.baseURI);
                if (target.pathname === '/interactive') target.host = `127.0.0.1:${port}`;
                super(target.href, protocols);
            }
        };
    }, address.port);
}

/** Signed by the fixture issuer; neither shared Keycloak nor a real account is involved. */
function bearer(overrides: Record<string, unknown> = {}) {
    const key = readFileSync(join(process.cwd(), 'playwright', '.cache',
        `mcp-test-key-${process.env['EB_APP_PORT'] || '9000'}.pem`));
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({alg: 'RS256', typ: 'JWT', kid: 'test-key'})}.${encode({
        iss: issuer, sub: 'user-1', aud: audience, exp: now() + 600,
        scope: 'openid viewer', access: {roles: ['read', 'control']}, ...overrides
    })}`;
    return `Bearer ${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}

async function openAuthenticatedViewer(page: Page, subject: string, baseURL: string) {
    await proxyBrowserAuthority(page, subject, baseURL);
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
