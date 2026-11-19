import {ApplicationRef, ComponentRef, EnvironmentInjector, Injectable, InjectionToken, Injector, OnDestroy, Type, createComponent} from '@angular/core';
import {Subject, Subscription} from 'rxjs';
import {AppStateService} from '../appstate/appstate.service';
import {LayoutService} from '../layout/layout.service';
import {EDITORS_DOCK_TAB_ID} from '../layout/layout.model';
import {MapStyleState} from '../mapstyle/mapstyle.state';
import {EDITOR_PRESENTATION_RESET_EVENT, EditorDocumentController, EditorDocumentDescriptor, EditorDocumentKind, EditorDocumentLocation, EditorDocumentRef} from './editor-document.model';
import {EditorWorkspaceState} from './editor-workspace.state';

export const EDITOR_DOCUMENT = new InjectionToken<EditorDocumentRef>('Editor document');

/** A document component is attached once to Angular and moved between disposable shells. */
export interface EditorWorkspaceEntry {
    descriptor: EditorDocumentDescriptor;
    layoutId: string;
    content?: ComponentRef<EditorDocumentController>;
    host?: HTMLElement;
    activation?: EditorDocumentLocation;
    activationSerial: number;
}

/** Owns open document lifetimes independently of floating/docked presentation. */
@Injectable({providedIn: 'root'})
export class EditorWorkspaceService implements OnDestroy {
    readonly changed = new Subject<void>();
    readonly entries: EditorWorkspaceEntry[] = [];
    closing?: EditorWorkspaceEntry;
    private factories?: Record<EditorDocumentKind, Type<EditorDocumentController>>;
    private readonly subscriptions = new Subscription();
    private reconciling = false;
    private initialized = false;
    private destroyed = false;

    /** Registers state observation without constructing browser content during catalog generation. */
    constructor(public readonly state: EditorWorkspaceState,
                public readonly layout: LayoutService,
                private readonly persistence: AppStateService,
                private readonly legacyStyle: MapStyleState,
                private readonly app: ApplicationRef,
                private readonly environment: EnvironmentInjector,
                private readonly injector: Injector) {}

    /** Starts the UI workspace after catalogs and persistence have initialized. */
    initialize(factories: Record<EditorDocumentKind, Type<EditorDocumentController>>): void {
        if (this.initialized) return;
        this.factories = factories;
        this.initialized = true;
        this.reconcile();
        this.subscriptions.add(this.persistence.snapshotReplaced.subscribe(() => queueMicrotask(() => this.reconcile())));
        this.subscriptions.add(this.state.documents.subscribe(() => {
            if (!this.reconciling) queueMicrotask(() => this.reconcile());
        }));
        window.addEventListener('beforeunload', this.beforeUnload);
        window.addEventListener(EDITOR_PRESENTATION_RESET_EVENT, this.presentationReset);
    }

    /** Opens one document, or reveals the existing draft without reinitializing its content. */
    open(kind: EditorDocumentKind, target?: string, sourceUrl?: string): EditorWorkspaceEntry {
        let entry = this.entries.find(item => item.descriptor.kind === kind &&
            ((kind !== 'style' && kind !== 'drawing') || item.descriptor.target === target || (!!sourceUrl && item.descriptor.sourceUrl === sourceUrl)));
        if (!entry) {
            entry = this.add({id: `editor-${crypto.randomUUID()}`, kind, ...(target ? {target} : {}), ...(sourceUrl ? {sourceUrl} : {})});
            if (this.docked().length) this.layout.setSurfaceDocked(entry.layoutId, true, EDITORS_DOCK_TAB_ID);
            this.persist();
        }
        this.activate(entry);
        return entry;
    }

    /** Focuses one surface; pending diagnostic navigation is delivered after mounting. */
    activate(entry: EditorWorkspaceEntry, location?: EditorDocumentLocation): void {
        entry.activation = location;
        entry.activationSerial++;
        if (this.layout.isSurfaceDocked(entry.layoutId)) {
            this.layout.state.isDockOpen = true;
            this.layout.state.dockActiveTab = EDITORS_DOCK_TAB_ID;
            this.layout.setPanelLayout(entry.layoutId, {panelCollapsed: false});
        }
        this.notify();
    }

    /** Returns live dock entries in persisted order, never orphaned layout records. */
    docked(): EditorWorkspaceEntry[] {
        return this.entries.filter(entry => this.layout.isSurfaceDocked(entry.layoutId))
            .sort((a, b) => (this.layout.getDialogLayout(a.layoutId)?.dockOrder ?? 0) - (this.layout.getDialogLayout(b.layoutId)?.dockOrder ?? 0));
    }

    /** Returns the documents currently presented as floating dialogs. */
    floating(): EditorWorkspaceEntry[] { return this.entries.filter(entry => !this.layout.isSurfaceDocked(entry.layoutId)); }

    /** Changes placement without touching document content or save operations. */
    dock(entry: EditorWorkspaceEntry, docked: boolean): void {
        this.layout.setSurfaceDocked(entry.layoutId, docked, EDITORS_DOCK_TAB_ID);
        this.activate(entry);
    }

