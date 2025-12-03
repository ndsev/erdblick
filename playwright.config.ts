import { defineConfig } from '@playwright/test';

const baseURL = process.env["EB_APP_URL"] || 'http://localhost:9000';

export default defineConfig({
    testDir: './playwright',
    snapshotDir: './playwright/reference',
    timeout: 120000,
    expect: {
        timeout: 10000
    },
    reporter: process.env["CI"] ? 'dot' : 'list',
    use: {
        baseURL,
        headless: true,
        viewport: {
            width: 1920,
            height: 1080
        },
        actionTimeout: 20000,
        navigationTimeout: 30000,
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
    workers: process.env["CI"] ? 2 : undefined
});
