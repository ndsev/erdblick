import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '../fixtures/test';

export async function getSources(request: APIRequestContext): Promise<any[]> {
    const response = await request.get('/sources');
    expect(response.status()).toBe(200);
    const body = await response.json();
    return Array.isArray(body) ? body : [];
}

export async function requireTestMapSource(request: APIRequestContext): Promise<any | null> {
    const sources = await getSources(request);
    const testMap = sources.find(
        (s: any) => s && s.mapId === 'TestMap' && s.layers && s.layers.WayLayer
    );

    if (!testMap) {
        test.skip('Python example datasource (TestMap/WayLayer) is not available in /sources');
        return null;
    }

    return testMap;
}
