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

/** Opens a main-bar submenu, including layouts that require a click after hover. */
export async function openMainMenu(page: Page, rootLabel: string): Promise<Locator> {
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
    const currentLabels = label === 'Preferences'
        ? ['Preferences', 'Settings']
        : [label === 'Styles' ? 'Styles Configurator' : label];
    const button = submenu.getByRole('menuitem', {
        name: new RegExp(`(?:${currentLabels.map(escapeRegExp).join('|')})$`)
    }).first();
    await expect(button).toBeVisible();
    await button.click();
}

export async function openPreferencesDialog(page: Page): Promise<Locator> {
    await clickPrefButton(page, 'Preferences');
    const dialog = page.getByRole('dialog', {name: 'Preferences'}).first();
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
 * Runs a "Search Features and Attributes" query and waits until at least one
 * result appears in the feature search dialog.
 */
export async function runFeatureSearch(page: Page, query: string): Promise<void> {
    const searchInput = page.getByTestId('search-input');
    await searchInput.click();
    await searchInput.fill(query);
    await searchInput.focus();

    const searchMenu = page.getByTestId('search-menu-panel');
    await expect(searchMenu).toBeVisible();

    const featureSearchAction = searchMenu.locator('.search-menu', {
        hasText: 'Search Features and Attributes'
    }).first();
    await expect(featureSearchAction).toBeVisible();
    await featureSearchAction.locator('.search-option-wrapper').first().click();

    const featureSearch = page.getByTestId('feature-search-panel');
    await expect(featureSearch).toBeVisible();

    const resultsBadge = featureSearch.locator('.p-badge').first();
    // Wait until the badge reports at least one search result.
    await expect.poll(async () => {
        const text = await resultsBadge.innerText();
        const value = parseInt(text || '0', 10);
        return Number.isNaN(value) ? 0 : value;
    }, {
        timeout: 80000
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

/** Derives the packed tile id used by the deterministic test viewport. */
export async function packedTileIdForTestPosition(
    page: Page,
    locationIndex: number = 0
): Promise<number> {
    const [lon, lat, level] = TEST_VIEW_POSITIONS[locationIndex];
    return page.evaluate(({lon, lat, level}) => {
        const debugApi = window.ebDebug as any;
        const core = debugApi?.coreLib?.();
        if (!core || typeof core.getTileIdFromPosition !== 'function') {
            throw new Error('window.ebDebug.coreLib().getTileIdFromPosition is not available');
        }
        return core.getTileIdFromPosition(lon, lat, level) as number;
    }, {lon, lat, level});
}

/**
 * Selects one deterministic feature through the same AppState path used by
 * result clicks and map picking. The inspection service performs the exact
 * restricted feature fetch; no client-side complete-tile registry is involved.
 */
export async function selectFeatureForInspection(
    page: Page,
    mapId: string,
    layerId: string,
    featureId: string,
    tileId?: number
): Promise<void> {
    const resolvedTileId = tileId ?? await packedTileIdForTestPosition(page);
    await page.evaluate(async ({ mapId, layerId, tileId, featureId }) => {
        const debugApi = window.ebDebug as any;
        const mapTileKey = debugApi.mapTileKey(mapId, layerId, tileId);
        const summary = await debugApi.featureInspectionHoverSummary(
            mapTileKey,
            featureId
        );
        if (summary?.error) {
            throw new Error(String(summary.error));
        }
        debugApi.stateService.setSelection([{ mapTileKey, featureId }]);
    }, { mapId, layerId, tileId: resolvedTileId, featureId });
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
    through?: Locator;
    label: string;
    color?: string;
    placement?: DocsScreenshotLabelPlacement;
    outlinePadding?: number;
    gap?: number;
    at?: [number, number];
    labelWidth?: number;
    shape?: 'circle';
};

/** Draw temporary callouts; strict mode rejects obscured targets and unusable label placement. */
export async function captureDocsScreenshotWithLabels(
    page: Page,
    screenshotPath: string,
    labels: DocsScreenshotLabel[],
    {strict = false, fontSize = 12}: {strict?: boolean; fontSize?: number} = {}
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
        gap: number;
        at?: [number, number];
        labelWidth?: number;
        shape?: 'circle';
    }> = [];

    for (const entry of labels) {
        await expect(entry.locator).toBeVisible();
        let box = await entry.locator.boundingBox();
        if (!box) {
            throw new Error(`Could not read bounds for docs label "${entry.label}"`);
        }
        for (const target of [entry.locator, ...(entry.through ? [entry.through] : [])]) {
            if (strict) {
                const exposed = await target.evaluate(element => {
                    const rect = element.getBoundingClientRect();
                    if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) {
                        return false;
                    }
                    // Non-interactive overlays (hover labels, navigation rings) deliberately
                    // use pointer-events:none. Include this target in hit testing temporarily
                    // so the same occlusion check also covers those painted overlays.
                    const style = (element as HTMLElement).style;
                    const pointerEvents = style.getPropertyValue('pointer-events');
                    const priority = style.getPropertyPriority('pointer-events');
                    style.setProperty('pointer-events', element instanceof SVGElement ? 'bounding-box' : 'auto', 'important');
                    try {
                        return [[0.2, 0.2], [0.8, 0.2], [0.5, 0.5], [0.2, 0.8], [0.8, 0.8]]
                            .every(([x, y]) => {
                                const hit = document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y);
                                return hit !== null && (element.contains(hit) || hit.contains(element));
                            });
                    } finally {
                        if (pointerEvents) style.setProperty('pointer-events', pointerEvents, priority);
                        else style.removeProperty('pointer-events');
                    }
                });
                expect(exposed, `Docs annotation target is clipped or obscured: ${entry.label}`).toBe(true);
            }
        }
        if (entry.through) {
            await expect(entry.through).toBeVisible();
            const end = await entry.through.boundingBox();
            if (!end) throw new Error(`Missing end target for ${entry.label}`);
            const x = Math.min(box.x, end.x), y = Math.min(box.y, end.y);
            box = {x, y, width: Math.max(box.x + box.width, end.x + end.width) - x,
                height: Math.max(box.y + box.height, end.y + end.height) - y};
        }
        labelBoxes.push({
            label: entry.label,
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            color: entry.color,
            placement: entry.placement ?? 'auto',
            outlinePadding: entry.outlinePadding ?? 3,
            at: entry.at, labelWidth: entry.labelWidth, shape: entry.shape,
            gap: entry.gap ?? 18
        });
    }

    try {
        await page.evaluate(({entries, strict, fontSize}) => {
            document.getElementById('__erdblick-doc-labels__')?.remove();

            const root = document.createElement('div');
            root.id = '__erdblick-doc-labels__';
            root.style.position = 'fixed';
            root.style.inset = '0';
            root.style.pointerEvents = 'none';
            root.style.zIndex = '2147483647';
            document.body.appendChild(root);

            const palette = ['#f97316', '#22c55e', '#06b6d4', '#eab308', '#a855f7', '#ef4444', '#14b8a6', '#3b82f6'];
            const padding = 12;
            const connectorThickness = 3;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const placedLabelRects: Array<{ left: number; top: number; right: number; bottom: number }> = [];
            const placedOutlineRects: Array<{ left: number; top: number; right: number; bottom: number }> = [];
            const connections: Array<{label: Rect; target: Rect; color: string; text: string; circle: boolean}> = [];

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
                preferenceBias: number,
                labelGap: number
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
                label.style.font = `600 ${fontSize}px/1.2 sans-serif`;
                label.style.whiteSpace = entry.labelWidth ? 'normal' : 'nowrap';
                if (entry.labelWidth) label.style.width = `${entry.labelWidth}px`;
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
                    candidateIndex,
                    entry.gap
                ));
                const chosen = candidates.reduce((best, current) => current.score < best.score ? current : best);
                if (entry.at) {
                    chosen.rect = {left: entry.at[0], top: entry.at[1], right: entry.at[0] + measuredRect.width, bottom: entry.at[1] + measuredRect.height};
                    const dx = (chosen.rect.left + chosen.rect.right - targetRect.left - targetRect.right) / 2;
                    const dy = (chosen.rect.top + chosen.rect.bottom - targetRect.top - targetRect.bottom) / 2;
                    chosen.side = entry.placement !== 'auto' ? entry.placement : Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
                }
                if (strict && (overflowPenalty(chosen.rect) > 0
                    || intersects(chosen.rect, outlineRect)
                    || placedLabelRects.some(rect => intersects(chosen.rect, inflateRect(rect, 4)))
                    || entries.some(other => intersects(chosen.rect, {
                        left: other.x, top: other.y, right: other.x + other.width, bottom: other.y + other.height
                    })))) {
                    throw new Error(`Docs annotation overlaps a target, another label, or the viewport edge: ${entry.label}`);
                }

                const outline = document.createElement('div');
                outline.style.position = 'fixed';
                outline.style.boxSizing = 'border-box';
                outline.style.pointerEvents = 'none';
                outline.style.zIndex = '2147483646';
                outline.style.left = `${outlineRect.left}px`;
                outline.style.top = `${outlineRect.top}px`;
                outline.style.width = `${outlineRect.right - outlineRect.left}px`;
                outline.style.height = `${outlineRect.bottom - outlineRect.top}px`;
                outline.style.border = `2px solid ${color}`;
                outline.style.borderRadius = entry.shape === 'circle' ? '50%' : '10px';
                outline.style.boxShadow = `0 0 0 1px ${color}33`;
                root.appendChild(outline);

                label.style.left = `${chosen.rect.left}px`;
                label.style.top = `${chosen.rect.top}px`;

                connections.push({label: chosen.rect, target: outlineRect, color, text: entry.label, circle: entry.shape === 'circle'});

                placedLabelRects.push(chosen.rect);
                placedOutlineRects.push(outlineRect);
            });
            // Route only after all labels have final bounds. Every route sees every
            // label/target and the already drawn paths, including their stroke width.
            type Point = {x: number; y: number};
            const segments: Array<{a: Point; b: Point}> = [];
            const ports = (r: Rect) => [
                {x: r.left, y: (r.top + r.bottom) / 2, dx: -1, dy: 0},
                {x: r.right, y: (r.top + r.bottom) / 2, dx: 1, dy: 0},
                {x: (r.left + r.right) / 2, y: r.top, dx: 0, dy: -1},
                {x: (r.left + r.right) / 2, y: r.bottom, dx: 0, dy: 1}
            ];
            const inside = (p: Point, r: Rect) => p.x > r.left && p.x < r.right && p.y > r.top && p.y < r.bottom;
            /** Clip any segment against a rectangle, including diagonal direct routes. */
            const hits = (a: Point, b: Point, r: Rect): boolean => {
                let enter = 0, exit = 1;
                for (const [origin, delta, min, max] of [
                    [a.x, b.x - a.x, r.left, r.right],
                    [a.y, b.y - a.y, r.top, r.bottom]
                ]) {
                    if (delta === 0) {
                        if (origin < min || origin > max) return false;
                    } else {
                        const first = (min - origin) / delta, last = (max - origin) / delta;
                        enter = Math.max(enter, Math.min(first, last));
                        exit = Math.min(exit, Math.max(first, last));
                        if (enter > exit) return false;
                    }
                }
                return true;
            };
            /** Distance to the painted segment, rather than its potentially large bounding box. */
            const pointSegmentDistance = (p: Point, a: Point, b: Point): number => {
                const dx = b.x - a.x, dy = b.y - a.y;
                const lengthSquared = dx * dx + dy * dy;
                const t = lengthSquared ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared, 0, 1) : 0;
                return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
            };
            /** Keep a stroke-width margin around existing paths, including crossings in their interiors. */
            const touchesPath = (a: Point, b: Point, c: Point, d: Point): boolean => {
                const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
                const boundsOverlap = Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x))
                    && Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
                return (boundsOverlap && cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0)
                    || Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
                        pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b)) < 4;
            };
            // Reserve nearby connections first; distant callouts can route around
            // them instead of forcing a short connection into a long detour.
            const separation = ({label, target}: typeof connections[number]) =>
                Math.max(0, label.left - target.right, target.left - label.right) +
                Math.max(0, label.top - target.bottom, target.top - label.bottom);
            for (const connection of connections.sort((a, b) => separation(a) - separation(b))) {
                const center = {x: (connection.target.left + connection.target.right) / 2, y: (connection.target.top + connection.target.bottom) / 2};
                const outlines = placedOutlineRects.filter(r => r === connection.target || !inside(center, r));
                const pathObstacles = segments.map(({a, b}) => inflateRect({left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y)}, 4));
                const obstacles = [
                    ...placedLabelRects.map(r => inflateRect(r, 5)),
                    ...outlines.map(r => inflateRect(r, 4))
                ];
                const entryObstacles = [
                    ...placedLabelRects.filter(r => r !== connection.label).map(r => inflateRect(r, 5)),
                    ...outlines.map(r => inflateRect(r, 4))
                ];
                const targetPorts = ports(connection.target);
                const labelPorts = ports(connection.label);
                // A straight connector need not start at the outline's midpoint.
                // Project the label's center onto flat edges, keeping rounded
                // corners (and circular targets) clear so endpoints touch paint.
                if (!connection.circle) {
                    const target = connection.target;
                    const x = (connection.label.left + connection.label.right) / 2;
                    const y = (connection.label.top + connection.label.bottom) / 2;
                    const radius = Math.min(10, (target.right - target.left) / 2, (target.bottom - target.top) / 2);
                    if (y >= target.top + radius && y <= target.bottom - radius) {
                        targetPorts.push({x: target.left, y, dx: -1, dy: 0}, {x: target.right, y, dx: 1, dy: 0});
                    }
                    if (x >= target.left + radius && x <= target.right - radius) {
                        targetPorts.push({x, y: target.top, dx: 0, dy: -1}, {x, y: target.bottom, dx: 0, dy: 1});
                    }
                    // Wide capsules also have flat top/bottom edges. Use the
                    // shared horizontal span for an unobstructed vertical line.
                    const labelRadius = Math.min((connection.label.right - connection.label.left) / 2,
                        (connection.label.bottom - connection.label.top) / 2);
                    const left = Math.max(target.left + radius, connection.label.left + labelRadius);
                    const right = Math.min(target.right - radius, connection.label.right - labelRadius);
                    if (left <= right) {
                        const sharedX = (left + right) / 2;
                        targetPorts.push({x: sharedX, y: target.top, dx: 0, dy: -1}, {x: sharedX, y: target.bottom, dx: 0, dy: 1});
                        labelPorts.push({x: sharedX, y: connection.label.top, dx: 0, dy: -1},
                            {x: sharedX, y: connection.label.bottom, dx: 0, dy: 1});
                    }
                }
                const directObstacles = [
                    ...placedLabelRects.filter(r => r !== connection.label).map(r => inflateRect(r, 5)),
                    ...outlines.filter(r => r !== connection.target).map(r => inflateRect(r, 4))
                ];
                // Prefer one visible line. Ports remain on painted flat edges or
                // circle midpoints, and the line must leave/enter their outward sides.
                const direct = targetPorts.flatMap(start => labelPorts.map(end => ({start, end})))
                    .filter(({start, end}) => (end.x - start.x) * start.dx + (end.y - start.y) * start.dy > 0
                        && (start.x - end.x) * end.dx + (start.y - end.y) * end.dy > 0
                        && !directObstacles.some(r => hits(start, end, r))
                        && !segments.some(({a, b}) => touchesPath(start, end, a, b)))
                    .sort((a, b) => Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y)
                        - Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y))[0];
                let points: Point[];
                if (direct) {
                    points = [direct.start, direct.end];
                } else {
                    const starts = targetPorts.map(p => ({port: p, x: p.x + p.dx * 10, y: p.y + p.dy * 10}));
                    // The final stub crosses its own label's padding, but no other obstacle.
                    const ends = labelPorts.map(p => ({port: p, x: p.x + p.dx * 10, y: p.y + p.dy * 10}))
                        .filter(end => !entryObstacles.some(r => hits(end, end.port, r))
                            && !segments.some(({a, b}) => touchesPath(end, end.port, a, b)));
                    const available = (p: Point) => p.x >= padding && p.x <= viewportWidth - padding && p.y >= padding && p.y <= viewportHeight - padding
                        && !obstacles.some(r => inside(p, r)) && !segments.some(({a, b}) => pointSegmentDistance(p, a, b) < 4);
                    const clear = (a: Point, b: Point) => !obstacles.some(r => hits(a, b, r))
                        && !segments.some(other => touchesPath(a, b, other.a, other.b));
                    const gridObstacles = [...obstacles, ...pathObstacles];
                    const xs = [...new Set([padding, viewportWidth - padding, ...starts.map(p => p.x), ...ends.map(p => p.x), ...gridObstacles.flatMap(r => [r.left - 1, r.right + 1])])].filter(x => x >= padding && x <= viewportWidth - padding).sort((a,b) => a-b);
                    const ys = [...new Set([padding, viewportHeight - padding, ...starts.map(p => p.y), ...ends.map(p => p.y), ...gridObstacles.flatMap(r => [r.top - 1, r.bottom + 1])])].filter(y => y >= padding && y <= viewportHeight - padding).sort((a,b) => a-b);
                    type Step = {x: number; y: number; axis: number; cost: number; previous?: Step; start: typeof starts[number]};
                    const queue: Step[] = [];
                    const costs = new Map<string, number>();
                    const key = (x: number, y: number, axis: number) => `${x},${y},${axis}`;
                    for (const start of starts.filter(available)) {
                        // The short exit stub may cross its own outline, never a neighbour.
                        if (placedLabelRects.some(r => hits(start.port, start, inflateRect(r, 5))) ||
                            outlines.some(r => r !== connection.target && hits(start.port, start, inflateRect(r, 4))) ||
                            segments.some(({a, b}) => touchesPath(start.port, start, a, b))) continue;
                        const step = {x: xs.indexOf(start.x), y: ys.indexOf(start.y), axis: start.port.dx ? 0 : 1, cost: 0, start};
                        queue.push(step); costs.set(key(step.x, step.y, step.axis), 0);
                    }
                    let finish: Step | undefined;
                    let end: typeof ends[number] | undefined;
                    while (queue.length) {
                        queue.sort((a,b) => b.cost-a.cost);
                        const step = queue.pop()!;
                        if (costs.get(key(step.x, step.y, step.axis)) !== step.cost) continue;
                        const point = {x: xs[step.x], y: ys[step.y]};
                        end = ends.find(p => p.x === point.x && p.y === point.y && available(p));
                        if (end) {finish = step; break;}
                        for (const [dx, dy, axis] of [[-1,0,0],[1,0,0],[0,-1,1],[0,1,1]]) {
                            const x = step.x + dx, y = step.y + dy;
                            if (x < 0 || y < 0 || x >= xs.length || y >= ys.length) continue;
                            const next = {x: xs[x], y: ys[y]};
                            if (!available(next) || !clear(point, next)) continue;
                            const cost = step.cost + Math.abs(next.x-point.x) + Math.abs(next.y-point.y) + (step.axis === axis ? 0 : 24);
                            const id = key(x,y,axis);
                            if (cost >= (costs.get(id) ?? Infinity)) continue;
                            costs.set(id,cost); queue.push({x,y,axis,cost,previous:step,start:step.start});
                        }
                    }
                    if (!finish || !end) throw new Error(`No collision-free connector route: ${connection.text}`);
                    points = [end.port, end];
                    for (let step: Step | undefined = finish; step; step = step.previous) points.push({x: xs[step.x], y: ys[step.y]});
                    points.push(finish.start.port); points.reverse();
                }
                // Remove duplicate and collinear vertices, so aligned endpoints stay straight.
                const route: Point[] = [];
                for (const point of points) {
                    if (route.length && route.at(-1)!.x === point.x && route.at(-1)!.y === point.y) continue;
                    while (route.length > 1 && ((route.at(-2)!.x === route.at(-1)!.x && route.at(-1)!.x === point.x) || (route.at(-2)!.y === route.at(-1)!.y && route.at(-1)!.y === point.y))) route.pop();
                    route.push(point);
                }
                for (let i = 1; i < route.length; i++) segments.push({a: route[i-1], b: route[i]});
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147483645';
                const line = document.createElementNS(svg.namespaceURI, 'path');
                line.setAttribute('d', route.map((p,i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' '));
                line.setAttribute('data-docs-route', connection.text);
                line.setAttribute('fill', 'none');
                line.setAttribute('stroke', connection.color);
                line.setAttribute('stroke-width', String(connectorThickness));
                line.setAttribute('stroke-linejoin', 'round');
                svg.appendChild(line); root.appendChild(svg);
            }
        }, {entries: labelBoxes, strict, fontSize});

        const browserName = page.context().browser()?.browserType().name();
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
