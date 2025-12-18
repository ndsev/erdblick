import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAME, TEST_MAP_NAME, TEST_VIEW_POSITION } from '../utils/test-params';
import { enableMapLayer, navigateToArea, navigateToRoot, runFeatureSearch } from '../utils/ui-helpers';

test.describe('Snapshot – feature search', () => {
    test('feature search results dialog', async ({ page, request }) => {
        await requireTestMapSource(request);
        await navigateToRoot(page);
        await enableMapLayer(page, TEST_MAP_NAME, TEST_LAYER_NAME);
        await navigateToArea(page, ...TEST_VIEW_POSITION);

        await runFeatureSearch(page, '**.name');

        const dialog = page.locator('.feature-search-dialog').first();
        await expect(dialog).toBeVisible();

        await expect(dialog).toHaveScreenshot('search-in-progress.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});
