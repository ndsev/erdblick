import { expect, test } from '../fixtures/test';
import { requireMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAMES, TEST_MAP_NAMES } from '../utils/test-params';
import {
    captureDocsScreenshotWithLabels,
    enableMapLayer,
    navigateToStateSnapshotRoot,
    openOmnibar
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

        await openOmnibar(page, SEARCH_QUERY);
        const searchMenu = page.getByTestId('omnibar-menu-panel');
        const featureSearchAction = searchMenu.getByTestId('omnibar-action')
            .filter({hasText: 'Search Features and Attributes'});
        await expect(featureSearchAction).toBeVisible();
        // This expression is a search, not a feature ID. Matching jump actions
        // are covered separately; unrelated jump rows must stay out of the palette.
        await expect(searchMenu.locator('[data-action-id^="fj:"]')).toHaveCount(0);
        // End leaves this completed single-line expression intact and dismisses
        // completion, including late replies, before capturing the action menu.
        await page.getByTestId('omnibar-input').press('End');
        await expect(page.getByTestId('omnibar-input')).toHaveValue(SEARCH_QUERY);
        await expect(page.getByTestId('search-completion-popup')).toBeHidden();
        await page.mouse.move(0, 0);
        await expect(page).toHaveScreenshot('search-component-palette.png', {
            maxDiffPixelRatio: 0.01
        });

        await featureSearchAction.click();

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
        const closeButton = featureSearchDialog.getByTestId('surface-close-button');

        await page.mouse.move(0, 0);
        await captureDocsScreenshotWithLabels(page, 'docs/screenshots/search-component-controls.png', [
            {
                locator: page.getByTestId('omnibar-input'),
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
                label: 'Close search dialog',
                placement: 'right'
            }
        ]);
    });
});
