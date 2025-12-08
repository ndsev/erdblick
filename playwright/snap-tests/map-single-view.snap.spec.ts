import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import { enableMapLayer, navigateToArea, navigateToRoot } from '../utils/ui-helpers';

test.describe('Snapshot – single map view', () => {
    test('TestMap/WayLayer single-view layout', async ({ page, request }) => {
        await requireTestMapSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, 'TestMap', 'WayLayer');
        await navigateToArea(page, 42.5, 11.615, 13);

        const mapContainer = page.locator('#mapViewContainer-0');
        await expect(mapContainer).toBeVisible();

        await expect(mapContainer).toHaveScreenshot('map-single-view.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});

