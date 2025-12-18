import { expect, test } from '../fixtures/test';
import { navigateToRoot, openDatasourcesDialog, openLayerDialog } from '../utils/ui-helpers';

test.describe('Snapshot – datasource editor', () => {
    test('datasource configuration editor dialog', async ({ page }) => {
        await navigateToRoot(page);
        await openLayerDialog(page);

        const dialog = await openDatasourcesDialog(page);
        await expect(dialog).toContainText('DataSource Configuration Editor');

        await expect(dialog).toHaveScreenshot('datasource-editor.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});

