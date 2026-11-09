import {expect, test} from '../fixtures/test';
import {requireTestMapSource} from '../utils/backend-helpers';
import {TEST_LAYER_NAMES, TEST_MAP_NAMES} from '../utils/test-params';
import {enableMapLayer, navigateToStateSnapshotRoot, openOmnibar} from '../utils/ui-helpers';

test.use({stateSnapshot: 'style_editor_state'});

/** Catch missing worker assets and schema-install failures through the actual editor. */
test('Omnibar offers schema completions from its module worker', async ({page, request}) => {
    await requireTestMapSource(request);
    await navigateToStateSnapshotRoot(page);
    await enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
    await openOmnibar(page, 'attributes.isB');
    // Completion is driven by typing/caret events, rather than form assignment.
    await page.getByTestId('omnibar-input').press('r');
    const popup = page.locator('.completion-popup:not(.completion-popup-hidden)');
    await expect(popup.getByText('isBridge', {exact: true})).toBeVisible({timeout: 15000});
});

/** Exercise the real worker and field picker without requiring search matches. */
test('Visualization discovers nested fields without separate scope controls', async ({page, request}) => {
    await requireTestMapSource(request);
    await navigateToStateSnapshotRoot(page);
    await enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
    const palette = await openOmnibar(page, 'false');
    await palette.locator('.omnibar-menu', {hasText: 'Search Features and Attributes'})
        .first().locator('.omnibar-option-wrapper').first().click();
    const dialog = page.getByTestId('feature-search-dialog').locator('.p-dialog').first();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', {name: /^Visualization/}).click();
    await expect(page.getByTestId('feature-search-field-browser')).toHaveCount(0);
    await expect(dialog.getByText('Include descendant fields', {exact: true})).toHaveCount(0);

    // These entries originate in the real worker result and UI application,
    // rather than an injected catalog or a direct main-thread WASM call.
    await expect.poll(() => page.evaluate(() => {
        const entry = performance.getEntriesByName('erdblick.search.style-fields.worker').at(-1) as PerformanceMeasure | undefined;
        return entry?.detail?.fields ?? 0;
    })).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() =>
        performance.getEntriesByName('erdblick.search.style-fields.apply').length)).toBeGreaterThan(0);
    await expect(dialog.getByText(/Schema fields are unavailable/)).toHaveCount(0);
});
