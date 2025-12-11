import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import {
    addComparisonView,
    enableMapLayer,
    navigateToArea,
    navigateToRoot, setupTwoViewsWithPositionSync,
    waitForAppReady
} from '../utils/ui-helpers';

/**
 * Visual regression tests for the multi-view synchronised layout.
 *
 * The primary scenario enables position synchronisation between two map views,
 * navigates to a known coordinate and asserts that the combined layout matches
 * the `map-multiview-sync.png` snapshot.
 */

test.describe('Snapshot – multi-view sync layout', () => {
    test('two views with position sync enabled', async ({ page, request }) => {
        await setupTwoViewsWithPositionSync(page, request);
        await navigateToArea(page, 42.5, 11.615, 13);

        // The map view container should present both synchronised views.
        const mapContainer = page.locator('mapview-container');
        await expect(mapContainer).toBeVisible();

        await expect(mapContainer).toHaveScreenshot('map-multiview-sync.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});
