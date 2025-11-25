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
    const layersButton = page.locator('.layers-button');
    await layersButton.click();

    const dialog = page.locator('.map-layer-dialog');
    await expect(dialog).toBeVisible();

    const mapLabelLocator = dialog.locator('label', { hasText: mapLabel }).first();
    await expect(mapLabelLocator).toBeVisible();
    await mapLabelLocator.click();

    const layerLabelLocator = dialog.locator('label', { hasText: layerLabel }).first();
    await expect(layerLabelLocator).toBeVisible();
    await layerLabelLocator.click();
}

