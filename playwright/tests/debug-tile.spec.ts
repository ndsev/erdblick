import { expect, test } from '../fixtures/test';
import { navigateToRoot } from '../utils/ui-helpers';

/**
 * End-to-end tests for the `window.ebDebug` debug tile integration.
 *
 * These specs verify that the application boots correctly, hides its global
 * loading spinner, and that invoking `ebDebug.showTestTile()` results in a
 * visible canvas in the primary map view.
 */

test.describe('Debug tile integration', () => {
    test('boots application and hides global spinner', async ({ page }) => {
        await navigateToRoot(page);

        // The global spinner should be hidden once the app is ready.
        const spinner = page.locator('#global-spinner-container');
        await expect(spinner).toBeHidden();

        // The initial map view container should now be visible.
        const mapContainer = page.locator('#mapViewContainer-0');
        await expect(mapContainer).toBeVisible();
    });

    test('renders debug tile via ebDebug', async ({ page }) => {
        await navigateToRoot(page);

        await page.evaluate(() => {
            if (window.ebDebug) {
                // Ask the debug bridge to render a synthetic test tile.
                window.ebDebug.showTestTile();
            } else {
                throw new Error('window.ebDebug is not available');
            }
        });

        // A canvas should be present inside the primary map view.
        const mapContainer = page.locator('#mapViewContainer-0 canvas');
        await expect(mapContainer.first()).toBeVisible();
    });
});
