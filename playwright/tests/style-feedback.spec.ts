import {expect, test} from '../fixtures/test';
import {requireMapSource} from '../utils/backend-helpers';
import {TEST_LAYER_NAMES, TEST_MAP_NAMES} from '../utils/test-params';
import {
    closeLayerDialog,
    enableMapLayer,
    navigateToStateSnapshotRoot,
    openLayerDialog,
    openSearchPalette,
    openStylesDialog
} from '../utils/ui-helpers';

const SEARCH_QUERY = '**.layerId == "Road"';

test.use({stateSnapshot: 'style_editor_state'});

test.describe('Style feedback workflows', () => {
    test('search styles support Save and Save and Open with matching visibility', async ({page, request}) => {
        await requireMapSource(request, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
        await navigateToStateSnapshotRoot(page);
        await enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
        const searchPalette = await openSearchPalette(page, SEARCH_QUERY);
        const featureSearchAction = searchPalette.locator('.search-menu', {
            hasText: 'Search Features and Attributes'
        }).first();
        await featureSearchAction.locator('.search-option-wrapper').first().click();

        const searchDialog = page.getByTestId('feature-search-dialog').locator('.p-dialog').first();
        await expect(searchDialog).toBeVisible();
        await searchDialog.getByRole('tab', {name: /Visualization/}).click();
        const saveStyle = searchDialog.getByTestId('feature-search-save-style');
        await expect(saveStyle).toBeVisible();

        await saveStyle.click();
        const saveDialog = page.getByTestId('search-style-save-dialog');
        await expect(saveDialog).toBeVisible();
        const enabled = saveDialog.getByTestId('search-style-save-enabled').locator('input');
        await expect(enabled).toBeChecked();
        await saveDialog.getByTestId('search-style-save-name').fill('Playwright/Plain Save');
        await saveDialog.getByTestId('search-style-save-confirm').click();
        await expect(saveDialog).toBeHidden();
        await expect(page.getByTestId('style-editor-dialog').locator('.p-dialog').first()).toBeHidden();
        const enabledSource = await page.evaluate(() => {
            const stored = JSON.parse(localStorage.getItem('importedStyleData') ?? '{"sources":[]}');
            return stored.sources.find((source: string) =>
                source.includes('name: Playwright/Plain Save')) as string | undefined;
        });
        expect(enabledSource).toContain('\ndefault: true\n');
        expect(enabledSource).toContain('\noptions:\n  - label: Show Playwright/Plain Save\n');
        expect(enabledSource).toContain('id: showSearchStyle\n    type: bool\n    default: true');
        expect(enabledSource).toContain('filter: showSearchStyle == true');

        const stylesDialog = await openStylesDialog(page);
        await expect(stylesDialog.getByTestId('style-visibility-playwright-plain-save').locator('input'))
            .toBeChecked();
        await stylesDialog.getByTestId('styles-close-button').click();

        await openLayerDialog(page);
        const layerDialog = page.getByTestId('map-layer-dialog').locator('.p-dialog-content');
        const savedStyleOption = layerDialog
            .getByTestId(/style-option-0-.*Playwright-Plain-Save-showSearchStyle/)
            .first();
        await expect(savedStyleOption).toBeVisible();
        await expect(savedStyleOption.locator('input')).toBeChecked();
        await expect(savedStyleOption.locator('xpath=following-sibling::label'))
            .toHaveText('Show Playwright/Plain Save');
        await closeLayerDialog(page);

        await saveStyle.click();
        await expect(saveDialog).toBeVisible();
        await saveDialog.getByTestId('search-style-save-name').fill('Playwright/Save and Open');
        await enabled.click();
        await expect(enabled).not.toBeChecked();
        await saveDialog.getByTestId('search-style-save-and-open').click();

        const editor = page.getByTestId('style-editor-dialog').locator('.p-dialog').first();
        await expect(editor).toBeVisible();
        const disabledSource = await page.evaluate(() => {
            const stored = JSON.parse(localStorage.getItem('importedStyleData') ?? '{"sources":[]}');
            return stored.sources.find((source: string) =>
                source.includes('name: Playwright/Save and Open')) as string | undefined;
        });
        expect(disabledSource).toContain('\ndefault: false\n');
        await expect(editor.getByTestId('style-editor-header').locator('.app-surface-header'))
            .toBeVisible();
        await expect(editor.getByTestId('style-editor-quick-name'))
            .toHaveValue('Playwright/Save and Open');
        await expect(editor.getByTestId('style-editor-quick-layers')).toBeVisible();
        await expect(editor.getByTestId('style-editor-enabled').locator('input')).not.toBeChecked();
    });
});
