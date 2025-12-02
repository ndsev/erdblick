import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import {enableMapLayer, navigateToArea, navigateToRoot} from '../utils/ui-helpers';

test.describe('Python example datasource integration', () => {
    test('TestMap/WayLayer appears in /sources and triggers tile requests', async ({ page, request }) => {
        await requireTestMapSource(request);

        await navigateToRoot(page);

        const tileRequests: string[] = [];
        page.on('request', (req) => {
            if (req.url().endsWith('/tiles') && req.method() === 'POST') {
                const body = req.postData();
                if (body && body.includes('"mapId":"TestMap"')) {
                    tileRequests.push(req.url());
                }
            }
        });

        await enableMapLayer(page, 'TestMap', 'WayLayer');
        await navigateToArea(page, 42.5, 11.615, 10);

        await expect.poll(() => tileRequests.length, {
            timeout: 15000
        }).toBeGreaterThan(0);
    });
});
