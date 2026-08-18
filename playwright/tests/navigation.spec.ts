import {expect, test} from '../fixtures/test';
import type {Page} from '@playwright/test';
import {navigateToRoot} from '../utils/ui-helpers';

interface DebugCamera {
    position: number[];
    orientation: {heading: number; pitch: number; roll: number};
}

async function camera(page: Page): Promise<DebugCamera> {
    const raw = await page.evaluate(() => window.ebDebug?.getCamera(0));
    if (!raw) {
        throw new Error('Camera debug state is unavailable.');
    }
    return JSON.parse(raw) as DebugCamera;
}

async function activeTargetPixel(page: Page): Promise<[number, number]> {
    const overlay = page.getByTestId('mapViewContainer-0')
        .getByTestId('navigation-target-overlay');
    await expect(overlay).toHaveAttribute('data-navigation-state', 'active');
    const circle = overlay.locator('circle');
    return [
        Number(await circle.getAttribute('cx')),
        Number(await circle.getAttribute('cy'))
    ];
}

test.describe('3D navigation', () => {
    test('pan is world-planar and pointer rotation keeps the acquired cursor target', async ({page}) => {
        await navigateToRoot(page);
        const container = page.getByTestId('mapViewContainer-0');
        const canvas = container.locator('canvas').first();
        await expect(canvas).toBeVisible();
        const bounds = await canvas.boundingBox();
        if (!bounds) {
            throw new Error('Map canvas has no bounds.');
        }
        const start = {
            x: bounds.x + bounds.width * 0.48,
            y: bounds.y + bounds.height * 0.62
        };

        const beforePan = await camera(page);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 70, start.y + 35, {steps: 8});
        await page.mouse.up();
        await expect.poll(async () => (await camera(page)).position.join(','))
            .not.toBe(beforePan.position.join(','));
        const afterPan = await camera(page);
        expect(afterPan.orientation.heading).toBeCloseTo(beforePan.orientation.heading, 8);
        expect(afterPan.orientation.pitch).toBeCloseTo(beforePan.orientation.pitch, 8);
        expect(afterPan.orientation.roll).toBeCloseTo(beforePan.orientation.roll, 8);

        await page.mouse.move(start.x, start.y);
        await page.mouse.down({button: 'right'});
        await page.mouse.move(start.x + 25, start.y + 12, {steps: 4});
        const rightTarget = await activeTargetPixel(page);
        await page.mouse.move(start.x + 60, start.y + 28, {steps: 4});
        const rightTargetAfter = await activeTargetPixel(page);
        expect(rightTargetAfter[0]).toBeCloseTo(rightTarget[0], 1);
        expect(rightTargetAfter[1]).toBeCloseTo(rightTarget[1], 1);
        await page.mouse.up({button: 'right'});

        await page.keyboard.down('Shift');
        await page.mouse.move(start.x - 30, start.y + 10);
        await page.mouse.down();
        await page.mouse.move(start.x - 5, start.y + 25, {steps: 4});
        const modifiedTarget = await activeTargetPixel(page);
        await page.mouse.move(start.x + 25, start.y + 42, {steps: 4});
        const modifiedTargetAfter = await activeTargetPixel(page);
        expect(modifiedTargetAfter[0]).toBeCloseTo(modifiedTarget[0], 1);
        expect(modifiedTargetAfter[1]).toBeCloseTo(modifiedTarget[1], 1);
        await page.mouse.up();
        await page.keyboard.up('Shift');
    });
});
