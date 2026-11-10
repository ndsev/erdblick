import {expect, test} from '../fixtures/test';
import {installStyleSupportFixture} from '../fixtures/style-support';
import {requireMapSource} from '../utils/backend-helpers';
import {TEST_LAYER_NAMES, TEST_MAP_NAMES} from '../utils/test-params';
import {enableMapLayer, navigateToStateSnapshotRoot, openLayerDialog, openOmnibar, openStylesDialog} from '../utils/ui-helpers';

test.use({stateSnapshot: 'style_editor_state'});

test('edits the stylesheet name through the shared header and keeps it out of metadata', async ({page}) => {
    await installStyleSupportFixture(page);
    await navigateToStateSnapshotRoot(page);
    const styles = await openStylesDialog(page);
    await expect(styles.getByTestId('surface-title-edit')).toHaveCount(0);
    await styles.getByTestId('style-edit-button-style-support').click();
    const editor = page.getByTestId('style-editor-dialog').locator('.p-dialog').first();
    const title = editor.getByTestId('style-editor-header').locator('.app-surface-header-title-text');
    const pencil = editor.getByTestId('surface-title-edit');
    const input = editor.getByTestId('surface-title-input');
    const apply = editor.getByTestId('style-editor-apply-button').locator('button');
    const bounds = await editor.boundingBox();
    await pencil.hover();
    await expect(title).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await pencil.click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Style Support');
    await input.fill('Canceled name');
    await input.press('Escape');
    await expect(title).toHaveText('Style Support');
    await expect(editor).toBeVisible();
    await expect(apply).toBeDisabled();
    await expect(pencil).toBeFocused();
    expect(await editor.boundingBox()).toEqual(bounds);

    await pencil.press('Enter');
    await input.fill('');
    await input.press('Enter');
    await expect(editor.getByTestId('style-editor-name-error')).toContainText('required');
    await expect(apply).toBeDisabled();
    await pencil.click();
    await input.fill('Renamed Style Support');
    await editor.getByRole('tab', {name: 'Metadata', exact: true}).click();
    await expect(title).toHaveText('Renamed Style Support');
    await expect(editor.getByTestId('style-editor-metadata')).toBeVisible();
    await expect(editor.getByTestId('style-editor-quick-name')).toHaveCount(0);
    await editor.getByRole('tab', {name: 'Rules', exact: true}).click();
    await editor.locator('[data-style-bubble="rules.0.width"]').click();
    await expect(pencil).toBeDisabled();
    await editor.getByTestId('style-property-dismiss').click();
    await expect(pencil).toBeEnabled();
    await editor.getByRole('tab', {name: 'Advanced', exact: true}).click();
    await expect(editor.locator('editor .cm-content')).toContainText(/name: "?Renamed Style Support"?/);
    await expect(editor.locator('editor .cm-content')).toContainText('# Keep this author comment');
    await expect(apply).toBeEnabled();
    await apply.click();
    const notice = page.getByRole('dialog', {name: 'Updated Modified Styles'});
    if (await notice.isVisible()) await notice.getByRole('button', {name: 'Ok', exact: true}).click();
    await expect(apply).toBeDisabled();
    await editor.getByTestId('style-editor-close-button').click();
    await expect(styles.getByTestId('style-edit-button-renamed-style-support')).toBeVisible();
    await styles.getByTestId('style-edit-button-renamed-style-support').click();
    await expect(title).toHaveText('Renamed Style Support');
});

