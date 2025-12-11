import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
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
                if (body && body.includes('"mapId":"TestMap"')) {
                    tileRequests.push(req.url());
                }
            }
        });

        await enableMapLayer(page, 'TestMap', 'WayLayer');
        await navigateToArea(page, 42.5, 11.65, 10);

        // Eventually the UI should have issued at least one TestMap tile request.
        await expect.poll(() => tileRequests.length, {
            timeout: 15000
        }).toBeGreaterThan(0);
    });
});
