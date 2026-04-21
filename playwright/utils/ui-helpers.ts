import type {APIRequestContext, Locator, Page} from '@playwright/test';
import { expect } from '@playwright/test';
import {test} from '../fixtures/test';
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

type ReadinessDiagnostics = {
    label: string;
    mapId: string;
    layerId: string;
    extra?: Record<string, unknown>;
};

async function waitForLayerRequestStartup(
    page: Page,
    mapId: string,
    layerId: string,
    timeoutMs: number
): Promise<boolean> {
    try {
        await page.waitForFunction(({nextMapId, nextLayerId}) => {
            const readiness = window.ebDebug?.debugReadiness?.(nextMapId, nextLayerId) as {
                loadedTileCountTotal?: number;
                tileStream?: { isOpen?: boolean } | null;
                layer?: { requestedTileCountForLayer?: number } | null;
            } | null;
            if (!readiness) {
                return false;
            }
            return (readiness.loadedTileCountTotal ?? 0) > 0
                || !!readiness.tileStream?.isOpen
                || (readiness.layer?.requestedTileCountForLayer ?? 0) > 0;
        }, {
            nextMapId: mapId,
            nextLayerId: layerId
        }, {
            timeout: timeoutMs
        });
        return true;
    } catch {
        return false;
    }
}

async function logReadinessDiagnostics(page: Page, details: ReadinessDiagnostics): Promise<void> {
    const snapshot = await page.evaluate(({label, mapId, layerId, extra}) => {
        const ebDebug = window.ebDebug;
        const mapLayerDialog = document.querySelector('[data-testid="map-layer-dialog"] .p-dialog-content');
        const featureSearchPanel = document.querySelector('[data-testid="feature-search-panel"]');
        const featureSearchBadge = featureSearchPanel?.querySelector('.p-badge')?.textContent?.trim() ?? null;
        const featureSearchStatus = document.querySelector('[data-testid="feature-search-dialog"] .p-tree-empty-message')?.textContent?.trim() ?? null;
        const layerNode = mapLayerDialog?.querySelector(`[data-id="${mapId}/${layerId}"]`);
        const layerCheckbox = layerNode?.querySelector('input.p-checkbox-input[type="checkbox"]') as HTMLInputElement | null;
        const visibleDialogs = Array.from(document.querySelectorAll('.p-dialog[aria-modal="true"]'))
            .map(dialog => {
                const title = dialog.querySelector('.p-dialog-title')?.textContent?.trim();
                return title && title.length ? title : 'untitled-dialog';
            });
        return {
            label,
            userAgent: navigator.userAgent,
            url: window.location.href,
            timeMs: Date.now(),
            dom: {
                mapViewCount: document.querySelectorAll('[data-testid^="mapViewContainer-"]').length,
                canvasCount: document.querySelectorAll('canvas').length,
                visibleDialogs,
                hasViewSyncSelect: !!document.querySelector('[data-testid="viewsync-select"]'),
                featureSearchBadge,
                featureSearchStatus,
                layerCheckboxChecked: layerCheckbox?.checked ?? null
            },
            debugReadiness: typeof ebDebug?.debugReadiness === 'function'
                ? ebDebug.debugReadiness(mapId, layerId)
                : null,
            extra: extra ?? null
        };
    }, details);
    console.log(`[PlaywrightDiag] ${details.label} ${JSON.stringify(snapshot)}`);
}

