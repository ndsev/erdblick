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
        const saveDialogShell = page.locator('.p-dialog.app-dialog-compact.search-style-save-dialog').first();
        await expect(saveDialogShell).toBeVisible();
        const saveDialogSpacing = await saveDialogShell.evaluate(element => {
            const header = element.querySelector(':scope > .p-dialog-header');
            const content = element.querySelector(':scope > .p-dialog-content');
            if (!(header instanceof HTMLElement) || !(content instanceof HTMLElement)) {
                throw new Error('Expected direct PrimeNG dialog header and content children');
            }
            const headerStyle = getComputedStyle(header);
            const contentStyle = getComputedStyle(content);
            return {
                headerPaddingTop: Number.parseFloat(headerStyle.paddingTop),
                headerFontSize: Number.parseFloat(headerStyle.fontSize),
                contentPaddingTop: Number.parseFloat(contentStyle.paddingTop),
                contentFontSize: Number.parseFloat(contentStyle.fontSize)
            };
        });
        expect(saveDialogSpacing.headerPaddingTop / saveDialogSpacing.headerFontSize).toBeCloseTo(0.75, 2);
        expect(saveDialogSpacing.contentPaddingTop / saveDialogSpacing.contentFontSize).toBeCloseTo(0.5, 2);
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
        const editorTabs = editor.locator('.style-editor-tabs .p-tab');
        await expect(editorTabs).toHaveCount(2);
        const tabSpacing = await editorTabs.evaluateAll(elements => elements.map(element => {
            const style = getComputedStyle(element);
            const fontSize = Number.parseFloat(style.fontSize);
            return {
                blockRatio: Number.parseFloat(style.paddingTop) / fontSize,
                inlineRatio: Number.parseFloat(style.paddingLeft) / fontSize,
                marginTop: Number.parseFloat(style.marginTop)
            };
        }));
        for (const spacing of tabSpacing) {
            expect(spacing.blockRatio).toBeCloseTo(0.25, 2);
            expect(spacing.inlineRatio).toBeCloseTo(1, 2);
            expect(spacing.marginTop).toBe(0);
        }
    });
});
