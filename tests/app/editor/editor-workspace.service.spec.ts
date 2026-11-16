import '@angular/compiler';
import {ComponentRef} from '@angular/core';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {EditorWorkspaceService} from '../../../app/editor/editor-workspace.service';
import {EDITOR_PRESENTATION_RESET_EVENT, EditorDocumentController} from '../../../app/editor/editor-document.model';
import {stateOwners, testPersistence} from '../../support/state-owners';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(dispose => dispose()); });

/** Constructs real state owners with inert Angular view ownership for lifecycle tests. */
function workspace() {
    const persistence = testPersistence(), owners = stateOwners(persistence);
    const app = {detachView: vi.fn(), attachView: vi.fn()};
    const service = new EditorWorkspaceService(owners.editors, owners.layout, persistence,
        owners.styleService.state, app as never, {} as never, {} as never);
    service.initialize({} as never);
    cleanup.push(() => { service.ngOnDestroy(); persistence.ngOnDestroy(); });
    return {service, owners, persistence, app};
}

/** Supplies a controllable document whose async saves exercise actual workspace close logic. */
function controller(dirty = true): EditorDocumentController & {dirty: boolean; busy: boolean} {
    return {title: 'Draft', dirty, busy: false, saveLabel: 'Save', saveEnabled: true, error: '', save: vi.fn(async () => false)};
}

