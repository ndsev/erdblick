import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import {
    enableMapLayer,
    navigateToArea,
    navigateToRoot,
    waitForAppReady
} from '../utils/ui-helpers';

async function runFeatureSearch(page: Page, query: string): Promise<void> {
    const searchInput = page.locator('textarea[placeholder="Search"]');
    await searchInput.click();

    const searchMenuContainer = page.locator('.resizable-container').filter({
        has: page.locator('.search-menu-dialog')
    }).first();
    const searchMenu = searchMenuContainer.locator('.p-dialog-content');
    await expect(searchMenu).toBeVisible();

    const searchLoadedFeatures = searchMenu.locator('.search-menu .search-option-name', {
        hasText: 'Search Loaded Features'
    }).first();
    await expect(searchLoadedFeatures).toBeVisible();

    await searchInput.fill(query);
    await searchInput.focus();
    await page.keyboard.press('Enter');

    const featureSearch = page.locator('.feature-search-dialog').first();
    const featureSearchContent = featureSearch.locator('.p-dialog-content').first();
    await expect(featureSearchContent).toBeVisible();

    const resultsBadge = featureSearchContent.locator('.p-badge').first();
    await expect.poll(async () => {
        const text = await resultsBadge.innerText();
        const value = parseInt(text || '0', 10);
        return Number.isNaN(value) ? 0 : value;
    }, {
        timeout: 10000
    }).toBeGreaterThan(0);
}

async function clickFirstSearchResult(page: Page): Promise<void> {
    const featureSearch = page.locator('.feature-search-dialog').first();
    const tree = featureSearch.locator('.p-tree').first();
    const leafNodes = tree.locator('.p-tree-node-leaf');
    const count = await leafNodes.count();
    if (count === 0) {
        throw new Error('Expected at least one search result leaf node');
    }
    await leafNodes.first().locator('.p-tree-node-content').first().click();
}

test.describe('Snapshot – inspection panel', () => {
    test('inspection panel for TestMap feature selected via search', async ({ page, request }) => {
        await requireTestMapSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, 'TestMap', 'WayLayer');
        await navigateToArea(page, 42.5, 11.65, 11);
        await waitForAppReady(page);

        await runFeatureSearch(page, '**.name');
        await clickFirstSearchResult(page);

        const inspectionContainer = page.locator('.inspection-container');
        await expect(inspectionContainer).toBeVisible();

        await expect(inspectionContainer).toHaveScreenshot('inspection-panel-testmap.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});

