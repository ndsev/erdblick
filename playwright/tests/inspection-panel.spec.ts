import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import {
    enableMapLayer,
    navigateToArea,
    navigateToRoot
} from '../utils/ui-helpers';

async function runFeatureSearch(page: Page, query: string): Promise<void> {
    const searchInput = page.locator('textarea[placeholder="Search"]');
    await searchInput.click();

    const searchMenuContainer = page.locator('.resizable-container').filter({
        has: page.locator('.search-menu-dialog')
    }).first();
    const searchMenu = searchMenuContainer.locator('.p-dialog-content');
    await expect(searchMenu).toBeVisible();

    const searchLoadedFeatures = searchMenu.locator('.search-menu .search-option-name', {
        hasText: 'Search Loaded Features'
    }).first();
    await expect(searchLoadedFeatures).toBeVisible();

    await searchInput.fill(query);
    await searchInput.focus();
    await page.keyboard.press('Enter');

    const featureSearch = page.locator('.feature-search-dialog').first();
    const featureSearchContent = featureSearch.locator('.p-dialog-content').first();
    await expect(featureSearchContent).toBeVisible();

    const resultsBadge = featureSearchContent.locator('.p-badge').first();
    await expect.poll(async () => {
        const text = await resultsBadge.innerText();
        const value = parseInt(text || '0', 10);
        return Number.isNaN(value) ? 0 : value;
    }, {
        timeout: 10000
    }).toBeGreaterThan(0);

    const emptyMessage = featureSearchContent.locator('.p-tree-empty-message');
    await expect(emptyMessage).toHaveCount(0);
}

async function clickSearchResultLeaf(page: Page, index: number): Promise<void> {
    const featureSearch = page.locator('.feature-search-dialog').first();
    const featureSearchContent = featureSearch.locator('.p-dialog-content').first();
    const tree = featureSearchContent.locator('.p-tree').first();
    const leafNodes = tree.locator('.p-tree-node-content');
    const count = await leafNodes.count();
    if (count === 0) {
        throw new Error('Expected at least one search result leaf node');
    }
    const targetIndex = Math.min(index, count - 1);
    await leafNodes.nth(targetIndex).click();
}

test.describe('Inspection panels over TestMap/WayLayer', () => {
    test('selecting a feature from search opens an inspection panel with TestMap attributes', async ({ page, request }) => {
        await requireTestMapSource(request);

        await navigateToRoot(page);
        await enableMapLayer(page, 'TestMap', 'WayLayer');
        await navigateToArea(page, 42.5, 11.65, 11);

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
        await navigateToArea(page, 42.5, 11.65, 11);

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

