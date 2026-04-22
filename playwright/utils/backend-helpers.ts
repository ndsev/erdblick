import type {APIRequestContext} from '@playwright/test';
import {expect} from '../fixtures/test';
import { TEST_LAYER_NAMES, TEST_MAP_NAMES } from './test-params';

/**
 * Helper utilities for talking to the `mapget` backend directly via the
 * Playwright `APIRequestContext`.
 *
 * These functions are used from tests and UI helpers to assert that the test
 * `TestMap/WayLayer` datasource is available before exercising UI flows.
 */

/**
 * Fetches `/sources` and returns the decoded JSON array of sources.
 *
 * The helper asserts a `200` HTTP status code and normalises non-array
 * payloads to an empty array so callers do not have to handle unexpected
 * shapes.
 */
export async function getSources(request: APIRequestContext): Promise<any[]> {
    const response = await request.get('/sources');
    // The integration backend is expected to expose `/sources`.
    expect(response.status()).toBe(200);
    const body = await response.json();
    // Normalise unexpected payloads to an empty array to simplify callers.
    return Array.isArray(body) ? body : [];
}

function hasLayerEntry(source: any, layerId: string): boolean {
    if (!source || !source.layers) {
        return false;
    }
    const layers = source.layers as any;
    if (typeof layers === 'object' && layers !== null) {
        if (layers[layerId]) {
            return true;
        }
        try {
            return Object.values(layers).some((layer: any) => layer && layer.layerId === layerId);
        } catch {
            return false;
        }
    }
    return false;
}

/**
 * Asserts that a source entry for the requested map/layer exists in `/sources`
 * and returns it.
 */
export async function requireMapSource(request: APIRequestContext, mapId: string, layerId: string): Promise<any | null> {
    const sources = await getSources(request);
    const found =
        sources.find((s: any) => s && s.mapId === mapId && hasLayerEntry(s, layerId)) ?? null;
    expect(found, `Expected /sources to contain ${mapId}/${layerId}`).toBeTruthy();
    return found;
}

/**
 * Looks up the synthetic `TestMap` sources entry in `/sources` output and
 * returns it, or `null` when it cannot be found.
 *
 * Many tests use this helper to guard against misconfigured integration
 * environments before interacting with the UI.
 */
export async function requireTestMapSource(request: APIRequestContext): Promise<any | null> {
    return requireMapSource(request, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
}
