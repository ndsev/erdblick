import {expect, test} from '../fixtures/test';
import {navigateToRoot, openPreferencesDialog} from '../utils/ui-helpers';

test.use({stateSnapshot: null});

test('point-cloud sampling applies one persisted threshold and preserves an explicit opt-out', async ({page}) => {
    await navigateToRoot(page);
    let preferences = await openPreferencesDialog(page);
    await preferences.getByTestId('preferences-tab-rendering').click();
    await expect(preferences.getByTestId('rendering-memory-preferences')).toHaveCount(0);
    const sampling = preferences.getByLabel('Enable point-cloud downsampling', {exact: true});
    await expect(sampling).toBeChecked();
    const threshold = preferences.getByTestId('point-cloud-max-points');
    await expect(threshold).toHaveValue('14000000');
    const slider = preferences.getByTestId('point-cloud-max-points-slider').getByRole('slider');
    await slider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(threshold).toHaveValue('13900000');
    await threshold.fill('500000');
    expect(await page.evaluate(() => window.ebDebug!.viewSettings.pointCloudPolicy.maxPoints)).toBe(14_000_000);
    await preferences.getByTestId('point-cloud-apply').click();
    await expect.poll(() => page.evaluate(() =>
        window.ebDebug!.viewSettings.pointCloudPolicy.maxPoints
    )).toBe(500_000);
    await sampling.uncheck();
    await expect(threshold).toBeDisabled();
    await preferences.getByTestId('point-cloud-apply').click();
    await expect.poll(() => page.evaluate(() =>
        localStorage.getItem('pointCloudDownsamplingEnabled')
    )).toBe('0');

    await page.reload();
    preferences = await openPreferencesDialog(page);
    await preferences.getByTestId('preferences-tab-rendering').click();
    await expect(preferences.getByLabel('Enable point-cloud downsampling', {exact: true})).not.toBeChecked();
    await expect(preferences.getByTestId('point-cloud-max-points')).toHaveValue('500000');
    await expect(preferences.getByTestId('rendering-memory-preferences')).toHaveCount(0);
    expect(await page.evaluate(() =>
        window.ebDebug!.subsetRenderPresentation().fatalPresentationFailures
    )).toBe(0);
});
