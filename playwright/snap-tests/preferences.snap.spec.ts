import { expect, test } from '../fixtures/test';
import { navigateToRoot, openPreferencesDialog } from '../utils/ui-helpers';

test.describe('Snapshot – preferences', () => {
    test('preferences dialog', async ({ page }) => {
        await navigateToRoot(page);
        const dialog = await openPreferencesDialog(page);

        await expect(dialog).toHaveScreenshot('preferences.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});

