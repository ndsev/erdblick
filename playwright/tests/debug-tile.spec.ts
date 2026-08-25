import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAMES, TEST_MAP_NAMES } from '../utils/test-params';
import {
    navigateToRoot,
    packedTileIdForTestPosition
} from '../utils/ui-helpers';

/**
 * End-to-end tests for the supported `window.ebDebug` S4E2 integration.
 *
 * These specs verify that the application boots correctly and that the debug
 * bridge reaches an exact feature through the inspection-only restricted
 * `/tiles` path.
 */

test.describe('Debug S4E2 integration', () => {
    test('boots application and hides global spinner', async ({ page }) => {
        await navigateToRoot(page);

        // The global spinner should be hidden once the app is ready.
        const spinner = page.locator('#global-spinner-container');
        await expect(spinner).toBeHidden();

        // The initial map view container should now be visible.
        const mapContainer = page.getByTestId('mapViewContainer-0');
        await expect(mapContainer).toBeVisible();
    });

    test('loads one exact inspection feature via ebDebug', async ({ page, request }) => {
        await requireTestMapSource(request);
        await navigateToRoot(page);

        const tileId = await packedTileIdForTestPosition(page);
        const summary = await page.evaluate(
            async ({mapId, layerId, tileId}) => {
                const debugApi = window.ebDebug;
                if (!debugApi) {
                    throw new Error('window.ebDebug is not available');
                }
                const mapTileKey = debugApi.mapTileKey(mapId, layerId, tileId);
                return debugApi.featureInspectionHoverSummary(mapTileKey, 'Way.0');
            },
            {
                mapId: TEST_MAP_NAMES[0],
                layerId: TEST_LAYER_NAMES[0],
                tileId
            }
        );

        expect(summary).toMatchObject({
            featureId: 'Way.0'
        });
        expect(summary).not.toHaveProperty('error');
    });
});
