import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAME, TEST_MAP_NAME, TEST_VIEW_POSITION } from '../utils/test-params';
import {enableMapLayer, navigateToArea, navigateToRoot} from '../utils/ui-helpers';

/**
 * Integration tests for the Python example datasource.
 *
 * The main scenario ensures that the synthetic `TestMap/WayLayer` source is
 * present in `/sources` and that enabling it in the UI causes POST `/tiles`
 * requests that reference `TestMap` to be issued.
 */

test.describe('Python example datasource integration', () => {
    test('TestMap/WayLayer appears in /sources and triggers tile requests', async ({ page, request }) => {
        await requireTestMapSource(request);

        await navigateToRoot(page);

        const tileRequests: string[] = [];
        // Capture outgoing POST `/tiles` requests that reference `TestMap`.
        page.on('request', (req) => {
            if (req.url().endsWith('/tiles') && req.method() === 'POST') {
                const body = req.postData();
                if (body && body.includes(`\"mapId\":\"${TEST_MAP_NAME}\"`)) {
                    tileRequests.push(req.url());
                }
            }
        });

        await enableMapLayer(page, TEST_MAP_NAME, TEST_LAYER_NAME);
        await navigateToArea(page, ...TEST_VIEW_POSITION);

        // Eventually the UI should have issued at least one TestMap tile request.
        await expect.poll(() => tileRequests.length, {
            timeout: 15000
        }).toBeGreaterThan(0);
    });
});
