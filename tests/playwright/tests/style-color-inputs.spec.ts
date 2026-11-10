import {expect, test} from '../fixtures/test';
import {installStyleSupportFixture} from '../fixtures/style-support';
import {navigateToStateSnapshotRoot, openStylesDialog} from '../utils/ui-helpers';

test.use({stateSnapshot: 'style_editor_state'});

test.beforeEach(async ({page}) => {
    await installStyleSupportFixture(page);
    await page.route('**/static-config/styles/style-support.yaml', route => route.fulfill({
        contentType: 'text/yaml',
        body: `name: Style Support
version: 2
options: [{id: tint, type: color, default: blue}]
interaction-effects:
  hover:
    tint: red
    halo: {color: white, radius: 2}
    stripe: {color: '#123456', width: 2, spacing: 10}
  selection: {tint: {option: tint}}
rules:
  - geometry: line
    width: 2
    color-scale:
      mode: categorical
      expression: '1'
      stops: [[road, red], [7, '0x00ff00'], [true, '#abc']]
      fallback: blue
`
    }));
    await navigateToStateSnapshotRoot(page);
    const styles = await openStylesDialog(page);
    await styles.getByTestId('style-edit-button-style-support').click();
});

test.describe('Light theme', () => {
    test.use({darkMode: 'off'});

    test('scale pickers preserve typed keys, drafts and row identity in a narrow editor', async ({page}) => {
        const editor = page.getByTestId('style-editor-dialog').locator('.p-dialog').first();
        const form = editor.getByTestId('style-document-editor');
        const apply = editor.getByTestId('style-editor-apply-button').locator('button');
        const bubble = form.locator('[data-style-bubble="rules.0.color-scale"]');
        const rows = form.locator('.style-stop');
        await bubble.click();
        for (const [index, color] of ['rgb(255, 0, 0)', 'rgb(0, 255, 0)', 'rgb(170, 187, 204)'].entries()) {
            await expect(rows.nth(index).getByRole('textbox', {name: `Color picker for stop ${index + 1}`, exact: true}))
                .toHaveCSS('background-color', color);
        }
        await expect(form.locator('[data-style-path="rules.0.color-scale.fallback"]')
            .getByRole('textbox', {name: 'Color picker for fallback', exact: true})).toHaveCSS('background-color', 'rgb(0, 0, 255)');
        const firstPicker = rows.nth(0).getByRole('textbox', {name: 'Color picker for stop 1', exact: true});
        await firstPicker.press('Space');
        await expect(page.locator('.p-colorpicker-panel')).toBeVisible();
        await firstPicker.press('Escape');
        await expect(page.locator('.p-colorpicker-panel')).toBeHidden();
        await expect(rows.nth(0).getByRole('textbox', {name: 'Stop color', exact: true})).toHaveValue('red');
        await form.getByTestId('style-property-dismiss').click();
        await expect(apply).toBeDisabled();

        await bubble.click();
        await page.setViewportSize({width: 480, height: 600});
        await rows.nth(0).getByRole('textbox', {name: 'Stop color', exact: true}).fill('#a1b2c3');
        await expect(firstPicker).toHaveCSS('background-color', 'rgb(161, 178, 195)');
        await rows.nth(1).getByRole('textbox', {name: 'Stop key', exact: true}).fill('1e');
        const secondPicker = rows.nth(1).getByRole('textbox', {name: 'Color picker for stop 2', exact: true});
        await secondPicker.click();
        await page.locator('.p-colorpicker-color-selector').click({position: {x: 75, y: 75}});
        await secondPicker.press('Escape');
        const secondColor = rows.nth(1).getByRole('textbox', {name: 'Stop color', exact: true});
        await expect(secondColor).toHaveValue(/^#[\da-f]{6}$/i);
        const picked = await secondColor.inputValue();
        // Changing the color must not erase an unfinished sibling key or its error.
        await expect(rows.nth(1).getByRole('textbox', {name: 'Stop key', exact: true})).toHaveValue('1e');
        await expect(form.getByTestId('style-property-save')).toBeDisabled();
        await rows.nth(1).getByRole('textbox', {name: 'Stop key', exact: true}).fill('7');
        await rows.nth(1).getByRole('button', {name: 'Move stop up', exact: true}).click();
        await expect(rows.nth(0).getByRole('textbox', {name: 'Stop color', exact: true})).toHaveValue(picked);
        await form.getByTestId('style-property-save').click();
        await bubble.click();
        await expect(rows.nth(0).getByRole('textbox', {name: 'Stop key', exact: true})).toHaveValue('7');
        await expect(rows.nth(1).getByRole('textbox', {name: 'Stop key', exact: true})).toHaveValue('road');
        await expect(rows.nth(1).getByRole('textbox', {name: 'Stop color', exact: true})).toHaveValue('#a1b2c3');
        await expect(rows.nth(2).getByRole('combobox', {name: 'Stop key type', exact: true})).toHaveValue('boolean');
        await expect(rows.nth(2).getByRole('textbox', {name: 'Stop color', exact: true})).toHaveValue('#abc');
        expect(await form.evaluate(element => element.scrollWidth <= element.clientWidth + 2)).toBe(true);
        await firstPicker.scrollIntoViewIfNeeded();
        await expect(firstPicker).toBeInViewport();
        await page.mouse.move(0, 0);
        await page.screenshot({path: test.info().outputPath('narrow-scale-color-pickers.png')});
        await form.getByTestId('style-property-dismiss').click();
        await apply.click();
        await expect(apply).toBeDisabled();
    });
});

test('interaction color pickers synchronize literal values and preserve option references', async ({page}) => {
    const editor = page.getByTestId('style-editor-dialog').locator('.p-dialog').first();
    const form = editor.getByTestId('style-document-editor');
    const apply = editor.getByTestId('style-editor-apply-button').locator('button');
    await form.locator('summary').filter({hasText: /^Interaction$/}).click();
    for (const [path, label, color] of [
        ['tint', 'tint', 'rgb(255, 0, 0)'],
        ['halo.color', 'color', 'rgb(255, 255, 255)'],
        ['stripe.color', 'color', 'rgb(18, 52, 86)']
    ]) {
        const field = form.locator(`[data-style-path="interaction-effects.hover.${path}"]`);
        const picker = field.getByRole('textbox', {name: `Color picker for ${label}`, exact: true});
        const text = field.getByRole('textbox', {name: label, exact: true});
        await expect(picker).toHaveCSS('background-color', color);
        await text.fill('0x1a2b3c');
        await expect(picker).toHaveCSS('background-color', 'rgb(26, 43, 60)');
        await picker.click();
        await page.locator('.p-colorpicker-color-selector').click({position: {x: 75, y: 75}});
        await picker.press('Escape');
        await expect(text).toHaveValue(/^#[\da-f]{6}$/i);
        await expect(editor).toBeVisible();
    }
    const reference = form.locator('[data-style-path="interaction-effects.selection.tint"]');
    await expect(reference.locator('p-colorpicker')).toHaveCount(0);
    await expect(reference.getByRole('textbox', {name: 'Color option ID', exact: true})).toHaveValue('tint');
    await reference.getByRole('combobox', {name: 'Color source', exact: true}).selectOption('literal');
    await reference.getByRole('textbox', {name: 'tint', exact: true}).fill('#f00');
    await expect(reference.getByRole('textbox', {name: 'Color picker for tint', exact: true}))
        .toHaveCSS('background-color', 'rgb(255, 0, 0)');
    await reference.getByRole('combobox', {name: 'Color source', exact: true}).selectOption('option');
    await expect(reference.locator('p-colorpicker')).toHaveCount(0);
    await reference.getByRole('textbox', {name: 'Color option ID', exact: true}).fill('tint');
    await reference.getByRole('textbox', {name: 'Color option ID', exact: true}).press('Tab');
    await expect(form.locator('.style-form-error')).toHaveCount(0);
    await editor.getByRole('tab', {name: 'Advanced', exact: true}).click();
    await expect(editor.locator('editor .cm-content')).toContainText(/option: ["']?tint["']?/);
    await apply.click();
    await expect(apply).toBeDisabled();
});
