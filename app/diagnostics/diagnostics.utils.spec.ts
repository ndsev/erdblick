import {describe, expect, it} from 'vitest';
import {buildPerfTreeNodes, computeSuspiciousLevel, parsePerfUnit, splitPerfPath} from './diagnostics.utils';

const sampleStats = [
    {
        key: 'Rendering/Feature-Model-Parsing#ms',
        path: ['Rendering', 'Feature-Model-Parsing'],
        peak: 120,
        average: 60
    },
    {
        key: 'Size/Tile-Blob#kb',
        path: ['Size', 'Tile-Blob'],
        peak: 600,
        average: 300
    }
];

describe('diagnostics utils', () => {
    it('parses perf units from keys', () => {
        expect(parsePerfUnit('Rendering/Feature-Model-Parsing#ms')).toBe('ms');
        expect(parsePerfUnit('Size/Tile-Blob#kb')).toBe('KB');
        expect(parsePerfUnit('Cache/Hit-Rate#%')).toBe('%');
        expect(parsePerfUnit('Errors/Decode#count')).toBe('count');
    });

    it('splits perf paths and strips unit suffixes', () => {
        expect(splitPerfPath('Rendering/Feature-Model-Parsing#ms')).toEqual(['Rendering', 'Feature-Model-Parsing']);
        expect(splitPerfPath('Cache/Hit-Rate#%')).toEqual(['Cache', 'Hit-Rate']);
    });

    it('builds perf tree nodes with leaf values', () => {
        const nodes = buildPerfTreeNodes(sampleStats as any);
        const rendering = nodes.find(node => node.data?.key === 'Rendering');
        const size = nodes.find(node => node.data?.key === 'Size');

        expect(rendering).toBeDefined();
        expect(size).toBeDefined();
        expect(rendering?.children?.[0].data?.peak).toBe(120);
        expect(rendering?.children?.[0].data?.unit).toBe('ms');
        expect(size?.children?.[0].data?.unit).toBe('KB');
    });

    it('computes suspicious levels by unit', () => {
        const msStat = {key: 'Render#ms', path: ['Render'], peak: 250};
        const kbStat = {key: 'Size#kb', path: ['Size'], peak: 1200};
        const pctStat = {key: 'Cache#%', path: ['Cache'], peak: 40};

        expect(computeSuspiciousLevel(msStat as any, 'ms')).toBe('bad');
        expect(computeSuspiciousLevel(kbStat as any, 'KB')).toBe('bad');
        expect(computeSuspiciousLevel(pctStat as any, '%')).toBe('bad');
    });
});
