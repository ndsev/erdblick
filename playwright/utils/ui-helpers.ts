import type {APIRequestContext, Locator, Page} from '@playwright/test';
import { expect } from '@playwright/test';
import {requireMapSource} from './backend-helpers';
import {TEST_LAYER_NAMES, TEST_MAP_NAMES, TEST_VIEW_POSITIONS} from './test-params';

function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function menuItemNamePattern(label: string): RegExp {
    return new RegExp(`${escapeRegExp(label)}$`);
}

async function openMainMenu(page: Page, rootLabel: string): Promise<Locator> {
    const rootItem = page.locator('.main-bar').first().getByRole('menuitem', {
        name: menuItemNamePattern(rootLabel)
    }).first();
    await expect(rootItem).toBeVisible();
    await rootItem.hover();

    const submenu = page.locator('.p-menubar-submenu:visible').last();
    if (!(await submenu.isVisible().catch(() => false))) {
        await rootItem.click();
    }
    await expect(submenu).toBeVisible();
    return submenu;
}

/**
 * High-level UI helpers for driving the Angular app in Playwright tests.
 *
 * The helpers in this module wrap common navigation and interaction patterns
 * (search, layer toggles, multi-view configuration, etc.) so tests can focus
 * on asserting behaviour rather than low-level DOM wiring.
 */

async function finishInitialNavigation(page: Page): Promise<void> {
    await waitForAppReady(page);
    await disableUiAnimations(page);
    await dismissSurveyIfPresent(page);
}

/**
 * Opens the app root without encoding camera or OSM state into the URL.
 *
 * Use this when the test intentionally relies on hydrated application state
 * from a Playwright `stateSnapshot` fixture.
 */
export async function navigateToStateSnapshotRoot(page: Page): Promise<void> {
    await page.goto('/');
    await finishInitialNavigation(page);
}

export async function navigateToRoot(page: Page, locationIndex: number = 0): Promise<void> {
    // Disable OSM by default to make visual assertions more stable.
    const [lon, lat] = TEST_VIEW_POSITIONS[locationIndex];
    const params = new URLSearchParams({
        osm: '0~6,0~6',
        lon: String(lon),
        lat: String(lat),
        alt: String(500),
        h: String(0.02),
        p: String(-0.75),
        r: String(0)
    });
    await page.goto(`/?${params.toString()}`);
    await finishInitialNavigation(page);
}

export async function waitForAppReady(page: Page): Promise<void> {
    // The global spinner hides once the Angular app is ready.
    await page.waitForSelector('#global-spinner-container', {
        state: 'hidden',
        timeout: 30000
    });
}

export async function disableUiAnimations(page: Page): Promise<void> {
    await page.addStyleTag({
        content: `
            *,
            *::before,
            *::after {
                transition: none !important;
                animation: none !important;
                caret-color: transparent !important;
            }
        `
    });
}

export async function dismissSurveyIfPresent(page: Page): Promise<void> {
    const survey = page.locator('#survey').first();
    if (await survey.count() === 0) {
        return;
    }

    // The banner is time-based (config.json start/end). Dismiss it when present so
    // snapshots remain stable across dates.
    const closeButton = survey.locator('.material-symbols-outlined', { hasText: 'close' }).first();
    try {
        if (await closeButton.isVisible({ timeout: 500 })) {
            await closeButton.click({ timeout: 500 });
        }
    } catch {
        // Ignore flakiness if the banner disappears mid-test.
    }
}

export async function revealPrefButtons(page: Page): Promise<Locator> {
    return openMainMenu(page, 'Edit');
}

export async function clickPrefButton(page: Page, label: string): Promise<void> {
    const submenu = await revealPrefButtons(page);
    const currentLabel = label === 'Preferences'
        ? 'Settings'
        : label === 'Styles'
            ? 'Styles Configurator'
            : label;
    const button = submenu.getByRole('menuitem', {
        name: menuItemNamePattern(currentLabel)
    }).first();
    await expect(button).toBeVisible();
    await button.click();
}

