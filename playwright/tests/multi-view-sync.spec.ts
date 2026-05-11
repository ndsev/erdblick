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
 * projection between views, and verifying that layer visibility and background
 * toggles stay in sync.
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

        const leftTileGridButton = leftTab.getByTestId('tile-grid-button-0');
        await expect(leftTileGridButton).toBeVisible();
        await leftTileGridButton.click();
        const leftTileGridPopover = page.getByTestId('tile-grid-popover-0');
        await expect(leftTileGridPopover).toBeVisible();
        const leftTileGridModeXyz = leftTileGridPopover.getByTestId('tile-grid-mode-xyz-0');
        await leftTileGridModeXyz.click();
        await expect(leftTileGridModeXyz.locator('input')).toBeChecked();
        const leftTileGridEnabled = leftTileGridPopover.getByTestId('tile-grid-enabled-0').locator('input');
        await expect(leftTileGridEnabled).toBeChecked();
        await leftTileGridEnabled.click();
        await expect(leftTileGridEnabled).not.toBeChecked();
        await page.keyboard.press('Escape');

        const leftBackgroundButton = leftTab.getByTestId('background-button-0');
        const rightBackgroundButton = rightTab.getByTestId('background-button-1');
        await expect(leftBackgroundButton).toBeVisible();
        await expect(rightBackgroundButton).toBeVisible();
        await leftBackgroundButton.click();
        const leftBackgroundSelect = page.getByTestId('background-select-0');
        const leftBackgroundEnabled = page.getByTestId('background-enabled-0').locator('input');
        // navigateToRoot() disables backgrounds through the legacy OSM URL state
        // so map-focused tests keep deterministic rendering.
        await expect(leftBackgroundEnabled).not.toBeChecked();
        await expect(leftBackgroundSelect).toBeVisible();
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await rightBackgroundButton.click();
        const rightBackgroundSelect = page.getByTestId('background-select-1');
        const rightBackgroundEnabled = page.getByTestId('background-enabled-1').locator('input');
        await expect(rightBackgroundEnabled).not.toBeChecked();
        await expect(rightBackgroundSelect).toBeVisible();
        await page.keyboard.press('Escape');

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

        await leftBackgroundButton.click();
        await expect(leftBackgroundEnabled).not.toBeChecked();
        await leftBackgroundEnabled.click();
        await expect(leftBackgroundEnabled).toBeChecked();
        await expect(leftBackgroundSelect).toContainText('Blue Marble');
        await page.keyboard.press('Escape');

        // The synced right view should track the same enabled background state.
        await rightBackgroundButton.click();
        await expect(rightBackgroundEnabled).toBeChecked();
        await expect(rightBackgroundSelect).toContainText('Blue Marble');
        await page.keyboard.press('Escape');

        await leftBackgroundButton.click();
        await expect(leftBackgroundEnabled).toBeChecked();
        await leftBackgroundEnabled.click();
        await expect(leftBackgroundEnabled).not.toBeChecked();

        // The synced right view should track the same disabled background state.
        await page.keyboard.press('Escape');
        await rightBackgroundButton.click();
        await expect(rightBackgroundEnabled).not.toBeChecked();
    });
});
