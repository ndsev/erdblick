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

/**
 * Visual regression tests for inspection panels.
 *
 * The main scenario mirrors the behavioural inspection-panel tests but uses a
 * screenshot assertion on the inspection container to guard against layout
 * regressions for `TestMap` feature inspection.
 */

test.describe('Snapshot – inspection panel', () => {
    test('inspection panel for TestMap feature selected via search', async ({ page, request }) => {
        await requireTestMapSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, 'TestMap', 'WayLayer');
        await navigateToArea(page, 42.5, 11.615, 13);

        await runFeatureSearch(page, '**.name');
        await clickSearchResultLeaf(page, 0);

        // The inspection container should reflect the selected TestMap feature.
        const inspectionContainer = page.locator('.inspection-container');
        await expect(inspectionContainer).toBeVisible();

        await expect(inspectionContainer).toHaveScreenshot('inspection-panel-testmap.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});