export async function openPreferencesDialog(page: Page): Promise<Locator> {
    await clickPrefButton(page, 'Preferences');
    const dialog = page.locator('.pref-dialog').first().locator('.p-dialog').first();
    await expect(dialog).toBeVisible();
    return dialog;
}

export async function openStylesDialog(page: Page): Promise<Locator> {
    await clickPrefButton(page, 'Styles');
    const dialog = page.getByTestId('styles-dialog').locator('.p-dialog').first();
    await expect(dialog).toBeVisible();
    return dialog;
}

export async function openDatasourcesDialog(page: Page): Promise<Locator> {
    await clickPrefButton(page, 'Datasources');
    const dialog = page.locator('div').filter({ hasText: /^DataSource Configuration Editor$/ }).first();
    await expect(dialog).toBeVisible();
    return dialog;
}

export async function openSearchPalette(page: Page, query: string): Promise<Locator> {
    const searchInput = page.locator('textarea[placeholder="Search"]').first();
    await expect(searchInput).toBeVisible();
    await searchInput.click();
    await searchInput.fill(query);

    const searchMenuContainer = page.locator('.resizable-container').filter({
        has: page.locator('.search-menu-dialog')
    }).first();
    await expect(searchMenuContainer).toBeVisible();
    return searchMenuContainer;
}

export async function enableMapLayer(page: Page, mapLabel: string, layerLabel: string): Promise<void> {
    // Open the layer dialog through the toolbar button.
    const mapsButton = page.getByTestId('maps-toggle');
    await mapsButton.click({ force: true });

    const dialog = page.getByTestId('map-layer-dialog').locator('.p-dialog-content');
    await expect(dialog).toBeVisible();
    await dialog.click();

    const layerNode = dialog.locator(`[data-id="${mapLabel}/${layerLabel}"]`).first();
    await expect(layerNode).toBeVisible();

    // Toggle the corresponding checkbox for the requested layer.
    const layerCheckboxInput = layerNode.locator('input.p-checkbox-input[type="checkbox"]').first();
    await expect(layerCheckboxInput).toBeVisible();
    await layerCheckboxInput.check();
    await closeLayerDialog(page);
}

/**
 * Uses the search box to jump to a specific lon/lat/level by selecting the
 * "WGS84 Lon-Lat Coordinates" search option.
 */
export async function navigateToArea(page: Page, lon: number, lat: number, level: number): Promise<void> {
    const searchInput = page.getByTestId('search-input');
    await searchInput.click();
    await searchInput.fill(`${lon} ${lat} ${level}`);
    const searchMenu = page.getByTestId('search-menu-panel');
    await expect(searchMenu).toBeVisible();
    const jumpToWGS84 = searchMenu.locator('.search-menu', {
        hasText: 'WGS84 Lon-Lat Coordinates'
    }).first();
    await expect(jumpToWGS84).toBeVisible();
    // Force the exact coordinate target even when the map panel overlaps the
    // search overlay on narrow layouts.
    await jumpToWGS84.click({ force: true });
}

export async function openLayerDialog(page: Page): Promise<void> {
    const dialog = page.getByTestId('map-layer-dialog').locator('.p-dialog-content');
    if (await dialog.isVisible()) {
        // Dialog is already open; nothing to do.
        return;
    }

    const mapsButton = page.getByTestId('maps-toggle');
    await mapsButton.click({ force: true });
    await expect(dialog).toBeVisible();
}

export async function closeLayerDialog(page: Page): Promise<void> {
    const dialog = page.getByTestId('map-layer-dialog').locator('.p-dialog-content');
    if (!(await dialog.isVisible().catch(() => false))) {
        return;
    }

    const mapsButton = page.getByTestId('maps-toggle');
    await mapsButton.click({ force: true });
    await expect(dialog).toBeHidden();
}

export async function addComparisonView(page: Page): Promise<void> {
    await openLayerDialog(page);

    const dialog = page.getByTestId('map-layer-dialog').locator('.p-dialog-content');
    const addViewButton = dialog.getByTestId('add-view-button');
    await expect(addViewButton).toBeVisible();
    await addViewButton.click();

    // A second map canvas should appear for the comparison view.
    const secondViewCanvas = page.getByTestId('mapViewContainer-1').locator('canvas').first();
    await expect(secondViewCanvas).toBeVisible();
}

