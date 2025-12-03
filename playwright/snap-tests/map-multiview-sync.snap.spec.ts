import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import {
    addComparisonView,
    enableMapLayer,
    navigateToArea,
    navigateToRoot,
    waitForAppReady
} from '../utils/ui-helpers';

test.describe('Snapshot – multi-view sync layout', () => {
    test('two views with position sync enabled', async ({ page, request }) => {
        await requireTestMapSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, 'TestMap', 'WayLayer');
        await addComparisonView(page);

        const syncGroup = page.locator('.viewsync-select').first();
        await expect(syncGroup).toBeVisible();

        const positionToggle = syncGroup.locator('.material-symbols-outlined', {
            hasText: 'location_on'
        }).first();
        await expect(positionToggle).toBeVisible();
        await positionToggle.click();

        await navigateToArea(page, 42.5, 11.615, 13);
        await waitForAppReady(page);

        const mapContainer = page.locator('mapview-container');
        await expect(mapContainer).toBeVisible();

        await expect(mapContainer).toHaveScreenshot('map-multiview-sync.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});

