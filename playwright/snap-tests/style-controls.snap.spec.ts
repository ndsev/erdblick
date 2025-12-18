import { expect, test } from '../fixtures/test';
import { navigateToRoot, openLayerDialog, openStylesDialog } from '../utils/ui-helpers';

test.describe('Snapshot – style controls', () => {
    test('style sheets dialog with editor open', async ({ page }) => {
        await navigateToRoot(page);
        await openLayerDialog(page);

        const stylesDialog = await openStylesDialog(page);

        // Expand the "NDS.Live" group when present (keyboard expansion is more stable than hunting togglers).
        const ndsLiveNode = stylesDialog.locator('.p-tree-node-content', { hasText: 'NDS.Live' }).first();
        if (await ndsLiveNode.count()) {
            await ndsLiveNode.click();
            await page.keyboard.press('ArrowRight');
        }

        // Open the editor for a stable built-in style (prefer NDS.Live/Lanes, fall back to Common).
        const candidateNames = ['Lanes', 'Common'];
        let opened = false;
        for (const name of candidateNames) {
            const node = stylesDialog.locator('.p-tree-node-content', { hasText: name }).first();
            if (await node.count()) {
                const editButton = node.locator('button:has(.pi-file-edit)').first();
                if (await editButton.count()) {
                    await editButton.click();
                    opened = true;
                    break;
                }
            }
        }
        expect(opened).toBeTruthy();

        const editorDialog = page.locator('.editor-dialog').filter({ hasNot: page.locator('.datasource-dialog') }).first();
        await expect(editorDialog).toBeVisible();

        // Capture both dialogs + surrounding controls.
        await expect(page.locator('body')).toHaveScreenshot('style-controls.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});