/** Emits a compact browser/app readiness snapshot into the Playwright logs. */
export async function emitReadinessDiagnostics(
    page: Page,
    label: string,
    mapId: string,
    layerId: string,
    extra?: Record<string, unknown>
): Promise<void> {
    await logReadinessDiagnostics(page, {label, mapId, layerId, extra});
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
    await page.waitForFunction(({nextMapId, nextLayerId}) => {
        const readiness = window.ebDebug?.debugReadiness?.(nextMapId, nextLayerId) as {
            layer?: { layerVisibleByView?: boolean[] } | null;
        } | null;
        return !!readiness?.layer?.layerVisibleByView?.some(Boolean);
    }, {
        nextMapId: mapLabel,
        nextLayerId: layerLabel
    });
    await closeLayerDialog(page);
    const requestStartupObserved = await waitForLayerRequestStartup(page, mapLabel, layerLabel, 2000);
    if (!requestStartupObserved) {
        await emitReadinessDiagnostics(page, 'enableMapLayer-no-request-startup', mapLabel, layerLabel);
    }
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
    try {
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
    } catch (error) {
        await logReadinessDiagnostics(page, {
            label: 'runFeatureSearch-timeout',
            mapId: TEST_MAP_NAMES[0],
            layerId: TEST_LAYER_NAMES[0],
            extra: {
                query,
                resultPanelVisible: await featureSearch.isVisible().catch(() => false),
                badgeText: await resultsBadge.textContent().catch(() => null)
            }
        });
        throw error;
    }
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
    try {
        await expect(syncGroup).toBeVisible();
    } catch (error) {
        await logReadinessDiagnostics(page, {
            label: 'setupTwoViewsWithPositionSync-missing-sync-group',
            mapId: TEST_MAP_NAMES[mapIndex],
            layerId: TEST_LAYER_NAMES[layerIndex],
            extra: {
                mapIndex,
                layerIndex
            }
        });
        throw error;
    }

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

export type DocsScreenshotLabel = {
    locator: Locator;
    label: string;
};

export async function captureDocsScreenshotWithLabels(
    page: Page,
    screenshotPath: string,
    labels: DocsScreenshotLabel[]
): Promise<void> {
    const labelBoxes: Array<{ label: string; x: number; y: number; width: number; height: number }> = [];

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
            height: box.height
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

        const gap = 8;
        const padding = 8;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        const measuredEntries = entries.map((entry) => {
            const label = document.createElement('div');
            label.textContent = entry.label;
            label.style.position = 'fixed';
            label.style.pointerEvents = 'none';
            label.style.zIndex = '2147483647';
            label.style.padding = '4px 8px';
            label.style.borderRadius = '999px';
            label.style.background = 'rgba(16, 24, 40, 0.92)';
            label.style.color = '#f8fafc';
            label.style.border = '1px solid rgba(148, 163, 184, 0.75)';
            label.style.font = '600 12px/1.2 sans-serif';
            label.style.whiteSpace = 'nowrap';
            label.style.boxShadow = '0 6px 18px rgba(15, 23, 42, 0.28)';
            label.style.left = '-9999px';
            label.style.top = '-9999px';

            root.appendChild(label);

            const rect = label.getBoundingClientRect();
            const maxLeft = Math.max(padding, viewportWidth - padding - rect.width);
            const centeredLeft = entry.x + (entry.width / 2) - (rect.width / 2);
            const left = Math.min(Math.max(centeredLeft, padding), maxLeft);

            return {
                entry,
                label,
                left,
                right: left + rect.width,
                labelHeight: rect.height,
                placeBelow: true
            };
        });

        measuredEntries.sort((a, b) => {
            if (a.entry.y !== b.entry.y) {
                return a.entry.y - b.entry.y;
            }
            return a.entry.x - b.entry.x;
        });

        for (let i = 0; i < measuredEntries.length; i++) {
            const current = measuredEntries[i];
            const previous = i > 0 ? measuredEntries[i - 1] : null;

            if (previous) {
                const verticalDistance = Math.abs(current.entry.y - previous.entry.y);
                const maxElementHeight = Math.max(current.entry.height, previous.entry.height);
                const verticalThreshold = maxElementHeight + gap;
                const labelsOverlapOrClose =
                    current.left <= previous.right + gap &&
                    current.right >= previous.left - gap;
                const currentCenterX = current.entry.x + (current.entry.width / 2);
                const previousCenterX = previous.entry.x + (previous.entry.width / 2);
                const xDistance = Math.abs(currentCenterX - previousCenterX);
                const xNear = xDistance <= maxElementHeight;
                const sameCollisionBand =
                    verticalDistance <= verticalThreshold &&
                    (labelsOverlapOrClose || xNear);

                current.placeBelow = sameCollisionBand ? !previous.placeBelow : true;
            }

            const preferredTop = current.placeBelow
                ? current.entry.y + current.entry.height + gap
                : current.entry.y - gap - current.labelHeight;
            const maxTop = Math.max(padding, viewportHeight - padding - current.labelHeight);
            const top = Math.min(Math.max(preferredTop, padding), maxTop);

            current.label.style.left = `${current.left}px`;
            current.label.style.top = `${top}px`;
        }
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
