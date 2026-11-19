import {Component, Inject, OnDestroy, OnInit, ViewChild} from '@angular/core';
import {Subscription} from 'rxjs';
import {EDITOR_DOCUMENT} from '../editor/editor-workspace.service';
import {EditorDocumentController, EditorDocumentLocation, EditorDocumentRef} from '../editor/editor-document.model';
import {EditorService} from '../editor/editor.service';
import {InfoMessageService} from '../diagnostics/info.service';
import {MapDataService} from '../mapdata/mapdata.service';
import {MapStyleService} from './mapstyle.service';
import {ErdblickStyle} from './mapstyle.model';
import {StyleDocumentModel} from './style-document.model';
import {StyleDocumentEditorComponent} from './style-document-editor.component';
import {decodeCanonicalLayerAffinity, updateStyleSourceMetadata} from '../search/search-style-sheet.converter';

@Component({
    selector: 'style-editor-document', standalone: false,
    template: `
        @if (error || stale) {
            <div class="editor-document-error" role="alert">{{ error || 'This style changed outside this editor. Review your draft before applying.' }}</div>
            <p-button label="Reload current style" [disabled]="busy" (click)="reloadRequested()"/>
        }
            <p-tabs [(value)]="styleEditorTab" class="style-editor-tabs" data-testid="style-editor-tabs">
                <p-tablist>
                    @if (styleEditorQuickAvailable) {
                        <p-tab value="quick">Quick</p-tab>
                    }
                    <p-tab value="advanced">Advanced</p-tab>
                </p-tablist>
                <p-tabpanels>
                    @if (styleEditorQuickAvailable) {
                        <p-tabpanel value="quick" class="style-editor-quick-panel">
                            <div class="style-editor-quick-content"
                                 [class.read-only]="quickProjectionStale">
                                @if (quickProjectionStale) {
                                    <div class="style-editor-quick-stale">
                                        Quick is read-only until Advanced contains valid YAML: {{ quickProjectionError }}
                                    </div>
                                }
                                <div class="style-editor-quick-metadata">
                                    <div class="style-editor-quick-field">
                                        <label [attr.for]="document.id + '-style-editor-quick-name'">Name</label>
                                        <input [id]="document.id + '-style-editor-quick-name'"
                                               data-testid="style-editor-quick-name"
                                               pInputText
                                               autocomplete="off"
                                               [ngModel]="quickStyleName"
                                               (ngModelChange)="onQuickStyleNameChange($event)"
                                               [disabled]="quickProjectionStale">
                                        @if (quickStyleNameIssue(); as issue) {
                                            <small class="style-editor-quick-error" role="alert">{{ issue }}</small>
                                        }
                                    </div>
                                    <div class="style-editor-quick-field style-editor-quick-affinity">
                                        <label [attr.for]="document.id + '-style-editor-quick-layers'">Layer affinity</label>
                                        @if (quickLayerAffinityKind === 'custom' && !quickReplacingCustomAffinity) {
                                            <div class="style-editor-custom-affinity" data-testid="style-editor-custom-affinity">
                                                <input aria-label="Custom layer affinity" pInputText
                                                    [ngModel]="quickCustomLayerAffinity"
                                                    (ngModelChange)="onQuickCustomAffinityChange($event)"
                                                    [disabled]="quickProjectionStale">
                                                <span [pTooltip]="quickCustomLayerAffinity">
                                                    Custom affinity (regular expression)
                                                </span>
                                                <p-button label="Choose exact layers"
                                                          size="small"
                                                          severity="secondary"
                                                          [text]="true"
                                                          [disabled]="quickProjectionStale"
                                                          (click)="beginReplacingQuickAffinity()"/>
                                                <p-button label="Any layer"
                                                          size="small"
                                                          severity="secondary"
                                                          [text]="true"
                                                          [disabled]="quickProjectionStale"
                                                          (click)="setQuickAffinityAny()"/>
                                            </div>
                                        } @else {
                                            <p-multiSelect [inputId]="document.id + '-style-editor-quick-layers'"
                                                           data-testid="style-editor-quick-layers"
                                                           [options]="quickLayerOptions"
                                                           [ngModel]="quickLayerAffinityIds"
                                                           (ngModelChange)="onQuickLayerAffinityChange($event)"
                                                           optionLabel="label"
                                                           optionValue="value"
                                                           placeholder="Any layer"
                                                           [filter]="true"
                                                           [showToggleAll]="true"
                                                           [maxSelectedLabels]="3"
                                                           [disabled]="quickProjectionStale"
                                                           appendTo="body">
                                            </p-multiSelect>
                                            <small>No selection means any layer.</small>
                                            @if (quickReplacingCustomAffinity) {
                                                <p-button label="Clear custom affinity to Any"
                                                          size="small"
                                                          severity="secondary"
                                                          [text]="true"
                                                          (click)="setQuickAffinityAny()"/>
                                            }
                                        }
                                    </div>
                                </div>
                                <style-document-editor [sessionScope]="document.id" [resetVersion]="quickResetVersion" [source]="quickSource" [skipMetadata]="true"
                                    (sourceChange)="commitQuickSource($event)"
                                    (invalidChange)="onQuickValidity($event)"/>

                            </div>
                        </p-tabpanel>
                    }
                    <p-tabpanel value="advanced" class="style-editor-advanced-panel">
                        <editor [sessionId]="styleEditorSessionId"></editor>
                    </p-tabpanel>
                </p-tabpanels>
            </p-tabs>
            <div class="editor-actions style-editor-actions">
                <div class="editor-actions-left">
                    <p-button
                        [attr.data-testid]="canSaveCurrentStyleToSource() ? 'style-editor-save-source-button' : 'style-editor-apply-button'"
                        (click)="saveOrApplyEditedStyle()"
                        [label]="canSaveCurrentStyleToSource() ? 'Save to Source' : 'Apply'"
                        [icon]="canSaveCurrentStyleToSource() ? 'pi pi-save' : 'pi pi-check'"
                        [disabled]="busy || !!quickStyleNameIssue() || quickFormInvalid || (canSaveCurrentStyleToSource() ? !currentStyleHasSourceChanges() : !sourceWasModified)"
                        [pTooltip]="canSaveCurrentStyleToSource() ? styleSourceSaveTooltip() : ''"></p-button>
                    <p-button data-testid="style-editor-close-button" (click)="closeEditorDialog($event)"
                              [label]='dirty ? "Discard" : "Close"'
                              severity="secondary" [text]="true"
                              icon="pi pi-times"></p-button>
                    <div class="editor-shortcuts">
                        <span><kbd>Ctrl/Cmd+S</kbd> to {{ canSaveCurrentStyleToSource() ? 'save' : 'apply' }}</span>
                        <span><kbd>Esc</kbd> to close</span>
                    </div>
                </div>
                <div class="editor-actions-right">
                    <p-button data-testid="style-editor-export-button" (click)="exportStyle(document.descriptor.target ?? '')"
                              [disabled]="sourceWasModified || !document.descriptor.target"
                              label="Export" icon="pi pi-file-export" severity="secondary" [text]="true">
                    </p-button>
                    <p-button data-testid="style-editor-help-button" (click)="openStyleHelp()" label="Help" icon="pi pi-book"
                              severity="secondary" [text]="true"></p-button>
                </div>
            </div>
    `
})

