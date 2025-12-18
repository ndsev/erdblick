import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import { navigateToRoot, openLayerDialog } from '../utils/ui-helpers';

test.describe('Snapshot – maps & layers', () => {
    test('maps & layers panel', async ({ page, request }) => {
        await requireTestMapSource(request);
        await navigateToRoot(page);
        await openLayerDialog(page);

        const dialog = page.locator('.map-layer-dialog').first();
        await expect(dialog).toBeVisible();

        await expect(dialog).toHaveScreenshot('maps-and-layers.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});

