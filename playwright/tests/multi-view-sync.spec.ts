import { expect, test } from '../fixtures/test';
import {
    TEST_LAYER_NAMES,
    TEST_MAP_NAMES,
    TEST_VIEW_POSITIONS
} from '../utils/test-params';
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
        const testMapLayerId = `${TEST_MAP_NAMES[0]}/${TEST_LAYER_NAMES[0]}`;
        const leftLayerNode = leftTab.locator(`[data-id="${testMapLayerId}"]`).first();
        const rightLayerNode = rightTab.locator(`[data-id="${testMapLayerId}"]`).first();
        await expect(leftLayerNode).toBeVisible();
        await expect(rightLayerNode).toBeVisible();

        const leftOsmButton = leftTab.getByTestId('osm-toggle-0');
        const rightOsmButton = rightTab.getByTestId('osm-toggle-1');
        await expect(leftOsmButton).toBeVisible();
        await expect(rightOsmButton).toBeVisible();
        await expect(leftOsmButton.locator('.pi-eye-slash').first()).toBeVisible();
        await expect(rightOsmButton.locator('.pi-eye-slash').first()).toBeVisible();

        const secondViewCanvas = page.getByTestId('mapViewContainer-1').locator('canvas').first();
        await expect(secondViewCanvas).toBeVisible();

        await navigateToArea(page, ...TEST_VIEW_POSITIONS[0]);

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

        const leftMapNode = leftTab.locator(`[data-id="${TEST_MAP_NAMES[0]}"]`).first();
        const rightMapNode = rightTab.locator(`[data-id="${TEST_MAP_NAMES[0]}"]`).first();
        await expect.poll(async () => {
            const left = await leftMapNode.isChecked();
            const right = await rightMapNode.isChecked();
            return !left && !right;
        }, { timeout: 3000 }).toBe(true);

        await leftOsmButton.click();

        // Both OSM buttons should use the same "eye" icon state.
        const leftOsmIcon = leftOsmButton.locator('.pi-eye').first();
        const rightOsmIcon = rightOsmButton.locator('.pi-eye').first();
        await expect(rightOsmIcon).toBeVisible();
        await expect(leftOsmIcon).toBeVisible();
    });
});
