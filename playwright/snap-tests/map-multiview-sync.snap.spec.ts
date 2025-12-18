import { expect, test } from '../fixtures/test';
import { TEST_VIEW_POSITION } from '../utils/test-params';
import {
    navigateToArea,
    setupTwoViewsWithPositionSync
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
        await navigateToArea(page, ...TEST_VIEW_POSITION);

        // The map view container should present both synchronised views.
        const mapContainer = page.getByTestId('mapview-container');
        await expect(mapContainer).toBeVisible();

        await expect(mapContainer).toHaveScreenshot('map-multiview-sync.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});
