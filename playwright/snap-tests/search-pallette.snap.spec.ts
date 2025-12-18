import { expect, test } from '../fixtures/test';
import { navigateToRoot, openSearchPalette } from '../utils/ui-helpers';

test.describe('Snapshot – search pallette', () => {
    test('search menu options', async ({ page }) => {
        await navigateToRoot(page);
        const searchMenu = await openSearchPalette(page, '12345');

        await expect(searchMenu).toHaveScreenshot('search-pallette.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});

