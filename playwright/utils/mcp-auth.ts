import {readFileSync} from 'node:fs';
import {sign} from 'node:crypto';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import type {Duplex} from 'node:stream';
import type {Page} from '@playwright/test';

const issuer = 'https://issuer.example/realm';
const audience = 'https://viewer.example/mcp';
const now = () => Math.floor(Date.now() / 1000);
/** Real upgrade-only test proxy: inject authority at the trusted peer, never in browser messages. */
export async function proxyBrowserAuthority(page: Page, subject: string, baseURL: string) {
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
    const close = async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
    };
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
    return close;
}

/** Signed by the fixture issuer; neither shared Keycloak nor a real account is involved. */
export function bearer(overrides: Record<string, unknown> = {}) {
    const key = readFileSync(join(process.cwd(), 'playwright', '.cache',
        `mcp-test-key-${process.env['EB_APP_PORT'] || '9000'}.pem`));
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({alg: 'RS256', typ: 'JWT', kid: 'test-key'})}.${encode({
        iss: issuer, sub: 'user-1', aud: audience, exp: now() + 600,
        scope: 'openid viewer', access: {roles: ['read', 'control']}, ...overrides
    })}`;
    return `Bearer ${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}
