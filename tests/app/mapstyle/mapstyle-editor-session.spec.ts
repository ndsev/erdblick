import '@angular/compiler';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {Subscription} from 'rxjs';
import {EditorService} from '../../../app/editor/editor.service';
import {StyleComponent} from '../../../app/mapstyle/mapstyle.component';
import {StyleDocumentModel} from '../../../app/mapstyle/style-document.model';

describe('style form source transitions', () => {
    afterEach(() => vi.useRealTimers());

    it('preserves an Advanced edit through an immediate form edit and retires the queued projection', () => {
        vi.useFakeTimers();
        // Exercise the shell session methods without bootstrapping maps or rendering services.
        const component: StyleComponent = Object.create(StyleComponent.prototype);
        const editor = new EditorService();
        Object.assign(component, {
            styleEditorSessionId: 'style-editor', editorService: editor,
            styleService: {state: {styleEditorTargetId: 'Original'}},
            mapInfoService: {maps: {allFeatureLayers: () => []}},
            ngZone: {runOutsideAngular: (callback: () => void) => callback()},
            changeDetector: {detectChanges: vi.fn()},
            styleEditorSourceSubscription: new Subscription(), styleEditorSaveSubscription: new Subscription()
        });
        component['prepareStyleEditorSource']('name: Original\nrules: [{width: 2}]\n');
        component.onStyleEditorTabChange('advanced');
        editor.updateSessionSource('style-editor', 'name: From Advanced\nrules: [{width: 2}]\n');
        component.onStyleEditorTabChange('rules');
        const updated = new StyleDocumentModel(component.quickSource).edit({op: 'set', path: ['rules', 0, 'width'], value: 3});
        component['commitQuickSource'](updated);
        vi.advanceTimersByTime(200);
        expect(editor.getSessionSource('style-editor')).toBe(updated);
        expect(component.quickSource).toBe(updated);
        expect(component.quickStyleName).toBe('From Advanced');
        expect(new StyleDocumentModel(updated).value(['rules', 0, 'width'])).toBe(3n);

        component.propertyPanelDirty = true;
        component.onStyleEditorTabChange('metadata');
        expect(component.styleEditorTab).toBe('rules');
        component.propertyPanelDirty = false;
        component.onStyleEditorTabChange('metadata');
        expect(component.styleEditorTab).toBe('metadata');
        component.styleEditorSourceSubscription.unsubscribe();
        component.styleEditorSaveSubscription.unsubscribe();
        editor.closeSession('style-editor');
    });
});
