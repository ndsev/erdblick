import { WebMercatorViewport } from '@deck.gl/core';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/test';
import { navigateToStateSnapshotRoot, openOmnibar } from '../utils/ui-helpers';

const metadata = { id: 'wof:1', name: 'Area Place', lonLat: [160, 70], aabb: [[0, 0], [22, 10]], geometryAvailable: true };
const geometry = {
    type: 'MultiPolygon', coordinates: [
        [[[0, 0], [10, 0], [10, 10], [6, 10], [6, 6], [0, 6], [0, 0]],
        [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]],
        [[[20, 0], [22, 0], [22, 2], [20, 2], [20, 0]]]
    ]
};
const point = { id: 'wof:2', name: 'Point Place', lonLat: [35, 20], aabb: [[35, 20], [0, 0]], geometryAvailable: false };

/** Reads the normal published camera, so a renderer-only move cannot satisfy the assertion. */
async function camera(page: Page) {
    return page.evaluate(() => {
        const value = (window.ebDebug!.stateService.exportSnapshot()['cameraView'] as Array<{
            lon: number; lat: number; alt: number; h: number; p: number; r: number
        }>)[0];
        return {
            destination: { lon: value.lon, lat: value.lat, alt: value.alt },
            orientation: { heading: value.h, pitch: value.p, roll: value.r }
        };
    });
}

/** Selects the stable result identity through the ordinary omnibox. */
async function selectPlace(page: Page, query = 'Area', id = 'wof:1', freezeHighlight = false) {
    await openOmnibar(page, query);
    const row = page.getByTestId('omnibar-action').filter({ has: page.getByText(query === 'Area' ? 'Area Place' : 'Point Place', { exact: true }) })
        .and(page.locator(`[data-action-id="loc:mapget-offline:${id}"]`));
    await row.waitFor({ state: 'visible' });
    if (freezeHighlight) await page.clock.pauseAt(new Date(Date.now() + 60_000));
    await row.click();
}

/** Samples the rendered PNG at geographic positions, including polygon holes and concavities. */
async function sampleMap(page: Page, points: number[][]): Promise<number[][]> {
    const canvas = page.getByTestId('mapViewContainer-0').locator('canvas').first();
    const bounds = (await canvas.boundingBox())!;
    const state = await camera(page);
    const { lon, lat, alt } = state.destination;
    const metersPerPixel = (2 * alt / 3) / bounds.height;
    const zoom = Math.log2(Math.cos(lat * Math.PI / 180) * 2 * Math.PI * 6378137 / (512 * metersPerPixel));
    const viewport = new WebMercatorViewport({
        width: bounds.width, height: bounds.height,
        longitude: lon, latitude: lat, zoom, orthographic: true
    });
    const pixels = points.map(([x, y]) => viewport.project([x + 360 * Math.round((lon - x) / 360), y]));
    const png = (await canvas.screenshot()).toString('base64');
    return page.evaluate(async ({ png, pixels }) => {
        const blob = await (await fetch(`data:image/png;base64,${png}`)).blob();
        const image = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const colors = pixels.map(([x, y]) => [...context.getImageData(Math.round(x), Math.round(y), 1, 1).data]);
        image.close();
        return colors;
    }, { png, pixels });
}

test.use({ stateSnapshot: 'location_navigation' });

test('fits all polygon components, renders holes, fades, and replays metadata-only history', async ({ page }) => {
    let details = 0;
    await page.route('**/location?**', async route => {
        const id = new URL(route.request().url()).searchParams.get('id');
        if (id) details++;
        await route.fulfill({ json: [{ ...metadata, ...(id ? { geometry } : {}) }] });
    });
    await page.clock.install();
    await navigateToStateSnapshotRoot(page);
    await openOmnibar(page, 'Area');
    await expect(page.getByText('Area Place', { exact: true })).toBeVisible();
    expect(details).toBe(0);
    await selectPlace(page, 'Area', 'wof:1', true);
    await expect.poll(async () => (await camera(page)).destination.lon).toBeCloseTo(11, 5);
    await page.clock.runFor(250);
    expect(details).toBe(1);
    // Snapshots use the deployed scalar Boolean codec: marker visibility is 0/1.
    expect(await page.evaluate(() => window.ebDebug!.stateService.exportSnapshot()['marker'])).toBe(0);
    const samples = await sampleMap(page, [[8, 8], [3, 3], [3, 8], [21, 1]]);
    const cyan = samples.map(([r, g, b]) => Math.min(g, b) - r);
    expect(cyan[0]).toBeGreaterThan(cyan[1] + 10); // Hole is unfilled.
    expect(cyan[0]).toBeGreaterThan(cyan[2] + 10); // Concavity is not replaced by the bounding box.
    expect(cyan[3]).toBeGreaterThan(cyan[1] + 10); // Distant island is also visible.
    await page.clock.fastForward(4500);
    await page.clock.runFor(100); // Flush the registry removal on the following animation frame.
    const faded = await sampleMap(page, [[8, 8]]);
    expect(Math.min(faded[0][1], faded[0][2]) - faded[0][0]).toBeLessThan(5);
    const saved = await page.evaluate(() => localStorage.getItem('searchHistory'));
    expect(saved).toContain('wof:1');
    expect(saved).not.toContain('coordinates');
    const beforeReload = await camera(page);
    await page.clock.resume();
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!window.ebDebug)).toBe(true);
    await expect.poll(async () => (await camera(page)).destination.lon).toBeCloseTo(beforeReload.destination.lon, 5);
    await expect.poll(async () => (await camera(page)).destination.alt).toBeCloseTo(beforeReload.destination.alt, 1);
    await openOmnibar(page, '');
    await page.getByTestId('omnibar-history-action').filter({ has: page.getByText('Area', { exact: true }) }).click();
    await expect.poll(() => details).toBe(2);
});

