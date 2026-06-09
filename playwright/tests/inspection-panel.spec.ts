import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAMES, TEST_MAP_NAMES, TEST_VIEW_POSITIONS } from '../utils/test-params';
import {
    enableMapLayer,
    navigateToArea,
    navigateToRoot,
    selectFeatureForInspection
} from '../utils/ui-helpers';

/**
 * Behavioural tests for inspection panels driven by deterministic test-tile selections.
 *
 * The main scenario loads `TestMap/WayLayer`, jumps to a known area, selects
 * deterministic synthetic features and verifies that selection opens inspection panels
 * with the expected map / layer identifiers and supports pinning multiple
 * panels.
 */

test.describe('Inspection panels over TestMap/WayLayer', () => {
    test('selecting a feature opens an inspection panel with TestMap attributes and opens the second panel', async ({ page, request }) => {
        // Ensure the synthetic TestMap datasource is available.
        await requireTestMapSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
        await navigateToArea(page, ...TEST_VIEW_POSITIONS[0]);

        await selectFeatureForInspection(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0], 'Way.0');

        // An inspection panel should appear for the selected feature.
        const panel = page.getByTestId('inspection-container').getByTestId('inspection-panel').first();
        await expect(panel).toBeVisible();

        const treeBody = panel.locator('.p-treetable-tbody');
        await expect(treeBody).toBeVisible();

        // Validate that the inspected feature belongs to TestMap / WayLayer.
        const mapIdRow = treeBody.locator('tr', {
            hasText: TEST_MAP_NAMES[0]
        }).first();
        await expect(mapIdRow).toHaveCount(1);
        const layerIdRow = treeBody.locator('tr', {
            hasText: TEST_LAYER_NAMES[0]
        }).first();
        await expect(layerIdRow).toHaveCount(1);

        const lockToggle = panel.locator('.app-surface-header-title').first();
        // Lock the first panel so the next selection opens a second panel.
        await expect(lockToggle).toBeVisible();
        await lockToggle.click();

        // Selecting another feature should open a second inspection panel.
        await selectFeatureForInspection(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0], 'Way.1');
        const panels = page.getByTestId('inspection-container').getByTestId('inspection-panel');
        await expect(panels).toHaveCount(2);
    });

    test('collapsing a single docked inspection hides tree content and restores it on expand', async ({ page, request }) => {
        await requireTestMapSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, 'TestMap', 'WayLayer');
        await navigateToArea(page, 42.5, 11.615, 13);

        await selectFeatureForInspection(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0], 'Way.0');

        const panel = page.getByTestId('inspection-container').getByTestId('inspection-panel').first();
        await expect(panel).toBeVisible();

        const accordionPanel = panel.locator('.p-accordionpanel').first();
        await expect(accordionPanel).toHaveClass(/p-accordionpanel-active/);

        const treeTable = panel.locator('.p-treetable').first();
        await expect(treeTable).toBeVisible();

        const header = panel.locator('.p-accordionheader').first();
        const headerBox = await header.boundingBox();
        if (!headerBox) {
            throw new Error('Expected docked inspection header to have a bounding box');
        }
        const toggleClickPosition = {
            x: Math.max(headerBox.width - 16, 4),
            y: headerBox.height / 2
        };
        await header.click({ position: toggleClickPosition });

        await expect(accordionPanel).not.toHaveClass(/p-accordionpanel-active/);
        await expect(treeTable).not.toBeVisible();

        await header.click({ position: toggleClickPosition });

        await expect(accordionPanel).toHaveClass(/p-accordionpanel-active/);
        await expect(treeTable).toBeVisible();
    });
});