/**
 * Runs a "Search Loaded Features" query and waits until at least one result
 * appears in the feature search dialog.
 */
export async function runFeatureSearch(page: Page, query: string): Promise<void> {
    const searchInput = page.getByTestId('search-input');
    await searchInput.click();

    const searchMenu = page.getByTestId('search-menu-panel');
    await expect(searchMenu).toBeVisible();

    const searchLoadedFeatures = searchMenu.locator('.search-menu .search-option-name', {
        hasText: 'Search Loaded Features'
    }).first();
    await expect(searchLoadedFeatures).toBeVisible();

    await searchInput.fill(query);
    await searchInput.focus();
    await page.keyboard.press('Enter');

    const featureSearch = page.getByTestId('feature-search-panel');
    await expect(featureSearch).toBeVisible();

    const resultsBadge = featureSearch.locator('.p-badge').first();
    // Wait until the badge reports at least one search result.
    await expect.poll(async () => {
        const text = await resultsBadge.innerText();
        const value = parseInt(text || '0', 10);
        return Number.isNaN(value) ? 0 : value;
    }, {
        timeout: 10000
    }).toBeGreaterThan(0);

    const emptyMessage = featureSearch.locator('.p-tree-empty-message');
    // When results are available, the "empty tree" message should disappear.
    await expect(emptyMessage).toHaveCount(0);
}

/**
 * Clicks the `index`-th leaf node within the feature search tree, failing the
 * test early when no results are available.
 */
