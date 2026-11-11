import {expect, test} from '../fixtures/test';
import {captureDocsScreenshotWithLabels, disableUiAnimations, dismissSurveyIfPresent, openPreferencesDialog, waitForAppReady} from '../utils/ui-helpers';

test.use({stateSnapshot: null, viewport: {width: 1600, height: 1200}});
test.skip(({browserName}) => browserName !== 'chromium', 'Documentation captures use Chromium');

test('notification occurrences and dismissal controls', async ({page}) => {
    await page.goto('/?v2=1&n=1&vid=0&m=1&f=0&sync=&lon=11&lat=48&alt=4000000&h=0&p=-1&r=0&px=0&py=0&pz=0&m2d=1&bg=world-overview~100&tb=0&l=');
    await waitForAppReady(page);
    await disableUiAnimations(page);
    await dismissSurveyIfPresent(page);
    const preferences = await openPreferencesDialog(page);
    await preferences.getByTestId('preferences-tab-rendering').click();
    // The Rendering pane grows below the dialog's initial position. Move its
    // real title bar so the entire form remains visible in the documentation.
    const header = await preferences.locator('.p-dialog-header').boundingBox();
    await page.mouse.move(header!.x + header!.width / 2, header!.y + header!.height / 2);
    await page.mouse.down();
    await page.mouse.move(header!.x + header!.width / 2, 230, {steps: 8});
    await page.mouse.up();
    const input = preferences.getByTestId('max-tiles-to-load');
    await input.fill('-1');
    for (let index = 0; index < 3; index++) await input.press('Enter');
    const notice = page.getByTestId('info-message').filter({hasText: 'Please enter valid tile limits!'});
    await expect(notice).toHaveAttribute('data-count', '3');
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot('info-messages.png', {fullPage: true, maxDiffPixelRatio: 0.01});
    await captureDocsScreenshotWithLabels(page, 'docs/screenshots/info-messages.png', [
        {locator: notice, label: 'One notification for repeated messages', placement: 'left'},
        {locator: notice.getByTestId('info-message-count'), label: 'Occurrence count', placement: 'right', at: [1030, 12]},
        {locator: notice.getByTestId('info-message-close'), label: 'Dismiss this notification', placement: 'right', at: [1030, 90]}
    ], {strict: true});
});
