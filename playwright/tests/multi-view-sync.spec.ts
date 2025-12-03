import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import {
    addComparisonView,
    enableMapLayer,
    navigateToArea,
    navigateToRoot,
    openLayerDialog
} from '../utils/ui-helpers';

async function setupTwoViewsWithPositionSync(page: Page, request: APIRequestContext): Promise<void> {
    await requireTestMapSource(request);

    await navigateToRoot(page);
    await enableMapLayer(page, 'TestMap', 'WayLayer');

    await addComparisonView(page);

    const syncGroup = page.locator('.viewsync-select').first();
    await expect(syncGroup).toBeVisible();

    const positionToggle = syncGroup.locator('.material-symbols-outlined', {
        hasText: 'location_on'
    }).first();
    await expect(positionToggle).toBeVisible();
    await positionToggle.click();
}

async function getCameraPosition(page: Page, viewIndex: number): Promise<number[] | null> {
    const raw = await page.evaluate((idx: number) => window.ebDebug?.getCamera(idx), viewIndex);
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed.position) ? parsed.position as number[] : null;
    } catch {
        return null;
    }
}

test.describe('Multi-view synchronisation', () => {
    test('second view can be added and WGS84 navigation is position-synchronised', async ({ page, request }) => {
        await setupTwoViewsWithPositionSync(page, request);

        const secondViewCanvas = page.locator('#mapViewContainer-1 canvas').first();
        await expect(secondViewCanvas).toBeVisible();

        await navigateToArea(page, 42.5, 11.615, 13);

        await expect.poll(async () => {
            const [p0, p1] = await Promise.all([
                getCameraPosition(page, 0),
                getCameraPosition(page, 1)
            ]);
            if (!p0 || !p1) {
                return Number.POSITIVE_INFINITY;
            }
            const dx = Math.abs(p0[0] - p1[0]);
            const dy = Math.abs(p0[1] - p1[1]);
            const dz = Math.abs(p0[2] - p1[2]);
            return dx + dy + dz;
        }, { timeout: 20000 }).toBeLessThan(1e-3);
    });

    test('navigation controls move both views when position sync is enabled', async ({ page, request }) => {
        await setupTwoViewsWithPositionSync(page, request);

        await navigateToArea(page, 42.5, 11.615, 13);

        const before0 = await getCameraPosition(page, 0);
        const before1 = await getCameraPosition(page, 1);

        const primaryUI = page.locator('.view-ui-container.mirrored').first();
        await expect(primaryUI).toBeVisible();

        await primaryUI.locator('.pi-plus').first().click();
        await primaryUI.locator('.pi-arrow-right').first().click();

        await expect.poll(async () => {
            const [p0, p1] = await Promise.all([
                getCameraPosition(page, 0),
                getCameraPosition(page, 1)
            ]);
            if (!p0 || !p1 || !before0 || !before1) {
                return Number.POSITIVE_INFINITY;
            }
            const moved0 = Math.abs(p0[0] - before0[0]) + Math.abs(p0[1] - before0[1]) + Math.abs(p0[2] - before0[2]);
            const moved1 = Math.abs(p1[0] - before1[0]) + Math.abs(p1[1] - before1[1]) + Math.abs(p1[2] - before1[2]);
            const diffBetweenViews = Math.abs(p0[0] - p1[0]) + Math.abs(p0[1] - p1[1]) + Math.abs(p0[2] - p1[2]);
            return moved0 > 0 && moved1 > 0 ? diffBetweenViews : Number.POSITIVE_INFINITY;
        }, { timeout: 20000 }).toBeLessThan(1e-3);
    });

    test('2D projection mode can be activated and synchronised across views', async ({ page, request }) => {
        await setupTwoViewsWithPositionSync(page, request);

        const syncGroup = page.locator('.viewsync-select').first();
        const projectionToggle = syncGroup.locator('.material-symbols-outlined', {
            hasText: '3d_rotation'
        }).first();
        await expect(projectionToggle).toBeVisible();
        await projectionToggle.click();

        const primaryUI = page.locator('.view-ui-container.mirrored').first();
        await expect(primaryUI).toBeVisible();
        const projectionSelect = primaryUI.locator('.p-selectbutton').first();
        await projectionSelect.locator('.p-button', { hasText: '2D' }).first().click();

        const viewUIs = page.locator('.view-ui-container');
        await expect(viewUIs).toHaveCount(2);

        for (let i = 0; i < 2; i++) {
            const ui = viewUIs.nth(i);
            const activeButton = ui.locator('.p-selectbutton .p-button.p-highlight').first();
            await expect(activeButton).toContainText('2D');
        }
    });

    test('layer and OSM settings are synchronised across views when layer sync is enabled', async ({ page, request }) => {
        await setupTwoViewsWithPositionSync(page, request);

        const syncGroup = page.locator('.viewsync-select').first();
        const layersToggle = syncGroup.locator('.material-symbols-outlined', {
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

