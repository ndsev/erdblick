import {expect, test} from '../fixtures/test';
import {captureDocsScreenshotWithLabels, navigateToStateSnapshotRoot, openDatasourcesDialog} from '../utils/ui-helpers';

test.use({stateSnapshot: 'style_editor_state'});

test('read-only datasource document shares the editor workspace', async ({page}) => {
    await page.route('**/config', async route => {
        const response = await route.fetch();
        await route.fulfill({response, json: {...await response.json(), readOnly: true}});
    });
    await navigateToStateSnapshotRoot(page);
    const dialog = await openDatasourcesDialog(page);
    const readOnly = dialog.getByText('Datasource configuration is read-only.', {exact: true});
    await expect(readOnly).toBeVisible();
    await expect(dialog.locator('editor .cm-content')).toHaveAttribute('contenteditable', 'false');
    // This legacy snapshot saved a 163px-high dialog. Restoring it must leave
    // a usable text area, while small viewports still bound the entire window.
    await expect.poll(async () => (await dialog.locator('editor .cm-editor').boundingBox())?.height ?? 0).toBeGreaterThan(150);
    await page.setViewportSize({width: 360, height: 320});
    await expect.poll(() => dialog.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    })).toBe(true);
    await page.setViewportSize({width: 1600, height: 900});
    await expect.poll(async () => (await dialog.locator('editor .cm-editor').boundingBox())?.height ?? 0).toBeGreaterThan(150);
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot('datasource-editor.png', {maxDiffPixelRatio: 0.01});
    await captureDocsScreenshotWithLabels(page, 'docs/screenshots/datasource-configuration.png', [
        {locator: dialog.getByTestId('editor-header'), label: 'Dockable configuration document', placement: 'top'},
        {locator: readOnly, label: 'Server write capability', placement: 'left'},
        {locator: dialog.getByRole('button', {name: 'Reload configuration', exact: true}), label: 'Explicit reload', placement: 'bottom'}
    ]);
});
