import {expect, test} from '../fixtures/test';
import {navigateToRoot, openPreferencesDialog} from '../utils/ui-helpers';

test.use({stateSnapshot: null});

test('point-cloud sampling remains configurable without experimental memory controls', async ({page}) => {
    await navigateToRoot(page);
    let preferences = await openPreferencesDialog(page);
    await preferences.getByTestId('preferences-tab-rendering').click();
    await expect(preferences.getByTestId('rendering-memory-preferences')).toHaveCount(0);
    const sampling = preferences.getByLabel('Adaptive detail', {exact: true});
    await expect(sampling).toBeChecked();
    await sampling.uncheck();
    await preferences.getByTestId('point-cloud-apply').click();
    await expect.poll(() => page.evaluate(() =>
        localStorage.getItem('pointCloudDownsamplingEnabled')
    )).toBe('0');

    await page.reload();
    preferences = await openPreferencesDialog(page);
    await preferences.getByTestId('preferences-tab-rendering').click();
    await expect(preferences.getByLabel('Adaptive detail', {exact: true})).not.toBeChecked();
    await expect(preferences.getByTestId('rendering-memory-preferences')).toHaveCount(0);
    expect(await page.evaluate(() =>
        window.ebDebug!.subsetRenderPresentation().fatalPresentationFailures
    )).toBe(0);
});
