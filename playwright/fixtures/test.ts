import { test as base } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

declare global {
    interface Window {
        ebDebug?: {
            showTestTile: () => void;
            setCamera: (viewIndex: number, cameraInfoStr: string) => void;
            getCamera: (viewIndex: number) => string | undefined;
        };
    }
}

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
                await route.continue();
                return;
            }

            let body: any;
            try {
                body = request.postDataJSON();
            } catch {
                await route.continue();
                return;
            }

            // Expect shape { requests: [{ mapId, typeId, featureId: [...] }, ...] }.
            const requests = Array.isArray(body?.requests) ? body.requests : null;
            if (!requests || requests.length === 0) {
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
        const supportsCoverage = browserName === 'chromium';

        if (supportsCoverage) {
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
                const [jsCoverage, cssCoverage] = await Promise.all([
                    page.coverage.stopJSCoverage(),
                    page.coverage.stopCSSCoverage(),
                ]);

                const outDir = path.join(process.cwd(), 'coverage', 'playwright', 'raw');
                await fs.mkdir(outDir, { recursive: true });

                const baseName = testInfo.testId.replace(/[^\w-]/g, '_');
                await fs.writeFile(
                    path.join(outDir, `${baseName}-js.json`),
                    JSON.stringify(jsCoverage),
                );
                await fs.writeFile(
                    path.join(outDir, `${baseName}-css.json`),
                    JSON.stringify(cssCoverage),
                );
            }
        }
    }
});

export const expect = test.expect;
