import {expect, test} from '../fixtures/test';
import {requireTestMapSource} from '../utils/backend-helpers';
import {
    navigateToRoot,
    openLayerDialog,
    openPreferencesDialog,
    openSearchPalette
} from '../utils/ui-helpers';

test.use({stateSnapshot: null});

test.describe('UI quick-fix regressions', () => {
    test('3D feature zoom clearance is explained and persists locally', async ({page}) => {
        await navigateToRoot(page);
        let preferences = await openPreferencesDialog(page);
        const input = preferences.getByTestId('feature-zoom-clearance-input');
        await expect(input).toHaveValue('20');

        const infoIcon = preferences.getByText('3D Feature Zoom Clearance (m)')
            .locator('i.pi-info-circle');
        await infoIcon.hover();
        await expect(page.locator('.p-tooltip-text')).toHaveText(
            'Minimum camera distance from a picked 3D feature while zooming. ' +
            'Increase it to stop farther away; set it to 0 to disable the limit.'
        );

        await input.fill('37');
        const apply = preferences.getByTestId('apply-feature-zoom-clearance');
        await expect(apply).toBeEnabled();
        await apply.click();
        await preferences.getByRole('button', {name: 'Close'}).click();

        await page.reload();
        preferences = await openPreferencesDialog(page);
        await expect(preferences.getByTestId('feature-zoom-clearance-input')).toHaveValue('37');
    });

    test('the map panel keeps icon-only controls compact and still grows for wide content', async ({page, request}) => {
        await requireTestMapSource(request);
        await navigateToRoot(page);
        await openLayerDialog(page);

        const dialog = page.getByTestId('map-layer-dialog').locator('.p-dialog').first();
        const content = dialog.locator('.p-dialog-content');
        await expect(dialog.locator('.app-dialog-resize-handle')).toHaveCount(4);
        const compactRow = dialog.locator('.map-tree-row:not(.has-map-presets)').first();
        await expect(compactRow).toBeVisible();
        const compactControls = compactRow.locator('.map-controls');
        const compactMetrics = await compactControls.evaluate(element => ({
            width: element.getBoundingClientRect().width,
            fontSize: Number.parseFloat(getComputedStyle(element).fontSize)
        }));
        expect(compactMetrics.width).toBeLessThan(compactMetrics.fontSize * 6);

        await content.evaluate(element => {
            const probe = document.createElement('div');
            probe.dataset['testid'] = 'map-panel-width-probe';
            probe.style.width = '44rem';
            probe.style.height = '1px';
            probe.style.flex = '0 0 auto';
            element.appendChild(probe);
        });

        await expect.poll(async () => dialog.evaluate(element => element.getBoundingClientRect().width))
            .toBeGreaterThan(700);
        const overflow = await content.evaluate(element => ({
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth
        }));
        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    });

    test('the search actions pane uses a width-only custom resize handle', async ({page}) => {
        await navigateToRoot(page);
        const searchPane = await openSearchPalette(page, '42.5 11.615');
        const handle = searchPane.getByTestId('search-resize-handle');
        await expect(handle).toBeVisible();
        expect(await searchPane.evaluate(element => getComputedStyle(element).resize)).toBe('none');

        const before = await searchPane.boundingBox();
        const handleBox = await handle.boundingBox();
        if (!before || !handleBox) {
            throw new Error('Expected the search pane and its resize handle to be measurable');
        }
        const startX = handleBox.x + handleBox.width - 3;
        const startY = handleBox.y + handleBox.height - 3;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX + 80, startY);
        await page.mouse.up();

        await expect.poll(async () => (await searchPane.boundingBox())?.width ?? 0)
            .toBeGreaterThan(before.width + 60);
        expect(await searchPane.evaluate(element => element.style.height)).toBe('');

        await page.setViewportSize({width: 800, height: 900});
        await expect(handle).toBeHidden();
    });

    test('the Cache Reset dialog uses compact erdblick shell spacing', async ({page}) => {
        await navigateToRoot(page);
        const toolsItem = page.locator('.main-bar').first().getByRole('menuitem', {name: /Tools$/}).first();
        await expect(toolsItem).toBeVisible();
        await toolsItem.hover();
        const submenu = page.locator('.p-menubar-submenu:visible').last();
        if (!(await submenu.isVisible().catch(() => false))) {
            await toolsItem.click();
        }
        await expect(submenu).toBeVisible();
        await submenu.getByRole('menuitem', {name: /Cache Reset$/}).click();

        const dialog = page.locator('.p-dialog.app-dialog-compact.cache-reset-dialog').first();
        await expect(dialog).toBeVisible();
        const spacing = await dialog.evaluate(element => {
            const header = element.querySelector(':scope > .p-dialog-header');
            const content = element.querySelector(':scope > .p-dialog-content');
            if (!(header instanceof HTMLElement) || !(content instanceof HTMLElement)) {
                throw new Error('Expected direct PrimeNG dialog header and content children');
            }
            const headerStyle = getComputedStyle(header);
            const contentStyle = getComputedStyle(content);
            return {
                headerPaddingTop: Number.parseFloat(headerStyle.paddingTop),
                headerFontSize: Number.parseFloat(headerStyle.fontSize),
                contentPaddingTop: Number.parseFloat(contentStyle.paddingTop),
                contentFontSize: Number.parseFloat(contentStyle.fontSize)
            };
        });
        expect(spacing.headerPaddingTop / spacing.headerFontSize).toBeCloseTo(0.75, 2);
        expect(spacing.contentPaddingTop / spacing.contentFontSize).toBeCloseTo(0.5, 2);
    });

    test('coordinate visibility does not remove marker controls', async ({page}) => {
        await page.addInitScript(() => {
            window.localStorage.setItem('marker', '1');
            window.localStorage.setItem('markedPosition', JSON.stringify([42.5, 11.615, 0]));
        });
        await navigateToRoot(page);

        await expect(page.getByTestId('coordinates-display')).toBeVisible();
        await expect(page.getByTestId('map-marker-toggle')).toBeVisible();
        await expect(page.getByTestId('map-marker-focus')).toBeVisible();

        const preferences = await openPreferencesDialog(page);
        const coordinateSetting = preferences.getByTestId('coordinates-enabled-setting');
        await expect(coordinateSetting.locator('input')).toBeChecked();
        await coordinateSetting.click();
        await expect(coordinateSetting.locator('input')).not.toBeChecked();
        await preferences.getByRole('button', {name: 'Close'}).click();

        await expect(page.getByTestId('coordinates-display')).toBeHidden();
        await expect(page.getByTestId('map-marker-toggle')).toBeVisible();
        await expect(page.getByTestId('map-marker-focus')).toBeVisible();
    });
});