/** Owns one style draft for its complete lifetime, independent of its surrounding surface. */
export class StyleEditorDocumentComponent implements EditorDocumentController, OnInit, OnDestroy {
    @ViewChild(StyleDocumentEditorComponent) private quickForm?: StyleDocumentEditorComponent;
    private readonly subscriptions = new Subscription();
    private baseline = '';
    private quickProjectionRefreshTimer?: ReturnType<typeof setTimeout>;
    private updatingSourceFromQuick = false;
    private failedSourceSave = false;
    busy = false;
    error = '';
    styleEditorTab: 'quick' | 'advanced' = 'quick';
    styleEditorQuickAvailable = true;
    quickSource = '';
    quickFormInvalid = false;
    quickResetVersion = 0;
    quickStyleName = '';
    quickLayerAffinityKind: 'any' | 'exact' | 'custom' = 'any';
    quickLayerAffinityIds: string[] = [];
    quickCustomLayerAffinity = '';
    quickReplacingCustomAffinity = false;
    quickLayerOptions: Array<{label: string; value: string}> = [];
    quickProjectionStale = false;
    quickProjectionError = '';

    /** Captures the stable document reference and existing style authoring services. */
    constructor(@Inject(EDITOR_DOCUMENT) public readonly document: EditorDocumentRef,
                public readonly editorService: EditorService,
                public readonly styleService: MapStyleService,
                private readonly mapInfoService: MapDataService,
                private readonly messageService: InfoMessageService) {}

