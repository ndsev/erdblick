import {expect, test} from '../fixtures/test';
import {installStyleSupportFixture} from '../fixtures/style-support';
import {navigateToStateSnapshotRoot, openStylesDialog, clickPrefButton, openPreferencesDialog} from '../utils/ui-helpers';
import type {Locator, Page} from '@playwright/test';

test.use({stateSnapshot: 'style_editor_state', stateSnapshotOnce: true, actionTimeout: 20000});

/** Opens a specific style using its public catalog entry, then clears catalog chrome. */
async function openStyle(page: Page, suffix: string): Promise<Locator> {
    const catalog = await openStylesDialog(page);
    await catalog.getByTestId(`style-edit-button-${suffix}`).click();
    // A newly opened editor can overlap the catalog; its close action remains a direct UI command.
    await catalog.getByTestId('styles-close-button').click({force: true});
    const name = suffix === 'style-support' ? 'Style Support' : 'Other Style';
    return page.locator('editor-surface').filter({has: page.locator('.app-surface-header-title-text', {hasText: `Style Editor — ${name}`})});
}

/** Selects the ordinary dock/eject action without relying on child-button ordering. */
async function place(surface: Locator, icon: 'move_to_inbox' | 'eject'): Promise<void> {
    await surface.locator('app-surface-header p-button').filter({hasText: icon}).click();
}

test('retains independent CodeMirror history, Quick input and close guards across editor docking', async ({page}) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await installStyleSupportFixture(page, true);
    await navigateToStateSnapshotRoot(page);
    const first = await openStyle(page, 'style-support');
    await expect(first.locator('.p-dialog')).toBeVisible();
    await first.getByRole('tab', {name: 'Advanced', exact: true}).click();
    const editor = first.locator('editor .cm-content');
    await editor.click();
    await editor.press('ControlOrMeta+End');
    await editor.press('Enter');
    await editor.pressSequentially('# first draft');
    const firstId = await first.getAttribute('data-editor-id');
    await place(first, 'move_to_inbox');
    const docked = page.locator(`editor-surface[data-editor-id="${firstId}"]`);
    await expect(docked.getByTestId('editor-docked-panel')).toBeVisible();
    await expect.poll(async () => (await docked.getByTestId('dock-panel-content').boundingBox())?.width ?? 0).toBeGreaterThan(300);
    await expect(docked.locator('editor .cm-content')).toContainText('# first draft');
    await place(docked, 'eject');
    await expect(docked.locator('.p-dialog')).toBeVisible();
    await docked.locator('editor .cm-content').press('ControlOrMeta+z');
    await expect(docked.locator('editor .cm-content')).not.toContainText('# first draft');
    await docked.locator('editor .cm-content').press('ControlOrMeta+Shift+z');
    await expect(docked.locator('editor .cm-content')).toContainText('# first draft');

    const second = await openStyle(page, 'other-style');
    await expect(second.getByTestId('style-editor-quick-name')).toHaveValue('Other Style');
    await expect(page.locator('editor-surface[data-editor-kind="style"]')).toHaveCount(2);
    await expect(second.locator('editor .cm-content')).not.toContainText('# first draft');
    await second.getByTestId('style-editor-quick-name').fill('Other draft');
    await second.getByRole('textbox', {name: 'Width / point diameter', exact: true}).fill('-');
    await place(second, 'move_to_inbox');
    await expect(second.getByRole('textbox', {name: 'Width / point diameter', exact: true})).toHaveValue('-');
    await expect(page.getByTestId('editors-dock-tab')).toContainText('1');
    // Reopening the first resource preserves its identity and draft.
    await openStyle(page, 'style-support');
    await expect(page.locator('editor-surface[data-editor-kind="style"]')).toHaveCount(2);
    await expect(docked.locator('editor .cm-content')).toContainText('# first draft');
    await docked.getByTestId('surface-close-button').click();
    const confirmation = page.getByRole('dialog', {name: 'Unsaved editor changes'});
    await expect(confirmation).toContainText('Style Support');
    await confirmation.getByRole('button', {name: 'Cancel', exact: true}).click();
    await expect(docked.locator('.p-dialog')).toBeVisible();
    await docked.getByTestId('surface-close-button').click();
    await confirmation.getByRole('button', {name: 'Discard', exact: true}).click();
    await expect(page.locator('editor-surface[data-editor-kind="style"]')).toHaveCount(1);
    await expect(second.getByTestId('style-editor-quick-name')).toHaveValue('Other draft');
    await expect(second.getByRole('textbox', {name: 'Width / point diameter', exact: true})).toHaveValue('-');
    await expect(second.getByTestId('style-editor-apply-button').locator('button')).toBeDisabled();
    expect(errors).toEqual([]);
});

