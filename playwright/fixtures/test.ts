import { test as base } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TEST_LAYER_NAMES, TEST_MAP_NAMES, TEST_STATE_SNAPSHOT, TEST_VIEW_POSITIONS } from '../utils/test-params';
import { loadStateSnapshotLocalStorageEntries } from '../utils/state-snapshots';

const DARK_MODE_KEY = 'ui.darkMode';
const FORCED_DARK_MODE_SETTING = 'on';

/**
 * Shared Playwright fixtures used across end-to-end tests.
 *
 * This module:
 * - Forces dark mode through localStorage before the app bootstraps.
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
            /** Builds the canonical feature-layer tile key for a map/layer/tile tuple. */
            mapTileKey: (mapId: string, layerId: string, tileId: string | number | bigint) => string;
            /** Exposes the initialized native core for deterministic coordinate helpers. */
            coreLib: () => any;
            /** Loads one exact feature through the inspection-only restricted tile path. */
            featureInspectionHoverSummary: (
                mapTileKey: string,
                featureId: string,
                keyFilter?: string
            ) => Promise<Record<string, unknown>>;
            /** Application state used to drive the same selection path as picking and search. */
            stateService: {
                setSelection: (
                    features: Array<{mapTileKey: string; featureId: string}>
                ) => void;
            };
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
 * - Forces the UI into dark mode for deterministic visual coverage.
 * - Mocks `/locate` requests to return deterministic synthetic locations that
 *   point into the `TestMap/WayLayer` tiles served by the Python datasource.
 * - Starts JS / CSS coverage collection on Chromium-based browsers and writes
 *   the results into NDJSON files once each test completes.
 */
type SnapshotFixtures = {
    stateSnapshot: string | null;
};

/** Computes the packed tile id that contains one deterministic test viewport position. */
async function packedTileIdForTestPosition(locationIndex = 0): Promise<number> {
    const { MortonCode, PackedTileId, Wgs84 } = await import('@ndsev/ndslive-math');
    const [lon, lat, level] = TEST_VIEW_POSITIONS[locationIndex];
    const [x, y] = new Wgs84(lon, lat).toNdsCoordinates();
    return PackedTileId.fromMortonAndLevel(MortonCode.fromNdsCoordinates(x, y), level).value;
}

export const test = base.extend<SnapshotFixtures>({
    stateSnapshot: [TEST_STATE_SNAPSHOT, { option: true }],
    context: async ({ context, stateSnapshot }, use) => {
        const snapshotEntries = loadStateSnapshotLocalStorageEntries(stateSnapshot);
        await context.addInitScript(([key, value]) => {
            window.localStorage.setItem(key, value);
        }, [DARK_MODE_KEY, FORCED_DARK_MODE_SETTING]);
        if (snapshotEntries) {
            await context.addInitScript((entries) => {
                for (const [key, value] of Object.entries(entries)) {
                    window.localStorage.setItem(key, value);
                }
            }, snapshotEntries);
        }

        await use(context);
    },
    page: async ({ page }, use) => {
        const backendBinary = process.env["MAPGET_BIN"];
        const usingMapviewerBinary = !!backendBinary && ['mapviewer', 'mapviewer.exe'].includes(path.basename(backendBinary).toLowerCase());
        const shouldMockLocate = !usingMapviewerBinary;

        if (shouldMockLocate) {
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

                // Expect the canonical locate shape
                // { requests: [{ mapId, featureId: "Type.id" }, ...] }.
                const requests = Array.isArray(body?.requests) ? body.requests : null;
                if (!requests || requests.length === 0) {
                    // No locate requests to satisfy; fall back to default handling.
                    await route.continue();
                    return;
                }

                if (typeof requests[0]?.featureId !== 'string') {
                    await route.continue();
                    return;
                }

                const tileId = await packedTileIdForTestPosition();
                const responses = requests.map((req: any) => {
                    const mapId = typeof req.mapId === 'string' ? req.mapId : TEST_MAP_NAMES[0];
                    const canonicalFeatureId = typeof req.featureId === 'string'
                        ? req.featureId
                        : 'Way.0';

                    // Use a valid packed tile id for all located features. The
                    // Python datasource generates the same synthetic grid in
                    // every tile, but mapget now rejects non-packed legacy ids.
                    const tileKey = `Features:${mapId}:${TEST_LAYER_NAMES[0]}:${tileId}`;

                    // Each locate request yields a single synthetic location result.
                    return [{
                        tileId: tileKey,
                        canonicalFeatureId
                    }];
                });

                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ responses })
                });
            });
        }

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
