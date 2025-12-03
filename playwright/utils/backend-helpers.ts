import type {APIRequestContext} from '@playwright/test';
import {expect} from '../fixtures/test';

export async function getSources(request: APIRequestContext): Promise<any[]> {
    const response = await request.get('/sources');
    expect(response.status()).toBe(200);
    const body = await response.json();
    return Array.isArray(body) ? body : [];
}

export async function requireTestMapSource(request: APIRequestContext): Promise<any | null> {
    const sources = await getSources(request);
    return sources.find(
        (s: any) => s && s.mapId === 'TestMap' && s.layers && s.layers.WayLayer
    );
}
