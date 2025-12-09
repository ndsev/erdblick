import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import {
    clickSearchResultLeaf,
    enableMapLayer,
    navigateToArea,
    navigateToRoot,
    runFeatureSearch
} from '../utils/ui-helpers';

test.describe('Inspection panels over TestMap/WayLayer', () => {
    test('selecting a feature from search opens an inspection panel with TestMap attributes and opens the second panel', async ({ page, request }) => {
        await requireTestMapSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, 'TestMap', 'WayLayer');
        await navigateToArea(page, 42.5, 11.615, 13);

        await runFeatureSearch(page, '**.name');
        await clickSearchResultLeaf(page, 0);

        const panel = page.locator('.inspection-container .inspect-panel').first();
        await expect(panel).toBeVisible();

        const treeBody = panel.locator('.p-treetable-tbody');
        await expect(treeBody).toBeVisible();

        const mapIdRow = treeBody.locator('tr', {
            hasText: 'TestMap'
        }).first();
        await expect(mapIdRow).toHaveCount(1);
        const layerIdRow = treeBody.locator('tr', {
            hasText: 'WayLayer'
        }).first();
        await expect(layerIdRow).toHaveCount(1);

        const pinIcon = panel.locator('.material-symbols-outlined', {
            hasText: 'keep_off'
        }).first();
        await expect(pinIcon).toBeVisible();
        await pinIcon.click();

        await clickSearchResultLeaf(page, 1);
        const panels = page.locator('.inspection-container .inspect-panel');
        await expect(panels).toHaveCount(2);
    });
});