test('falls back from failed geometry to extent, then preserves point marker navigation', async ({ page }) => {
    await page.route('**/location?**', async route => {
        const query = new URL(route.request().url()).searchParams;
        if (query.has('id')) await route.fulfill({ status: 413, body: 'Boundary too large' });
        else await route.fulfill({ json: [query.get('name') === 'Point' ? point : metadata] });
    });
    await page.clock.install();
    await navigateToStateSnapshotRoot(page);
    await selectPlace(page, 'Area', 'wof:1', true);
    await expect.poll(async () => (await camera(page)).destination.lon).toBeCloseTo(11, 5);
    await page.clock.runFor(250);
    await expect(page.getByText(/Showing its bounding extent/)).toBeVisible();
    expect(await page.evaluate(() => window.ebDebug!.stateService.exportSnapshot()['marker'])).toBe(0);
    const extentSample = (await sampleMap(page, [[3, 8]]))[0];
    expect(Math.min(extentSample[1], extentSample[2]) - extentSample[0]).toBeGreaterThan(10);
    await page.clock.resume();
    await selectPlace(page, 'Point', 'wof:2');
    await expect.poll(async () => (await camera(page)).destination.lon).toBeCloseTo(35, 5);
    expect(await page.evaluate(() => window.ebDebug!.stateService.exportSnapshot()['marker'])).toBe(1);
    expect(await page.evaluate(() => window.ebDebug!.stateService.exportSnapshot()['markedPosition'])).toEqual([35, 20, 0]);
});

test('a late polygon response cannot override a newer point selection', async ({ page }) => {
    let release: () => void = () => { };
    const delayed = new Promise<void>(resolve => { release = resolve; });
    let finished: () => void = () => { };
    const responded = new Promise<void>(resolve => { finished = resolve; });
    let requested = false;
    await page.route('**/location?**', async route => {
        const query = new URL(route.request().url()).searchParams;
        if (query.has('id')) {
            requested = true;
            await delayed;
            await route.fulfill({ json: [{ ...metadata, geometry }] }).catch(() => { }); // Aborted fetches are expected.
            finished();
        } else await route.fulfill({ json: [query.get('name') === 'Point' ? point : metadata] });
    });
    await navigateToStateSnapshotRoot(page);
    await selectPlace(page);
    await expect.poll(() => requested).toBe(true);
    await selectPlace(page, 'Point', 'wof:2');
    await expect.poll(async () => (await camera(page)).destination.lon).toBeCloseTo(35, 5);
    release();
    await responded;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(async () => (await camera(page)).destination.lon).toBeCloseTo(35, 5);
    expect(await page.evaluate(() => window.ebDebug!.stateService.exportSnapshot()['marker'])).toBe(1);
});

test('keeps a dateline-crossing boundary and its hole in the fitted world copy', async ({ page }) => {
    const crossing = {
        type: 'Polygon', coordinates: [
            [[170, 0], [-175, 0], [-175, 10], [170, 10], [170, 0]],
            [[178, 2], [-178, 2], [-178, 8], [178, 8], [178, 2]]
        ]
    };
    await page.route('**/location?**', route => route.fulfill({
        json: [{
            ...metadata,
            lonLat: [175, 5], aabb: [[170, 0], [15, 10]],
            ...(new URL(route.request().url()).searchParams.has('id') ? { geometry: crossing } : {})
        }]
    }));
    await page.clock.install();
    await navigateToStateSnapshotRoot(page);
    await selectPlace(page, 'Area', 'wof:1', true);
    await expect.poll(async () => (await camera(page)).destination.lon).toBeCloseTo(177.5, 5);
    await page.clock.runFor(250);
    const samples = await sampleMap(page, [[172, 1], [-176, 1], [179, 3], [-179, 3]]);
    const cyan = samples.map(([r, g, b]) => Math.min(g, b) - r);
    expect(cyan[0]).toBeGreaterThan(cyan[2] + 10);
    expect(cyan[1]).toBeGreaterThan(cyan[3] + 10);
});
