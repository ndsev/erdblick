import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '../fixtures/test';

export async function getSources(request: APIRequestContext): Promise<any[]> {
    const response = await request.get('/sources');
    expect(response.status()).toBe(200);
    const body = await response.json();
    return Array.isArray(body) ? body : [];
}

export async function requireTropicoSource(request: APIRequestContext): Promise<any | null> {
    const sources = await getSources(request);
    const tropico = sources.find(
        (s: any) => s && s.mapId === 'Tropico' && s.layers && s.layers.WayLayer
    );

    if (!tropico) {
        test.skip('Tropico HTTP sample datasource is not available in /sources');
        return null;
    }

    return tropico;
}

