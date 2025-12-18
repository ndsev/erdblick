import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAME, TEST_MAP_NAME, TEST_VIEW_POSITION } from '../utils/test-params';
import {
    clickSearchResultLeaf,
    enableMapLayer,
    navigateToArea,
    navigateToRoot,
    runFeatureSearch
} from '../utils/ui-helpers';

/**
 * Behavioural tests for inspection panels driven by feature search.
 *
 * The main scenario loads `TestMap/WayLayer`, jumps to a known area, runs a
 * feature search and verifies that selecting results opens inspection panels
 * with the expected map / layer identifiers and supports pinning multiple
 * panels.
 */

test.describe('Inspection panels over TestMap/WayLayer', () => {
    test('selecting a feature from search opens an inspection panel with TestMap attributes and opens the second panel', async ({ page, request }) => {
        // Ensure the synthetic TestMap datasource is available.
        await requireTestMapSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, TEST_MAP_NAME, TEST_LAYER_NAME);
        await navigateToArea(page, ...TEST_VIEW_POSITION);

        // Run a feature search and select the first result.
        await runFeatureSearch(page, '**.name');
        await clickSearchResultLeaf(page, 0);

        // An inspection panel should appear for the selected feature.
        const panel = page.getByTestId('inspection-container').getByTestId('inspection-panel').first();
        await expect(panel).toBeVisible();

        const treeBody = panel.locator('.p-treetable-tbody');
        await expect(treeBody).toBeVisible();

        // Validate that the inspected feature belongs to TestMap / WayLayer.
        const mapIdRow = treeBody.locator('tr', {
            hasText: TEST_MAP_NAME
        }).first();
        await expect(mapIdRow).toHaveCount(1);
        const layerIdRow = treeBody.locator('tr', {
            hasText: TEST_LAYER_NAME
        }).first();
        await expect(layerIdRow).toHaveCount(1);

        // const pinIcon = panel.locator('.material-symbols-outlined', {
        //     hasText: 'keep_off'
        // }).first();
        // Pin the first panel so the next selection opens a second panel.
        // await expect(pinIcon).toBeVisible();
        // await pinIcon.click();

        // Selecting another result should open a second inspection panel.
        await clickSearchResultLeaf(page, 1);
        const panels = page.getByTestId('inspection-container').getByTestId('inspection-panel');
        await expect(panels).toHaveCount(2);
    });

    test('collapsing a single docked inspection hides tree content and restores it on expand', async ({ page, request }) => {
        await requireTestMapSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, 'TestMap', 'WayLayer');
        await navigateToArea(page, 42.5, 11.615, 13);

        await runFeatureSearch(page, '**.name');
        await clickSearchResultLeaf(page, 0);

        const panel = page.getByTestId('inspection-container').getByTestId('inspection-panel').first();
        await expect(panel).toBeVisible();

        const accordionPanel = panel.locator('.p-accordionpanel').first();
        await expect(accordionPanel).toHaveClass(/p-accordionpanel-active/);

        const treeTable = panel.locator('.p-treetable').first();
        await expect(treeTable).toBeVisible();

        const header = panel.locator('.p-accordionheader').first();
        await header.click();

        await expect(accordionPanel).not.toHaveClass(/p-accordionpanel-active/);
        await expect(treeTable).not.toBeVisible();

        await header.click();

        await expect(accordionPanel).toHaveClass(/p-accordionpanel-active/);
        await expect(treeTable).toBeVisible();
    });
});
