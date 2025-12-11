import { expect, test } from '../fixtures/test';
import {
    navigateToArea,
    openLayerDialog,
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
        const dialog = page.locator('.map-layer-dialog .p-dialog-content');
        const tabs = dialog.locator('.map-tab');
        await expect(tabs).toHaveCount(2);
        const leftTab = tabs.nth(0);
        const rightTab = tabs.nth(1);
        const leftLayerNode = leftTab.locator('[data-id="TestMap/WayLayer"]').first();
        const rightLayerNode = rightTab.locator('[data-id="TestMap/WayLayer"]').first();
        await expect(leftLayerNode).toBeVisible();
        await expect(rightLayerNode).toBeVisible();

        // Disable OSM background on the right view to differentiate them.
        const rightOsmButton = rightTab.locator('.osm-controls .osm-button').first();
        await expect(rightOsmButton).toBeVisible();
        await rightOsmButton.click();

        const secondViewCanvas = page.locator('#mapViewContainer-1 canvas').first();
        await expect(secondViewCanvas).toBeVisible();

        await navigateToArea(page, 42.5, 11.615, 13);

        const rightUiControls = page.locator('.view-ui-container:not(.mirrored)').first();
        await expect(rightUiControls).toBeVisible();

        // Use the UI controls to change zoom / pitch on the right view.
        await rightUiControls.locator('.navigation-controls > div > p-button').first().click();
        await rightUiControls.locator('.navigation-controls > div:nth-child(2) > p-button').first().click();

        const syncGroup = page.locator('.viewsync-select').first();
        await expect(syncGroup).toBeVisible();
        const projectionToggle = syncGroup.locator('.material-symbols-outlined', {
            hasText: '3d_rotation'
        }).first();
        await expect(projectionToggle).toBeVisible();
        await projectionToggle.click();

        const projectionSelect = rightUiControls.locator('.p-selectbutton').first();
        await projectionSelect.getByText('2D').first().click();

        // Both UIs should now show the same projection mode.
        const viewUIs = page.locator('.view-ui-container');
        await expect(viewUIs).toHaveCount(2);
        for (let i = 0; i < 2; i++) {
            const ui = viewUIs.nth(i);
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
        // Turning off the left TestMap layer should also disable it on the right.
        await leftLayerCheckbox.click();

        const leftMapNode = leftTab.locator('[data-id="TestMap"]').first();
        const rightMapNode = rightTab.locator('[data-id="TestMap"]').first();
        await expect.poll(async () => {
            const left = await leftMapNode.isChecked();
            const right = await rightMapNode.isChecked();
            return !left && !right;
        }, { timeout: 3000 }).toBe(true);

        const leftOsmButton = leftTab.locator('.osm-controls .osm-button').first();
        await expect(leftOsmButton).toBeVisible();
        await leftOsmButton.click();

        // Both OSM buttons should use the same "eye" icon state.
        const leftOsmIcon = leftOsmButton.locator('.pi-eye').first();
        const rightOsmIcon = rightOsmButton.locator('.pi-eye').first();
        await expect(rightOsmIcon).toBeVisible();
        await expect(leftOsmIcon).toBeVisible();
    });
});
