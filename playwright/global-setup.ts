import type { FullConfig } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

interface GlobalState {
    mapgetPid: number | null;
    baseURL: string;
}

async function waitForSources(baseURL: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const ok = await new Promise<boolean>((resolve) => {
            try {
                const req = http.get(
                    `${baseURL.replace(/\/$/, '')}/sources`,
                    (res) => {
                        if (res.statusCode !== 200) {
                            res.resume();
                            resolve(false);
                            return;
                        }
                        const chunks: Buffer[] = [];
                        res.on('data', (chunk) => chunks.push(chunk as Buffer));
                        res.on('end', () => {
                            try {
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

        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}

async function globalSetup(config: FullConfig): Promise<void> {
    const configDir = config.configDir ?? process.cwd();
    const projectRoot = configDir;
    const port = process.env.EB_APP_PORT || '9000';
    const baseURL = process.env.EB_APP_URL || `http://localhost:${port}`;

    const mapgetConfigPath = path.join(projectRoot, 'test', 'mapget-integration.yaml');
    if (!fs.existsSync(mapgetConfigPath)) {
        throw new Error(`Expected mapget config at ${mapgetConfigPath}`);
    }

    const mapgetExecutable = process.env.MAPGET_BIN || 'mapget';
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

    const stateDir = path.join(projectRoot, 'playwright', '.cache');
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, 'global-state.json');
    fs.writeFileSync(statePath, JSON.stringify(state), { encoding: 'utf-8' });

    await waitForSources(baseURL, 60000);
}

export default globalSetup;