    /** Attaches one retained Angular root view to a shell; there is no second editor instance. */
    attach(entry: EditorWorkspaceEntry, target: HTMLElement): void {
        if (!this.entries.includes(entry) || this.destroyed) return;
        if (!entry.content) {
            if (!this.factories) return;
            const documentRef: EditorDocumentRef = {
                descriptor: entry.descriptor, id: entry.descriptor.id,
                changed: () => {
                    if (!this.entries.includes(entry) || this.destroyed) return;
                    entry.content?.changeDetectorRef.markForCheck(); this.notify();
                },
                close: event => { event?.stopPropagation(); this.requestClose(entry); },
                rename: (name, url) => { entry.descriptor.target = name; entry.descriptor.sourceUrl = url; this.persist(); },
                conflictingEditors: snapshot => this.conflictingEditors(entry, snapshot)
            };
            entry.host = document.createElement('div');
            entry.host.className = 'editor-document-content';
            entry.content = createComponent(this.factories[entry.descriptor.kind], {
                hostElement: entry.host, environmentInjector: this.environment,
                elementInjector: Injector.create({parent: this.injector, providers: [{provide: EDITOR_DOCUMENT, useValue: documentRef}]})
            });
            this.app.attachView(entry.content.hostView);
            // Initialization happens once, before any surface can request a save.
            entry.content.changeDetectorRef.detectChanges();
        }
        target.appendChild(entry.host!);
    }

    /** Detaches only the outgoing shell's attachment; a newer shell may already own it. */
    detach(entry: EditorWorkspaceEntry, target: HTMLElement): void {
        if (entry.host?.parentElement === target) entry.host.remove();
    }

    /** Starts a single guarded close flow, including callers from the dialog stack. */
    requestClose(entry: EditorWorkspaceEntry): void {
        if (!this.entries.includes(entry) || (this.closing && this.closing !== entry)) return;
        const controller = entry.content?.instance;
        if (controller?.busy || controller?.dirty) this.closing = entry;
        else this.dispose(entry);
        this.notify();
    }

    /** Closes only after the selected document confirms a successful, still-clean save. */
    async saveAndClose(): Promise<void> {
        const entry = this.closing;
        const controller = entry?.content?.instance;
        if (!entry || !controller || controller.busy) return;
        if (await controller.save() && this.entries.includes(entry) && !controller.dirty) this.dispose(entry);
        this.notify();
    }

    /** Discards one confirmed draft, never another document or an outstanding write. */
    async discard(): Promise<void> {
        const entry = this.closing;
        if (entry && !entry.content?.instance.busy &&
            (!entry.content?.instance.discard || await entry.content.instance.discard())) this.dispose(entry);
        this.notify();
    }

    /** Keeps all documents intact when the close decision is cancelled. */
    cancelClose(): void { this.closing = undefined; this.notify(); }

    /** Preserves drafts when an automated presentation replaces visible workspace state. */
    parkForPresentation(): void {
        for (const entry of this.entries) this.layout.setSurfaceDocked(entry.layoutId, true, EDITORS_DOCK_TAB_ID);
        this.layout.state.isDockOpen = false;
        this.persist();
    }

    /** Reports other drafts that a snapshot's changed workspace would remove or move. */
    private conflictingEditors(current: EditorWorkspaceEntry, snapshot: Record<string, unknown>): string[] {
        const live = this.persistence.exportSnapshot();
        if (!['editorDocuments', 'dialogLayouts'].some(key => key in snapshot && JSON.stringify(snapshot[key]) !== JSON.stringify(live[key]))) return [];
        return this.entries.filter(entry => entry !== current && (entry.content?.instance.dirty || entry.content?.instance.busy))
            .map(entry => entry.content!.instance.title);
    }

    /** Creates a stable identity and a usable floating layout for a restored/new document. */
    private add(descriptor: EditorDocumentDescriptor): EditorWorkspaceEntry {
        const entry = {descriptor: {...descriptor}, layoutId: `editor:${descriptor.id}`, activationSerial: 0};
        this.entries.push(entry);
        if (!this.layout.getDialogLayout(entry.layoutId)) {
            const legacyId = {style: 'style-editor-dialog', presets: 'style-preset-editor-dialog',
                datasources: 'datasources-editor-dialog', preferences: 'advanced-preferences-dialog', drawing: 'drawing-editor-dialog'}[descriptor.kind];
            const legacyLayout = this.layout.getDialogLayout(legacyId);
            const width = Math.min(800, window.innerWidth - 24), height = Math.min(700, window.innerHeight - 24);
            const offset = (this.entries.length - 1) % 6 * 24;
            this.layout.upsertDialogLayout(entry.layoutId, {
                position: {left: Math.max(0, (window.innerWidth - width) / 2 + offset), top: Math.max(0, (window.innerHeight - height) / 2 + offset)},
                size: {width, height}, ...legacyLayout, open: false, docked: false, dockTab: EDITORS_DOCK_TAB_ID
            });
            if (legacyLayout) this.layout.removeDialogLayout(legacyId);
        }
        return entry;
    }

