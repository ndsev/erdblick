import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures/test';
import { requireMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAMES, TEST_MAP_NAMES, TEST_VIEW_POSITIONS } from '../utils/test-params';
import {
    captureDocsScreenshotWithLabels,
    enableMapLayer,
    navigateToRoot,
    openLayerDialog,
    openSearchPalette
} from '../utils/ui-helpers';

const MAP_INDEX = 0;
const LAYER_INDEX = 0;
const LOCATION_INDEX = 0;

type DebugCoreBridge = {
    getTileIdFromPosition?: (lon: number, lat: number, level: number) => bigint | number | string;
};

type DebugWindow = Window & {
    ebDebug?: {
        coreLib?: () => DebugCoreBridge;
    };
};

async function openSourceDataSelectionDialog(page: Page): Promise<Locator> {
    const [lon, lat, level] = TEST_VIEW_POSITIONS[LOCATION_INDEX];
    const tileId = await page.evaluate(({ tileLon, tileLat, tileLevel }) => {
        const core = (window as DebugWindow).ebDebug?.coreLib?.();
        if (!core || typeof core.getTileIdFromPosition !== 'function') {
            throw new Error('window.ebDebug.coreLib().getTileIdFromPosition is not available');
        }
        return String(core.getTileIdFromPosition(tileLon, tileLat, tileLevel));
    }, {
        tileLon: lon,
        tileLat: lat,
        tileLevel: level
    });

    // Unlike navigateToRoot(), the third tuple entry is used here to derive a
    // deterministic tile id for the source-data search action.
    const searchMenu = await openSearchPalette(page, `${tileId} "${TEST_MAP_NAMES[MAP_INDEX]}"`);
    const sourceDataAction = searchMenu.locator('.search-option-wrapper', {
        hasText: 'Inspect Tile Layer Source Data'
    }).first();
    await expect(sourceDataAction).toBeVisible();
    await sourceDataAction.click();

    await expect(page.getByTestId('search-menu-dialog').locator('.p-dialog').first()).toBeHidden();

    const dialog = page.getByTestId('source-data-selection-panel').first();
    await expect(dialog).toBeVisible();
    return dialog;
}

test.describe('Snapshot – map panel and source data selection dialog', () => {
    test('map panel and empty source data selection state', async ({ page, request }) => {
        await requireMapSource(request, TEST_MAP_NAMES[MAP_INDEX], TEST_LAYER_NAMES[LAYER_INDEX]);
        await navigateToRoot(page, LOCATION_INDEX);
        await enableMapLayer(page, TEST_MAP_NAMES[MAP_INDEX], TEST_LAYER_NAMES[LAYER_INDEX]);

        await openLayerDialog(page);
        const mapPanel = page.getByTestId('map-layer-dialog').locator('.p-dialog').first();
        await expect(mapPanel).toBeVisible();

        await expect(page).toHaveScreenshot('map-panel.png', {
            maxDiffPixelRatio: 0.01
        });

        const sourceDataDialog = await openSourceDataSelectionDialog(page);

        await expect(page).toHaveScreenshot('map-panel-source-data-selection-dialog.png', {
            maxDiffPixelRatio: 0.01
        });

        await captureDocsScreenshotWithLabels(page, 'docs/screenshots/map-panel-source-data-selection-controls.png', [
            {
                locator: page.getByTestId('maps-toggle'),
                label: 'Toggle maps panel'
            },
            {
                locator: sourceDataDialog.getByTestId('source-data-selection-custom-tile-id'),
                label: 'Tile ID input'
            },
            {
                locator: sourceDataDialog.getByTestId('source-data-selection-toggle-custom-tile-id'),
                label: 'Reset tile input'
            },
            {
                locator: sourceDataDialog.getByTestId('source-data-selection-map-select'),
                label: 'Map selector'
            },
            {
                locator: sourceDataDialog.getByTestId('source-data-selection-layer-select'),
                label: 'Source data layer selector'
            },
            {
                locator: sourceDataDialog.getByTestId('source-data-selection-confirm-button'),
                label: 'Confirm inspection'
            },
            {
                locator: sourceDataDialog.getByTestId('source-data-selection-close-button'),
                label: 'Close dialog'
            }
        ]);
    });
});
