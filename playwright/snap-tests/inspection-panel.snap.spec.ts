import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import {
    enableMapLayer,
    navigateToArea,
    navigateToRoot,
    runFeatureSearch,
    clickSearchResultLeaf
} from '../utils/ui-helpers';

test.describe('Snapshot – inspection panel', () => {
    test('inspection panel for TestMap feature selected via search', async ({ page, request }) => {
        await requireTestMapSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, 'TestMap', 'WayLayer');
        await navigateToArea(page, 42.5, 11.615, 13);

        await runFeatureSearch(page, '**.name');
        await clickSearchResultLeaf(page, 0);

        const inspectionContainer = page.locator('.inspection-container');
        await expect(inspectionContainer).toBeVisible();

        await expect(inspectionContainer).toHaveScreenshot('inspection-panel-testmap.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});

