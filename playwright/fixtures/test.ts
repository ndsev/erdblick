import { test as base } from '@playwright/test';

declare global {
    interface Window {
        ebDebug?: {
            showTestTile: () => void;
            setCamera: (viewIndex: number, cameraInfoStr: string) => void;
            getCamera: (viewIndex: number) => string | undefined;
        };
    }
}

export const test = base.extend({
    page: async ({ page }, use) => {
        await use(page);
    }
});

export const expect = test.expect;