    get title(): string { return `Style Editor — ${this.document.descriptor.target ?? 'Unavailable'}`; }
    get dirty(): boolean { return this.sourceWasModified || !!this.quickForm?.hasPendingInput || this.failedSourceSave; }
    get sourceWasModified(): boolean { return this.editorService.getSessionSource(this.document.id) !== this.baseline; }
    get styleEditorSessionId(): string { return this.document.id; }
    get saveLabel(): string { return this.canSaveCurrentStyleToSource() ? 'Save to Source' : 'Apply'; }
    get saveEnabled(): boolean { return !this.busy && !this.quickFormInvalid && !this.quickStyleNameIssue() && !!this.currentEditorStyle() && (this.dirty || this.currentStyleHasSourceChanges()); }
    get enabled(): boolean | undefined { return this.currentEditorStyle()?.visible; }
    get stale(): boolean { return this.currentEditorStyle()?.source !== this.baseline; }

    /** Loads the authoritative source once and installs document-local subscriptions. */
    ngOnInit(): void {
        const descriptor = this.document.descriptor;
        const style = this.styleService.styles.get(descriptor.target ?? '') ??
            [...this.styleService.styles.values()].find(candidate => !!descriptor.sourceUrl && candidate.url === descriptor.sourceUrl);
        if (style) this.document.rename(style.id, style.url || undefined);
        this.baseline = style?.source ?? '';
        if (!style) this.error = 'This style is no longer available. Close the editor or restore its source.';
        this.editorService.createSession({id: this.document.id, source: this.baseline, language: 'yaml', styleCompletions: true});
        this.refreshQuickProjection(this.baseline);
        this.subscriptions.add(this.editorService.getSession(this.document.id)!.source$.subscribe(source => {
            if (!this.updatingSourceFromQuick) {
                if (this.quickProjectionRefreshTimer) clearTimeout(this.quickProjectionRefreshTimer);
                this.quickProjectionRefreshTimer = setTimeout(() => { this.refreshQuickProjection(source); this.document.changed(); }, 150);
            }
            this.document.changed();
        }));
        this.subscriptions.add(this.editorService.onSaveRequested(this.document.id)!.subscribe(() => { void this.save(); }));
        this.subscriptions.add(this.mapInfoService.maps$.subscribe(() => { this.refreshQuickLayerOptions(); this.document.changed(); }));
    }

    /** Keeps visibility a live style operation, independent of unsaved YAML. */
    setEnabled(enabled: boolean): void {
        if (this.document.descriptor.target) this.styleService.toggleStyle(this.document.descriptor.target, enabled, true);
        this.document.changed();
    }

    /** Reveals a requested diagnostic in Advanced without changing the draft. */
    activate(location?: EditorDocumentLocation): void {
        if (!location) return;
        this.styleEditorTab = 'advanced';
        const source = this.editorService.getSessionSource(this.document.id);
        if (location.sourceHash && location.sourceHash !== this.styleService.createEditorSourceRef(this.document.descriptor.target ?? '', source).sourceHash) {
            this.error = 'This diagnostic refers to an earlier source revision. Validate the current draft for an accurate location.';
            this.document.changed();
            return;
        }
        this.document.changed();
        requestAnimationFrame(() => this.editorService.revealLocation(this.document.id, location));
    }

