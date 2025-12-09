import { expect, test } from '../fixtures/test';
import {
    navigateToArea,
    openLayerDialog,
    setupTwoViewsWithPositionSync
} from '../utils/ui-helpers';

test.describe('Multi-view synchronisation', () => {
    test('second view can be added and synchronised', async ({ page, request }) => {
        await setupTwoViewsWithPositionSync(page, request);

        const secondViewCanvas = page.locator('#mapViewContainer-1 canvas').first();
        await expect(secondViewCanvas).toBeVisible();

        await navigateToArea(page, 42.5, 11.615, 13);

        const primaryUI = page.locator('.view-ui-container:not(.mirrored)').first();
        await expect(primaryUI).toBeVisible();

        await primaryUI.locator('button', {
            has: primaryUI.locator('.pi-plus').first()
        }).first().click();
        await primaryUI.locator('button', {
            has: primaryUI.locator('.pi-arrow-right').first()
        }).first().click();

        const syncGroup = page.locator('.viewsync-select').first();
        const projectionToggle = syncGroup.locator('button', {
            hasText: '3d_rotation'
        }).first();
        await expect(projectionToggle).toBeVisible();
        await projectionToggle.click();

        const projectionSelect = primaryUI.locator('.p-selectbutton').first();
        await projectionSelect.locator('.p-button', { hasText: '2D' }).first().click();

        const viewUIs = page.locator('.view-ui-container');
        await expect(viewUIs).toHaveCount(2);

        for (let i = 0; i < 2; i++) {
            const ui = viewUIs.nth(i);
            const activeButton = ui.locator('.p-selectbutton .p-button.p-highlight').first();
            await expect(activeButton).toContainText('2D');
        }

        const layersToggle = syncGroup.locator('button', {
            hasText: 'layers'
        }).first();
        await expect(layersToggle).toBeVisible();
        await layersToggle.click();

        await openLayerDialog(page);

        const dialog = page.locator('.map-layer-dialog .p-dialog-content');
        const tabs = dialog.locator('.map-tab');
        await expect(tabs).toHaveCount(2);

        const leftTab = tabs.nth(0);
        const rightTab = tabs.nth(1);

        const leftLayerNode = leftTab.locator('[data-id="TestMap/WayLayer"]').first();
        const rightLayerNode = rightTab.locator('[data-id="TestMap/WayLayer"]').first();
        await expect(leftLayerNode).toBeVisible();
        await expect(rightLayerNode).toBeVisible();

        const leftLayerCheckbox = leftLayerNode.locator('input.p-checkbox-input[type="checkbox"]').first();
        const rightLayerCheckbox = rightLayerNode.locator('input.p-checkbox-input[type="checkbox"]').first();

        const initialChecked = await leftLayerCheckbox.isChecked();
        await leftLayerCheckbox.click();

        await expect.poll(async () => {
            const left = await leftLayerCheckbox.isChecked();
            const right = await rightLayerCheckbox.isChecked();
            return left === right && left !== initialChecked;
        }, { timeout: 15000 }).toBe(true);

        const leftOsmButton = leftTab.locator('.osm-controls .osm-button').first();
        const rightOsmButton = rightTab.locator('.osm-controls .osm-button').first();
        await expect(leftOsmButton).toBeVisible();
        await expect(rightOsmButton).toBeVisible();

        await leftOsmButton.click();

        const leftOsmIcon = leftOsmButton.locator('i.pi').first();
        const rightOsmIcon = rightOsmButton.locator('i.pi').first();

        await expect.poll(async () => {
            const leftClass = await leftOsmIcon.getAttribute('class') || '';
            const rightClass = await rightOsmIcon.getAttribute('class') || '';
            const leftIsHidden = leftClass.includes('pi-eye-slash');
            const rightIsHidden = rightClass.includes('pi-eye-slash');
            return leftIsHidden && rightIsHidden;
        }, { timeout: 15000 }).toBe(true);
    });
});

