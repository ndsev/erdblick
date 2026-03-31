import { expect, test } from '../fixtures/test';
import { requireMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAMES, TEST_MAP_NAMES } from '../utils/test-params';
import {
    captureDocsScreenshotWithLabels,
    enableMapLayer,
    navigateToRoot,
    openStylesDialog
} from '../utils/ui-helpers';

const STYLE_ID = 'DefaultStyle';
const MAP_INDEX = 0;
const LAYER_INDEX = 0;
const LOCATION_INDEX = 0;

function styleIdToTestIdSuffix(styleId: string): string {
    return styleId
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'unknown';
}

test.describe('Snapshot – style component', () => {
    test('style dialog and editor', async ({ page, request }) => {
        const styleTestIdSuffix = styleIdToTestIdSuffix(STYLE_ID);

        await requireMapSource(request, TEST_MAP_NAMES[MAP_INDEX], TEST_LAYER_NAMES[LAYER_INDEX]);
        await navigateToRoot(page, LOCATION_INDEX);
        await enableMapLayer(page, TEST_MAP_NAMES[MAP_INDEX], TEST_LAYER_NAMES[LAYER_INDEX]);

        const stylesDialog = await openStylesDialog(page);
        const editButton = stylesDialog.getByTestId(`style-edit-button-${styleTestIdSuffix}`);
        await expect(editButton).toBeVisible();

        await expect(page).toHaveScreenshot('style-component-dialog.png', {
            maxDiffPixelRatio: 0.01
        });

        await editButton.click();
        const editorDialog = page.getByTestId('style-editor-dialog').locator('.p-dialog').first();
        await expect(editorDialog).toBeVisible();

        await expect(page).toHaveScreenshot('style-component-editor.png', {
            maxDiffPixelRatio: 0.01
        });

        await captureDocsScreenshotWithLabels(page, 'docs/screenshots/style-component-editor-controls.png', [
            {
                locator: editorDialog.getByTestId('style-editor-apply-button'),
                label: 'Apply changes'
            },
            {
                locator: editorDialog.getByTestId('style-editor-close-button'),
                label: 'Close editor'
            },
            {
                locator: editorDialog.getByTestId('style-editor-export-button'),
                label: 'Export style'
            },
            {
                locator: editorDialog.getByTestId('style-editor-help-button'),
                label: 'Open style help'
            }
        ]);
    });
});