test('Rules, options and metadata edit native fields, options and effects without losing source content', async ({page, request}) => {
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
    const bubble = (path: string) => form.locator(`[data-style-bubble="${path}"]`);
    const saveProperty = form.getByTestId('style-property-save');
    const dismissProperty = form.getByTestId('style-property-dismiss');
    const metadata = editor.getByTestId('style-editor-metadata');
    await expect(editor.locator('editor .cm-editor')).toHaveCount(0);
    await expect(editor.getByRole('tab')).toHaveText(['Rules', 'Options and Presets', 'Metadata', 'Advanced']);
    await expect(editor.getByTestId('style-editor-quick-name')).toHaveCount(0);
    await editor.getByRole('tab', {name: 'Metadata', exact: true}).click();
    await expect(metadata.getByTestId('style-editor-quick-layers')).toBeVisible();
    await expect(metadata.locator('[data-style-path="version"] input')).toHaveValue('2');
    await expect(metadata.locator('[data-style-path="default"] select')).toBeVisible();
    await expect(metadata.getByRole('button', {name: 'Add Category', exact: true})).toBeVisible();
    await expect(metadata.getByRole('button', {name: 'Add Lod thresholds', exact: true})).toBeVisible();
    await expect(form.locator('summary').filter({hasText: /^Document$/})).toHaveCount(0);
    await expect(form.locator('.style-field-label').filter({hasText: /^Rules$/})).toHaveCount(0);
    await editor.getByRole('tab', {name: 'Rules', exact: true}).click();
    await expect(bubble('rules.0.width').locator('.style-rule-bubble-label')).toHaveText('Width');
    await expect(bubble('rules.0.width').locator('.style-rule-bubble-value')).toHaveText('0.25');
    await expect(form.getByTestId('style-property-panel')).toHaveCount(0);
    await expect(apply).toBeDisabled();
    const branches = form.locator('[data-rule-path="rules.0"] > details');
    await expect(branches).toHaveJSProperty('open', false);
    await expect(bubble('rules.0.all-of.0.width')).toHaveCount(0);
    await branches.locator(':scope > summary').click();
    await bubble('rules.0.color').click();
    const colorField = form.locator('[data-style-path="rules.0.color"]');
    const colorPicker = colorField.getByRole('textbox', {name: 'Color picker for color', exact: true});
    const colorText = colorField.getByRole('textbox', {name: 'color', exact: true});
    await expect(colorPicker).toHaveCSS('background-color', 'rgb(255, 0, 0)');
    await colorPicker.press('Space');
    await expect(page.locator('.p-colorpicker-panel')).toBeVisible();
    await colorPicker.press('Escape');
    await expect(page.locator('.p-colorpicker-panel')).toBeHidden();
    await expect(form.getByTestId('style-property-panel')).toBeVisible();
    await colorText.fill('0x1A2B3C');
    await expect(colorPicker).toHaveCSS('background-color', 'rgb(26, 43, 60)');
    await expect(bubble('rules.0.color').locator('.style-rule-bubble-value')).toHaveText('red');
    await dismissProperty.click();
    await expect(bubble('rules.0.color')).toBeFocused();
    await expect(apply).toBeDisabled();
    await bubble('rules.0.filter').click();
    await form.getByRole('button', {name: 'About filter', exact: true}).focus();
    await expect(page.getByRole('tooltip')).toContainText('Feature predicate');
    await dismissProperty.click();

    await bubble('rules.0.width').click();
    await expect(metadata.locator('[data-style-path="version"] input')).toBeDisabled();
    const width = form.locator('[data-style-path="rules.0.width"] input');
    await width.fill('1e');
    await expect(saveProperty).toBeDisabled();
    await expect(apply).toBeDisabled();
    await bubble('rules.0.all-of.0.width').click();
    await expect(width).toHaveValue('1e');
    await expect(form.getByRole('status')).toContainText('Save or dismiss');
    await expect(editor.getByRole('tab', {name: 'Advanced', exact: true})).toHaveAttribute('aria-disabled', 'true');
    await width.press('Escape');
    await expect(form.getByTestId('style-property-panel')).toHaveCount(0);
    await expect(bubble('rules.0.width')).toBeFocused();
    await expect(apply).toBeDisabled();

    await form.getByTestId('style-add-property-rules.0').click();
    const menu = page.getByRole('menu', {name: 'Add style property', exact: true});
    await expect(menu).toBeVisible();
    await menu.press('Escape');
    await expect(menu).toBeHidden();
    await expect(editor).toBeVisible();
    await expect(form.getByTestId('style-add-property-rules.0')).toBeFocused();
    await form.getByTestId('style-add-property-rules.0').click();
    await menu.getByRole('menuitem', {name: 'Appearance', exact: true}).click();
    await menu.getByRole('menuitem', {name: 'Opacity', exact: true}).click();
    await expect(form.getByTestId('style-property-delete')).toHaveCount(0);
    await expect(form.locator('[data-style-path="rules.0.opacity"] input')).toHaveValue('1');
    await saveProperty.click();
    await expect(bubble('rules.0.opacity')).toBeVisible();
    await bubble('rules.0.opacity').click();
    await form.getByTestId('style-property-delete').click();
    await expect(bubble('rules.0.opacity')).toHaveCount(0);
    await expect(bubble('rules.0.color').locator('.style-rule-bubble-value')).toHaveText('red');

    await bubble('rules.0.width').click();
    await width.fill('128');
    await width.press('ControlOrMeta+s');
    await expect(form.getByTestId('style-property-panel')).toHaveCount(0);
    await expect(apply).toBeEnabled();
    await bubble('rules.0.all-of.0.width').click();
    const branchWidth = form.locator('[data-style-path="rules.0.all-of.0.width"] input');
    await branchWidth.fill('96');
    await saveProperty.click();
    await form.getByRole('button', {name: 'Switch to first matching', exact: true}).click();
    await expect(bubble('rules.0.first-of.0.width').locator('.style-rule-bubble-value')).toHaveText('96');

    await editor.getByRole('tab', {name: 'Options and Presets', exact: true}).click();
    const optionList = form.locator('[data-style-path="options"]');
    await optionList.getByRole('button', {name: /Option 2: Tint/}).click();
    const tintField = form.locator('[data-style-path="options.1.default"]');
    const tintDefault = tintField.getByRole('textbox', {name: 'default', exact: true});
    await tintDefault.fill('orange');
    const tintPicker = tintField.getByRole('textbox', {name: 'Color picker for default', exact: true});
    await expect(tintPicker).toHaveCSS('background-color', 'rgb(255, 165, 0)');
    await tintPicker.click();
    await page.locator('.p-colorpicker-color-selector').click({position: {x: 75, y: 75}});
    await expect(tintDefault).toHaveValue(/^#[\da-f]{6}$/i);
    await tintPicker.press('Escape');
    await expect(page.locator('.p-colorpicker-panel')).toBeHidden();
    await tintDefault.fill('orange');
    await editor.getByRole('tab', {name: 'Rules', exact: true}).click();
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
    await expect(source).toContainText(/color: "?red"?/);
    await expect(source).toContainText(/default: "?orange"?/);
    await expect(source).toContainText('radius: 6');
    await editor.getByRole('tab', {name: 'Rules', exact: true}).click();
    await expect(editor.locator('editor .cm-editor')).toHaveCount(1);
    const savedBounds = await editor.boundingBox();
    if (!savedBounds) throw new Error('Expected a visible style editor');
    // Shrinking the viewport must clamp the open window, without replacing its saved desktop layout.
    await page.setViewportSize({width: 480, height: 600});
    await expect.poll(() => editor.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    })).toBe(true);
    await expect(editor.getByTestId('style-editor-close-button')).toBeInViewport();
    await page.setViewportSize({width: 1600, height: 900});
    await expect.poll(() => editor.boundingBox()).toEqual(savedBounds);
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
    await bubble('rules.0.width').scrollIntoViewIfNeeded();
    const overflow = await form.evaluate(element => element.scrollWidth > element.clientWidth + 2);
    expect(overflow).toBe(false);
    expect(pageErrors).toEqual([]);
    await page.mouse.move(0, 0);
    await page.screenshot({path: test.info().outputPath('quick-style-editor.png')});
    await page.setViewportSize({width: 1600, height: 900});
    // A draft alone is unsaved work, even after the document buffer has been applied.
    await bubble('rules.0.first-of.0.width').click();
    await form.locator('[data-style-path="rules.0.first-of.0.width"] input').fill('1e');
    await editor.getByTestId('style-editor-close-button').click();
    const warning = page.getByRole('dialog', {name: 'Warning!', exact: true});
    await expect(warning.getByRole('button', {name: 'Save', exact: true})).toBeDisabled();
    await warning.getByRole('button', {name: 'Discard', exact: true}).click();
    await expect(editor).toBeHidden();
    await styles.getByTestId('style-edit-button-style-support').click();
    await expect(branches).toHaveJSProperty('open', false);
    await branches.locator(':scope > summary').click();
    await expect(bubble('rules.0.first-of.0.width').locator('.style-rule-bubble-value')).toHaveText('96');
    await expect(form.getByTestId('style-property-panel')).toHaveCount(0);
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

test('defers collapsed branches and Advanced while retaining edits and expansion state', async ({page}) => {
    await installStyleSupportFixture(page);
    await page.route('**/static-config/styles/style-support.yaml', route => route.fulfill({
        contentType: 'text/yaml',
        body: 'name: Style Support\nversion: 2\nrules: [{geometry: line, width: 2, all-of: [{all-of: [{all-of: [{width: 5}]}]}]}]\n'
    }));
    await navigateToStateSnapshotRoot(page);
    const styles = await openStylesDialog(page);
    await styles.getByTestId('style-edit-button-style-support').click();
    const editor = page.getByTestId('style-editor-dialog').locator('.p-dialog').first();
    const form = editor.getByTestId('style-document-editor');
    const branches = form.locator('[data-rule-path="rules.0"] > details');
    const section = form.locator('[data-rule-path="rules.0.all-of.0"] > details');
    const nested = form.locator('[data-rule-path="rules.0.all-of.0.all-of.0"] > details');
    const bubble = form.locator('[data-style-bubble="rules.0.all-of.0.all-of.0.all-of.0.width"]');
    await expect(editor.locator('editor')).toHaveCount(0);
    await expect(branches).toHaveJSProperty('open', false);
    await expect(section).toHaveCount(0);
    await branches.locator(':scope > summary').click();
    await expect(section).toHaveJSProperty('open', false);
    await expect(nested).toHaveCount(0);
    await section.locator(':scope > summary').click();
    await expect(nested).toBeVisible();
    await expect(bubble).toHaveCount(0);
    await nested.locator(':scope > summary').click();
    await expect(bubble.locator('.style-rule-bubble-value')).toHaveText('5');
    await section.locator(':scope > summary').click();
    await expect(bubble).toBeAttached();
    // WebKit's visibility check misses closed ancestors of nested open details.
    await expect(section).toHaveJSProperty('open', false);
    await expect(nested).toHaveJSProperty('open', true);
    await section.locator(':scope > summary').click();
    await expect(bubble).toBeVisible();
    await bubble.click();
    await form.locator('[data-style-path="rules.0.all-of.0.all-of.0.all-of.0.width"] input').fill('6');
    await branches.locator(':scope > summary').click();
    await expect(branches).toHaveJSProperty('open', true);
    await expect(form.getByTestId('style-property-save')).toBeVisible();
    await form.getByTestId('style-property-save').click();
    await editor.getByRole('tab', {name: 'Advanced', exact: true}).click();
    const source = editor.locator('editor .cm-content');
    await expect(source).toContainText('width: 6');
    await source.click();
    await source.press('ControlOrMeta+End');
    await page.keyboard.insertText('\n# retained undo history');
    await editor.getByRole('tab', {name: 'Rules', exact: true}).click();
    await expect(bubble.locator('.style-rule-bubble-value')).toHaveText('6');
    await editor.getByRole('tab', {name: 'Advanced', exact: true}).click();
    await source.click();
    await source.press('ControlOrMeta+z');
    await expect(source).not.toContainText('retained undo history');

    // Invalid YAML and its correction still flow through the shared form projection.
    await source.press('ControlOrMeta+a');
    await page.keyboard.insertText('name: Style Support\nrules: [');
    await editor.getByRole('tab', {name: 'Rules', exact: true}).click();
    await expect(editor.locator('.style-editor-quick-stale')).toBeVisible();
    await editor.getByRole('tab', {name: 'Advanced', exact: true}).click();
    await source.click();
    await source.press('ControlOrMeta+a');
    await page.keyboard.insertText('name: Style Support\nversion: 2\nrules: [{width: 7}]\n');
    await editor.getByRole('tab', {name: 'Rules', exact: true}).click();
    await expect(editor.locator('.style-editor-quick-stale')).toHaveCount(0);
    await expect(form.locator('[data-style-bubble="rules.0.width"] .style-rule-bubble-value')).toHaveText('7');
    await editor.getByTestId('style-editor-close-button').click();
    await page.getByRole('dialog', {name: 'Warning!', exact: true}).getByRole('button', {name: 'Discard', exact: true}).click();
    await expect(editor).toBeHidden();
    await styles.getByTestId('style-edit-button-style-support').click();
    await expect(editor.locator('editor')).toHaveCount(0);
    await expect(form.locator('[data-style-bubble="rules.0.width"] .style-rule-bubble-value')).toHaveText('2');
    await expect(branches).toHaveJSProperty('open', false);
    await expect(section).toHaveCount(0);
    await expect(nested).toHaveCount(0);
});

test('a validation issue opens the deferred Advanced editor at its source location', async ({page}) => {
    await installStyleSupportFixture(page);
    await page.route('**/static-config/styles/style-support.yaml', route => route.fulfill({
        contentType: 'text/yaml',
        body: "name: Style Support\nversion: 2\nrules:\n  - geometry: line\n  - scope: attribute\n    attribute-type: '*SPEED*'\n    geometry: line\n"
    }));
    await navigateToStateSnapshotRoot(page);
    const styles = await openStylesDialog(page);
    await styles.getByTestId('style-validation-error-button-style-support').click();
    await styles.getByTestId('style-errors-table').locator('.style-error-row').filter({hasText: 'attribute-type'}).first().click();
    const editor = page.getByTestId('style-editor-dialog').locator('.p-dialog').first();
    await expect(editor.getByRole('tab', {name: 'Advanced', exact: true})).toHaveAttribute('aria-selected', 'true');
    await expect(editor.locator('editor .editor-line-highlight')).toContainText('attribute-type:');
    await expect(editor.locator('editor .cm-content')).toBeFocused({timeout: 5000});
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
    await expect(editor.locator('[data-style-bubble="rules.0.scope"] .style-rule-bubble-value')).toHaveText('attribute');
    await expect(editor.locator('[data-style-bubble="rules.0.attribute-filter"]')).toContainText('speedLimitKmh');
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

test.describe('Light theme', () => {
    test.use({darkMode: 'off'});

    test('keeps bubble panels and the add menu usable in a narrow light-theme window', async ({page, request}) => {
        await requireMapSource(request, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
        await installStyleSupportFixture(page);
        await page.route('**/static-config/styles/style-support.yaml', route => route.fulfill({
            contentType: 'text/yaml',
            body: `name: Style Support
version: 2
rules:
  - geometry: line
    width: 2
    filter: true and (true or false) and (false or true) and (true or false)
    color-scale: {mode: linear, expression: '1', stops: [[0, red], [1, orange], [2, yellow], [3, green], [4, blue], [5, purple]]}
    all-of: [{filter: 'true', width: 3}]
`
        }));
        await navigateToStateSnapshotRoot(page);
        const styles = await openStylesDialog(page);
        await styles.getByTestId('style-edit-button-style-support').click();
        const editor = page.getByTestId('style-editor-dialog').locator('.p-dialog').first();
        const form = editor.getByTestId('style-document-editor');
        await page.setViewportSize({width: 480, height: 600});
        for (const key of ['filter', 'color-scale']) {
            const bubble = form.locator(`[data-style-bubble="rules.0.${key}"]`);
            const label = bubble.locator('.style-rule-bubble-label');
            const value = bubble.locator('.style-rule-bubble-value');
            await expect(label).toBeVisible();
            expect(await label.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
            expect(await value.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
        }
        await page.mouse.move(0, 0);
        await form.screenshot({path: test.info().outputPath('light-style-long-bubbles.png')});
        await editor.getByTestId('surface-title-edit').click();
        const titleInput = editor.getByTestId('surface-title-input');
        await expect(titleInput).toBeInViewport();
        await titleInput.fill('A long stylesheet name in a narrow editor');
        await titleInput.press('Escape');
        await form.locator('[data-style-bubble="rules.0.width"]').click();
        await form.getByTestId('style-property-save').scrollIntoViewIfNeeded();
        await expect(form.getByTestId('style-property-save')).toBeInViewport();
        await expect(form.getByTestId('style-property-delete')).toBeInViewport();
        expect(await form.evaluate(element => element.scrollWidth > element.clientWidth + 2)).toBe(false);
        await form.getByTestId('style-property-dismiss').click();
        await form.getByTestId('style-add-property-rules.0').click();
        const menu = page.getByRole('menu', {name: 'Add style property', exact: true});
        await expect(menu).toBeInViewport();
        await menu.getByRole('menuitem', {name: 'Appearance', exact: true}).click();
        await page.screenshot({path: test.info().outputPath('light-style-property-menu.png')});
        await menu.getByRole('menuitem', {name: 'Opacity', exact: true}).click();
        await expect(form.getByTestId('style-property-delete')).toHaveCount(0);
        await form.getByTestId('style-property-save').scrollIntoViewIfNeeded();
        await expect(form.getByTestId('style-property-save')).toBeInViewport();
        await expect(form.locator('.style-form-error')).toHaveCount(0);
        await page.mouse.move(0, 0);
        await page.screenshot({path: test.info().outputPath('light-style-property-panel.png'), fullPage: true});
        await form.getByTestId('style-property-dismiss').click();
        await editor.getByTestId('style-editor-close-button').click();
    });
});
