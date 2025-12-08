import { defineConfig } from '@playwright/test';

const baseURL = process.env["EB_APP_URL"] || 'http://localhost:9000';

export default defineConfig({
    testDir: './playwright',
    snapshotDir: './playwright/reference',
    timeout: 480000,
    expect: {
        timeout: 120000
    },
    reporter: process.env["CI"] ? 'dot' : 'list',
    use: {
        baseURL,
        headless: true,
        viewport: {
            width: 1600,
            height: 900
        },
        actionTimeout: 240000,
        navigationTimeout: 240000,
        screenshot: 'only-on-failure',
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
    workers: process.env["CI"] ? 1 : undefined
});
