import type {APIRequestContext, Page} from '@playwright/test';
import { expect } from '@playwright/test';
import {test} from "../fixtures/test";
import {requireTestMapSource} from "./backend-helpers";

export async function navigateToRoot(page: Page): Promise<void> {
    await page.goto('/');
    await waitForAppReady(page);
}

export async function waitForAppReady(page: Page): Promise<void> {
    await page.waitForSelector('#global-spinner-container', {
        state: 'hidden',
        timeout: 30000
    });
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

export async function runFeatureSearch(page: Page, query: string): Promise<void> {
    const searchInput = page.locator('textarea[placeholder="Search"]');
    await searchInput.click();

    const searchMenuContainer = page.locator('.resizable-container').filter({
        has: page.locator('.search-menu-dialog')
    }).first();
    const searchMenu = searchMenuContainer.locator('.p-dialog-content');
    await expect(searchMenu).toBeVisible();

    const searchLoadedFeatures = searchMenu.locator('.search-menu .search-option-name', {
        hasText: 'Search Loaded Features'
    }).first();
    await expect(searchLoadedFeatures).toBeVisible();

    await searchInput.fill(query);
    await searchInput.focus();
    await page.keyboard.press('Enter');

    const featureSearch = page.locator('.feature-search-dialog').first();
    const featureSearchContent = featureSearch.locator('.p-dialog-content').first();
    await expect(featureSearchContent).toBeVisible();

    const resultsBadge = featureSearchContent.locator('.p-badge').first();
    await expect.poll(async () => {
        const text = await resultsBadge.innerText();
        const value = parseInt(text || '0', 10);
        return Number.isNaN(value) ? 0 : value;
    }, {
        timeout: 10000
    }).toBeGreaterThan(0);

    const emptyMessage = featureSearchContent.locator('.p-tree-empty-message');
    await expect(emptyMessage).toHaveCount(0);
}

export async function clickSearchResultLeaf(page: Page, index: number): Promise<void> {
    const featureSearch = page.locator('.feature-search-dialog').first();
    const featureSearchContent = featureSearch.locator('.p-dialog-content').first();
    const tree = featureSearchContent.locator('.p-tree').first();
    const leafNodes = tree.locator('.p-tree-node-leaf');
    const count = await leafNodes.count();
    if (count === 0) {
        throw new Error('Expected at least one search result leaf node');
    }
    const resultButton = leafNodes.nth(index).locator('.p-tree-node-content').first();
    await resultButton.click();
}

export async function setupTwoViewsWithPositionSync(page: Page, request: APIRequestContext): Promise<void> {
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

export async function getCameraPosition(page: Page, viewIndex: number): Promise<number[] | null> {
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