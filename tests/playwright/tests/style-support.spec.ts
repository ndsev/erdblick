import {expect, test} from '../fixtures/test';
import {installStyleSupportFixture} from '../fixtures/style-support';
import {requireMapSource} from '../utils/backend-helpers';
import {TEST_LAYER_NAMES, TEST_MAP_NAMES} from '../utils/test-params';
import {enableMapLayer, navigateToStateSnapshotRoot, openLayerDialog, openOmnibar, openStylesDialog} from '../utils/ui-helpers';

test.use({stateSnapshot: 'style_editor_state'});

test('Quick edits nested native fields, options and effects without losing source content', async ({page, request}) => {
    await requireMapSource(request, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await installStyleSupportFixture(page);
    await navigateToStateSnapshotRoot(page);
    const styles = await openStylesDialog(page);
    await styles.getByTestId('style-edit-button-style-support').click();
    const editor = page.getByTestId('style-editor-dialog').locator('.p-dialog').first();
    const form = editor.getByTestId('style-document-editor');
    const apply = editor.getByTestId('style-editor-apply-button').locator('button');
    const width = form.locator('[data-style-path="rules.0.width"] input');
    await expect(width).toHaveValue('0.25');
    await width.fill('1e');
    await expect(apply).toBeDisabled();
    await form.locator('summary').filter({hasText: /^Branches$/}).first().click();
    const branchWidth = form.locator('[data-style-path="rules.0.all-of.0.width"] input');
    await expect(branchWidth).toHaveValue('48');
    await branchWidth.fill('96');
    await branchWidth.press('Tab');
    await expect(width).toHaveValue('1e');
    await expect(apply).toBeDisabled();
    await width.fill('128');
    await width.press('Tab');
    await form.locator('[data-style-path="rules.0.first-of"]').getByRole('button', {name: 'Set first-of', exact: true}).click();
    await expect(form.locator('[data-style-path="rules.0.first-of.0.width"] input')).toHaveValue('96');

    await form.locator('summary').filter({hasText: /^Options and presets$/}).click();
    const optionList = form.locator('[data-style-path="options"]');
    await optionList.getByRole('button', {name: /option 2: Tint/}).click();
    const tintDefault = form.locator('[data-style-path="options.1.default"] input:not([type=color])');
    await tintDefault.fill('orange');
    await form.locator('summary').filter({hasText: /^Interaction$/}).click();
    const radius = form.locator('[data-style-path="interaction-effects.hover.halo.radius"] input');
    await radius.fill('6');
    await radius.press('Tab');
    await expect(form.locator('.style-form-error')).toHaveCount(0);
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(apply).toBeDisabled();
    const updatedNotice = page.getByRole('dialog', {name: 'Updated Modified Styles'});
    if (await updatedNotice.isVisible()) await updatedNotice.getByRole('button', {name: 'Ok', exact: true}).click();

    await editor.getByRole('tab', {name: 'Advanced', exact: true}).click();
    const source = editor.locator('editor .cm-content');
    await expect(source).toContainText('first-of:');
    await expect(source).toContainText('width: 96');
    await expect(source).toContainText('# Keep this branch comment');
    await expect(source).toContainText('# Keep this author comment');
    await expect(source).toContainText('default: orange');
    await expect(source).toContainText('radius: 6');
    await editor.getByRole('tab', {name: 'Quick', exact: true}).click();
    const corner = await editor.locator('[data-resize-corner="se"]').boundingBox();
    if (!corner) throw new Error('Expected a resizable style editor');
    await page.mouse.move(corner.x + 2, corner.y + 2);
    await page.mouse.down();
    await page.mouse.move(corner.x - 250, corner.y - 60);
    await page.mouse.up();
    const header = await editor.locator('.p-dialog-header').boundingBox();
    if (!header) throw new Error('Expected a draggable style editor header');
    await page.mouse.move(header.x + 200, header.y + 20);
    await page.mouse.down();
    await page.mouse.move(220, 70);
    await page.mouse.up();
    await page.setViewportSize({width: 900, height: 800});
    await expect(form).toBeVisible();
    await editor.getByTestId('style-editor-quick-name').scrollIntoViewIfNeeded();
    const overflow = await form.evaluate(element => element.scrollWidth > element.clientWidth + 2);
    expect(overflow).toBe(false);
    expect(pageErrors).toEqual([]);
    await page.mouse.move(0, 0);
    await page.screenshot({path: test.info().outputPath('quick-style-editor.png')});
    await page.setViewportSize({width: 1600, height: 900});
    await editor.getByTestId('style-editor-close-button').click();
    await styles.getByTestId('styles-close-button').click();
    await openLayerDialog(page);
    const layers = page.getByTestId('map-layer-dialog');
    const tint = layers.getByTestId(/style-option-0-.*Style-Support-tint/).first();
    const caption = layers.getByTestId(/style-option-0-.*Style-Support-caption/).first();
    // Existing runtime values survive changing the definition's default.
    await expect(tint).toHaveValue('blue');
    await tint.fill('#abcdef');
    await tint.press('Tab');
    await caption.fill('Edited caption');
    await caption.press('Tab');
    await expect(tint).toHaveValue('#abcdef');
    await expect(caption).toHaveValue('Edited caption');
});

test('attribute search Save and Open produces an active independently editable attribute style', async ({page, request}) => {
    await requireMapSource(request, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
    await navigateToStateSnapshotRoot(page);
    await enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
    const palette = await openOmnibar(page, '**.speedLimitKmh');
    await palette.getByTestId('omnibar-action')
        .and(page.locator('[data-action-id="features"]')).click();
    const search = page.getByTestId('feature-search-dialog').locator('.p-dialog').first();
    await search.getByTestId('feature-search-scope').click();
    await page.getByRole('option', {name: 'Attribute', exact: true}).click();
    await search.getByRole('tab', {name: /Visualization/}).click();
    await expect(search.getByTestId(/^feature-search-style-panel-/).first()).toBeAttached();
    await search.getByTestId('feature-search-save-style').click();
    const save = page.getByTestId('search-style-save-dialog');
    await save.getByTestId('search-style-save-name').fill('Attribute saved');
    await save.getByTestId('search-style-save-and-open').click();
    const editor = page.getByTestId('style-editor-dialog').locator('.p-dialog').first();
    await expect(editor).toBeVisible();
    await expect(editor.getByTestId('style-editor-enabled').locator('input')).toBeChecked();
    await expect(editor.locator('[data-style-path="rules.0.scope"] option:checked')).toHaveText('attribute');
    await expect(editor.locator('[data-style-path="rules.0.attribute-filter"]')).toContainText('speedLimitKmh');
    const saved = await page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('importedStyleData') ?? '{"sources":[]}');
        return data.sources.find((source: string) => source.includes('name: Attribute saved')) as string;
    });
    expect(saved).toContain('scope: attribute');
    expect(saved).toContain('attribute-filter:');
    expect(saved).toContain('speedLimitKmh');
    expect(saved).toContain('default: true');
    expect(saved).not.toContain('attribute-validity-geom: required');

    // Retire the original overlay before assessing independent saved-style drawing.
    await editor.getByTestId('style-editor-close-button').click();
    await search.getByTestId('feature-search-show-highfi-geometry').locator('input').uncheck();
    const styles = await openStylesDialog(page);
    for (const visibility of await styles.locator('[data-testid^="style-visibility-"]').all()) {
        if (await visibility.getAttribute('data-testid') !== 'style-visibility-attribute-saved') {
            await visibility.locator('input').uncheck();
        }
    }
    const savedVisibility = styles.getByTestId('style-visibility-attribute-saved').locator('input');
    await expect(savedVisibility).toBeChecked();
    await expect.poll(async () => page.evaluate(() => window.ebDebug?.subsetRenderPresentation().activeContributions ?? 0)).toBeGreaterThan(0);
    await savedVisibility.uncheck();
    await expect.poll(async () => page.evaluate(() => window.ebDebug?.subsetRenderPresentation().activeContributions ?? 0)).toBe(0);
    await savedVisibility.check();
    await expect.poll(async () => page.evaluate(() => window.ebDebug?.subsetRenderPresentation().activeContributions ?? 0)).toBeGreaterThan(0);
});
