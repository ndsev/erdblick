import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAME, TEST_MAP_NAME, TEST_VIEW_POSITION } from '../utils/test-params';
import { addComparisonView, enableMapLayer, navigateToArea, navigateToRoot } from '../utils/ui-helpers';

test.describe('Snapshot – split view', () => {
    test('two map views side-by-side', async ({ page, request }) => {
        await requireTestMapSource(request);
        await navigateToRoot(page);
        await enableMapLayer(page, TEST_MAP_NAME, TEST_LAYER_NAME);

        await addComparisonView(page);
        await navigateToArea(page, ...TEST_VIEW_POSITION);

        const mapContainer = page.locator('mapview-container').first();
        await expect(mapContainer).toBeVisible();

        await expect(mapContainer).toHaveScreenshot('split.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});
