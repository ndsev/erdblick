import {beforeAll, describe, expect, it} from 'vitest';
import {initializeLibrary} from '../../../app/integrations/wasm.adapter';
import {styleAuthoringSchema} from '../../../app/mapstyle/style-authoring-schema.adapter';
import {StyleDocumentModel} from '../../../app/mapstyle/style-document.model';
import {StylePropertyDraft} from '../../../app/mapstyle/style-property-draft.controller';
import {styleFieldSeed} from '../../../app/mapstyle/style-rule.presentation';

describe('isolated style property draft', () => {
    beforeAll(async () => { await initializeLibrary(); });
    const source = '# Keep\nname: Test\nversion: 2\nrules:\n  - color: red # Color comment\n    width: 2\n    custom: preserved\n    all-of: [{width: 3}]\n';
    /** Creates a draft against the exact authoritative source. */
    function draft(key: string, path: (string | number)[] = ['rules', 0]): StylePropertyDraft {
        const catalog = styleAuthoringSchema();
        const field = catalog.records['rule'][key];
        return new StylePropertyDraft(new StyleDocumentModel(source), path, key, field, document.createElement('button'), styleFieldSeed(field, catalog));
    }

    it('opening and saving an unchanged field leaves the source byte-identical', () => {
        const panel = draft('width');
        expect(panel.dirty).toBe(false);
        expect(panel.commit(source)).toBe(source);
    });

    it('stages mode replacements without mutating the original or unrelated content', () => {
        const panel = draft('color-scale');
        expect(panel.isNew).toBe(true);
        expect(panel.base.source).toBe(source);
        expect(panel.base.has(['rules', 0, 'color'])).toBe(true);
        const saved = new StyleDocumentModel(panel.commit(source));
        expect(saved.has(['rules', 0, 'color'])).toBe(false);
        expect(saved.has(['rules', 0, 'color-scale'])).toBe(true);
        expect(saved.value(['rules', 0, 'custom'])).toBe('preserved');
        expect(saved.source).toContain('# Keep');
        expect(saved.value(['rules', 0, 'all-of', 0, 'width'])).toBe(3n);
    });

    it('deletes exactly the selected property rather than its category or draft siblings', () => {
        const panel = draft('width');
        panel.edit({op: 'set', path: panel.path, value: 90});
        const deleted = new StyleDocumentModel(panel.commit(source, true));
        expect(deleted.has(panel.path)).toBe(false);
        expect(deleted.value(['rules', 0, 'color'])).toBe('red');
        expect(deleted.source).toContain('# Color comment');
        expect(deleted.length(['rules', 0, 'all-of'])).toBe(1);
    });

    it('saves child fields directly without a parent transaction', () => {
        const panel = draft('width', ['rules', 0, 'all-of', 0]);
        panel.edit({op: 'set', path: panel.path, value: 4});
        const saved = new StyleDocumentModel(panel.commit(source));
        expect(saved.value(panel.path)).toBe(4n);
        expect(saved.value(['rules', 0, 'width'])).toBe(2n);
    });

    it('blocks incomplete numeric input and stale source, while allowing semantic reconciliation', () => {
        const panel = draft('width');
        panel.problems.set('rules.0.width', 'Enter a finite number.');
        expect(panel.dirty).toBe(true);
        expect(() => panel.commit(source)).toThrow('unfinished');
        panel.problems.clear();
        panel.edit({op: 'set', path: panel.path, value: -100});
        expect(panel.canSave).toBe(true);
        expect(() => panel.commit(source + '# external change\n')).toThrow('source changed');
        expect(panel.commit(source)).toContain('width: -100');
    });
});
