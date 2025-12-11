import type {APIRequestContext, Page} from '@playwright/test';
import { expect } from '@playwright/test';
import {test} from '../fixtures/test';
import {requireTestMapSource} from './backend-helpers';

/**
 * High-level UI helpers for driving the Angular app in Playwright tests.
 *
 * The helpers in this module wrap common navigation and interaction patterns
 * (search, layer toggles, multi-view configuration, etc.) so tests can focus
 * on asserting behaviour rather than low-level DOM wiring.
 */

export async function navigateToRoot(page: Page): Promise<void> {
    // Disable OSM by default to make visual assertions more stable.
    await page.goto('/?osm=0');
    await waitForAppReady(page);
}

export async function waitForAppReady(page: Page): Promise<void> {
    // The global spinner hides once the Angular app is ready.
    await page.waitForSelector('#global-spinner-container', {
        state: 'hidden',
        timeout: 30000
    });
}

export async function enableMapLayer(page: Page, mapLabel: string, layerLabel: string): Promise<void> {
    // Open the layer dialog through the toolbar button.
    const layersButton = page.locator('.layers-button').locator('.p-button');
    await layersButton.click({ force: true });

    const dialog = page.locator('.map-layer-dialog').locator('.p-dialog-content');
    await expect(dialog).toBeVisible();
    await dialog.click();

    const layerNode = dialog.locator(`[data-id="${mapLabel}/${layerLabel}"]`).first();
    await expect(layerNode).toBeVisible();

    // Toggle the corresponding checkbox for the requested layer.
    const layerCheckboxInput = layerNode.locator('input.p-checkbox-input[type="checkbox"]').first();
    await expect(layerCheckboxInput).toBeVisible();
    await layerCheckboxInput.check();
}

/**
 * Uses the search box to jump to a specific lon/lat/level by selecting the
 * "WGS84 Lon-Lat Coordinates" search option.
 */
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
    // Trigger "Jump to WGS84" using the typed lon/lat/level.
    await jumpToWGS84.click();
}

export async function openLayerDialog(page: Page): Promise<void> {
    const dialog = page.locator('.map-layer-dialog .p-dialog-content');
    if (await dialog.isVisible()) {
        // Dialog is already open; nothing to do.
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

    // A second map canvas should appear for the comparison view.
    const secondViewCanvas = page.locator('#mapViewContainer-1 canvas').first();
    await expect(secondViewCanvas).toBeVisible();
}

/**
 * Runs a "Search Loaded Features" query and waits until at least one result
 * appears in the feature search dialog.
 */
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
    // Wait until the badge reports at least one search result.
    await expect.poll(async () => {
        const text = await resultsBadge.innerText();
        const value = parseInt(text || '0', 10);
        return Number.isNaN(value) ? 0 : value;
    }, {
        timeout: 10000
    }).toBeGreaterThan(0);

    const emptyMessage = featureSearchContent.locator('.p-tree-empty-message');
    // When results are available, the "empty tree" message should disappear.
    await expect(emptyMessage).toHaveCount(0);
}

/**
 * Clicks the `index`-th leaf node within the feature search tree, failing the
 * test early when no results are available.
 */
export async function clickSearchResultLeaf(page: Page, index: number): Promise<void> {
    const featureSearch = page.locator('.feature-search-dialog').first();
    const featureSearchContent = featureSearch.locator('.p-dialog-content').first();
    const tree = featureSearchContent.locator('.p-tree').first();
    const leafNodes = tree.locator('.p-tree-node-leaf');
    const count = await leafNodes.count();
    if (count === 0) {
        throw new Error('Expected at least one search result leaf node');
    }
    // Select the requested leaf node and trigger the associated action.
    const resultButton = leafNodes.nth(index).locator('.p-tree-node-content').first();
    await resultButton.click();
}

/**
 * Prepares a two-view layout with the `TestMap/WayLayer` enabled and position
 * synchronisation toggled on.
 *
 * This encapsulates the relatively verbose UI sequence into a single call so
 * multi-view tests stay readable.
 */
export async function setupTwoViewsWithPositionSync(page: Page, request: APIRequestContext): Promise<void> {
    await requireTestMapSource(request);

    await navigateToRoot(page);
    await enableMapLayer(page, 'TestMap', 'WayLayer');

    await addComparisonView(page);

    const syncGroup = page.locator('.viewsync-select').first();
    await expect(syncGroup).toBeVisible();

    // Enable position synchronisation between the two map views.
    const positionToggle = syncGroup.locator('.material-symbols-outlined', {
        hasText: 'location_on'
    }).first();
    await expect(positionToggle).toBeVisible();
    await positionToggle.click();
}

/**
 * Reads and deserialises the camera position for a given view index via the
 * `window.ebDebug` bridge. Returns `null` when no camera information is
 * available or when the payload cannot be parsed.
 */
export async function getCameraPosition(page: Page, viewIndex: number): Promise<number[] | null> {
    const raw = await page.evaluate((idx: number) => window.ebDebug?.getCamera(idx), viewIndex);
    if (!raw) {
        return null;
    }
    try {
        // The debug bridge returns a JSON string with a `position` field.
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed.position) ? parsed.position as number[] : null;
    } catch {
        return null;
    }
}
