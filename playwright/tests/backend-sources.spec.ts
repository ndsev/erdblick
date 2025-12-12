import { expect, test } from '../fixtures/test';

/**
 * Smoke tests for the `mapget` `/sources` endpoint using Playwright's
 * `APIRequestContext`. This verifies that the integration datasource is
 * discoverable before running more elaborate UI flows.
 */

test.describe('mapget backend /sources', () => {
    test('GET /sources returns a JSON array', async ({ request }) => {
        // Use the shared API client to hit the backend directly.
        const response = await request.get('/sources');

        expect(response.status()).toBe(200);

        // The backend should always expose `/sources` as a JSON array.
        const body = await response.json();
        expect(Array.isArray(body)).toBe(true);
    });
});
