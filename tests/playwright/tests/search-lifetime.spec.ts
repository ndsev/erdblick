import {expect, test} from '../fixtures/test';
import {requireMapSource} from '../utils/backend-helpers';
import {enableMapLayer, openOmnibar, waitForAppReady} from '../utils/ui-helpers';
import {TEST_LAYER_NAMES, TEST_MAP_NAMES} from '../utils/test-params';

test.use({stateSnapshot: null});

/** Exercises the dialog's independently owned sections across live Angular view replacement. */
test('search sections retain scope, style and results through docking and close cleanly', async ({page, request}) => {
    await requireMapSource(request, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/?lon=10&lat=40&alt=500&h=0&p=-1&r=0&tll=1&osm=0~0');
    await waitForAppReady(page);
    await enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
    const menu = await openOmnibar(page, 'true');
    await menu.locator('.omnibar-menu', {hasText: 'Search Features and Attributes'})
        .first().locator('.omnibar-option-wrapper').first().click();
    const dialog = page.getByTestId('feature-search-dialog').locator('.p-dialog').first();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('feature-search-tree')).toBeVisible();
    // The synthetic sources need an explicit level; they do not publish an
    // automatic source-level preference. Exercise the section's real selector.
    await dialog.getByTestId('feature-search-levels').click();
    await page.getByRole('option', {name: '13', exact: true}).click();
    await dialog.getByTestId('feature-search-scope').click();
    await page.getByRole('option', {name: 'Feature', exact: true}).click();
    await expect(dialog.getByTestId('feature-search-scope')).toContainText('Feature');
    await expect(dialog.locator('.feature-search-progress-label')).toContainText('Complete,');
    await expect(dialog.getByTestId('feature-search-tree').getByRole('treeitem').first()).toBeVisible();

    await dialog.getByRole('tab', {name: /^Visualization/}).click();
    await expect(dialog.getByTestId('feature-search-style-rules')).toBeVisible();
    await expect(dialog.getByTestId('feature-search-save-style').getByRole('button')).toBeEnabled();
    await dialog.getByTestId('feature-search-save-style').click();
    const save = page.getByTestId('search-style-save-dialog');
    await expect(save).toBeVisible();
    await save.locator('#search-style-save-name').fill('Refactor lifecycle style');
    await save.getByTestId('search-style-save-confirm').click();
    await expect(save).not.toBeVisible();

    await dialog.getByRole('tab', {name: /^Diagnostics/}).click();
    await expect(dialog.locator('search-diagnostics[mode="progress"]')).toContainText('Complete');
    await dialog.locator('app-surface-header p-button').filter({hasText: 'move_to_inbox'}).click();
    const docked = page.getByTestId('feature-search-docked-panel');
    await expect(docked).toBeVisible();
    await expect(dialog).not.toBeVisible();
    await expect(docked.getByTestId('feature-search-scope')).toContainText('Feature');
    await docked.getByRole('tab', {name: /^Results/}).click();
    await expect(docked.getByTestId('feature-search-tree').getByRole('treeitem').first()).toBeVisible();
    await docked.locator('app-surface-header p-button').filter({hasText: 'eject'}).click();
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('surface-close-button').click();
    await expect(dialog).not.toBeVisible();
    await expect(docked).not.toBeVisible();
    expect(errors).toEqual([]);
});
