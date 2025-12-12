import { test as base } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Shared Playwright fixtures used across end-to-end tests.
 *
 * This module:
 * - Defines the `Window.ebDebug` surface that the Angular app exposes for
 *   debug interactions in tests.
 * - Hooks into Chromium's V8 coverage APIs to collect JS / CSS coverage and
 *   append it as NDJSON alongside other coverage reports.
 * - Adds a custom `page` fixture that mocks `/locate` responses for
 *   deterministic feature search / inspection flows.
 */

declare global {
    interface Window {
        /**
         * Optional debug hook injected by the Angular app that exposes helpers
         * for Playwright tests. The implementation lives on the UI side; here
         * we only describe the surface we rely on.
         */
        ebDebug?: {
            /** Renders a synthetic debug tile into the primary map view. */
            showTestTile: () => void;
            /**
             * Serialised camera setter used for synchronising camera positions
             * across views in tests.
             */
            setCamera: (viewIndex: number, cameraInfoStr: string) => void;
            /**
             * Serialised camera getter used from Playwright to inspect camera
             * positions in different views.
             */
            getCamera: (viewIndex: number) => string | undefined;
        };
    }
}

/**
 * Appends raw V8 JS / CSS coverage entries to an NDJSON file under
 * `coverage/playwright`. Each entry is written on a separate line so the
 * global teardown can aggregate the data efficiently.
 *
 * @param entries Coverage entries provided by Playwright.
 * @param kind Distinguishes JS and CSS coverage output files.
 */
function appendCoverage(entries: unknown[], kind: 'js' | 'css'): void {
    if (!entries || (Array.isArray(entries) && entries.length === 0)) {
        // Nothing to append for this test run.
        return;
    }

    const outDir = path.join(process.cwd(), 'coverage', 'playwright');
    fs.mkdirSync(outDir, { recursive: true });

    const outFile = path.join(outDir, `v8-${kind}-coverage.ndjson`);
    const lines =
        (entries as unknown[])
            .map((entry) => JSON.stringify(entry))
            .join('\n') + '\n';

    fs.appendFileSync(outFile, lines, { encoding: 'utf8' });
}

/**
 * Extended Playwright test object that:
 * - Mocks `/locate` requests to return deterministic synthetic locations that
 *   point into the `TestMap/WayLayer` tiles served by the Python datasource.
 * - Starts JS / CSS coverage collection on Chromium-based browsers and writes
 *   the results into NDJSON files once each test completes.
 */
export const test = base.extend({
    page: async ({ page }, use, testInfo) => {
        // Mock /locate responses for deterministic integration tests.
        // The backend Python datasource does not currently implement
        // a locate() handler, so mapget would otherwise return an
        // empty response. For UI flows that depend on /locate
        // (inspection panels, jump targets), we synthesize responses
        // that point to a stable TestMap/WayLayer tile key.
        await page.route('**/locate', async (route) => {
            const request = route.request();
            if (request.method() !== 'POST') {
                // Non-POST requests are passed through unchanged.
                await route.continue();
                return;
            }

            let body: any;
            try {
                body = request.postDataJSON();
            } catch {
                // If the body is not JSON, leave the request untouched.
                await route.continue();
                return;
            }

            // Expect shape { requests: [{ mapId, typeId, featureId: [...] }, ...] }.
            const requests = Array.isArray(body?.requests) ? body.requests : null;
            if (!requests || requests.length === 0) {
                // No locate requests to satisfy; fall back to default handling.
                await route.continue();
                return;
            }

            // Only handle "feature locate" requests that carry a flat featureId array.
            if (!Array.isArray(requests[0]?.featureId)) {
                await route.continue();
                return;
            }

            const responses = requests.map((req: any) => {
                const mapId = typeof req.mapId === 'string' ? req.mapId : 'TestMap';
                const typeId = typeof req.typeId === 'string' ? req.typeId : 'Way';
                const featureId = Array.isArray(req.featureId) ? req.featureId : [];

                // Use a fixed tile id for all located features. The Python
                // datasource generates the same synthetic grid of roads in
                // every tile, so any tile id is acceptable as long as the
                // key matches coreLib.getTileFeatureLayerKey(mapId, layerId, tileId).
                const numericTileId = 1;
                const hexTileId = numericTileId.toString(16);
                const tileKey = `Features:${mapId}:WayLayer:${hexTileId}`;

                // Each locate request yields a single synthetic location result.
                return [{
                    tileId: tileKey,
                    typeId,
                    featureId
                }];
            });

            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ responses })
            });
        });

        const browser = page.context().browser();
        const browserName = browser?.browserType().name();
        // Only Chromium exposes the V8 coverage APIs Playwright hooks into.
        const supportsCoverage = browserName === 'chromium';

        if (supportsCoverage) {
            // Start capturing JS / CSS coverage across navigations.
            await page.coverage.startJSCoverage({
                resetOnNavigation: false
            });
            await page.coverage.startCSSCoverage({
                resetOnNavigation: false
            });
        }

        try {
            await use(page);
        } finally {
            if (supportsCoverage) {
                // Stop coverage collection and append raw entries for later aggregation.
                const jsCoverage = await page.coverage.stopJSCoverage();
                const cssCoverage = await page.coverage.stopCSSCoverage();

                appendCoverage(jsCoverage, 'js');
                appendCoverage(cssCoverage, 'css');
            }
        }
    }
});

export const expect = test.expect;
