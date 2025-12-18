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

test.describe('Snapshot – feature inspection', () => {
    test('multiple pinned inspection panels', async ({ page, request }) => {
        await requireTestMapSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, TEST_MAP_NAME, TEST_LAYER_NAME);
        await navigateToArea(page, ...TEST_VIEW_POSITION);

        await runFeatureSearch(page, '**.name');
        await clickSearchResultLeaf(page, 0);

        const firstPanel = page.locator('.inspection-container .inspect-panel').first();
        await expect(firstPanel).toBeVisible();

        // Pin the first panel and open a second one.
        const pinIcon = firstPanel.locator('.material-symbols-outlined', { hasText: 'keep_off' }).first();
        await expect(pinIcon).toBeVisible();
        await pinIcon.click();

        await clickSearchResultLeaf(page, 1);

        const inspectionContainer = page.locator('.inspection-container').first();
        await expect(inspectionContainer).toBeVisible();
        await expect(inspectionContainer.locator('.inspect-panel')).toHaveCount(2);

        await expect(inspectionContainer).toHaveScreenshot('feature-inspection-multi.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});
