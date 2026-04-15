import {describe, expect, it} from 'vitest';
import {MapTileStreamClient} from './tilestream';

describe('MapTileStreamClient', () => {
    it('grows the /tiles/next batch budget without shrinking it on slow samples', () => {
        const client = new MapTileStreamClient('/tiles');
        const tileStream = client as any;
        try {
            expect(tileStream.currentPullMaxBytes()).toBe(512 * 1024);

            tileStream.recordDownstreamSample(1024, 1000);
            expect(tileStream.currentPullMaxBytes()).toBe(512 * 1024);

            tileStream.recordDownstreamSample(100 * 1024 * 1024, 1000);
            const grownBudget = tileStream.currentPullMaxBytes();
            expect(grownBudget).toBeGreaterThan(512 * 1024);

            tileStream.recordDownstreamSample(1024, 1000);
            expect(tileStream.currentPullMaxBytes()).toBe(grownBudget);

            tileStream.recordDownstreamSample(512 * 1024 * 1024, 1000);
            expect(tileStream.currentPullMaxBytes()).toBe(64 * 1024 * 1024);
        } finally {
            client.destroy();
        }
    });
});
