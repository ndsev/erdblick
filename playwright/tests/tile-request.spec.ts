import { expect, test } from '../fixtures/test';
import { requireTestMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAMES, TEST_MAP_NAMES, TEST_VIEW_POSITIONS } from '../utils/test-params';
import {enableMapLayer, navigateToArea, navigateToRoot} from '../utils/ui-helpers';

/**
 * Integration tests for the configured native or Python example datasource.
 *
 * The main scenario ensures that the configured synthetic map/layer is present
 * in `/sources` and enabling it causes real subset delivery. TestMap/WayLayer is
 * the default; the ordinary test-map/layer environment overrides also apply.
 */

test.describe('Interactive tile transport', () => {
    test('announces a fresh UUID before requests and accepts both payload routes', async ({page}) => {
        await navigateToRoot(page);
        const observed = await page.evaluate(async () => {
            /** Opens a real idle connection; deliberately sends no tile request. */
            function connect() {
                return new Promise<{socket: WebSocket; clientId: string; requestId: number}>((resolve, reject) => {
                    const url = new URL('/interactive', location.href);
                    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
                    const socket = new WebSocket(url);
                    socket.binaryType = 'arraybuffer';
                    const timeout = setTimeout(() => { socket.close(); reject(new Error('No initial request context')); }, 5000);
                    socket.onerror = () => { clearTimeout(timeout); reject(new Error('Interactive socket failed')); };
                    socket.onmessage = event => {
                        const bytes = new Uint8Array(event.data);
                        for (let offset = 0; offset + 11 <= bytes.length;) {
                            const size = new DataView(bytes.buffer).getUint32(offset + 7, true);
                            if (offset + 11 + size > bytes.length) break;
                            if (bytes[offset + 6] === 6) {
                                const context = JSON.parse(new TextDecoder().decode(bytes.subarray(offset + 11, offset + 11 + size)));
                                clearTimeout(timeout);
                                resolve({socket, clientId: context.clientId, requestId: context.requestId});
                                return;
                            }
                            offset += 11 + size;
                        }
                    };
                });
            }
            const first = await connect();
            const pulls = [];
            try {
                for (const endpoint of ['/interactive/payload', '/tiles/next']) {
                    const url = new URL(endpoint, location.href);
                    url.search = new URLSearchParams({clientId: first.clientId, waitMs: '0', maxBytes: '65536', compress: '0'}).toString();
                    const response = await fetch(url);
                    pulls.push({status: response.status, cacheControl: response.headers.get('cache-control')});
                    await response.arrayBuffer();
                }
            } finally {
                first.socket.close();
            }
            const second = await connect();
            second.socket.close();
            return {first: first.clientId, second: second.clientId, requestId: first.requestId, pulls};
        });
        expect(observed.first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(observed.requestId).toBe(0);
        expect(observed.second).not.toBe(observed.first);
        expect(observed.pulls.map(pull => pull.status)).toEqual([204, 204]);
        expect(observed.pulls.every(pull => pull.cacheControl?.includes('no-store'))).toBe(true);
    });

    test('the configured layer appears in /sources and triggers tile requests', async ({ page, request }) => {
        await requireTestMapSource(request);

        const tilePullRequests: string[] = [];
        const frameTypes: number[] = [];
        // Capture outgoing long-poll pulls for the interactive stream.
        page.on('request', (req) => {
            if (req.url().includes('/interactive/payload') && req.method() === 'GET') {
                tilePullRequests.push(req.url());
            }
        });
        page.on('response', async response => {
            if (!response.url().includes('/interactive/payload') || response.status() !== 200) return;
            const bytes = await response.body().catch(() => Buffer.alloc(0));
            for (let offset = 0; offset + 11 <= bytes.length;) {
                const size = bytes.readUInt32LE(offset + 7);
                if (offset + 11 + size > bytes.length) break;
                frameTypes.push(bytes[offset + 6]);
                offset += 11 + size;
            }
        });

        await navigateToRoot(page);
        await enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
        await navigateToArea(page, ...TEST_VIEW_POSITIONS[0]);

        // Eventually the UI should activate the tile stream pull loop.
        await expect.poll(() => tilePullRequests.length, {
            timeout: 15000
        }).toBeGreaterThan(0);
        expect(new URL(tilePullRequests[0]).searchParams.get('clientId'))
            .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        // Exercise actual transport, not just a request against a missing session.
        await expect.poll(() => frameTypes.includes(7), {timeout: 15000}).toBe(true);
        expect(frameTypes.indexOf(1)).toBeGreaterThanOrEqual(0);
        expect(frameTypes.indexOf(1)).toBeLessThan(frameTypes.indexOf(7));
    });
});
