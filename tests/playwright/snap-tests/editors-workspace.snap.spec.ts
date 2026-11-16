import {expect, test} from '../fixtures/test';
import {installStyleSupportFixture} from '../fixtures/style-support';
import {captureDocsScreenshotWithLabels, navigateToStateSnapshotRoot, openStylesDialog} from '../utils/ui-helpers';

test.use({stateSnapshot: 'style_editor_state'});

test('independent floating and docked editor documents', async ({page}) => {
    await installStyleSupportFixture(page, true);
    await navigateToStateSnapshotRoot(page);
    let catalog = await openStylesDialog(page);
    await catalog.getByTestId('style-edit-button-style-support').click();
    await catalog.getByTestId('styles-close-button').click({force: true});
    const floating = page.getByTestId('style-editor-dialog').locator('.p-dialog');
    await expect(floating).toBeVisible();
    const header = await floating.locator('.p-dialog-header').boundingBox();
    if (!header) throw new Error('Missing editor header');
    await page.mouse.move(header.x + 220, header.y + 20);
    await page.mouse.down(); await page.mouse.move(250, 105, {steps: 12}); await page.mouse.up();
    await floating.getByTestId('style-editor-quick-name').fill('Road styling draft');

    catalog = await openStylesDialog(page);
    await catalog.getByTestId('style-edit-button-other-style').click();
    await catalog.getByTestId('styles-close-button').click({force: true});
    const other = page.locator('editor-surface').filter({has: page.locator('.app-surface-header-title-text', {hasText: 'Style Editor — Other Style'})});
    await other.locator('app-surface-header p-button').filter({hasText: 'move_to_inbox'}).click();
    await other.getByRole('tab', {name: 'Advanced', exact: true}).click();

    catalog = await openStylesDialog(page);
    await catalog.getByTestId('style-presets-tab').click();
    await catalog.getByTestId('style-preset-raw-edit-button').click();
    await catalog.getByTestId('styles-close-button').click();
    await expect(page.getByTestId('editors-dock-tab')).toContainText('2');
    await expect(other.getByTestId('dock-panel-content')).toBeVisible();
    // Keep the top of the workspace in view after focusing the second dock panel.
    await page.locator('.editor-dock-container').evaluate(element => {element.scrollTop = 0;});
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot('editors-workspace.png', {maxDiffPixelRatio: 0.01});
    await captureDocsScreenshotWithLabels(page, 'docs/screenshots/editors-workspace.png', [
        {locator: floating.getByTestId('style-editor-header'), label: 'Independent style draft', placement: 'top'},
        {locator: floating.getByTestId('style-editor-quick-name'), label: 'Quick form', placement: 'bottom'},
        {locator: page.getByTestId('editors-dock-tab'), label: 'Docked document count', placement: 'right'},
        {locator: other.getByTestId('style-editor-header'), label: 'Eject, expand or close', placement: 'bottom'},
        {locator: page.locator('editor-surface[data-editor-kind="presets"]').getByTestId('editor-header'), label: 'Separate preset document', placement: 'top'}
    ]);
});
