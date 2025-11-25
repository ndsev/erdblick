import { expect, test } from '../fixtures/test';

test.describe('mapget backend /sources', () => {
    test('GET /sources returns a JSON array', async ({ request }) => {
        const response = await request.get('/sources');

        expect(response.status()).toBe(200);

        const body = await response.json();
        expect(Array.isArray(body)).toBe(true);
    });
});

