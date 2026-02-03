import type {TreeTableNode} from 'primeng/api';
import {PerfStat, SuspiciousLevel} from './diagnostics.model';

const UNIT_SUFFIXES: Array<{suffix: string; unit: string}> = [
    {suffix: '#ms', unit: 'ms'},
    {suffix: '-ms', unit: 'ms'},
    {suffix: '#kb', unit: 'KB'},
    {suffix: '-kb', unit: 'KB'},
    {suffix: '#mb', unit: 'MB'},
    {suffix: '-mb', unit: 'MB'},
    {suffix: '#pct', unit: '%'},
    {suffix: '-pct', unit: '%'},
    {suffix: '#%', unit: '%'},
    {suffix: '-%', unit: '%'},
    {suffix: '#count', unit: 'count'},
    {suffix: '-count', unit: 'count'}
];

export const parsePerfUnit = (key: string): string | undefined => {
    const lower = key.toLowerCase();
    for (const entry of UNIT_SUFFIXES) {
        if (lower.endsWith(entry.suffix)) {
            return entry.unit;
        }
    }
    return undefined;
};

export const stripPerfUnitSuffix = (key: string): string => {
    const lower = key.toLowerCase();
    for (const entry of UNIT_SUFFIXES) {
        if (lower.endsWith(entry.suffix)) {
            return key.slice(0, key.length - entry.suffix.length);
        }
    }
    return key;
};

export const splitPerfPath = (key: string): string[] => {
    const cleaned = stripPerfUnitSuffix(key);
    return cleaned.split('/').map(segment => segment.trim()).filter(Boolean);
};

export const computeSuspiciousLevel = (stat: PerfStat, unit?: string): SuspiciousLevel | undefined => {
    if (stat.suspicious && stat.suspicious !== 'ok') {
        return stat.suspicious;
    }

    const resolvedUnit = unit ?? stat.unit;
    const keyLower = stat.key.toLowerCase();
    const peak = stat.peak ?? 0;
    const average = stat.average ?? 0;

    if (keyLower.includes('error') && (peak > 0 || average > 0)) {
        return 'bad';
    }

    if (resolvedUnit === 'ms') {
        if (peak > 200) {
            return 'bad';
        }
        if (peak > 50) {
            return 'warn';
        }
    }

    if (resolvedUnit === 'KB') {
        if (peak > 1024) {
            return 'bad';
        }
        if (peak > 256) {
            return 'warn';
        }
    }

    if (resolvedUnit === '%') {
        if (peak < 50) {
            return 'bad';
        }
        if (peak < 90) {
            return 'warn';
        }
    }

    return undefined;
};

export const buildPerfTreeNodes = (stats: PerfStat[]): TreeTableNode[] => {
    const rootNodes: TreeTableNode[] = [];
    const nodeLookup = new Map<string, TreeTableNode>();

    const ensureNode = (pathKey: string, label: string, parent?: TreeTableNode): TreeTableNode => {
        const existing = nodeLookup.get(pathKey);
        if (existing) {
            return existing;
        }
        const node: TreeTableNode = {
            data: {
                key: label
            },
            children: []
        };
        nodeLookup.set(pathKey, node);
        if (parent) {
            parent.children = parent.children ?? [];
            parent.children.push(node);
        } else {
            rootNodes.push(node);
        }
        return node;
    };

    stats.forEach(stat => {
        const path = stat.path && stat.path.length ? stat.path : splitPerfPath(stat.key);
        if (!path.length) {
            return;
        }

        let parent: TreeTableNode | undefined;
        let currentPath = '';
        path.forEach((segment, index) => {
            currentPath = currentPath ? `${currentPath}/${segment}` : segment;
            const node = ensureNode(currentPath, segment, parent);
            if (index === path.length - 1) {
                const unit = stat.unit ?? parsePerfUnit(stat.key);
                node.data = {
                    key: segment,
                    peak: stat.peak,
                    average: stat.average,
                    unit,
                    peakTileIds: stat.peakTileIds?.join(', '),
                    suspicious: computeSuspiciousLevel(stat, unit)
                };
            }
            parent = node;
        });
    });

    const sortNodes = (nodes: TreeTableNode[]) => {
        nodes.sort((a, b) => String(a.data?.key ?? '').localeCompare(String(b.data?.key ?? '')));
        nodes.forEach(node => {
            if (node.children && node.children.length) {
                sortNodes(node.children);
            }
        });
    };

    sortNodes(rootNodes);
    return rootNodes;
};
