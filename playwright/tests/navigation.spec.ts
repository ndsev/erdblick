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
    test('wheel stays cancelable when Zone and mjolnir are loaded together', async ({page}) => {
        const passiveListenerErrors: string[] = [];
        page.on('console', message => {
            const text = message.text();
            if (message.type() === 'error' && /passive|preventDefault/i.test(text)) {
                passiveListenerErrors.push(text);
            }
        });

        await navigateToRoot(page);
        const canvas = page.getByTestId('mapViewContainer-0').locator('canvas').first();
        await expect(canvas).toBeVisible();

        const zoneEvents = await page.evaluate(() =>
            (globalThis as typeof globalThis & {
                __zone_symbol__UNPATCHED_EVENTS?: string[];
            }).__zone_symbol__UNPATCHED_EVENTS
        );
        expect(zoneEvents).toContain('wheel');

        // Reproduce the listener ordering that caused Zone to merge mjolnir's passive observer
        // and cancelable wheel handler under one passive native listener.
        const mixedListenerProbe = await page.evaluate(() => {
            const element = document.createElement('div');
            let passiveCalls = 0;
            let activeCalls = 0;
            element.addEventListener('wheel', () => passiveCalls++, {passive: true});
            element.addEventListener('wheel', event => {
                activeCalls++;
                event.preventDefault();
            }, {passive: false});
            document.body.appendChild(element);
            const event = new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                deltaY: -120
            });
            const dispatchResult = element.dispatchEvent(event);
            element.remove();
            return {
                activeCalls,
                passiveCalls,
                defaultPrevented: event.defaultPrevented,
                dispatchResult
            };
        });
        expect(mixedListenerProbe).toEqual({
            activeCalls: 1,
            passiveCalls: 1,
            defaultPrevented: true,
            dispatchResult: false
        });

        const bounds = await canvas.boundingBox();
        if (!bounds) {
            throw new Error('Map canvas has no bounds.');
        }
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        const cameraBeforeWheel = await camera(page);
        await page.evaluate(() => {
            const result = {calls: 0, defaultPrevented: false};
            (globalThis as typeof globalThis & {
                __erdblickWheelSmoke?: typeof result;
            }).__erdblickWheelSmoke = result;
            document.addEventListener('wheel', event => {
                result.calls++;
                result.defaultPrevented = event.defaultPrevented;
            }, {once: true, passive: true});
        });
        await page.mouse.wheel(0, -120);

        await expect.poll(async () => (await camera(page)).position.join(','))
            .not.toBe(cameraBeforeWheel.position.join(','));
        const wheelResult = await page.evaluate(() =>
            (globalThis as typeof globalThis & {
                __erdblickWheelSmoke?: {calls: number; defaultPrevented: boolean};
            }).__erdblickWheelSmoke
        );
        expect(wheelResult).toEqual({calls: 1, defaultPrevented: true});
        expect(passiveListenerErrors).toEqual([]);
    });

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
