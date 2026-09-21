import {expect, test} from '../fixtures/test';
import {navigateToRoot, openPreferencesDialog} from '../utils/ui-helpers';

test.use({stateSnapshot: null});

test('semantic compositing can be bypassed, persisted and restored', async ({page}) => {
    await navigateToRoot(page);
    await expect.poll(() => page.evaluate(() =>
        window.ebDebug?.subsetRenderPresentation().views
    )).toBe(1);
    const enabledLayers = await page.evaluate(() =>
        window.ebDebug!.subsetRenderPresentation().layers
    );
    const canvas = page.getByTestId('mapViewContainer-0').locator('canvas');
    const enabledCanvas = await canvas.elementHandle();
    expect(enabledLayers).toBeGreaterThan(4);
    expect(enabledCanvas).not.toBeNull();

    let preferences = await openPreferencesDialog(page);
    await preferences.getByTestId('preferences-tab-rendering').click();
    let setting = preferences.getByTestId('semantic-compositing-setting');
    await expect(setting.getByRole('button', {name: 'On', exact: true}))
        .toHaveAttribute('aria-pressed', 'true');
    await setting.getByRole('button', {name: 'Off', exact: true}).click();

    await expect.poll(() => enabledCanvas!.evaluate(element => element.isConnected)).toBe(false);
    // Omit support, winner, visible composite and picking composite; retain the ordinary layers.
    await expect.poll(() => page.evaluate(() =>
        window.ebDebug!.subsetRenderPresentation().layers
    )).toBe(enabledLayers - 4);
    await expect.poll(() => page.evaluate(() =>
        localStorage.getItem('semanticCompositingEnabled')
    )).toBe('0');
    await preferences.getByRole('button', {name: 'Close'}).click();

    await page.reload();
    await expect.poll(() => page.evaluate(() =>
        window.ebDebug?.subsetRenderPresentation().layers
    )).toBe(enabledLayers - 4);
    const disabledCanvas = await canvas.elementHandle();
    expect(disabledCanvas).not.toBeNull();
    preferences = await openPreferencesDialog(page);
    await preferences.getByTestId('preferences-tab-rendering').click();
    setting = preferences.getByTestId('semantic-compositing-setting');
    await expect(setting.getByRole('button', {name: 'Off', exact: true}))
        .toHaveAttribute('aria-pressed', 'true');
    await setting.getByRole('button', {name: 'On', exact: true}).click();

    await expect.poll(() => disabledCanvas!.evaluate(element => element.isConnected)).toBe(false);
    await expect.poll(() => page.evaluate(() =>
        window.ebDebug!.subsetRenderPresentation().layers
    )).toBe(enabledLayers);
    await expect.poll(() => page.evaluate(() =>
        localStorage.getItem('semanticCompositingEnabled')
    )).toBe('1');
    expect(await page.evaluate(() =>
        window.ebDebug!.subsetRenderPresentation().fatalPresentationFailures
    )).toBe(0);
});
