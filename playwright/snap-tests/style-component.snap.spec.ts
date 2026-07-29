import { expect, test } from '../fixtures/test';
import { requireMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAMES, TEST_MAP_NAMES } from '../utils/test-params';
import {
    captureDocsScreenshotWithLabels,
    enableMapLayer,
    navigateToStateSnapshotRoot,
    openStylesDialog
} from '../utils/ui-helpers';

const MAP_INDEX = 0;
const LAYER_INDEX = 0;
const CONFIGURED_STYLE_TEST_ID = 'nds-live-display';
test.use({ stateSnapshot: 'style_editor_state' });

test.describe('Snapshot – style component', () => {
    test('style dialog and editor', async ({ page, request }) => {
        await requireMapSource(request, TEST_MAP_NAMES[MAP_INDEX], TEST_LAYER_NAMES[LAYER_INDEX]);
        await navigateToStateSnapshotRoot(page);
        await enableMapLayer(page, TEST_MAP_NAMES[MAP_INDEX], TEST_LAYER_NAMES[LAYER_INDEX]);

        const stylesDialog = await openStylesDialog(page);
        // Wait for the configured style bundle to replace the transient empty
        // startup tree, then edit a deterministic style. Choosing the first
        // live locator made this test race style initialization.
        const editButton = stylesDialog.getByTestId(
            `style-edit-button-${CONFIGURED_STYLE_TEST_ID}`
        );
        await expect(editButton).toBeVisible();
        const editButtonTestId = await editButton.getAttribute('data-testid');
        if (!editButtonTestId?.startsWith('style-edit-button-')) {
            throw new Error(`Expected a style edit button data-testid, got ${editButtonTestId}`);
        }
        const styleTestIdSuffix = editButtonTestId.slice('style-edit-button-'.length);

        await page.mouse.move(0, 0);
        await expect(page).toHaveScreenshot('style-component-dialog.png', {
            maxDiffPixelRatio: 0.01
        });

        await editButton.click();
        const editorDialog = page.getByTestId('style-editor-dialog').locator('.p-dialog').first();
        await expect(editorDialog).toBeVisible();

        await page.mouse.move(0, 0);
        await expect(page).toHaveScreenshot('style-component-editor.png', {
            maxDiffPixelRatio: 0.01
        });

        await page.mouse.move(0, 0);
        await captureDocsScreenshotWithLabels(page, 'docs/screenshots/style-component-editor-controls.png', [
            {
                locator: stylesDialog.getByTestId(`style-visibility-${styleTestIdSuffix}`),
                label: 'Toggle style visibility'
            },
            {
                locator: stylesDialog.getByTestId(`style-reset-button-${styleTestIdSuffix}`),
                label: 'Reset style'
            },
            {
                locator: editButton,
                label: 'Open style editor'
            },
            {
                locator: stylesDialog.getByTestId('style-import-button'),
                label: 'Import style'
            },
            {
                locator: stylesDialog.getByTestId('styles-close-button'),
                label: 'Close dialog'
            },
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
