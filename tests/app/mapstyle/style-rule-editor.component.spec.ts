import '@angular/compiler';
import {SimpleChange} from '@angular/core';
import {beforeAll, describe, expect, it} from 'vitest';
import {initializeLibrary} from '../../../app/integrations/wasm.adapter';
import {styleAuthoringSchema} from '../../../app/mapstyle/style-authoring-schema.adapter';
import {StyleDocumentModel} from '../../../app/mapstyle/style-document.model';
import {StyleRuleEditorComponent} from '../../../app/mapstyle/style-rule-editor.component';

describe('rule overview refresh', () => {
    beforeAll(async () => { await initializeLibrary(); });

    it('retains summaries across equivalent paths and refreshes changed rules and source', () => {
        const component = new StyleRuleEditorComponent();
        component.catalog = styleAuthoringSchema();
        component.model = new StyleDocumentModel('name: Test\nrules: [{width: 2}, {width: 3}]');
        component.path = ['rules', 0];
        component.ngOnChanges({model: new SimpleChange(undefined, component.model, true)});
        const properties = component.properties;
        const previousPath = component.path;
        component.path = ['rules', 0];
        component.ngOnChanges({path: new SimpleChange(previousPath, component.path, false)});
        component.ngOnChanges({draft: new SimpleChange(undefined, undefined, false)});
        expect(component.properties).toBe(properties);

        component.path = ['rules', 1];
        component.ngOnChanges({path: new SimpleChange(previousPath, component.path, false)});
        expect(component.properties.find(field => field.key === 'width')?.summary).toBe('3');
        const previousModel = component.model;
        component.model = new StyleDocumentModel('name: Test\nrules: [{width: 2}, {width: 0}]');
        component.ngOnChanges({model: new SimpleChange(previousModel, component.model, false)});
        expect(component.properties.find(field => field.key === 'width')?.summary).toBe('0');
    });
});
