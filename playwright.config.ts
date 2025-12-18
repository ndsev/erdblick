import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

function loadEnvFile(envPath: string): void {
    let raw: string;
    try {
        raw = fs.readFileSync(envPath, 'utf8');
    } catch (err: any) {
        if (err?.code === 'ENOENT') {
            return;
        }
        throw err;
    }

    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const eq = trimmed.indexOf('=');
        if (eq <= 0) {
            continue;
        }

        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();

        // Strip surrounding quotes to allow values like: FOO="bar baz"
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

// Allow parametrising Playwright tests via deps/erdblick/test/.env.
loadEnvFile(path.resolve(__dirname, 'test', '.env'));

const port = process.env["EB_APP_PORT"] || '9000';
const baseURL = process.env["EB_APP_URL"] || `http://localhost:${port}`;

export default defineConfig({
    testDir: './playwright',
    snapshotDir: './playwright/reference',
    timeout: 240000,
    forbidOnly: !!process.env["CI"],
    retries: process.env["CI"] ? 1 : 0,
    expect: {
        timeout: 80000
    },
    reporter: process.env["CI"] ? 'dot' : 'list',
    use: {
        baseURL,
        headless: true,
        testIdAttribute: 'data-testid',
        viewport: {
            width: 1600,
            height: 900
        },
        actionTimeout: 80000,
        navigationTimeout: 80000,
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
        launchOptions: {
            args: [
                '--use-gl=swiftshader',
                '--disable-gpu',
                '--ignore-gpu-blocklist'
            ],
            env: {
                LIBGL_ALWAYS_SOFTWARE: '1',
                ...(process.env as Record<string, string | undefined>)
            }
        },
        timezoneId: 'UTC',
        locale: 'en-US',
    },
    globalSetup: './playwright/global-setup.ts',
    globalTeardown: './playwright/global-teardown.ts',
    workers: process.env["CI"] ? 1 : 4
});
