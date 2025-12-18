import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAME, TEST_MAP_NAME, TEST_VIEW_POSITION } from '../utils/test-params';
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
        await enableMapLayer(page, TEST_MAP_NAME, TEST_LAYER_NAME);
        await navigateToArea(page, ...TEST_VIEW_POSITION);

        await runFeatureSearch(page, '**.name');
        await clickSearchResultLeaf(page, 0);

        // The inspection container should reflect the selected TestMap feature.
        const inspectionContainer = page.getByTestId('inspection-container');
        await expect(inspectionContainer).toBeVisible();

        await expect(inspectionContainer).toHaveScreenshot('inspection-panel-testmap.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});
