import { expect, test } from '../fixtures/test';
import { requireTropicoSource } from '../utils/backend-helpers';
import { enableMapLayer, navigateToRoot } from '../utils/ui-helpers';

test.describe('Tropico HTTP datasource integration', () => {
    test('Tropico/WayLayer appears in /sources and triggers tile requests', async ({ page, request }) => {
        await requireTropicoSource(request);

        await navigateToRoot(page);

        const tropicoTileRequests: string[] = [];
        page.on('request', (req) => {
            if (req.url().endsWith('/tiles') && req.method() === 'POST') {
                const body = req.postData();
                if (body && body.includes('"mapId":"Tropico"')) {
                    tropicoTileRequests.push(req.url());
                }
            }
        });

        await enableMapLayer(page, 'Tropico', 'WayLayer');

        await expect.poll(() => tropicoTileRequests.length, {
            timeout: 15000
        }).toBeGreaterThan(0);
    });
});
