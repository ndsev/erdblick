import {build} from 'esbuild';
import {expect, test} from '../fixtures/test';
import type * as comparison from '../fixtures/location-outline-comparison';

declare global {
    interface Window { locationOutlineComparison: typeof comparison; }
}

test.use({stateSnapshot: null, viewport: {width: 1260, height: 620}});
let bundle: string;
test.beforeAll(async () => {
    const result = await build({entryPoints: ['tests/playwright/fixtures/location-outline-comparison.ts'],
        bundle: true, write: false, format: 'iife', globalName: 'locationOutlineComparison', platform: 'browser'});
    bundle = result.outputFiles[0].text;
});

for (const scenario of [
    {name: 'flat', longitude: 10, latitude: 48, zoom: 5, pitch: 0, bearing: 0},
    {name: 'tilted and rotated', longitude: 10, latitude: 48, zoom: 5, pitch: 55, bearing: 35},
    {name: 'projection transition', longitude: 115, latitude: 80, zoom: 11.9, pitch: 60, bearing: 100},
    {name: 'high zoom', longitude: 115, latitude: 75, zoom: 20, pitch: 0, bearing: 0},
    {name: 'high zoom tilted', longitude: -160, latitude: -65, zoom: 20, pitch: 55, bearing: -30},
    {name: 'dateline and repeated worlds', longitude: 180, latitude: 0, zoom: 0, pitch: 35, bearing: 20, dateline: true}
]) for (const opacity of [1, 0.4]) {
    test(`complete location outline: ${scenario.name}, opacity ${opacity}`, async ({page}, testInfo) => {
        await page.setContent('<html><body></body></html>');
        await page.addScriptTag({content: bundle});
        const result = await page.evaluate(async ({scenario, opacity}) =>
            window.locationOutlineComparison.render(scenario, opacity, scenario.dateline), {scenario, opacity});
        console.log({scenario: scenario.name, opacity, ...result});
        await testInfo.attach('comparison.png', {body: await page.screenshot(), contentType: 'image/png'});
        for (const renderer of result.renderers) {
            expect(renderer.coverage).toBeGreaterThan(0);
            expect(renderer.uploadsDuringFade).toBe(0);
        }
        expect(result.unmatchedPixels).toBe(0);
        // Just below Deck's zoom-12 auto-offset threshold, GPU Mercator precision at 80° latitude
        // shifts antialiased edges by fractions of a pixel. Require identical one-pixel support above,
        // and retain the tighter coverage comparison for the other views.
        expect(result.relativePixelDifference).toBeLessThan(scenario.name === 'projection transition' ? 0.1 : 0.01);
    });
}