    /** Migrates old snapshots, then reconciles descriptors without throwing away live drafts. */
    private reconcile(): void {
        if (!this.initialized || this.destroyed || this.reconciling) return;
        this.reconciling = true;
        try {
            const descriptors = this.state.documents.getValue().map(entry => ({...entry}));
            const legacy: Array<[string, EditorDocumentKind, string | undefined]> = [
                ['style-editor-dialog', 'style', this.legacyStyle.styleEditorTargetId ?? undefined],
                ['style-preset-editor-dialog', 'presets', undefined],
                ['datasources-editor-dialog', 'datasources', undefined],
                ['advanced-preferences-dialog', 'preferences', undefined]
            ];
            for (const [layoutId, kind, target] of legacy) {
                const layout = this.layout.getDialogLayout(layoutId);
                if (layout?.open && (kind !== 'style' || target) && !descriptors.some(item => item.kind === kind && item.target === target)) {
                    const descriptor = {id: `legacy-${kind}`, kind, ...(target ? {target} : {})};
                    descriptors.push(descriptor);
                    this.layout.upsertDialogLayout(`editor:${descriptor.id}`, {...layout, open: false, dockTab: EDITORS_DOCK_TAB_ID});
                }
                // A closed legacy editor is only a geometry preference. Consume
                // it when that kind is first opened, without reopening it here.
                if (layout?.open) this.layout.removeDialogLayout(layoutId);
            }
            this.legacyStyle.styleEditorTargetId = null;
            for (const entry of [...this.entries]) {
                if (entry.descriptor.kind === 'drawing') { descriptors.push(entry.descriptor); continue; }
                const incoming = descriptors.find(item => item.id === entry.descriptor.id);
                if (incoming && incoming.kind === entry.descriptor.kind && incoming.target === entry.descriptor.target
                    && incoming.sourceUrl === entry.descriptor.sourceUrl) continue;
                if (entry.content?.instance.dirty || entry.content?.instance.busy) {
                    if (incoming) descriptors.splice(descriptors.indexOf(incoming), 1);
                    descriptors.push(entry.descriptor);
                    this.layout.setSurfaceDocked(entry.layoutId, true, EDITORS_DOCK_TAB_ID);
                } else this.dispose(entry, false, !!incoming);
            }
            for (const descriptor of descriptors) {
                if (!this.entries.some(entry => entry.descriptor.id === descriptor.id ||
                    (entry.descriptor.kind === descriptor.kind && ((descriptor.kind !== 'style' && descriptor.kind !== 'drawing') || entry.descriptor.target === descriptor.target
                        || (!!descriptor.sourceUrl && entry.descriptor.sourceUrl === descriptor.sourceUrl))))) this.add(descriptor);
            }
            for (const id of Object.keys(this.layout.state.dialogLayoutsState.getValue())) {
                if (id.startsWith('editor:') && !this.entries.some(entry => entry.layoutId === id)) this.layout.removeDialogLayout(id);
            }
            this.persist();
        } finally { this.reconciling = false; }
    }

    /** Releases the Angular content only after document closure, never on shell unmount. */
    private dispose(entry: EditorWorkspaceEntry, persist = true, keepLayout = false): void {
        const index = this.entries.indexOf(entry);
        if (index < 0) return;
        this.entries.splice(index, 1);
        if (entry.content) { this.app.detachView(entry.content.hostView); entry.content.destroy(); }
        entry.content = undefined;
        entry.host?.remove();
        if (this.closing === entry) this.closing = undefined;
        if (!this.destroyed && !keepLayout) this.layout.removeDialogLayout(entry.layoutId);
        if (persist) this.persist();
    }

    /** Writes only safe references; equality avoids snapshot-observer feedback loops. */
    private persist(): void {
        const descriptors = this.entries.filter(entry => entry.descriptor.kind !== 'drawing').map(entry => ({...entry.descriptor}));
        if (JSON.stringify(descriptors) !== JSON.stringify(this.state.documents.getValue())) this.state.documents.next(descriptors);
        this.notify();
    }

    /** Publishes live dock availability and structural changes to zoneless surfaces. */
    notify(): void {
        if (this.destroyed) return;
        this.layout.setDockTabCount(EDITORS_DOCK_TAB_ID, this.docked().length);
        this.changed.next();
    }

    /** Parks editor content when a presentation replaces visible application state. */
    private readonly presentationReset = (): void => this.parkForPresentation();

    /** Drawing documents own their autosave/unload guard; other Editors still require explicit saves. */
    private readonly beforeUnload = (event: BeforeUnloadEvent): void => {
        if (this.entries.some(entry => entry.descriptor.kind !== 'drawing' &&
            (entry.content?.instance.dirty || entry.content?.instance.busy))) {
            event.preventDefault(); event.returnValue = '';
        }
    };

    /** Tears down all retained views when the application itself retires. */
    ngOnDestroy(): void {
        this.destroyed = true;
        window.removeEventListener('beforeunload', this.beforeUnload);
        window.removeEventListener(EDITOR_PRESENTATION_RESET_EVENT, this.presentationReset);
        this.subscriptions.unsubscribe();
        for (const entry of [...this.entries]) this.dispose(entry, false);
        this.changed.complete();
    }
}
