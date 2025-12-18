import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAME, TEST_MAP_NAME, TEST_VIEW_POSITION } from '../utils/test-params';
import {
    clickSearchResultLeaf,
    enableMapLayer,
    navigateToArea,
    navigateToRoot,
    runFeatureSearch
} from '../utils/ui-helpers';

test.describe('Snapshot – feature inspection details', () => {
    test('inspection tree with filter applied', async ({ page, request }) => {
        await requireTestMapSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, TEST_MAP_NAME, TEST_LAYER_NAME);
        await navigateToArea(page, ...TEST_VIEW_POSITION);

        await runFeatureSearch(page, '**.name');
        await clickSearchResultLeaf(page, 0);

        const panel = page.locator('.inspection-container .inspect-panel').first();
        await expect(panel).toBeVisible();

        const filterInput = panel.locator('input.filter-input[placeholder="Filter inspection tree"]').first();
        await expect(filterInput).toBeVisible();
        await filterInput.fill('addresses');

        await expect(panel).toHaveScreenshot('feature-inspection-details.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});
