import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import { enableMapLayer, navigateToRoot } from '../utils/ui-helpers';

test.describe('Simfil feature search over Python datasource', () => {
    test('valid simfil query returns search results', async ({ page, request }) => {
        await requireTestMapSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, 'TestMap', 'WayLayer');

        const searchInput = page.locator('textarea[placeholder="Search"]');
        await searchInput.click();
        const searchMenuContainer = page.locator('.resizable-container').filter({
            has: page.locator('.search-menu-dialog')
        }).first();
        // Inside this container, .p-dialog-content is our search menu
        const searchMenu = searchMenuContainer.locator('.p-dialog-content');
        await expect(searchMenu).toBeVisible();
        const firstSearchMenuEntry = searchMenu.locator('.search-menu').first();
        const searchLoadedFeatures = firstSearchMenuEntry.locator('.search-option-name', {
            hasText: 'Search Loaded Features'
        }).first();
        await expect(searchLoadedFeatures).toBeVisible();
        await searchInput.fill('properties.isBridge == false');
        await searchInput.focus();
        await page.keyboard.press('Enter');

        const featureSearch = page.locator('.feature-search-dialog').first();
        const featureSearchHeader = featureSearch.locator('.p-dialog-header').first();
        await expect(featureSearchHeader).toBeVisible();
        const _ = featureSearchHeader.locator('.p-dialog-title', {
            hasText: 'Search Loaded Features'
        }).first();

        const featureSearchContent = featureSearch.locator('.p-dialog-content').first();
        await expect(featureSearchContent).toBeVisible();

        const resultsBadge = featureSearchContent.locator('.p-badge').first();
        await expect.poll(async () => {
            const text = await resultsBadge.innerText();
            const value = parseInt(text || '0', 10);
            return Number.isNaN(value) ? 0 : value;
        }, {
            timeout: 20000
        }).toBeGreaterThan(0);

        // Verify that empty-tree message is not present for a successful search
        const emptyMessage = featureSearchContent.locator('.p-tree-empty-message');
        await expect(emptyMessage).toHaveCount(0);
    });
});
