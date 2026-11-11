import {build} from 'esbuild';
import {expect, test} from '../fixtures/test';
import type * as comparison from '../fixtures/path-layer-comparison';

declare global {
    interface Window {
        pathComparison: typeof comparison;
    }
}

test.use({stateSnapshot: null, viewport: {width: 1260, height: 620}});

let bundle: string;
test.beforeAll(async () => {
    const result = await build({
        entryPoints: ['tests/playwright/fixtures/path-layer-comparison.ts'],
        bundle: true, write: false, format: 'iife', globalName: 'pathComparison', platform: 'browser'
    });
    bundle = result.outputFiles[0].text;
});

test('pixel paths, icons and labels keep their sizes throughout zoom and tilt', async ({page}, testInfo) => {
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({content: bundle});
    const measurements = await page.evaluate(() => window.pathComparison.measureScreenSizes());
    await testInfo.attach('pixel-sizes.json', {body: JSON.stringify(measurements), contentType: 'application/json'});
    expect(measurements).toHaveLength(24 * 3);
    for (const {camera, frame, sizes} of measurements) {
        for (let i = 0; i < 3; i++) {
            expect(sizes[i][1], `path ${i}, camera ${camera}, frame ${frame}`).toBeGreaterThanOrEqual(5);
            expect(sizes[i][1], `path ${i}, camera ${camera}, frame ${frame}`).toBeLessThanOrEqual(7);
        }
        for (const dimension of sizes[3]) expect(dimension).toBeGreaterThanOrEqual(31);
        for (const dimension of sizes[3]) expect(dimension).toBeLessThanOrEqual(33);
        for (const labelPart of [4, 5]) {
            const reference = measurements[0].sizes[labelPart];
            sizes[labelPart].forEach((value, axis) => expect(Math.abs(value - reference[axis])).toBeLessThanOrEqual(2));
        }
        expect(sizes[4][1]).toBeGreaterThan(10);
        expect(sizes[5][1]).toBeGreaterThan(sizes[4][1]);
    }
});

for (const pipeline of ['direct', 'contact', 'semantic'] as const) {
    for (const pitch of [0, 55]) {
        for (const billboard of [false, true]) {
            test(`PathLayer comparison at pitch ${pitch}, billboard ${billboard}, pipeline ${pipeline}`, async ({page}, testInfo) => {
                await page.setContent('<html><body></body></html>');
                await page.addScriptTag({content: bundle});
                const result = await page.evaluate(async ({pitch, billboard, pipeline}) => {
                    return window.pathComparison.render(pitch, billboard, pipeline);
                }, {pitch, billboard, pipeline});
                console.log({pitch, billboard, pipeline, ...result});
                await testInfo.attach('comparison.png', {body: await page.screenshot(), contentType: 'image/png'});
                expect(result.renderers[0].coverage).toBeGreaterThan(0);
                expect(result.renderers[1].coverage).toBeGreaterThan(0);
                if (pipeline === 'direct') {
                    // Allow endpoint tessellation and FP32/local vs FP64/WGS84 projection differences.
                    expect(result.relativePixelDifference).toBeLessThan(0.03);
                }
            });
        }
    }
}
