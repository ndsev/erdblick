import {expect, test} from '../fixtures/test';
import {requireTestMapSource} from '../utils/backend-helpers';
import {TEST_LAYER_NAMES, TEST_MAP_NAMES} from '../utils/test-params';
import {enableMapLayer, navigateToStateSnapshotRoot, openOmnibar} from '../utils/ui-helpers';

test.use({stateSnapshot: 'style_editor_state'});

/** Exercise the real schema worker and Angular field browser without requiring search matches. */
test('Visualization receives a compact inventory and lets users request descendant fields', async ({page, request}) => {
    await requireTestMapSource(request);
    await navigateToStateSnapshotRoot(page);
    await enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
    const palette = await openOmnibar(page, 'false');
    await palette.locator('.omnibar-menu', {hasText: 'Search Features and Attributes'})
        .first().locator('.omnibar-option-wrapper').first().click();
    const dialog = page.getByTestId('feature-search-dialog').locator('.p-dialog').first();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', {name: /^Visualization/}).click();
    const browser = page.getByTestId('feature-search-field-browser');
    await expect(browser).toBeVisible();
    await expect(browser).toContainText('Field scope: Result root');

    // These entries originate in the real worker result and UI application,
    // rather than an injected catalog or a direct main-thread WASM call.
    await expect.poll(() => page.evaluate(() => {
        const entry = performance.getEntriesByName('erdblick.search.style-fields.worker').at(-1) as PerformanceMeasure | undefined;
        return entry?.detail?.fields ?? 0;
    })).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() =>
        performance.getEntriesByName('erdblick.search.style-fields.apply').length)).toBeGreaterThan(0);
    const firstRequest = await page.evaluate(() =>
        performance.getEntriesByName('erdblick.search.style-fields.worker').at(-1)!.startTime);

    await browser.getByTestId('feature-search-field-descendants').getByRole('checkbox').check();
    await expect.poll(() => page.evaluate(() =>
        performance.getEntriesByName('erdblick.search.style-fields.worker').at(-1)?.startTime ?? 0))
        .toBeGreaterThan(firstRequest);
    await expect(dialog.getByText(/Schema fields are unavailable/)).toHaveCount(0);
    await expect(browser.getByTestId('feature-search-field-context')).toBeVisible();
});
