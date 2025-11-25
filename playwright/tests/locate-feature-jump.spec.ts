import { expect, test } from '../fixtures/test';
import { requireTropicoSource } from '../utils/backend-helpers';
import { enableMapLayer, navigateToRoot } from '../utils/ui-helpers';

test.describe('Feature jump /locate integration', () => {
    test('selecting a search result posts /locate', async ({ page, request }) => {
        await requireTropicoSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, 'Tropico', 'WayLayer');

        const locateRequests: string[] = [];
        page.on('request', (req) => {
            if (req.url().endsWith('/locate') && req.method() === 'POST') {
                locateRequests.push(req.url());
            }
        });

        const searchInput = page.locator('textarea[placeholder="Search"]');
        await searchInput.click();
        await searchInput.fill('properties.main_ingredient == "Pepper"');

        const searchMenu = page.locator('.search-menu-dialog');
        await expect(searchMenu).toBeVisible();

        const searchLoadedFeatures = searchMenu.locator('.search-option-name', {
            hasText: 'Search Loaded Features'
        }).first();
        await expect(searchLoadedFeatures).toBeVisible();
        await searchLoadedFeatures.click();

        const featureSearchDialog = page.locator('.feature-search-dialog');
        await expect(featureSearchDialog).toBeVisible();

        const tree = featureSearchDialog.locator('.p-tree');
        const firstResultNode = tree.locator('.p-treenode-content').first();
        await firstResultNode.click();

        await expect.poll(() => locateRequests.length, {
            timeout: 20000
        }).toBeGreaterThan(0);
    });
});
