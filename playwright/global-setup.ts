import type {FullConfig} from '@playwright/test';
import {spawn} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

/**
 * Global Playwright setup.
 *
 * Starts a `mapget` server instance before the test suite runs, waits until
 * the backend exposes a `/sources` endpoint, and writes the process id and
 * resolved base URL to `playwright/.cache/global-state.json` so teardown can
 * later terminate the process.
 *
 * The port and base URL can be overridden via `EB_APP_PORT` and `EB_APP_URL`,
 * and the `mapget` binary via `MAPGET_BIN`.
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
 * stores its pid and base URL in `playwright/.cache/global-state.json`. The
 * helper then waits for `/sources` to become available before returning.
 */
async function globalSetup(config: FullConfig): Promise<void> {
    const projectRoot = process.cwd();
    // Allow overriding port and base URL for CI or local custom setups.
    const port = process.env["EB_APP_PORT"] || '9000';
    const baseURL = process.env["EB_APP_URL"] || `http://localhost:${port}`;

    // The mapget config must exist; it wires the Python example datasource.
    const mapgetConfigPath = path.join(projectRoot, 'test', 'mapget-integration.yaml');
    if (!fs.existsSync(mapgetConfigPath)) {
        throw new Error(`Expected mapget config at ${mapgetConfigPath}`);
    }

    const mapgetExecutable = process.env["MAPGET_BIN"] || 'mapget';
    const args = [
        '--config',
        mapgetConfigPath,
        'serve',
        '--allow-post-config',
        '--port',
        port,
        '--cache-type',
        'none',
        '--webapp',
        '/:static/browser'
    ];

    // Start `mapget serve` in the repository root.
    const child = spawn(mapgetExecutable, args, {
        stdio: 'inherit',
        cwd: projectRoot
    });

    if (!child.pid) {
        throw new Error('Failed to start mapget process');
    }

    const state: GlobalState = {
        mapgetPid: child.pid,
        baseURL
    };

    // Persist pid / URL so `global-teardown` can cleanly shut down the process.
    const stateDir = path.join(projectRoot, 'playwright', '.cache');
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, 'global-state.json');
    fs.writeFileSync(statePath, JSON.stringify(state), { encoding: 'utf-8' });

    await waitForSources(baseURL, 60000);
}

export default globalSetup;
