import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export async function navigateToRoot(page: Page): Promise<void> {
    await page.goto('/');
    await waitForAppReady(page);
}

export async function waitForAppReady(page: Page): Promise<void> {
    await page.waitForSelector('#global-spinner-container', {
        state: 'hidden',
        timeout: 30000
    });

    await page.waitForFunction(
        () => typeof window !== 'undefined' && (window as unknown as { ebDebug?: unknown }).ebDebug !== undefined,
        undefined,
        {
            timeout: 30000
        }
    );
}

export async function enableMapLayer(page: Page, mapLabel: string, layerLabel: string): Promise<void> {
    const layersButton = page.locator('.layers-button').locator('.p-button');
    await layersButton.click({ force: true });

    const dialog = page.locator('.map-layer-dialog').locator('.p-dialog-content');
    await expect(dialog).toBeVisible();
    await dialog.click();

    const layerNode = dialog.locator(`[data-id="${mapLabel}/${layerLabel}"]`).first();
    await expect(layerNode).toBeVisible();

    const layerCheckboxInput = layerNode.locator('input.p-checkbox-input[type="checkbox"]').first();
    await expect(layerCheckboxInput).toBeVisible();
    await layerCheckboxInput.check();
}

export async function navigateToArea(page: Page, lon: number, lat: number, level: number): Promise<void> {
    const searchInput = page.locator('textarea[placeholder="Search"]');
    await searchInput.click();
    await searchInput.fill(`${lon} ${lat} ${level}`);
    const searchMenuContainer = page.locator('.resizable-container').filter({
        has: page.locator('.search-menu-dialog')
    }).first();

    // Inside this container, .p-dialog-content is our search menu
    const searchMenu = searchMenuContainer.locator('.p-dialog-content');
    await expect(searchMenu).toBeVisible();
    const jumpToWGS84 = searchMenu.locator('.search-menu', {
        hasText: 'WGS84 Lon-Lat Coordinates'
    }).first();
    await expect(jumpToWGS84).toBeVisible();
    await jumpToWGS84.click();
}

export async function openLayerDialog(page: Page): Promise<void> {
    const dialog = page.locator('.map-layer-dialog .p-dialog-content');
    if (await dialog.isVisible()) {
        return;
    }

    const layersButton = page.locator('.layers-button').locator('.p-button');
    await layersButton.click({ force: true });
    await expect(dialog).toBeVisible();
}

export async function addComparisonView(page: Page): Promise<void> {
    await openLayerDialog(page);

    const dialog = page.locator('.map-layer-dialog .p-dialog-content');
    const addViewButton = dialog.locator('.add-view-button').first();
    await expect(addViewButton).toBeVisible();
    await addViewButton.click();

    const secondViewCanvas = page.locator('#mapViewContainer-1 canvas').first();
    await expect(secondViewCanvas).toBeVisible();
}
