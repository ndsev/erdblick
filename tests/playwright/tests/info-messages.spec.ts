import type {Page} from '@playwright/test';
import {expect, test} from '../fixtures/test';
import {dismissSurveyIfPresent, openPreferencesDialog, waitForAppReady} from '../utils/ui-helpers';

test.use({stateSnapshot: null});

/** Reports actual validation failures through Preferences, without exposing notification internals. */
async function prepare(page: Page) {
    await page.goto('/?v2=1&n=1&vid=0&m=1&f=0&sync=&lon=11&lat=48&alt=4000000&h=0&p=-1&r=0&px=0&py=0&pz=0&m2d=1&bg=world-overview~100&tb=0&l=');
    await waitForAppReady(page);
    await dismissSurveyIfPresent(page);
    const preferences = await openPreferencesDialog(page);
    await preferences.getByTestId('preferences-tab-rendering').click();
    const input = preferences.getByTestId('max-tiles-to-load');
    await input.fill('-1');
    return {input, notice: page.getByTestId('info-message').filter({hasText: 'Please enter valid tile limits!'})};
}

test('repeats retain the toast, restart expiry, and start at one after keyboard dismissal', async ({page}) => {
    const {input, notice} = await prepare(page);
    await page.clock.install();
    await input.press('Enter');
    await expect(notice).toHaveAttribute('data-count', '1');
    const original = await notice.getAttribute('data-message-id');
    await page.mouse.move(0, 0);
    await page.clock.fastForward(9000);
    await input.press('Enter');
    await expect(notice).toHaveAttribute('data-count', '2');
    await expect(notice).toHaveAttribute('data-message-id', original!);
    await page.clock.fastForward(9000);
    await expect(notice).toHaveCount(1);
    await notice.getByTestId('info-message-close').focus();
    await page.clock.fastForward(20000);
    await expect(notice).toHaveCount(1);
    await page.keyboard.press('Enter');
    await page.clock.runFor(500);
    await expect(notice).toHaveCount(0);
    await input.press('Enter');
    await page.clock.runFor(500);
    await expect(notice).toHaveAttribute('data-count', '1');
    expect(await notice.getAttribute('data-message-id')).not.toBe(original);
    await page.mouse.move(0, 0);
    await page.clock.fastForward(10000);
    await page.clock.runFor(500);
    await expect(notice).toHaveCount(0);
});

for (const darkMode of ['on', 'off'] as const) {
    test.describe(`notification theme ${darkMode}`, () => {
        test.use({darkMode});
        test('keeps a counted notice readable and dismissible within a narrow viewport', async ({page}) => {
            const {input, notice} = await prepare(page);
            for (let index = 0; index < 3; index++) await input.press('Enter');
            await expect(notice).toHaveAttribute('data-count', '3');
            await page.setViewportSize({width: 390, height: 700});
            await expect(notice).toBeInViewport();
            const bounds = await notice.boundingBox();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
            await expect(notice.getByTestId('info-message-close')).toBeInViewport();
            await notice.getByTestId('info-message-close').click();
            await expect(notice).toHaveCount(0);
        });
    });
}
