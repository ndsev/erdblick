import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAMES, TEST_MAP_NAMES, TEST_VIEW_POSITIONS } from '../utils/test-params';
import {enableMapLayer, navigateToArea, navigateToRoot} from '../utils/ui-helpers';

/**
 * Integration tests for the Python example datasource.
 *
 * The main scenario ensures that the synthetic `TestMap/WayLayer` source is
 * present in `/sources` and that enabling it in the UI causes the tile stream
 * pull endpoint to become active.
 */

test.describe('Python example datasource integration', () => {
    test('TestMap/WayLayer appears in /sources and triggers tile requests', async ({ page, request }) => {
        await requireTestMapSource(request);

        const tilePullRequests: string[] = [];
        // Capture outgoing long-poll pulls for the `/tiles` stream.
        page.on('request', (req) => {
            if (req.url().includes('/tiles/next') && req.method() === 'GET') {
                tilePullRequests.push(req.url());
            }
        });

        await navigateToRoot(page);
        await enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
        await navigateToArea(page, ...TEST_VIEW_POSITIONS[0]);

        // Eventually the UI should activate the tile stream pull loop.
        await expect.poll(() => tilePullRequests.length, {
            timeout: 15000
        }).toBeGreaterThan(0);
    });
});
