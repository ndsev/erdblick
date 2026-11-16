import '@angular/compiler';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {of, Subject} from 'rxjs';
import {DatasourcesComponent} from '../../../app/mapdata/datasources.component';
import {AdvancedPreferencesComponent} from '../../../app/preferences/advanced-preferences.component';
import {EditorService} from '../../../app/editor/editor.service';
import {EditorDocumentRef} from '../../../app/editor/editor-document.model';
import {stateOwners, testPersistence} from '../../support/state-owners';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(dispose => dispose()); });

/** Supplies document commands without mounting dialog chrome. */
function documentRef(kind: 'datasources' | 'preferences'): EditorDocumentRef {
    return {id: kind, descriptor: {id: kind, kind}, changed: vi.fn(), close: vi.fn(), rename: vi.fn(), conflictingEditors: vi.fn(() => [])};
}

/** Uses a delayed HTTP acknowledgement to exercise configuration write races. */
function datasource(readOnly = false, hidden = false) {
    const editors = new EditorService(), document = documentRef('datasources'), response = new Subject<string>();
    const http = {get: vi.fn(() => of({model: {sources: []}, schema: {}, readOnly, datasourceConfigUnavailable: hidden})), post: vi.fn(() => response)};
    const maps = {reloadDataSources: vi.fn(async () => {})};
    const component = new DatasourcesComponent(document, editors, http as never, maps as never);
    component.ngOnInit(); cleanup.push(() => component.ngOnDestroy());
    return {component, editors, document, response, http, maps};
}

describe('Editor document save boundaries', () => {
    it('keeps newer datasource input dirty after the submitted source is acknowledged', async () => {
        const {component, editors, response, maps, http} = datasource();
        const source = '{"sources":[]}\n', newer = source + ' ';
        editors.updateSessionSource('datasources', source);
        const saving = component.save();
        expect(component.busy).toBe(true);
        editors.updateSessionSource('datasources', newer);
        response.next('Saved'); response.complete();
        expect(await saving).toBe(true);
        expect(http.post).toHaveBeenCalledWith('config', source, {responseType: 'text'});
        expect(maps.reloadDataSources).toHaveBeenCalledOnce();
        expect(component.dirty).toBe(true);
        expect(editors.getSessionSource('datasources')).toBe(newer);
    });

    it('retains a datasource draft after a failed write and refuses another in-flight save', async () => {
        const {component, editors, response, maps, http} = datasource();
        editors.updateSessionSource('datasources', '{"sources":[]}');
        const saving = component.save();
        expect(await component.save()).toBe(false);
        response.error(new Error('write failed'));
        expect(await saving).toBe(false);
        expect(component.dirty).toBe(true);
        expect(component.busy).toBe(false);
        expect(component.error).toContain('retained');
        expect(maps.reloadDataSources).not.toHaveBeenCalled();
        expect(http.post).toHaveBeenCalledOnce();
    });

    it.each([[true, false], [true, true]])('blocks writes to read-only datasource capability (hidden=%s/%s)', (readOnly, hidden) => {
        const {component, editors, http} = datasource(readOnly, hidden);
        editors.updateSessionSource('datasources', '{"sources":[]}');
        expect(component.saveEnabled).toBe(false);
        void component.save();
        expect(http.post).not.toHaveBeenCalled();
    });

    it('keeps hidden-but-writable datasource capability and explains full replacement', () => {
        const {component, editors} = datasource(false, true);
        expect(component.hiddenWritable).toBe(true);
        editors.updateSessionSource('datasources', '{"sources":[]}');
        expect(component.saveEnabled).toBe(true);
    });

    it('requires a fresh review when live preferences change again after a stale-snapshot warning', async () => {
        const persistence = testPersistence(), owners = stateOwners(persistence), editors = new EditorService();
        const document = documentRef('preferences');
        const component = new AdvancedPreferencesComponent(document, persistence, editors);
        component.ngOnInit(); cleanup.push(() => {component.ngOnDestroy(); persistence.ngOnDestroy();});
        editors.updateSessionSource('preferences', '{"dockWidth":500}');
        owners.layout.state.dockWidthState.next(600);
        expect(await component.save()).toBe(false);
        expect(component.saveLabel).toBe('Apply reviewed snapshot');
        owners.layout.state.dockWidthState.next(700);
        expect(await component.save()).toBe(false);
        expect(owners.layout.state.dockWidthState.getValue()).toBe(700);
        expect(await component.save()).toBe(true);
        expect(owners.layout.state.dockWidthState.getValue()).toBe(500);
        expect(component.dirty).toBe(false);
    });
});
