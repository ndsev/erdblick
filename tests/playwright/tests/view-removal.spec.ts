import type {Page} from '@playwright/test';
import {expect, test} from '../fixtures/test';
import {addComparisonView, closeLayerDialog, enableMapLayer, navigateToRoot, openLayerDialog, openMainMenu, selectFeatureForInspection, waitForAppReady} from '../utils/ui-helpers';
import {requireMapSource} from '../utils/backend-helpers';
import {TEST_LAYER_NAMES, TEST_MAP_NAMES} from '../utils/test-params';

test.use({stateSnapshot: null});

/** Reads persisted settings through the same public snapshot boundary used by saved sessions. */
async function snapshot(page: Page) {
    return page.evaluate(() => window.ebDebug!.stateService.exportSnapshot());
}

for (const removed of [0, 1]) {
    for (const control of ['panel', 'context', 'main menu']) {
        test(`closing ${removed === 0 ? 'left' : 'right'} via ${control} preserves the survivor`, async ({page, request}) => {
            await requireMapSource(request, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
            const errors: string[] = [];
            page.on('pageerror', error => errors.push(error.message));
            await navigateToRoot(page);
            await enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
            await addComparisonView(page);
            await closeLayerDialog(page);
            await page.getByTestId('view-ui-container-1').getByText('2D', {exact: true}).click();
            await page.evaluate(() => {
                // Stay above the test geometry so clearance constraints cannot block keyboard zoom.
                const leftCamera = JSON.parse(window.ebDebug!.getCamera(0));
                leftCamera.position[2] = 5000;
                window.ebDebug!.setCamera(0, JSON.stringify(leftCamera));
                window.ebDebug!.setCamera(1, JSON.stringify({
                    position: [43 * Math.PI / 180, 12 * Math.PI / 180, 1200],
                    orientation: {heading: 0, pitch: -Math.PI / 2, roll: 0}
                }));
            });
            await openLayerDialog(page);
            // Keep the survivor visible while disabling the closing pane's layer.
            const closingLayer = page.getByTestId(`map-tab-${removed}`)
                .locator(`[data-id="${TEST_MAP_NAMES[0]}/${TEST_LAYER_NAMES[0]}"]`).first();
            await closingLayer.locator('input.p-checkbox-input').first().uncheck();
            await selectFeatureForInspection(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0], 'Way.0');
            const panel = page.getByTestId('inspection-panel').first();
            await expect(panel).toBeVisible();
            const survivor = 1 - removed;
            const before = await snapshot(page);
            const camera = await page.evaluate(index => JSON.parse(window.ebDebug!.getCamera(index)), survivor);

            if (control === 'panel') {
                await page.getByTestId(`close-view-button-${removed}`).click();
            } else {
                await closeLayerDialog(page);
                if (control === 'context') {
                    await page.getByTestId(`mapViewContainer-${removed}`).locator('canvas').first()
                        .click({button: 'right', position: {x: 150, y: 120}});
                    await page.getByRole('menuitem', {name: 'Close View', exact: true}).click();
                } else {
                    await openMainMenu(page, 'View');
                    await page.getByRole('menuitem', {name: new RegExp(`Close ${removed === 0 ? 'Left' : 'Right'} View$`)}).click();
                }
            }
            await expect(page.getByTestId('mapViewContainer-1')).toHaveCount(0);
            await expect(page.getByTestId('mapViewContainer-0').locator('canvas').first()).toBeVisible();
            await expect(panel).toBeVisible();
            const after = await snapshot(page);
            for (const key of ['mode2d', 'background', 'visibility', 'zoomLevel', 'autoZoomLevel']) {
                expect(after[key], key).toEqual([(before[key] as unknown[])[survivor]]);
            }
            expect(after['selected']).toEqual(before['selected']);
            const remainingCamera = await page.evaluate(() => JSON.parse(window.ebDebug!.getCamera(0)));
            camera.position.forEach((value: number, index: number) => expect(remainingCamera.position[index]).toBeCloseTo(value, 5));
            expect(remainingCamera.orientation.heading).toBeCloseTo(camera.orientation.heading, 5);
            expect(remainingCamera.orientation.pitch).toBeCloseTo(camera.orientation.pitch, 5);

            if (control === 'panel') {
                await page.reload();
                await waitForAppReady(page);
                await expect(panel).toBeVisible();
                const reloaded = await snapshot(page);
                expect(reloaded['visibility']).toEqual(after['visibility']);
                expect(reloaded['mode2d']).toEqual(after['mode2d']);
                await addComparisonView(page);
                await page.getByTestId('close-view-button-1').click();
                await expect(page.getByTestId('mapViewContainer-1')).toHaveCount(0);
                expect((await snapshot(page))['visibility']).toEqual(after['visibility']);
            }
            await closeLayerDialog(page);
            const beforeZoom = await page.evaluate(() => window.ebDebug!.getCamera(0));
            // The canvas mounts before asynchronous Deck setup rebinds shortcuts.
            await expect(async () => {
                await page.keyboard.press('e');
                expect(await page.evaluate(() => window.ebDebug!.getCamera(0))).not.toBe(beforeZoom);
            }).toPass({timeout: 10000});
            expect(errors).toEqual([]);
        });
    }
}