test('opens all document kinds and hides the dock without closing them', async ({page}) => {
    await installStyleSupportFixture(page, true);
    await navigateToStateSnapshotRoot(page);
    const style = await openStyle(page, 'style-support');
    await place(style, 'move_to_inbox');
    const catalog = await openStylesDialog(page);
    await catalog.getByTestId('style-presets-tab').click();
    await catalog.getByTestId('style-preset-raw-edit-button').click();
    await catalog.getByTestId('styles-close-button').click();
    // New documents join the existing Editors dock.
    await clickPrefButton(page, 'Datasources');
    const preferences = await openPreferencesDialog(page);
    await preferences.getByRole('tab', {name: 'Storage', exact: true}).click();
    await preferences.getByRole('button', {name: 'Advanced', exact: false}).click();
    await expect(page.locator('editor-surface')).toHaveCount(4);
    await expect(page.getByTestId('editors-dock-tab')).toContainText('4');
    // Preferences is ordinary chrome and can be closed independently.
    await preferences.getByRole('button', {name: 'Close', exact: true}).click();
    await page.getByTestId('dock-toggle').click();
    await expect(page.locator('editor-surface')).toHaveCount(4);
    await page.getByTestId('dock-toggle').click();
    await expect(page.getByTestId('editors-dock-tab')).toContainText('4');
    await page.reload();
    await expect(page.locator('editor-surface')).toHaveCount(4);
    await expect(page.getByTestId('editors-dock-tab')).toContainText('4');
    await expect(page.locator('editor-surface[data-editor-kind="presets"] editor .cm-content')).toHaveAttribute('contenteditable', 'false');
});


test('failed datasource saves preserve the draft and keyboard commands target only the focused editor', async ({page}) => {
    await installStyleSupportFixture(page, true);
    await navigateToStateSnapshotRoot(page);
    const style = await openStyle(page, 'style-support');
    await style.getByTestId('style-editor-quick-name').fill('Unapplied style draft');
    let writes = 0;
    await page.route('**/config', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        writes++;
        await route.fulfill({status: 500, body: 'Write rejected by test'});
    });
    await clickPrefButton(page, 'Datasources');
    const datasource = page.locator('editor-surface[data-editor-kind="datasources"]');
    const json = datasource.locator('editor .cm-content');
    await expect(json).toBeVisible();
    await json.press('ControlOrMeta+End');
    await json.press('Enter');
    await json.press('ControlOrMeta+s');
    await expect(datasource.getByRole('alert')).toContainText('draft is retained');
    expect(writes).toBe(1);
    await expect(style.getByTestId('style-editor-quick-name')).toHaveValue('Unapplied style draft');
    await json.press('Escape');
    const confirmation = page.getByRole('dialog', {name: 'Unsaved editor changes'});
    await expect(confirmation).toContainText('Datasource Configuration');
    await confirmation.getByRole('button', {name: 'Discard', exact: true}).click();
    await expect(datasource).toHaveCount(0);
    await expect(style.getByTestId('style-editor-quick-name')).toHaveValue('Unapplied style draft');
    await style.getByTestId('style-editor-quick-name').press('Escape');
    await expect(confirmation).toContainText('Style Editor — Style Support');
    await confirmation.getByRole('button', {name: 'Cancel', exact: true}).click();
});

test('reorders, resizes, collapses and drags editor panels without replacing their drafts', async ({page}) => {
    await installStyleSupportFixture(page, true);
    await navigateToStateSnapshotRoot(page);
    const first = await openStyle(page, 'style-support');
    await place(first, 'move_to_inbox');
    const second = await openStyle(page, 'other-style');
    await second.getByTestId('style-editor-quick-name').fill('Docked draft');
    const id = await second.getAttribute('data-editor-id');
    const firstHeader = await first.getByTestId('style-editor-header').boundingBox();
    const secondHeader = await second.getByTestId('style-editor-header').boundingBox();
    if (!firstHeader || !secondHeader) throw new Error('Missing docked headers');
    await page.mouse.move(secondHeader.x + 170, secondHeader.y + 20);
    await page.mouse.down();
    await page.mouse.move(firstHeader.x + 170, firstHeader.y + 10, {steps: 15});
    await page.mouse.up();
    await expect(page.locator('.editor-dock-container > editor-surface').first()).toHaveAttribute('data-editor-id', id!);

    const body = second.getByTestId('dock-panel-content');
    const before = await body.boundingBox();
    const handle = await second.getByTestId('app-panel-resize-handle').boundingBox();
    if (!before || !handle) throw new Error('Missing resizable dock body');
    await page.mouse.move(handle.x + 3, handle.y + 3); await page.mouse.down();
    await page.mouse.move(handle.x + 3, handle.y + 70, {steps: 8}); await page.mouse.up();
    await expect.poll(async () => (await body.boundingBox())?.height ?? 0).toBeGreaterThan(before.height + 40);
    await second.locator('p-accordion-header > svg[data-p-icon]').click();
    await expect(body).not.toBeVisible();
    await second.locator('p-accordion-header > svg[data-p-icon]').click();
    await expect(second.getByTestId('style-editor-quick-name')).toHaveValue('Docked draft');
    const header = await second.getByTestId('style-editor-header').boundingBox();
    if (!header) throw new Error('Missing reopened header');
    await page.mouse.move(header.x + 170, header.y + 20); await page.mouse.down();
    await page.mouse.move(350, 140, {steps: 15}); await page.mouse.up();
    await expect(second.locator('.p-dialog')).toBeVisible();
    await expect(second.getByTestId('style-editor-quick-name')).toHaveValue('Docked draft');
    await expect(page.getByTestId('editors-dock-tab')).toContainText('1');
});
