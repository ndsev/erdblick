import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAME, TEST_MAP_NAME, TEST_VIEW_POSITION } from '../utils/test-params';
import {
    addComparisonView,
    clickSearchResultLeaf,
    enableMapLayer,
    navigateToArea,
    navigateToRoot,
    openDatasourcesDialog,
    openLayerDialog,
    openPreferencesDialog,
    openSearchPalette,
    openStylesDialog,
    revealPrefButtons,
    runFeatureSearch
} from '../utils/ui-helpers';

async function prepareTestMapView(page: Page, request: APIRequestContext): Promise<void> {
    await requireTestMapSource(request);
    await navigateToRoot(page);
    await enableMapLayer(page, TEST_MAP_NAME, TEST_LAYER_NAME);
    await navigateToArea(page, ...TEST_VIEW_POSITION);
}

test.describe('Snapshot – all', () => {
    test('all snapshots', async ({ page, request }) => {
        test.setTimeout(10000000);
        await prepareTestMapView(page, request);
        await expect(page.locator('body')).toHaveScreenshot('erdblick.png', {
            maxDiffPixelRatio: 0.01
        });

        await revealPrefButtons(page);
        const controls = page.locator('.pref-buttons-container').first();
        await expect(controls).toHaveScreenshot('layout.png', {
            maxDiffPixelRatio: 0.01
        });

        await openLayerDialog(page);
        const dialog = page.locator('.map-layer-dialog').locator('.p-dialog-content');
        await expect(dialog).toBeVisible();
        await dialog.click();
        await expect(dialog).toHaveScreenshot('maps-and-layers.png', {
            maxDiffPixelRatio: 0.01
        });

        const mapContainer = page.locator('#mapViewContainer-0');
        await expect(mapContainer).toBeVisible();
        await expect(mapContainer).toHaveScreenshot('map-single-view.png', {
            maxDiffPixelRatio: 0.01
        });

        const searchMenu = await openSearchPalette(page, '12345');
        await expect(searchMenu).toBeVisible();
        await expect(searchMenu).toHaveScreenshot('search-pallette.png', {
            maxDiffPixelRatio: 0.01
        });

        await runFeatureSearch(page, '**.name');
        const featureSearch = page.locator('.feature-search-dialog').first();
        const featureSearchDialog = featureSearch.locator('.p-dialog').first();
        await expect(featureSearchDialog).toBeVisible();
        await expect(featureSearchDialog).toHaveScreenshot('search-in-progress.png', {
            maxDiffPixelRatio: 0.01
        });

        await clickSearchResultLeaf(page, 0);
        const inspectionContainer = page.locator('.inspection-container');
        await expect(inspectionContainer).toBeVisible();
        await expect(inspectionContainer).toHaveScreenshot('inspection-panel-testmap.png', {
            maxDiffPixelRatio: 0.01
        });

        const panel = page.locator('.inspection-container .inspect-panel').first();
        await expect(panel).toBeVisible();
        const filterInput = panel.locator('input.filter-input[placeholder="Filter inspection tree"]').first();
        await expect(filterInput).toBeVisible();
        await filterInput.fill('id');
        await expect(panel).toHaveScreenshot('feature-inspection-details.png', {
            maxDiffPixelRatio: 0.01
        });

        const pinIcon = panel.locator('.material-symbols-outlined', { hasText: 'keep_off' }).first();
        await expect(pinIcon).toBeVisible();
        await pinIcon.click();
        await clickSearchResultLeaf(page, 1);
        const featureSearchHeader = featureSearchDialog.locator('.p-dialog-header').first();
        await expect(featureSearchHeader).toBeVisible();
        const closeButtonHeader = featureSearchHeader.locator('button').first();
        await closeButtonHeader.click();
        await expect(inspectionContainer).toBeVisible();
        await expect(inspectionContainer.locator('.inspect-panel')).toHaveCount(2);
        await expect(inspectionContainer).toHaveScreenshot('feature-inspection-multi.png', {
            maxDiffPixelRatio: 0.01
        });

        const datasourceDialog = await openDatasourcesDialog(page);
        await expect(datasourceDialog).toHaveScreenshot('datasource-editor.png', {
            maxDiffPixelRatio: 0.01
        });

        const stylesDialog = await openStylesDialog(page);
        await expect(stylesDialog).toHaveScreenshot('style-dialog.png', {
            maxDiffPixelRatio: 0.01
        });
        const editStyleButton = stylesDialog.locator('.tree-node-controls > p-button:nth-child(2)').first();
        await editStyleButton.click();
        const editorDialog = page.locator('div').filter({ hasText: /^Style Editor$/ }).first();
        await expect(editorDialog).toBeVisible();
        await expect(editorDialog).toHaveScreenshot('style-controls.png', {
            maxDiffPixelRatio: 0.01
        });

        await addComparisonView(page);
        const mapContainerTwoViews = page.locator('mapview-container').first();
        await expect(mapContainerTwoViews).toBeVisible();
        const syncGroup = page.locator('.viewsync-select').first();
        await expect(syncGroup).toBeVisible();
        const positionToggle = syncGroup.locator('.material-symbols-outlined', {
            hasText: 'location_on'
        }).first();
        await expect(positionToggle).toBeVisible();
        const mapContainerSync = page.locator('mapview-container').first();
        await expect(mapContainerSync).toBeVisible();
        await expect(mapContainerSync).toHaveScreenshot('map-multiview-sync.png', {
            maxDiffPixelRatio: 0.01
        });

        const prefDialog = await openPreferencesDialog(page);
        await expect(prefDialog).toHaveScreenshot('preferences.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});

