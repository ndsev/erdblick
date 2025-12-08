import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import {
    clickSearchResultLeaf,
    enableMapLayer,
    navigateToArea,
    navigateToRoot,
    runFeatureSearch
} from '../utils/ui-helpers';

test.describe('Synthetic road grid over TestMap/WayLayer', () => {
    test('grid roads are searchable and drive locate-based selection', async ({ page, request }) => {
        await requireTestMapSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, 'TestMap', 'WayLayer');
        await navigateToArea(page, 42.5, 11.65, 13);

        const locateRequests: string[] = [];
        page.on('request', (req) => {
            if (req.url().endsWith('/locate') && req.method() === 'POST') {
                locateRequests.push(req.url());
            }
        });

        // Search for the synthetic grid attribute; the base example
        // feature does not use `kind`, so results should come from
        // the vertical/horizontal road grid.
        await runFeatureSearch(page, '**.kind');
        await clickSearchResultLeaf(page, 0);

        // Ensure that the UI issued at least one /locate request as
        // part of the jump/selection flow.
        await expect.poll(() => locateRequests.length, {
            timeout: 15000
        }).toBeGreaterThan(0);

        const panel = page.locator('.inspection-container .inspect-panel').first();
        await expect(panel).toBeVisible();

        const treeBody = panel.locator('.p-treetable-tbody');
        await expect(treeBody).toBeVisible();

        // Check that the selected feature exposes the synthetic grid
        // attributes: kind = vertical|horizontal and a numeric speedLimit.
        const kindRow = treeBody.locator('tr', {
            has: treeBody.locator('td', { hasText: 'kind' })
        }).first();
        const kindCells = kindRow.locator('td');
        await expect(kindCells).toHaveCount(2);
        const kindValue = kindCells.nth(1);
        await expect(kindValue).toHaveText(/vertical|horizontal/);

        const speedLimitRow = treeBody.locator('tr', {
            has: treeBody.locator('td', { hasText: 'speedLimit' })
        }).first();
        const speedLimitCells = speedLimitRow.locator('td');
        await expect(speedLimitCells).toHaveCount(2);
        await expect(speedLimitCells.nth(1)).toHaveText(/[0-9]/);
    });
});