describe('Editor workspace document lifetime', () => {
    it('deduplicates a document while allowing two styles and every configuration editor', () => {
        const {service, persistence} = workspace();
        const first = service.open('style', 'A', '/styles/a.yaml');
        service.open('style', 'B', '/styles/b.yaml');
        service.open('presets'); service.open('datasources'); service.open('preferences');
        expect(service.open('style', 'A')).toBe(first);
        expect(service.entries).toHaveLength(5);
        const snapshot = persistence.exportSnapshot();
        expect(snapshot['editorDocuments']).toHaveLength(5);
        expect(JSON.stringify(snapshot['editorDocuments'])).not.toContain('source$');
    });

    it('moves retained content and ignores teardown of an obsolete slot', () => {
        const {service} = workspace(), entry = service.open('style', 'A');
        const doc = controller();
        entry.host = document.createElement('div');
        entry.host.textContent = 'unfinished input';
        entry.content = {instance: doc, hostView: {}, destroy: vi.fn()} as never;
        const first = document.createElement('div'), second = document.createElement('div');
        service.attach(entry, first);
        service.dock(entry, true);
        service.attach(entry, second);
        service.detach(entry, first);
        expect(second.firstChild).toBe(entry.host);
        expect((entry.content as ComponentRef<EditorDocumentController>).instance).toBe(doc);
        service.dock(entry, false);
        service.attach(entry, first);
        expect(first.textContent).toBe('unfinished input');
    });

    it('retains failed saves and later changes instead of closing the selected document', async () => {
        const {service} = workspace(), first = service.open('style', 'A'), second = service.open('style', 'B');
        const doc = controller(); first.content = {instance: doc, hostView: {}, destroy: vi.fn()} as never;
        service.requestClose(first);
        await service.saveAndClose();
        expect(service.entries).toEqual([first, second]);
        doc.save = vi.fn(async () => true);
        await service.saveAndClose();
        expect(service.entries).toContain(first); // Success must not discard text typed during the save.
        doc.dirty = false;
        await service.saveAndClose();
        expect(service.entries).toEqual([second]);
    });

    it('does not discard an unresolved write', () => {
        const {service} = workspace(), entry = service.open('datasources');
        const doc = controller(); doc.busy = true;
        entry.content = {instance: doc, hostView: {}, destroy: vi.fn()} as never;
        service.requestClose(entry); service.discard();
        expect(service.entries).toContain(entry);
    });

    it('parks live drafts during presentation reset without closing their views', () => {
        const {service, owners} = workspace(), entry = service.open('style', 'A');
        const destroy = vi.fn();
        entry.content = {instance: controller(), hostView: {}, destroy} as never;
        window.dispatchEvent(new Event(EDITOR_PRESENTATION_RESET_EVENT));
        expect(service.docked()).toEqual([entry]);
        expect(owners.layout.state.isDockOpen).toBe(false);
        expect(destroy).not.toHaveBeenCalled();
    });

    it('preserves dirty documents omitted by an imported snapshot and never serializes their source', async () => {
        const {service, owners, persistence} = workspace(), entry = service.open('style', 'A');
        entry.content = {instance: {...controller(), privateDraft: 'secret draft'}, hostView: {}, destroy: vi.fn()} as never;
        owners.editors.documents.next([]);
        await Promise.resolve();
        expect(service.entries).toContain(entry);
        expect(service.docked()).toContain(entry);
        expect(JSON.stringify(persistence.exportSnapshot())).not.toContain('secret draft');
    });

    it('does not retarget a dirty document when a snapshot reuses its ID', async () => {
        const {service, owners} = workspace(), entry = service.open('style', 'A');
        entry.content = {instance: controller(), hostView: {}, destroy: vi.fn()} as never;
        owners.editors.documents.next([{id: entry.descriptor.id, kind: 'style', target: 'B'}]);
        await Promise.resolve();
        expect(service.entries[0]).toBe(entry);
        expect(entry.descriptor.target).toBe('A');
        expect(service.docked()).toContain(entry);
    });

    it('recreates a clean retargeted document while retaining its imported geometry', async () => {
        const {service, owners} = workspace(), entry = service.open('style', 'A');
        const destroy = vi.fn();
        entry.content = {instance: controller(false), hostView: {}, destroy} as never;
        const position = {left: 100, top: 120};
        owners.layout.setDialogPosition(entry.layoutId, position);
        owners.editors.documents.next([{id: entry.descriptor.id, kind: 'style', target: 'B'}]);
        await Promise.resolve();
        expect(service.entries[0]).not.toBe(entry);
        expect(service.entries[0].descriptor.target).toBe('B');
        expect(owners.layout.getDialogLayout(entry.layoutId)?.position).toEqual(position);
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('keeps a close decision bound to one document and collapses only an empty dock', async () => {
        const {service, owners} = workspace(), first = service.open('style', 'A'), second = service.open('style', 'B');
        first.content = {instance: controller(), hostView: {}, destroy: vi.fn()} as never;
        service.dock(first, true); service.dock(second, true);
        service.requestClose(first); service.requestClose(second);
        expect(service.closing).toBe(first);
        service.discard(); await Promise.resolve();
        expect(owners.layout.state.isDockOpen).toBe(true);
        owners.layout.setDockTabCount('search', 1);
        service.requestClose(second); await Promise.resolve();
        expect(owners.layout.state.isDockOpen).toBe(true);
        owners.layout.setDockTabCount('search', 0); await Promise.resolve();
        expect(owners.layout.state.isDockOpen).toBe(false);
    });

    it('migrates the old open style target once and keeps its floating geometry', async () => {
        const {service, owners, persistence} = workspace();
        expect(persistence.importSnapshot({styleEditorTarget: 'Legacy', dialogLayouts: {
            'style-editor-dialog': {position: {left: 30, top: 40}, size: {width: 600, height: 500}, open: true}
        }})).toEqual([]);
        await Promise.resolve();
        expect(service.entries).toHaveLength(1);
        expect(service.entries[0].descriptor.target).toBe('Legacy');
        expect(owners.layout.getDialogLayout(service.entries[0].layoutId)?.position).toEqual({left: 30, top: 40});
        expect(owners.styleService.state.styleEditorTargetId).toBeNull();
        expect(owners.layout.getDialogLayout('style-editor-dialog')).toBeUndefined();
        persistence.snapshotReplaced.next(); await Promise.resolve();
        expect(service.entries).toHaveLength(1);
    });

    it('uses a closed legacy editor geometry on first open without restoring an unwanted document', async () => {
        const {service, owners, persistence} = workspace();
        persistence.importSnapshot({dialogLayouts: {
            'datasources-editor-dialog': {position: {left: 20, top: 30}, size: {width: 720, height: 600}, open: false}
        }});
        await Promise.resolve();
        expect(service.entries).toHaveLength(0);
        const entry = service.open('datasources');
        expect(owners.layout.getDialogLayout(entry.layoutId)?.position).toEqual({left: 20, top: 30});
        expect(owners.layout.getDialogLayout('datasources-editor-dialog')).toBeUndefined();
    });
});
