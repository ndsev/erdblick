import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAME, TEST_MAP_NAME, TEST_VIEW_POSITION } from '../utils/test-params';
import { enableMapLayer, navigateToArea, navigateToRoot } from '../utils/ui-helpers';

/**
 * Visual regression tests for the single-view map layout.
 *
 * These tests load `TestMap/WayLayer` in a single map view, navigate to a
 * known coordinate and assert that the rendered map container matches the
 * stored `map-single-view.png` snapshot within a small pixel difference.
 */

test.describe('Snapshot – single map view', () => {
    test('TestMap/WayLayer single-view layout', async ({ page, request }) => {
        await requireTestMapSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, TEST_MAP_NAME, TEST_LAYER_NAME);
        await navigateToArea(page, ...TEST_VIEW_POSITION);

        // Capture the rendered single-view map container for comparison.
        const mapContainer = page.getByTestId('mapViewContainer-0');
        await expect(mapContainer).toBeVisible();

        await expect(mapContainer).toHaveScreenshot('map-single-view.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});
