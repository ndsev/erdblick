import { expect, test } from '../fixtures/test';
import { requireMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAMES, TEST_MAP_NAMES } from '../utils/test-params';
import {
    captureDocsScreenshotWithLabels,
    enableMapLayer,
    navigateToStateSnapshotRoot,
    openSearchPalette
} from '../utils/ui-helpers';

const MAP_INDEX = 0;
const LAYER_INDEX = 0;
const SEARCH_QUERY = '**.layerId == "Road"';

test.use({ stateSnapshot: 'style_editor_state' });

test.describe('Snapshot – search component', () => {
    test('search palette and feature-search dialog', async ({ page, request }) => {
        await requireMapSource(request, TEST_MAP_NAMES[MAP_INDEX], TEST_LAYER_NAMES[LAYER_INDEX]);
        await navigateToStateSnapshotRoot(page);
        await enableMapLayer(page, TEST_MAP_NAMES[MAP_INDEX], TEST_LAYER_NAMES[LAYER_INDEX]);

        const searchPalette = await openSearchPalette(page, SEARCH_QUERY);
        // Schema-backed jump providers are initialized asynchronously. Wait
        // for one datasource-derived option so the snapshot never captures
        // the transient built-in-only palette.
        await expect(searchPalette.getByText('Jump to Way', { exact: true }))
            .toBeVisible();
        await page.mouse.move(0, 0);
        await expect(page).toHaveScreenshot('search-component-palette.png', {
            maxDiffPixelRatio: 0.01
        });

        const searchInput = page.getByTestId('search-input');
        const searchMenu = page.getByTestId('search-menu-panel');
        await expect(searchMenu).toBeVisible();

        const featureSearchAction = searchMenu.locator('.search-menu', {
            hasText: 'Search Features and Attributes'
        }).first();
        await expect(featureSearchAction).toBeVisible();

        await featureSearchAction.locator('.search-option-wrapper').first().click();

        const featureSearchDialog = page.getByTestId('feature-search-dialog').locator('.p-dialog').first();
        await expect(featureSearchDialog).toBeVisible();
        await expect(featureSearchDialog.getByTestId('feature-search-tree')).toBeVisible();
        await expect(featureSearchDialog.getByText('Complete, 1/1 tiles', {
            exact: true
        })).toBeVisible();
        await expect(featureSearchDialog.getByText('No matches found.', {
            exact: true
        })).toBeVisible();

        await page.mouse.move(0, 0);
        await expect(page).toHaveScreenshot('search-component-results.png', {
            maxDiffPixelRatio: 0.01
        });

        const resultsTab = page.getByRole('tab', { name: /^Results / });
        const diagnosticsTab = page.getByRole('tab', { name: /^Diagnostics / });
        const closeButton = featureSearchDialog.locator('.p-dialog-header button').first();

        await page.mouse.move(0, 0);
        await captureDocsScreenshotWithLabels(page, 'docs/screenshots/search-component-controls.png', [
            {
                locator: page.getByTestId('search-input'),
                label: 'Search query input'
            },
            {
                locator: resultsTab,
                label: 'Results tab'
            },
            {
                locator: diagnosticsTab,
                label: 'Diagnostics tab'
            },
            {
                locator: page.getByTestId('feature-search-tree'),
                label: 'Search results tree'
            },
            {
                locator: closeButton,
                label: 'Close search dialog'
            }
        ]);
    });
});
