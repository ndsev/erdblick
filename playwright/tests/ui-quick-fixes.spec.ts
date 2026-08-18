import {expect, test} from '../fixtures/test';
import {
    navigateToRoot,
    openLayerDialog,
    openPreferencesDialog
} from '../utils/ui-helpers';

test.use({stateSnapshot: null});

test.describe('UI quick-fix regressions', () => {
    test('the map panel grows for wide content before falling back to horizontal scrolling', async ({page}) => {
        await navigateToRoot(page);
        await openLayerDialog(page);

        const dialog = page.getByTestId('map-layer-dialog').locator('.p-dialog').first();
        const content = dialog.locator('.p-dialog-content');
        await expect(dialog.locator('.app-dialog-resize-handle')).toHaveCount(4);

        await content.evaluate(element => {
            const probe = document.createElement('div');
            probe.dataset['testid'] = 'map-panel-width-probe';
            probe.style.width = '44rem';
            probe.style.height = '1px';
            probe.style.flex = '0 0 auto';
            element.appendChild(probe);
        });

        await expect.poll(async () => dialog.evaluate(element => element.getBoundingClientRect().width))
            .toBeGreaterThan(700);
        const overflow = await content.evaluate(element => ({
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth
        }));
        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    });

    test('coordinate visibility does not remove marker controls', async ({page}) => {
        await page.addInitScript(() => {
            window.localStorage.setItem('marker', '1');
            window.localStorage.setItem('markedPosition', JSON.stringify([42.5, 11.615, 0]));
        });
        await navigateToRoot(page);

        await expect(page.getByTestId('coordinates-display')).toBeVisible();
        await expect(page.getByTestId('map-marker-toggle')).toBeVisible();
        await expect(page.getByTestId('map-marker-focus')).toBeVisible();

        const preferences = await openPreferencesDialog(page);
        const coordinateSetting = preferences.getByTestId('coordinates-enabled-setting');
        await expect(coordinateSetting.locator('input')).toBeChecked();
        await coordinateSetting.click();
        await expect(coordinateSetting.locator('input')).not.toBeChecked();
        await preferences.getByRole('button', {name: 'Close'}).click();

        await expect(page.getByTestId('coordinates-display')).toBeHidden();
        await expect(page.getByTestId('map-marker-toggle')).toBeVisible();
        await expect(page.getByTestId('map-marker-focus')).toBeVisible();
    });
});