    /** Applies this exact source and acknowledges only the revision actually submitted. */
    async save(): Promise<boolean> {
        if (this.busy) return false;
        if (this.quickFormInvalid || this.quickStyleNameIssue()) { this.error = 'Correct the highlighted style fields before applying changes.'; this.document.changed(); return false; }
        const style = this.currentEditorStyle();
        if (!style || this.stale) { this.error = 'The style changed or was removed. Review the current source before overwriting it.'; this.document.changed(); return false; }
        const source = this.editorService.getSessionSource(this.document.id);
        const report = this.styleService.validateStyleSource(source, this.styleService.createEditorSourceRef(style.id, source));
        if (!report.valid) { this.error = report.issues.map(issue => issue.message).join('\n'); this.document.changed(); return false; }
        this.busy = true; this.error = ''; this.document.changed();
        try {
            const target = source === this.baseline ? style.id : this.styleService.setStyleSource(style.id, source);
            if (!target) { this.error = 'Could not apply the style.'; return false; }
            this.document.rename(target, style.url || undefined);
            this.baseline = source;
            if (this.styleService.canSaveStyleToSource(target)) {
                this.failedSourceSave = true;
                if (!await this.styleService.saveStyleToSource(target)) { this.error = 'The style was applied locally, but saving to its source failed. Your draft is retained.'; return false; }
            }
            this.failedSourceSave = false;
            return true;
        } catch (error) {
            this.error = `Could not save the style: ${error instanceof Error ? error.message : String(error)}`;
            return false;
        } finally { this.busy = false; this.document.changed(); }
    }

    /** Routes the existing footer action through the same guarded save command. */
    saveOrApplyEditedStyle(): void { void this.save(); }
    /** Routes footer closure through the session guard. */
    closeEditorDialog(event: Event): void { this.document.close(event); }
    /** Reports whether this document has a writable source-file destination. */
    canSaveCurrentStyleToSource(): boolean { return !!this.document.descriptor.target && this.styleService.canSaveStyleToSource(this.document.descriptor.target); }
    /** Separates source-file changes from the editor's unapplied buffer. */
    currentStyleHasSourceChanges(): boolean { return this.dirty || this.currentEditorStyle()?.modified === true; }
    /** Describes the existing source-write destination. */
    styleSourceSaveTooltip(): string { return `Overwrite the YAML file below ${this.styleService.getStyleEditingDirectory() ?? 'the source styles directory'}`; }
    /** Exports this document's applied style through the existing domain operation. */
    exportStyle(styleId: string): void { this.styleService.exportStyleYamlFile(styleId); }
    /** Notifies the shell when incomplete Quick input changes dirty or save state. */
    onQuickValidity(invalid: boolean): void { this.quickFormInvalid = invalid; this.document.changed(); }
    /** Requires an explicit decision before replacing a draft with changed authoritative source. */
    reloadRequested(): void {
        if (this.dirty && !window.confirm(`Discard the unsaved draft of ${this.title}?`)) return;
        const style = this.currentEditorStyle();
        if (!style) return;
        this.baseline = style.source; this.failedSourceSave = false; this.error = '';
        this.quickResetVersion++;
        this.editorService.updateSessionSource(this.document.id, style.source);
        this.refreshQuickProjection(style.source); this.document.changed();
    }
    /** Cancels document work only on confirmed close or application teardown. */
    ngOnDestroy(): void {
        this.subscriptions.unsubscribe();
        if (this.quickProjectionRefreshTimer) clearTimeout(this.quickProjectionRefreshTimer);
        this.editorService.closeSession(this.document.id);
    }
    /** Reprojects the authoritative Advanced YAML without replacing the last good view on parse errors. */
    private refreshQuickProjection(source: string): void {
        if (!this.styleEditorQuickAvailable) {
            return;
        }
        this.quickSource = source;
        try {
            const document = new StyleDocumentModel(source);
            const layer = document.value(["layer"]);
            const ids = typeof layer === "string" ? decodeCanonicalLayerAffinity(layer) : undefined;
            this.quickSource = source;
            this.quickStyleName = String(document.value(["name"]) ?? "");
            this.quickLayerAffinityKind = layer === undefined ? "any" : ids ? "exact" : "custom";
            this.quickLayerAffinityIds = ids ?? [];
            this.quickCustomLayerAffinity = typeof layer === "string" && !ids ? layer : "";
            this.quickReplacingCustomAffinity = false;
            this.refreshQuickLayerOptions();
            this.quickProjectionStale = false;
            this.quickProjectionError = "";
        } catch (error) {
            this.quickProjectionStale = true;
            this.quickProjectionError = error instanceof Error ? error.message : String(error);
        }
    }

