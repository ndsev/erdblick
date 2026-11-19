import {expect, test} from '../fixtures/test';
import {requireMapSource} from '../utils/backend-helpers';
import {enableMapLayer, openOmnibar, waitForAppReady} from '../utils/ui-helpers';
import {TEST_LAYER_NAMES, TEST_MAP_NAMES} from '../utils/test-params';

test.use({stateSnapshot: null});

test('fits the search color picker at the right dock edge and scopes Escape to its popup', async ({page, request}) => {
    await requireMapSource(request, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
    await page.goto('/?lon=10&lat=40&alt=500&h=0&p=-1&r=0&tll=1&osm=0~0');
    await waitForAppReady(page);
    await enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
    const menu = await openOmnibar(page, 'true');
    await menu.getByTestId('omnibar-action').and(page.locator('[data-action-id="features"]')).click();
    const dialog = page.getByTestId('feature-search-dialog').locator('.p-dialog').first();
    await expect(dialog).toBeVisible();
    await dialog.locator('app-surface-header p-button').filter({hasText: 'move_to_inbox'}).click();
    const dock = page.getByTestId('feature-search-docked-panel');
    await dock.getByRole('tab', {name: /^Visualization/}).click();
    const picker = dock.locator('#feature-search-density-color');
    const initialColor = await picker.evaluate(element => getComputedStyle(element).backgroundColor);
    await picker.press('Space');
    await expect(page.locator('.p-colorpicker-panel')).toBeInViewport({ratio: 1});
    await page.locator('.p-colorpicker-color-selector').click({position: {x: 75, y: 75}});
    await expect(picker).not.toHaveCSS('background-color', initialColor);
    await page.keyboard.press('Escape');
    await expect(page.locator('.p-colorpicker-panel')).toBeHidden();
    await expect(dock).toBeVisible();
    await page.mouse.move(0, 0);
    await page.screenshot({path: test.info().outputPath('search-color-picker.png')});
});
