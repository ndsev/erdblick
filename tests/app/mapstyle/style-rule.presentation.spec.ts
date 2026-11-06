import {beforeAll, describe, expect, it} from 'vitest';
import {initializeLibrary} from '../../../app/integrations/wasm.adapter';
import {styleAuthoringSchema} from '../../../app/mapstyle/style-authoring-schema.adapter';
import {StyleDocumentModel} from '../../../app/mapstyle/style-document.model';
import {STYLE_RULE_CATEGORIES, STYLE_RULE_STRUCTURES, stylePropertySummary, styleRuleProperties} from '../../../app/mapstyle/style-rule.presentation';

describe('rule bubble presentation', () => {
    beforeAll(async () => { await initializeLibrary(); });

    it('covers every native field once without hiding false, zero, null or empty values', () => {
        const catalog = styleAuthoringSchema();
        const model = new StyleDocumentModel("name: Test\nrules: [{selectable: false, opacity: 0, label-text: '', color: null}]\n");
        const fields = styleRuleProperties(model, catalog, ['rules', 0]);
        expect(new Set(fields.map(field => field.key)).size).toBe(Object.keys(catalog.records['rule']).length);
        expect(fields.filter(field => field.present).map(field => field.key)).toEqual(['selectable', 'color', 'opacity', 'label-text']);
        for (const field of fields) expect(!!STYLE_RULE_STRUCTURES[field.key] || STYLE_RULE_CATEGORIES.includes(field.category)).toBe(true);
    });

    it('keeps categories and ordering stable across source order and values', () => {
        const catalog = styleAuthoringSchema();
        const first = new StyleDocumentModel('name: Test\nrules: [{width: 2, color: red, filter: foo}]');
        const second = new StyleDocumentModel('name: Test\nrules: [{filter: bar, color: blue, width: 3}]');
        const project = (model: StyleDocumentModel) => styleRuleProperties(model, catalog, ['rules', 0])
            .filter(field => field.present).map(({key, categoryIndex}) => [key, categoryIndex]);
        expect(project(first)).toEqual(project(second));
        expect(project(first).map(entry => entry[0])).toEqual(['filter', 'color', 'width']);
    });

    it('retains invalid configured fields while withholding illegal additions', () => {
        const catalog = styleAuthoringSchema();
        const model = new StyleDocumentModel('name: Test\nrules: [{scope: relation, first-of: [{scope: attribute}]}]');
        const root = styleRuleProperties(model, catalog, ['rules', 0]);
        expect(root.some(field => field.key === 'first-of')).toBe(true);
        expect(root.some(field => field.key === 'all-of')).toBe(false);
        const child = styleRuleProperties(model, catalog, ['rules', 0, 'first-of', 0]);
        expect(child.some(field => field.key === 'scope')).toBe(true);
        expect(child.some(field => field.key === 'fidelity')).toBe(false);
    });

    it('does not round int64 cells when summarizing composites', () => {
        const model = new StyleDocumentModel('name: Test\nrules: [{color-scale: {stops: [[9223372036854775807, red], ["1", blue]]}}]');
        expect(stylePropertySummary(model, ['rules', 0, 'color-scale'])).toContain('9223372036854775807');
    });

    it('summarizes displayed values without traversing branch contents or absent properties', () => {
        const model = new StyleDocumentModel('name: Test\nrules: [{width: 0, first-of: &branches [{first-of: *branches}]}]');
        const fields = styleRuleProperties(model, styleAuthoringSchema(), ['rules', 0]);
        expect(fields.filter(field => field.summary).map(field => [field.key, field.summary])).toEqual([['width', '0']]);
        expect(fields.find(field => field.key === 'first-of')?.present).toBe(true);
    });
});
