import { expect, test } from '../fixtures/test';
import { installStyleSupportFixture } from '../fixtures/style-support';
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
const CONFIGURED_STYLE_TEST_ID = 'style-support';
test.use({ stateSnapshot: 'style_editor_state' });

test.describe('Snapshot – style component', () => {
    test('style dialog and editor', async ({ page, request }) => {
        await requireMapSource(request, TEST_MAP_NAMES[MAP_INDEX], TEST_LAYER_NAMES[LAYER_INDEX]);
        await installStyleSupportFixture(page);
        await navigateToStateSnapshotRoot(page);
        await enableMapLayer(page, TEST_MAP_NAMES[MAP_INDEX], TEST_LAYER_NAMES[LAYER_INDEX]);
        await expect.poll(() => page.evaluate(() =>
            window.ebDebug?.subsetRenderPresentation().activeContributions ?? 0)).toBeGreaterThan(0);

        const stylesDialog = await openStylesDialog(page);
        // Wait for the configured style bundle to replace the transient empty
        // startup tree, then edit a deterministic style. Choosing the first
        // live locator made this test race style initialization.
        const editButton = stylesDialog.getByTestId(
            `style-edit-button-${CONFIGURED_STYLE_TEST_ID}`
        );
        await expect(editButton).toBeVisible();

        await page.mouse.move(0, 0);
        await expect(page).toHaveScreenshot('style-component-dialog.png', {
            maxDiffPixelRatio: 0.01
        });

        await editButton.click();
        const editorDialog = page.getByTestId('style-editor-dialog').locator('.p-dialog').first();
        await expect(editorDialog).toBeVisible();
        await expect(editorDialog.getByTestId('style-editor-header').locator('.app-surface-header'))
            .toBeVisible();
        await expect(editorDialog.getByTestId('style-editor-enabled')).toBeVisible();
        await expect(editorDialog.getByTestId('style-editor-quick-name')).toBeVisible();
        await expect(editorDialog.getByTestId('style-editor-quick-layers')).toBeVisible();
        await expect(editorDialog.locator('.style-form-error')).toHaveCount(0);

        await page.mouse.move(0, 0);
        await expect(page).toHaveScreenshot('style-component-editor.png', {
            maxDiffPixelRatio: 0.01
        });

        await editorDialog.locator('[data-style-bubble="rules.0.width"]').click();
        await expect(editorDialog.getByTestId('style-property-panel')).toBeVisible();
        await editorDialog.locator('[data-style-path="rules.0.width"] input').focus();
        await page.mouse.move(0, 0);
        await expect(page).toHaveScreenshot('style-component-property-panel.png', {
            maxDiffPixelRatio: 0.01
        });

        await page.mouse.move(0, 0);
        // Keep header and footer callouts clear of the neighboring controls.
        // The form's inherited app font can leave less spare vertical space.
        await captureDocsScreenshotWithLabels(page, 'docs/screenshots/style-component-editor-controls.png', [
            {
                locator: editorDialog.getByTestId('style-editor-enabled'),
                label: 'Enable or disable style',
                placement: 'left'
            },
            {
                locator: editorDialog.getByTestId('style-editor-metadata'),
                label: 'Style metadata',
                placement: 'left'
            },
            {
                locator: editorDialog.locator('[data-style-bubble="rules.0.scope"]'),
                through: editorDialog.locator('[data-style-bubble="rules.0.width"]'),
                label: 'Click a property to edit',
                placement: 'left'
            },
            {
                locator: editorDialog.getByTestId('style-add-property-rules.0'),
                label: 'Add a property',
                placement: 'top'
            },
            {
                locator: editorDialog.getByTestId('style-property-dismiss'),
                through: editorDialog.getByTestId('style-property-delete'),
                label: 'Dismiss / Save / Delete',
                placement: 'left'
            },
            {
                locator: editorDialog.locator('[data-style-bubble="rules.0.all-of.0.filter"]'),
                through: editorDialog.locator('[data-style-bubble="rules.0.all-of.0.label-text-expression"]'),
                label: 'Branch properties',
                placement: 'left'
            },
            {
                locator: editorDialog.getByTestId('style-editor-apply-button'),
                label: 'Apply document changes',
                placement: 'left'
            }
        ]);
    });
});
