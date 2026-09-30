import type {FullConfig} from '@playwright/test';
import {spawn} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import {generateKeyPairSync} from 'node:crypto';

/**
 * Global Playwright setup.
 *
 * Starts a `mapget` server instance before the test suite runs, waits until
 * the backend exposes a `/sources` endpoint, and writes the process id and
 * resolved base URL to `playwright/.cache/global-state-<port>.json` so teardown can
 * later terminate the process. The state filename is scoped by app port so
 * independent Playwright suites can run in parallel without stealing each
 * other's backend PID.
 *
 * The port and base URL can be overridden via `EB_APP_PORT` and `EB_APP_URL`,
 * the config via `EB_MAPGET_CONFIG`, and the `mapget` binary via `MAPGET_BIN`.
 */

interface GlobalState {
    mapgetPid: number | null;
    baseURL: string;
}

/**
 * Polls the `/sources` endpoint until it returns a JSON array or the timeout
 * elapses. This is used to ensure the `mapget` backend is fully ready before
 * browser tests start issuing requests.
 *
 * @param baseURL Base URL of the `mapget` server.
 * @param timeoutMs Maximum time to wait in milliseconds.
 * @throws Error when the timeout expires before `/sources` responds with an array.
 */
async function waitForSources(baseURL: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (true) {
        // Keep polling `/sources` until it returns a valid JSON array.
        const ok = await new Promise<boolean>((resolve) => {
            try {
                const req = http.get(
                    `${baseURL.replace(/\/$/, '')}/sources`,
                    (res) => {
                        // Treat non-200 responses as "not ready yet".
                        if (res.statusCode !== 200) {
                            res.resume();
                            resolve(false);
                            return;
                        }
                        const chunks: Buffer[] = [];
                        res.on('data', (chunk) => chunks.push(chunk as Buffer));
                        res.on('end', () => {
                            try {
                                // Parse the response body and ensure it is a JSON array.
                                const body = Buffer.concat(chunks).toString('utf-8');
                                const json = JSON.parse(body);
                                resolve(Array.isArray(json));
                            } catch {
                                resolve(false);
                            }
                        });
                    }
                );
                req.on('error', () => resolve(false));
            } catch {
                resolve(false);
            }
        });

        if (ok) {
            return;
        }

        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for mapget at ${baseURL}/sources`);
        }

        // Back off briefly before retrying.
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}

/**
 * Playwright `globalSetup` entry point.
 *
 * Verifies that the integration `mapget` configuration exists, spawns a
 * `mapget serve` process configured to serve the built Angular bundle, and
 * stores its pid and base URL in `playwright/.cache/global-state-<port>.json`. The
 * helper then waits for `/sources` to become available before returning.
 */
async function globalSetup(config: FullConfig): Promise<void> {
    const projectRoot = process.cwd();
    // Allow overriding port and base URL for CI or local custom setups.
    const port = process.env["EB_APP_PORT"] || '9000';
    const baseURL = process.env["EB_APP_URL"] || `http://localhost:${port}`;

    const defaultConfigPath = path.join(projectRoot, 'test', 'mapget-integration.yaml');
    const overrideConfig = process.env["EB_MAPGET_CONFIG"];
    const mapgetConfigPath = overrideConfig
        ? (path.isAbsolute(overrideConfig)
            ? overrideConfig
            : path.resolve(projectRoot, overrideConfig))
        : defaultConfigPath;

    // The mapget config must exist; it wires the integration datasource(s).
    if (!fs.existsSync(mapgetConfigPath)) {
        throw new Error(`Expected mapget config at ${mapgetConfigPath}`);
    }

    const mapgetExecutable = process.env["MAPGET_BIN"] || 'mapget';
    const cacheType = process.env["EB_MAPGET_CACHE_TYPE"] || 'none';
    const args = [
        '--config',
        mapgetConfigPath,
        'serve',
    ];
    const mcpOAuthFixture = process.env['EB_MAPGET_MCP_TEST_OAUTH'] === '1';
    if (process.env['EB_MAPGET_MCP_LOCAL'] === '1' || mcpOAuthFixture) {
        const origin = new URL(baseURL);
        if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
            throw new Error('The local MCP test fixture requires a loopback HTTP base URL');
        }
        const mcpConfigPath = path.join(projectRoot, 'playwright', '.cache', `mcp-test-${port}.json`);
        fs.mkdirSync(path.dirname(mcpConfigPath), {recursive: true});
        const alternateOrigin = new URL(origin);
        alternateOrigin.hostname = origin.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
        const origins = origin.hostname === '[::1]' ? [origin] : [origin, alternateOrigin];
        const mcpSettings: Record<string, unknown> = {
            authentication: mcpOAuthFixture ? 'oauth' : 'local',
            endpoint: mcpOAuthFixture ? 'https://viewer.example/mcp' : new URL('/mcp', origin).href,
            catalogPath: path.join(projectRoot, 'static', 'browser', 'viewer-actions.json'),
            allowedHosts: origins.map(value => value.host),
            allowedOrigins: origins.map(value => value.origin)
        };
        if (mcpOAuthFixture) {
            // Disposable test issuer and proxy claims, never shared SSO credentials or a production config.
            const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
            const keyPath = path.join(path.dirname(mcpConfigPath), `mcp-test-key-${port}.pem`);
            const jwksPath = path.join(path.dirname(mcpConfigPath), `mcp-test-jwks-${port}.json`);
            fs.writeFileSync(keyPath, privateKey.export({type: 'pkcs8', format: 'pem'}), {mode: 0o600});
            fs.writeFileSync(jwksPath, JSON.stringify({keys: [{
                ...publicKey.export({format: 'jwk'}), alg: 'RS256', use: 'sig', kid: 'test-key'
            }]}));
            mcpSettings['oauth'] = {
                issuer: 'https://issuer.example/realm', audience: 'https://viewer.example/mcp',
                jwksFile: jwksPath, requiredScopes: ['viewer'], clientId: 'public-client', clockSkewSeconds: 0,
                permissions: {
                    'viewer-read': {claim: '/access/roles', value: 'read'},
                    'viewer-control': {claim: '/access/roles', value: 'control'}
                },
                browser: {
                    trustedProxyAddresses: ['127.0.0.1', '::1'], issuerHeader: 'test-issuer',
                    subjectHeader: 'test-subject', expiryHeader: 'test-expiry',
                    permissionsHeader: 'test-permissions', maxLifetimeSeconds: 3600
                }
            };
        }
        fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpSettings));
        args.push('--host', origin.hostname === '[::1]' ? '::1' : '127.0.0.1', '--mcp-config', mcpConfigPath);
    }
    if (process.env["EB_MAPGET_ALLOW_POST_CONFIG"] !== '0') {
        args.push('--allow-post-config');
    }
    args.push(
        '--port',
        port,
        '--cache-type',
        cacheType,
        '--webapp',
        '/:static/browser'
    );

    console.log(`[playwright] Starting mapget backend: ${mapgetExecutable} ${args.join(' ')}`);

    // Start `mapget serve` in the repository root.
    const child = spawn(mapgetExecutable, args, {
        stdio: 'inherit',
        cwd: projectRoot,
        detached: process.platform !== 'win32',
        env: {
            ...process.env,
            HTTP_SETTINGS_FILE: process.env["HTTP_SETTINGS_FILE"] || mapgetConfigPath
        }
    });

    if (!child.pid) {
        throw new Error('Failed to start mapget process');
    }

    const state: GlobalState = {
        mapgetPid: child.pid,
        baseURL
    };
    child.unref();
    console.log(`[playwright] mapget backend pid: ${child.pid}`);

    // Persist pid / URL so `global-teardown` can cleanly shut down the process.
    const stateDir = path.join(projectRoot, 'playwright', '.cache');
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, `global-state-${port}.json`);
    fs.writeFileSync(statePath, JSON.stringify(state), { encoding: 'utf-8' });

    console.log(`[playwright] Waiting for mapget /sources at ${baseURL}`);
    await waitForSources(baseURL, 60000);
    console.log('[playwright] mapget /sources is ready');
}

export default globalSetup;
