import { expect, test } from '../fixtures/test';
import { navigateToRoot, waitForAppReady } from '../utils/ui-helpers';

test.describe('Debug tile integration', () => {
    test('boots application and hides global spinner', async ({ page }) => {
        await navigateToRoot(page);

        const spinner = page.locator('#global-spinner-container');
        await expect(spinner).toBeHidden();

        const mapContainer = page.locator('#mapViewContainer-0');
        await expect(mapContainer).toBeVisible();
    });

    test('renders debug tile via ebDebug', async ({ page }) => {
        await navigateToRoot(page);

        await page.evaluate(() => {
            if (window.ebDebug) {
                window.ebDebug.showTestTile();
            } else {
                throw new Error('window.ebDebug is not available');
            }
        });

        // Allow some time for Cesium and the WASM core to render the tile.
        await waitForAppReady(page);

        const mapContainer = page.locator('#mapViewContainer-0 canvas');
        await expect(mapContainer.first()).toBeVisible();
    });
});

