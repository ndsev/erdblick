import { expect, test } from '../fixtures/test';

test.describe('/config endpoint', () => {
    test('GET /config returns model and schema', async ({ request }) => {
        const response = await request.get('/config');

        expect(response.status()).toBe(200);

        const body = await response.json();
        expect(body).toHaveProperty('model');
        expect(body).toHaveProperty('schema');
        expect(body).toHaveProperty('readOnly');
    });
});