    /** Returns the currently persisted style controlled by the editor header. */
    protected currentEditorStyle(): ErdblickStyle | undefined {
        const styleId = this.document.descriptor.target;
        return styleId ? this.styleService.styles.get(styleId) : undefined;
    }

    /** Reports the immediate Quick-name validity used to gate Apply. */
    protected quickStyleNameIssue(): string {
        if (!this.quickStyleName.trim()) {
            return "A style name is required.";
        }
        const conflict = this.styleService.styleIdentityConflict(this.quickStyleName);
        return conflict && conflict.id !== this.document.descriptor.target
            ? `A style named or resolved by “${this.quickStyleName}” already exists.`
            : "";
    }

    /** Patches the root YAML name immediately, preserving every unrelated AST node. */
    protected onQuickStyleNameChange(name: string): void {
        this.quickStyleName = name ?? "";
        this.updateQuickMetadata({ name: this.quickStyleName });
    }

    /** Replaces Any/custom affinity with a deterministic set of exact layer IDs. */
    protected onQuickLayerAffinityChange(layerIds: string[] | null): void {
        const selected = [...(layerIds ?? [])];
        this.updateQuickMetadata({
            layerAffinity: selected.length
                ? { kind: "exact", layerIds: selected }
                : { kind: "any" }
        });
    }

    /** Edits a custom affinity without replacing it with exact layer IDs. */
    protected onQuickCustomAffinityChange(expression: string): void {
        const source = this.editorService.getSessionSource(this.document.id);
        this.commitQuickSource(new StyleDocumentModel(source).edit({op: "set", path: ["layer"], value: expression}));
    }

    /** Enters an explicit replacement state without mutating a custom regex. */
    protected beginReplacingQuickAffinity(): void {
        this.quickReplacingCustomAffinity = true;
        this.quickLayerAffinityIds = [];
    }

    /** Explicitly deletes the root layer expression. */
    protected setQuickAffinityAny(): void {
        this.updateQuickMetadata({ layerAffinity: { kind: "any" } });
    }

    /** Applies one metadata patch through the same guarded Advanced-source session. */
    private updateQuickMetadata(patch: Parameters<typeof updateStyleSourceMetadata>[1]): void {
        if (this.quickProjectionStale) {
            return;
        }
        try {
            const currentSource = this.editorService
                .getSessionSource(this.document.id)
                .replace(/\n+$/, "");
            this.commitQuickSource(updateStyleSourceMetadata(currentSource, patch));
        } catch (error) {
            this.messageService.showError(
                `Could not apply the Quick metadata change: ${error instanceof Error ? error.message : String(error)}`);
            this.refreshQuickProjection(this.editorService.getSessionSource(this.document.id));
        }
    }

    /** Updates CodeMirror synchronously while suppressing its delayed projection refresh. */
    protected commitQuickSource(updatedSource: string): void {
        this.updatingSourceFromQuick = true;
        try {
            this.editorService.updateSessionSource(this.document.id, updatedSource);
        } finally {
            this.updatingSourceFromQuick = false;
        }
        this.refreshQuickProjection(updatedSource);
    }

    /** Merges live map layer IDs with exact source-only affinity selections. */
    private refreshQuickLayerOptions(): void {
        const ids = new Set(this.quickLayerAffinityIds);
        for (const layer of this.mapInfoService.maps.allFeatureLayers()) {
            if (layer.id) {
                ids.add(layer.id);
            }
        }
        this.quickLayerOptions = [...ids]
            .sort((left, right) => left.localeCompare(right))
            .map(value => ({ label: value, value }));
    }

    /** Opens the style-definition documentation in a new browser tab. */
    openStyleHelp() {
        window.open("https://github.com/ndsev/erdblick?tab=readme-ov-file#style-definitions", "_blank");
    }

}
