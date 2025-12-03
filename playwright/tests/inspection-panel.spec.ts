import type { Page } from '@playwright/test';
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
    test('selecting a feature from search opens an inspection panel with TestMap attributes', async ({ page, request }) => {
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

        const isBridgeRow = treeBody.locator('tr', {
            has: treeBody.locator('td', { hasText: 'isBridge' })
        }).first();
        const isBridgeCells = isBridgeRow.locator('td');
        await expect(isBridgeCells).toHaveCount(2);
        await expect(isBridgeCells.nth(1)).toContainText('false');

        await expect(treeBody.locator('td')).toContainText('Main St.');
    });

    test('pinned panel remains while a new feature from search opens an additional panel', async ({ page, request }) => {
        await requireTestMapSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, 'TestMap', 'WayLayer');
        await navigateToArea(page, 42.5, 11.615, 13);

        await runFeatureSearch(page, '**.name');
        await clickSearchResultLeaf(page, 0);

        const panels = page.locator('.inspection-container .inspect-panel');
        await expect(panels).toHaveCount(1);

        const firstPanel = panels.first();
        const pinIcon = firstPanel.locator('.material-symbols-outlined', {
            hasText: 'keep_off'
        }).first();
        await expect(pinIcon).toBeVisible();
        await pinIcon.click();

        await expect(
            firstPanel.locator('.material-symbols-outlined', { hasText: 'keep' })
        ).toBeVisible();

        await clickSearchResultLeaf(page, 1);

        await expect(panels).toHaveCount(2);
    });
});