export async function clickSearchResultLeaf(page: Page, index: number): Promise<void> {
    const tree = page.getByTestId('feature-search-tree');
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
 * Prepares a two-view layout with the requested map layer enabled and
 * position synchronisation toggled on.
 *
 * This encapsulates the relatively verbose UI sequence into a single call so
 * multi-view tests stay readable.
 */
export async function setupTwoViewsWithPositionSync(
    page: Page,
    request: APIRequestContext,
    mapIndex: number = 0,
    layerIndex: number = 0
): Promise<void> {
    await requireMapSource(request, TEST_MAP_NAMES[mapIndex], TEST_LAYER_NAMES[layerIndex]);

    await navigateToRoot(page);
    await enableMapLayer(page, TEST_MAP_NAMES[mapIndex], TEST_LAYER_NAMES[layerIndex]);

    await addComparisonView(page);

    const syncGroup = page.getByTestId('viewsync-select');
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

export type DocsScreenshotLabelPlacement = 'auto' | 'top' | 'bottom' | 'left' | 'right';

export type DocsScreenshotLabel = {
    locator: Locator;
    label: string;
    color?: string;
    placement?: DocsScreenshotLabelPlacement;
    outlinePadding?: number;
};

export async function captureDocsScreenshotWithLabels(
    page: Page,
    screenshotPath: string,
    labels: DocsScreenshotLabel[]
): Promise<void> {
    const labelBoxes: Array<{
        label: string;
        x: number;
        y: number;
        width: number;
        height: number;
        color?: string;
        placement: DocsScreenshotLabelPlacement;
        outlinePadding: number;
    }> = [];

    for (const entry of labels) {
        await expect(entry.locator).toBeVisible();
        const box = await entry.locator.boundingBox();
        if (!box) {
            throw new Error(`Could not read bounds for docs label "${entry.label}"`);
        }
        labelBoxes.push({
            label: entry.label,
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            color: entry.color,
            placement: entry.placement ?? 'auto',
            outlinePadding: entry.outlinePadding ?? 3
        });
    }

    await page.evaluate((entries) => {
        document.getElementById('__erdblick-doc-labels__')?.remove();

        const root = document.createElement('div');
        root.id = '__erdblick-doc-labels__';
        root.style.position = 'fixed';
        root.style.inset = '0';
        root.style.pointerEvents = 'none';
        root.style.zIndex = '2147483647';
        document.body.appendChild(root);

        const palette = ['#f97316', '#22c55e', '#06b6d4', '#eab308', '#a855f7', '#ef4444', '#14b8a6', '#3b82f6'];
        const labelGap = 18;
        const padding = 12;
        const connectorThickness = 3;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const placedLabelRects: Array<{ left: number; top: number; right: number; bottom: number }> = [];
        const placedOutlineRects: Array<{ left: number; top: number; right: number; bottom: number }> = [];

        const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
        const inflateRect = (rect: { left: number; top: number; right: number; bottom: number }, amount: number) => ({
            left: rect.left - amount,
            top: rect.top - amount,
            right: rect.right + amount,
            bottom: rect.bottom + amount
        });
        const intersects = (
            a: { left: number; top: number; right: number; bottom: number },
            b: { left: number; top: number; right: number; bottom: number }
        ) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        const overlapPenalty = (
            rect: { left: number; top: number; right: number; bottom: number },
            others: Array<{ left: number; top: number; right: number; bottom: number }>,
            margin: number,
            weight: number
        ) => others.reduce((sum, other) => sum + (intersects(inflateRect(rect, margin), inflateRect(other, margin)) ? weight : 0), 0);
        const overflowPenalty = (rect: { left: number; top: number; right: number; bottom: number }) => {
            const left = Math.max(0, padding - rect.left);
            const top = Math.max(0, padding - rect.top);
            const right = Math.max(0, rect.right - (viewportWidth - padding));
            const bottom = Math.max(0, rect.bottom - (viewportHeight - padding));
            return left + top + right + bottom;
        };

        type Side = 'top' | 'bottom' | 'left' | 'right';
        type Rect = { left: number; top: number; right: number; bottom: number };
        type Candidate = { side: Side; rect: Rect; score: number; color: string; outlineRect: Rect; targetRect: Rect };

        const buildCandidate = (
            side: Side,
            targetRect: Rect,
            outlineRect: Rect,
            labelWidth: number,
            labelHeight: number,
            color: string,
            preferenceBias: number
        ): Candidate => {
            const [left, top] = side === 'top' || side === 'bottom'
                ? [
                    clamp((targetRect.left + targetRect.right - labelWidth) / 2, padding, viewportWidth - padding - labelWidth),
                    side === 'top' ? outlineRect.top - labelGap - labelHeight : outlineRect.bottom + labelGap
                ]
                : [
                    side === 'left' ? outlineRect.left - labelGap - labelWidth : outlineRect.right + labelGap,
                    clamp((targetRect.top + targetRect.bottom - labelHeight) / 2, padding, viewportHeight - padding - labelHeight)
                ];

            const rect = {
                left,
                top,
                right: left + labelWidth,
                bottom: top + labelHeight
            };

            const axisOverlap = side === 'top' || side === 'bottom'
                ? Math.min(rect.right, outlineRect.right) - Math.max(rect.left, outlineRect.left)
                : Math.min(rect.bottom, outlineRect.bottom) - Math.max(rect.top, outlineRect.top);
            const score =
                overflowPenalty(rect) * 1000 +
                (intersects(rect, inflateRect(outlineRect, 2)) ? 100000 : 0) +
                (axisOverlap <= 0 ? 100000 : 0) +
                overlapPenalty(rect, placedLabelRects, 12, 5000) +
                overlapPenalty(rect, placedOutlineRects, 8, 2000) +
                preferenceBias;

            return { side, rect, score, color, outlineRect, targetRect };
        };

        const sortedEntries = entries.slice().sort((a, b) => {
            if (a.y !== b.y) {
                return a.y - b.y;
            }
            return a.x - b.x;
        });

        sortedEntries.forEach((entry, index) => {
            const label = document.createElement('div');
            const color = entry.color || palette[index % palette.length];
            label.textContent = entry.label;
            label.style.position = 'fixed';
            label.style.pointerEvents = 'none';
            label.style.zIndex = '2147483647';
            label.style.padding = '4px 8px';
            label.style.borderRadius = '999px';
            label.style.background = 'rgba(15, 23, 42, 0.94)';
            label.style.color = '#f8fafc';
            label.style.border = `2px solid ${color}`;
            label.style.font = '600 12px/1.2 sans-serif';
            label.style.whiteSpace = 'nowrap';
            label.style.boxShadow = '0 8px 22px rgba(15, 23, 42, 0.28)';
            label.style.left = '-9999px';
            label.style.top = '-9999px';
            root.appendChild(label);

            const measuredRect = label.getBoundingClientRect();
            const targetRect = {
                left: entry.x,
                top: entry.y,
                right: entry.x + entry.width,
                bottom: entry.y + entry.height
            };
            const outlineRect = inflateRect(targetRect, entry.outlinePadding);
            const candidateOrder: Side[] = entry.placement === 'auto'
                ? ['bottom', 'top', 'right', 'left']
                : [entry.placement];
            const candidates = candidateOrder.map((side, candidateIndex) => buildCandidate(
                side,
                targetRect,
                outlineRect,
                measuredRect.width,
                measuredRect.height,
                color,
                candidateIndex
            ));
            const chosen = candidates.reduce((best, current) => current.score < best.score ? current : best);

            const outline = document.createElement('div');
            outline.style.position = 'fixed';
            outline.style.pointerEvents = 'none';
            outline.style.zIndex = '2147483646';
            outline.style.left = `${outlineRect.left}px`;
            outline.style.top = `${outlineRect.top}px`;
            outline.style.width = `${outlineRect.right - outlineRect.left}px`;
            outline.style.height = `${outlineRect.bottom - outlineRect.top}px`;
            outline.style.border = `2px solid ${color}`;
            outline.style.borderRadius = '10px';
            outline.style.boxShadow = `0 0 0 1px ${color}33`;
            root.appendChild(outline);

            label.style.left = `${chosen.rect.left}px`;
            label.style.top = `${chosen.rect.top}px`;

            const connector = document.createElement('div');
            connector.style.position = 'fixed';
            connector.style.pointerEvents = 'none';
            connector.style.zIndex = '2147483645';
            connector.style.background = color;
            connector.style.borderRadius = `${connectorThickness}px`;

            if (chosen.side === 'top' || chosen.side === 'bottom') {
                const overlapLeft = Math.max(chosen.rect.left, outlineRect.left);
                const overlapRight = Math.min(chosen.rect.right, outlineRect.right);
                const x = Math.round((overlapLeft + overlapRight) / 2 - connectorThickness / 2);
                const top = chosen.side === 'top' ? chosen.rect.bottom : outlineRect.bottom;
                const bottom = chosen.side === 'top' ? outlineRect.top : chosen.rect.top;
                connector.style.left = `${x}px`;
                connector.style.top = `${top}px`;
                connector.style.width = `${connectorThickness}px`;
                connector.style.height = `${Math.max(0, bottom - top)}px`;
            } else {
                const overlapTop = Math.max(chosen.rect.top, outlineRect.top);
                const overlapBottom = Math.min(chosen.rect.bottom, outlineRect.bottom);
                const y = Math.round((overlapTop + overlapBottom) / 2 - connectorThickness / 2);
                const left = chosen.side === 'left' ? chosen.rect.right : outlineRect.right;
                const right = chosen.side === 'left' ? outlineRect.left : chosen.rect.left;
                connector.style.left = `${left}px`;
                connector.style.top = `${y}px`;
                connector.style.width = `${Math.max(0, right - left)}px`;
                connector.style.height = `${connectorThickness}px`;
            }
            root.appendChild(connector);

            placedLabelRects.push(chosen.rect);
            placedOutlineRects.push(outlineRect);
        });
    }, labelBoxes);

    const browserName = page.context().browser()?.browserType().name();
    try {
        if (browserName === 'chromium') {
            await page.screenshot({
                path: screenshotPath
            });
        }
    } finally {
        await page.evaluate(() => {
            document.getElementById('__erdblick-doc-labels__')?.remove();
        });
    }
}
