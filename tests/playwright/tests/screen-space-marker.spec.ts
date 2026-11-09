import {expect, test} from '../fixtures/test';
import {waitForAppReady} from '../utils/ui-helpers';

test.use({stateSnapshot: null});

/** Reproduce the elevated Munich marker that nearly filled a tilted viewport. */
test('location marker retains its pixel size at the horizon and during zoom', async ({page}) => {
    await page.goto('/?v2=1&vid=0&n=1&f=0&lon=11.62430637&lat=48.20742409&alt=1959.91893164' +
        '&h=3.38375709&p=-0.29873531&r=0&px=0&py=0&pz=0&m2d=0&bg=~0&tb=0' +
        '&m=1&mp=11.63000604,48.22290924,536.15997314&l=');
    await waitForAppReady(page);
    const canvas = page.getByTestId('mapViewContainer-0').locator('canvas').first();
    for (const [altitude, pitch] of [[1959.91893164, -0.29873531], [2100, -0.3], [2400, -0.35], [3000, -0.35]]) {
        await page.evaluate(({altitude, pitch}) => {
            const camera = JSON.parse(window.ebDebug!.getCamera(0)!);
            camera.position[2] = altitude;
            camera.orientation.pitch = pitch;
            window.ebDebug!.setCamera(0, JSON.stringify(camera));
        }, {altitude, pitch});
        let visibleHeight = 0;
        await expect.poll(async () => {
            // The map has no basemap, layers or tile grid: white pixels belong
            // exclusively to the real built-in marker, not a test replacement.
            const png = (await canvas.screenshot()).toString('base64');
            visibleHeight = await page.evaluate(async png => {
                const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
                const target = document.createElement('canvas');
                target.width = image.width; target.height = image.height;
                const context = target.getContext('2d')!;
                context.drawImage(image, 0, 0);
                image.close();
                const pixels = context.getImageData(0, 0, target.width, target.height).data;
                let top = target.height, bottom = -1;
                // A canvas screenshot also includes DOM controls overlapping
                // its edges. All cameras keep the marker in the central area.
                for (let y = Math.floor(target.height * 0.12); y < target.height * 0.85; y++) {
                    for (let x = Math.floor(target.width * 0.25); x < target.width * 0.75; x++) {
                        const i = (y * target.width + x) * 4;
                        if (pixels[i] > 180 && pixels[i + 1] > 180 && pixels[i + 2] > 180) {
                            top = Math.min(top, y);
                            bottom = Math.max(bottom, y);
                        }
                    }
                }
                return bottom - top + 1;
            }, png);
            return visibleHeight;
        }).toBeGreaterThanOrEqual(24);
        // A 32 px icon has a 26 px visible pin inside its transparent margins.
        // The upper bound is checked separately so oversized regressions fail.
        expect(visibleHeight).toBeLessThanOrEqual(27);
        const screenshot = await canvas.screenshot();
        await test.info().attach(`marker-${altitude}-${pitch}.png`, {body: screenshot, contentType: 'image/png'});
    }
});
