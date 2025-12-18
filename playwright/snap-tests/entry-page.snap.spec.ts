import { expect, test } from '../fixtures/test';
import { navigateToRoot, revealPrefButtons } from '../utils/ui-helpers';

test.describe('Snapshot – entry / layout', () => {
    test('entry page', async ({ page }) => {
        await navigateToRoot(page);

        await expect(page.locator('body')).toHaveScreenshot('erdblick.png', {
            maxDiffPixelRatio: 0.01
        });
    });

    test('layout controls (main menu)', async ({ page }) => {
        await navigateToRoot(page);
        await revealPrefButtons(page);

        const controls = page.locator('.main-button-controls').first();
        await expect(controls).toBeVisible();

        await expect(controls).toHaveScreenshot('layout.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});

