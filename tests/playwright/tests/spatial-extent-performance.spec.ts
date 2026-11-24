import {expect, test} from '../fixtures/test';
import {closeLayerDialog, navigateToStateSnapshotRoot, openLayerDialog, openMainMenu} from '../utils/ui-helpers';

/** Test-only instrumentation; native APIs and ordinary controls remain the production ones. */
interface SpatialProbe {
    calls: Record<string, number>;
    elapsedMs: Record<string, number>;
    inputDelayMs: number[];
    nextFrameMs: number[];
    recording: boolean;
}

declare global {
    interface Window { spatialExtentProbe?: SpatialProbe; }
}

// Reuse a fixed 2D camera with backgrounds and tile borders disabled.
test.use({stateSnapshot: 'location_navigation'});

test('large coverage stays outside ordinary Maps and menu interactions', async ({page}, testInfo) => {
    // The deliberately slow pre-fix bundle is used only for manual qualification.
    if (process.env['EB_SPATIAL_BASELINE'] === '1') test.setTimeout(480_000);
    const {MortonCode, PackedTileId, Wgs84} = await import('@ndsev/ndslive-math');
    const coverage = Array.from({length: 2600}, (_, index) => {
        const [x, y] = new Wgs84(index * .05, 20).toNdsCoordinates();
        return PackedTileId.fromMortonAndLevel(MortonCode.fromNdsCoordinates(x, y), 13).value;
    });
    const mapId = 'Coverage performance fixture';
    const layers = Object.fromEntries(Array.from({length: 43}, (_, index) => [`Layer${index}`, {
        layerId: `Layer${index}`, type: 'Features', featureTypes: [], canRead: false, canWrite: false,
        // Exercise catalogue controls independently of viewport tile selection.
        defaultVisible: false,
        coverage, coverageComplete: true, zoomLevels: [13], version: {major: 1, minor: 0, patch: 0}
    }]));
    await page.route(/\/sources(?:\?.*)?$/, async route => {
        const response = await route.fetch();
        // Keep the live catalogue revision, but let Playwright size the new body.
        // Reusing the empty backend's Content-Length truncates it in Firefox.
        const headers = response.headers();
        delete headers['content-length'];
        delete headers['content-encoding'];
        await route.fulfill({response, headers, json: [{
            mapId, sourceId: mapId, stringPoolId: mapId, configIndex: 0, status: 'ready',
            maxParallelJobs: 1, addOn: false, extraJsonAttachment: {}, layers
        }]});
    });
    await navigateToStateSnapshotRoot(page);
    await testInfo.attach('spatial-extent-startup', {
        body: JSON.stringify({appReadyMs: await page.evaluate(() => performance.now())}),
        contentType: 'application/json'
    });
    await openLayerDialog(page);
    const settings = page.getByRole('button', {name: `Map configuration for ${mapId}`, exact: true});
    await expect(settings).toBeVisible();
    await settings.click();
    await expect(page.getByTestId('map-spatial-options')).toBeVisible();
    await settings.click();

    await page.evaluate(() => {
        const probe: SpatialProbe = {calls: {}, elapsedMs: {}, inputDelayMs: [], nextFrameMs: [], recording: true};
        window.spatialExtentProbe = probe;
        const prototype = window.ebDebug!.coreLib().TileLayerParser.prototype;
        // The retired name is observed only to measure the pre-fix production
        // bundle in a matched baseline run; the application has no legacy path.
        for (const name of ['coverageInfo', 'coverageSummary', 'coverageDisplayBounds', 'coverageRectangles']) {
            const original = prototype[name];
            if (typeof original !== 'function') continue;
            prototype[name] = function(this: unknown, ...args: unknown[]) {
                const start = performance.now();
                try {return original.apply(this, args);}
                finally {
                    if (probe.recording) {
                        probe.calls[name] = (probe.calls[name] ?? 0) + 1;
                        probe.elapsedMs[name] = (probe.elapsedMs[name] ?? 0) + performance.now() - start;
                    }
                }
            };
        }
        window.addEventListener('click', event => {
            if (!probe.recording || !event.isTrusted) return;
            probe.inputDelayMs.push(Math.max(0, performance.now() - event.timeStamp));
            requestAnimationFrame(() => {
                if (probe.recording) probe.nextFrameMs.push(Math.max(0, performance.now() - event.timeStamp));
            });
        }, {capture: true});
        performance.mark('spatial-ordinary-interactions-start');
    });

    // Thirty settings activations plus Maps, filtering, grouping and outside
    // menus exercise the actual Angular template with a closed or open popover.
    for (let index = 0; index < 15; ++index) {
        await settings.hover();
        await settings.click();
        await expect(page.getByTestId('map-spatial-options')).toBeVisible();
        await settings.click();
        await expect(page.getByTestId('map-spatial-options')).toBeHidden();
        if (index % 5 === 4) {
            await page.getByTestId('source-grouping-0').click();
            await page.getByTestId('map-filter-input').fill('Layer0');
            await expect(page.getByTestId('map-tree-0')).toContainText('Layer0');
            await expect(page.getByTestId('map-tree-0').getByRole('checkbox', {name: 'Layer1', exact: true})).toHaveCount(0);
            await page.getByTestId('map-filter-input').fill('');
            await closeLayerDialog(page);
            await openMainMenu(page, 'File');
            await page.keyboard.press('Escape');
            await openLayerDialog(page);
        }
    }
    const result = await page.evaluate(() => {
        performance.mark('spatial-ordinary-interactions-end');
        const probe = window.spatialExtentProbe!;
        probe.recording = false;
        return {calls: probe.calls, nativeElapsedMs: probe.elapsedMs,
            inputDelayMs: probe.inputDelayMs, nextFrameMs: probe.nextFrameMs};
    });
    await testInfo.attach('spatial-extent-interactions', {body: JSON.stringify(result, null, 2), contentType: 'application/json'});
    // Timing is reported, not asserted on shared CI machines. The stable
    // regression contract is zero native reads from UI-only updates.
    if (process.env['EB_SPATIAL_BASELINE'] !== '1') {
        expect(result.calls).toEqual({});
    } else {
        expect(result.calls['coverageInfo']).toBeGreaterThan(0);
    }

    await page.evaluate(() => {
        const probe = window.spatialExtentProbe!;
        probe.calls = {}; probe.elapsedMs = {}; probe.recording = true;
        performance.mark('spatial-explicit-focus-start');
    });
    await page.getByTestId('map-tree-0').getByRole('button', {name: 'center_focus_strong', exact: true}).first().click();
    const focus = await page.evaluate(() => {
        performance.mark('spatial-explicit-focus-end');
        const probe = window.spatialExtentProbe!;
        probe.recording = false;
        return {calls: probe.calls, nativeElapsedMs: probe.elapsedMs};
    });
    await testInfo.attach('spatial-extent-focus', {body: JSON.stringify(focus, null, 2), contentType: 'application/json'});
    expect(focus.calls['coverageDisplayBounds']).toBeGreaterThan(0);

    await page.evaluate(() => {
        const probe = window.spatialExtentProbe!;
        probe.calls = {}; probe.elapsedMs = {}; probe.recording = true;
        performance.mark('spatial-cached-focus-start');
    });
    await page.getByTestId('map-tree-0').getByRole('button', {name: 'center_focus_strong', exact: true}).first().click();
    const cached = await page.evaluate(() => {
        performance.mark('spatial-cached-focus-end');
        const probe = window.spatialExtentProbe!;
        probe.recording = false;
        return {calls: probe.calls, nativeElapsedMs: probe.elapsedMs};
    });
    await testInfo.attach('spatial-extent-cached-focus', {body: JSON.stringify(cached, null, 2), contentType: 'application/json'});
    if (process.env['EB_SPATIAL_BASELINE'] !== '1') expect(cached.calls).toEqual({});
});
