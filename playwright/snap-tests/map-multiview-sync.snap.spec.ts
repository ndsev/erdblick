import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import {
    addComparisonView,
    enableMapLayer,
    navigateToArea,
    navigateToRoot, setupTwoViewsWithPositionSync,
    waitForAppReady
} from '../utils/ui-helpers';

test.describe('Snapshot – multi-view sync layout', () => {
    test('two views with position sync enabled', async ({ page, request }) => {
        await setupTwoViewsWithPositionSync(page, request);
        await navigateToArea(page, 42.5, 11.615, 13);

        const mapContainer = page.locator('mapview-container');
        await expect(mapContainer).toBeVisible();

        await expect(mapContainer).toHaveScreenshot('map-multiview-sync.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});

