import { expect, test } from '../fixtures/test';
import { TEST_MAP_LAYER_DATA_ID, TEST_MAP_NAME, TEST_VIEW_POSITION } from '../utils/test-params';
import {
    navigateToArea,
    setupTwoViewsWithPositionSync
} from '../utils/ui-helpers';

/**
 * End-to-end tests for multi-view synchronisation.
 *
 * These specs focus on adding a comparison view, synchronising position and
 * projection between views, and verifying that layer visibility and OSM
 * background toggles stay in sync.
 */

test.describe('Multi-view synchronisation', () => {
    test('second view can be added and synchronised', async ({ page, request }) => {
        await setupTwoViewsWithPositionSync(page, request);
        // Both views should be represented as tabs in the layer dialog.
        const dialog = page.getByTestId('map-layer-dialog').locator('.p-dialog-content');
        const leftTab = dialog.getByTestId('map-tab-0');
        const rightTab = dialog.getByTestId('map-tab-1');
        const leftLayerNode = leftTab.locator(`[data-id="${TEST_MAP_LAYER_DATA_ID}"]`).first();
        const rightLayerNode = rightTab.locator(`[data-id="${TEST_MAP_LAYER_DATA_ID}"]`).first();
        await expect(leftLayerNode).toBeVisible();
        await expect(rightLayerNode).toBeVisible();

        // Disable OSM background on the right view to differentiate them.
        const rightOsmButton = rightTab.getByTestId('osm-toggle-1');
        await expect(rightOsmButton).toBeVisible();
        await rightOsmButton.click();

        const secondViewCanvas = page.getByTestId('mapViewContainer-1').locator('canvas').first();
        await expect(secondViewCanvas).toBeVisible();

        await navigateToArea(page, ...TEST_VIEW_POSITION);

        const rightUiControls = page.getByTestId('view-ui-container-1');
        await expect(rightUiControls).toBeVisible();

        // Use the UI controls to change zoom / pitch on the right view.
        await rightUiControls.getByTestId('zoom-in-button').click();
        await rightUiControls.getByTestId('move-up-button').click();

        const syncGroup = page.getByTestId('viewsync-select');
        await expect(syncGroup).toBeVisible();
        const projectionToggle = syncGroup.locator('.material-symbols-outlined', {
            hasText: '3d_rotation'
        }).first();
        await expect(projectionToggle).toBeVisible();
        await projectionToggle.click();

        const projectionSelect = rightUiControls.locator('.p-selectbutton').first();
        await projectionSelect.getByText('2D').first().click();

        // Both UIs should now show the same projection mode.
        for (const viewTestId of ['view-ui-container-0', 'view-ui-container-1']) {
            const ui = page.getByTestId(viewTestId);
            const activeButton = ui.locator('.p-togglebutton-checked').first();
            await expect(activeButton).toHaveText('2D');
        }

        const layersToggle = syncGroup.locator('.material-symbols-outlined', {
            hasText: 'layers'
        }).first();
        await expect(layersToggle).toBeVisible();
        await layersToggle.click();

        const leftLayerCheckbox = leftLayerNode.locator('input.p-checkbox-input[type="checkbox"]').first();
        await expect(leftLayerCheckbox).toBeChecked();
        // Turning off the left map layer should also disable it on the right.
        await leftLayerCheckbox.click();

        const leftMapNode = leftTab.locator(`[data-id="${TEST_MAP_NAME}"]`).first();
        const rightMapNode = rightTab.locator(`[data-id="${TEST_MAP_NAME}"]`).first();
        await expect.poll(async () => {
            const left = await leftMapNode.isChecked();
            const right = await rightMapNode.isChecked();
            return !left && !right;
        }, { timeout: 3000 }).toBe(true);

        const leftOsmButton = leftTab.getByTestId('osm-toggle-0');
        await expect(leftOsmButton).toBeVisible();
        await leftOsmButton.click();

        // Both OSM buttons should use the same "eye" icon state.
        const leftOsmIcon = leftOsmButton.locator('.pi-eye').first();
        const rightOsmIcon = rightOsmButton.locator('.pi-eye').first();
        await expect(rightOsmIcon).toBeVisible();
        await expect(leftOsmIcon).toBeVisible();
    });
});
