import '@angular/compiler';
import {beforeAll, describe, expect, it, vi, afterEach} from 'vitest';
import {ConfirmationService} from 'primeng/api';
import {AppConfirmPopupService} from '../../../app/alert/app-confirm-popup.service';
import {initializeLibrary} from '../../../app/integrations/wasm.adapter';
import {StyleDocumentEditorComponent} from '../../../app/mapstyle/style-document-editor.component';

describe('document property panel lifecycle', () => {
    beforeAll(async () => { await initializeLibrary(); });
    afterEach(() => { vi.useRealTimers(); });
    const source = 'name: Test\nversion: 2\nrules: [{geometry: line, width: 2, all-of: [{width: 3}]}]\n';
    /** Creates a local editor with no persisted style service or rendering dependencies. */
    function editor(): StyleDocumentEditorComponent {
        vi.useFakeTimers();
        const component = new StyleDocumentEditorComponent(new AppConfirmPopupService(new ConfirmationService()));
        component.source = source;
        component.ngOnChanges();
        return component;
    }
    /** Opens a field at the selected rule depth. */
    function open(component: StyleDocumentEditorComponent, path: (string | number)[], key: string): void {
        component.onRuleAction({kind: 'open', path, key, target: document.createElement('button')});
    }

    it('dismisses invalid input and nested edits without publishing any source', () => {
        const component = editor();
        const publish = vi.fn();
        component.sourceChange.subscribe(publish);
        open(component, ['rules', 0, 'all-of', 0], 'width');
        component.onRuleAction({kind: 'draft-edit', edit: {op: 'set', path: ['rules', 0, 'all-of', 0, 'width'], value: 8}});
        component.onRuleAction({kind: 'problem', path: 'rules.0.all-of.0.width', message: 'Unfinished input'});
        component.dismissPanel(false);
        expect(component.source).toBe(source);
        expect(component.draft).toBeUndefined();
        expect(publish).not.toHaveBeenCalled();
        component.ngOnDestroy();
    });

    it('blocks conflicting operations while dirty and publishes precisely once on Save', () => {
        const component = editor();
        const publish = vi.fn();
        component.sourceChange.subscribe(publish);
        open(component, ['rules', 0], 'width');
        component.onRuleAction({kind: 'draft-edit', edit: {op: 'set', path: ['rules', 0, 'width'], value: 9}});
        open(component, ['rules', 0], 'geometry');
        component.onRuleAction({kind: 'edit', edit: {op: 'remove', path: ['rules', 0]}});
        expect(component.draft?.key).toBe('width');
        expect(component.source).toBe(source);
        component.savePanel();
        expect(publish).toHaveBeenCalledTimes(1);
        expect(component.model?.value(['rules', 0, 'width'])).toBe(9n);
        expect(component.draft).toBeUndefined();
        component.ngOnDestroy();
    });

    it('keeps stale drafts visible but refuses to overwrite external source', () => {
        const component = editor();
        open(component, ['rules', 0], 'width');
        component.source = source + '# newer source\n';
        component.ngOnChanges();
        component.savePanel();
        expect(component.draft?.error).toContain('source changed');
        expect(component.source).toContain('# newer source');
        component.ngOnDestroy();
    });
});
