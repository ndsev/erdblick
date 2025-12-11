import { expect, test } from '../fixtures/test';

/**
 * Integration tests for the optional `/config` endpoint exposed by `mapget`.
 *
 * Some builds do not provide this endpoint (404); in that case the test suite
 * skips this spec. When available, we validate that the response contains the
 * expected configuration model, schema and read-only flag.
 */

test.describe('/config endpoint', () => {
    test('GET /config returns model and schema', async ({ request }) => {
        const response = await request.get('/config');

        const status = response.status();
        if (status === 404) {
            // `/config` is an optional endpoint; skip rather than fail.
            test.skip('/config endpoint is not available in this mapget build');
        }
        expect(status).toBe(200);

        // The configuration response must expose basic metadata fields.
        const body = await response.json();
        expect(body).toHaveProperty('model');
        expect(body).toHaveProperty('schema');
        expect(body).toHaveProperty('readOnly');
    });
});
