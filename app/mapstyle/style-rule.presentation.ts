import {StyleAuthoringSchema, StyleField} from './style-authoring-schema.adapter';
import {StyleDocumentModel, StylePath} from './style-document.model';

export const STYLE_RULE_CATEGORIES = ['Matching', 'Geometry', 'Attributes', 'Appearance',
    'Surface and drawing order', 'Offsets', 'Lines', 'Points', 'Labels', 'Relations', 'Compatibility'];
export const STYLE_RULE_STRUCTURES: Readonly<Record<string, string>> = {
    'first-of': 'First matching', 'all-of': 'All matching',
    'relation-source-style': 'Source style', 'relation-target-style': 'Target style',
    'relation-line-end-markers': 'End markers'
};
const CATEGORY_OVERRIDES: Readonly<Record<string, string>> = {
    scope: 'Matching', filter: 'Matching', geometry: 'Geometry', 'geometry-name': 'Geometry',
    'attribute-filter': 'Attributes', color: 'Appearance', 'color-expression': 'Appearance',
    'color-scale': 'Appearance', width: 'Appearance', 'width-scale': 'Appearance', opacity: 'Appearance',
    'label-text': 'Labels', 'label-text-expression': 'Labels'
};
const LABELS: Readonly<Record<string, string>> = {
    width: 'Width', type: 'Feature type', 'color-expression': 'Color expression',
    'label-text-expression': 'Label expression', ...STYLE_RULE_STRUCTURES
};

export interface StyleRuleProperty {
    key: string;
    label: string;
    category: string;
    categoryIndex: number;
    field: StyleField;
    present: boolean;
    summary: string;
}

/** Derives a stable visual order without changing source order or materializing defaults. */
export function styleRuleProperties(model: StyleDocumentModel, catalog: StyleAuthoringSchema, path: StylePath): StyleRuleProperty[] {
    const keys = new Set(model.keys(path));
    const relation = path.length === 2 && model.value([...path, 'scope']) === 'relation';
    return Object.entries(catalog.records['rule']).filter(([key, field]) => {
        if (keys.has(key)) return true;
        if (field.topLevel && path.length !== 2) return false;
        return !(relation && (key === 'first-of' || key === 'all-of'));
    }).map(([key, field]) => {
        const category = CATEGORY_OVERRIDES[key] ?? (field.group.startsWith('Label') ? 'Labels' : field.group);
        const label = LABELS[key] ?? field.label ?? key.replaceAll('-', ' ');
        return {key, field, category, categoryIndex: STYLE_RULE_CATEGORIES.indexOf(category),
            label: label.charAt(0).toUpperCase() + label.slice(1), present: keys.has(key),
            // Only property bubbles display summaries. Walking absent fields or
            // entire branch trees here multiplied alias work on every UI refresh.
            summary: keys.has(key) && !STYLE_RULE_STRUCTURES[key] ? stylePropertySummary(model, [...path, key]) : ''};
    }).sort((a, b) => a.categoryIndex - b.categoryIndex);
}

/** Formats source values for display only, retaining large integer cells and explicit empty values. */
export function stylePropertySummary(model: StyleDocumentModel, path: StylePath, depth = 0): string {
    if (depth > 3) return '…';
    if (model.isList(path)) {
        const count = model.length(path);
        const values = Array.from({length: Math.min(count, 4)}, (_, i) => stylePropertySummary(model, [...path, i], depth + 1));
        return `[${values.join(', ')}${count > 4 ? `, … (${count} items)` : ''}]`;
    }
    if (model.isRecord(path)) {
        const keys = model.keys(path);
        return keys.length ? keys.map(key => `${key}: ${stylePropertySummary(model, [...path, key], depth + 1)}`).join(' · ') : '{}';
    }
    const value = model.value(path);
    if (typeof value === 'string' && /^(?:[+-]?\d+(?:\.\d+)?|true|false|null)$/.test(value)) return JSON.stringify(value);
    return value === '' ? '""' : value === null ? 'null' : value === undefined ? '' : String(value);
}

/** Uses catalog seeds only following an explicit add/replace action. */
export function styleFieldSeed(field: StyleField, catalog: StyleAuthoringSchema, optionType?: unknown): unknown {
    if (field.seed !== undefined) return field.seed;
    switch (field.kind) {
        case 'record': return field.record === 'rule' ? {} : catalog.seeds[field.record!] ?? {};
        case 'list': case 'stops': return [];
        case 'vector': return field.sizes[0] === 0 ? 0 : Array(field.sizes[0]).fill(0);
        case 'enum': case 'enum-list': return field.values[0];
        case 'boolean': return false;
        case 'number': return 0;
        case 'color': case 'color-ref': return '#000000';
        case 'option-default': return optionType === undefined || optionType === 'bool' ? false : '';
        default: return '';
    }
}
