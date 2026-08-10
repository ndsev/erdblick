import {Component, EventEmitter, OnDestroy, Output} from "@angular/core";
import {Subscription} from "rxjs";

import {SearchStyleConfigurationService} from "../search/search-style-configuration.service";
import {
    FeatureSearchStyleRuleDraft,
    SearchStyleRuleDraftCodec
} from "../search/search-style-rule-editor.model";
import {SearchStyleConfigurationV1} from "../shared/search-style-configuration-state";
import {InfoMessageService} from "../shared/info.service";
import {SearchGeneratedStyleSheet, StyleService} from "./style.service";

export interface SearchGeneratedStyleEditRequest {
    source: string;
    styleId: string;
}

/** Manages saved search-style JSON configurations and their canonical generated YAML projections. */
@Component({
    selector: "search-styles",
    template: `
        <div class="search-styles-tab" data-testid="search-styles-tab">
            <div class="search-styles-toolbar">
                <p-select class="search-styles-select"
                          [options]="configurationOptions"
                          [ngModel]="selectedConfigurationId"
                          (ngModelChange)="selectConfiguration($event)"
                          optionLabel="label"
                          optionValue="value"
                          placeholder="Select a search style"
                          appendTo="body">
                </p-select>
                <p-button icon="pi pi-plus" label="New" size="small" (click)="createConfiguration()"/>
                <p-button icon="pi pi-copy" label="Duplicate" size="small" severity="secondary"
                          [outlined]="true" [disabled]="!selectedConfigurationId"
                          (click)="duplicateConfiguration()"/>
                <p-button icon="pi pi-trash" label="Delete" size="small" severity="danger"
                          [outlined]="true" [disabled]="!selectedConfigurationId"
                          (click)="deleteConfiguration()"/>
            </div>

            @if (selectedConfiguration) {
                <div class="search-styles-name-row">
                    <label for="search-style-configuration-name">Name</label>
                    <input id="search-style-configuration-name" pInputText
                           [(ngModel)]="editedName" (ngModelChange)="dirty = true">
                    <span class="search-styles-revision">Revision {{ selectedConfiguration.revision }}</span>
                    <p-button icon="pi pi-save" label="Save configuration" size="small"
                              [disabled]="!dirty" (click)="saveConfiguration()"/>
                    <p-button icon="pi pi-times" label="Cancel" size="small" severity="secondary"
                              [outlined]="true" [disabled]="!dirty" (click)="cancelConfigurationEdits()"/>
                </div>

                <div class="feature-search-style-rules search-styles-rule-editor">
                    <search-style-rule-editor
                        [drafts]="drafts"
                        (draftsChange)="onDraftsChange($event)"
                        completionOwnerPrefix="saved-search-style"
                        [showAddButton]="true"
                        [canRefreshValueSummaries]="false">
                    </search-style-rule-editor>
                </div>

                <section class="search-styles-generated">
                    <header>
                        <div>
                            <h3>Canonical YAML</h3>
                            <span class="search-styles-generated-status"
                                  [class.invalid]="generatedStyle && !generatedStyle.valid">
                                {{ generatedStatusLabel() }}
                            </span>
                            <p class="search-styles-generated-help">
                                High-fidelity rules only; search query and map/layer restrictions are not included.
                            </p>
                        </div>
                        <div class="search-styles-generated-actions">
                            <p-button icon="pi pi-download" label="Export YAML" size="small"
                                      severity="secondary" [outlined]="true"
                                      [disabled]="!generatedStyle?.valid"
                                      (click)="exportGeneratedStyle()"/>
                            <p-button icon="pi pi-file-edit" label="Copy to editor" size="small"
                                      severity="secondary" [outlined]="true"
                                      [disabled]="!generatedStyle?.valid"
                                      pTooltip="Edit a copy as a normal imported style"
                                      tooltipPosition="bottom"
                                      (click)="copyGeneratedStyleToEditor()"/>
                        </div>
                    </header>
                    @if (generatedStyle; as generated) {
                        @if (generated.valid) {
                            <pre class="search-styles-yaml" data-testid="search-style-generated-yaml">{{ generated.source }}</pre>
                        } @else if (generated.generationError) {
                            <div class="styles-empty search-styles-generation-error">
                                {{ generated.generationError }}
                            </div>
                        } @else {
                            <div class="styles-empty">
                                The current configuration did not produce a native-valid canonical stylesheet.
                            </div>
                        }
                    } @else {
                        <div class="styles-empty">The canonical YAML projection is not available.</div>
                    }
                </section>
            } @else {
                <div class="styles-empty search-styles-empty">
                    Save rules from Feature Search or create a configuration here.
                </div>
            }
        </div>
    `,
    standalone: false
})
export class SearchStylesComponent implements OnDestroy {
    @Output() copyToEdit = new EventEmitter<SearchGeneratedStyleEditRequest>();

    configurations: SearchStyleConfigurationV1[] = [];
    configurationOptions: Array<{label: string; value: string}> = [];
    selectedConfigurationId: string | null = null;
    selectedConfiguration?: SearchStyleConfigurationV1;
    generatedStyle?: SearchGeneratedStyleSheet;
    editedName = "";
    drafts: FeatureSearchStyleRuleDraft[] = [];
    dirty = false;

    private readonly subscriptions = new Subscription();
    private readonly codec = new SearchStyleRuleDraftCodec();

    constructor(
        private readonly configurationsService: SearchStyleConfigurationService,
        private readonly styleService: StyleService,
        private readonly infoMessageService: InfoMessageService
    ) {
        this.subscriptions.add(this.configurationsService.configurations$.subscribe(configurations => {
            this.configurations = configurations;
            this.configurationOptions = configurations.map(configuration => ({
                label: configuration.name,
                value: configuration.id
            }));
            if (!this.selectedConfigurationId && configurations.length) {
                this.selectConfiguration(configurations[0].id);
                return;
            }
            const current = configurations.find(configuration =>
                configuration.id === this.selectedConfigurationId);
            if (!current) {
                this.clearSelection();
                return;
            }
            if (!this.dirty && current.revision !== this.selectedConfiguration?.revision) {
                this.loadConfiguration(current);
            } else {
                this.selectedConfiguration = current;
            }
            this.refreshGeneratedStyle();
        }));
        this.subscriptions.add(this.styleService.searchGeneratedStylesState.subscribe(() => {
            this.refreshGeneratedStyle();
        }));
    }

    /** Releases subscriptions owned by the tab. */
    ngOnDestroy(): void {
        this.subscriptions.unsubscribe();
    }

    /** Loads a selected configuration into an independent editor draft. */
    selectConfiguration(configurationId: string | null): void {
        if (configurationId !== this.selectedConfigurationId && !this.confirmDiscardDirtyConfiguration()) {
            return;
        }
        if (!configurationId) {
            this.clearSelection();
            return;
        }
        const configuration = this.configurations.find(item => item.id === configurationId);
        if (configuration) {
            this.loadConfiguration(configuration);
        }
    }

    /** Creates and selects an empty reusable configuration. */
    createConfiguration(): void {
        if (!this.confirmDiscardDirtyConfiguration()) {
            return;
        }
        const name = window.prompt("New search style configuration", "Search Style");
        if (name === null) {
            return;
        }
        const created = this.configurationsService.create(name, []);
        if (!created) {
            this.infoMessageService.showError(
                "The search style configuration could not be created; the local library may be full.");
            return;
        }
        this.selectConfiguration(created.id);
    }

    /** Duplicates the selected configuration as a detached copy. */
    duplicateConfiguration(): void {
        if (!this.confirmDiscardDirtyConfiguration()) {
            return;
        }
        if (!this.selectedConfigurationId) {
            return;
        }
        const duplicate = this.configurationsService.duplicate(this.selectedConfigurationId);
        if (duplicate) {
            this.selectConfiguration(duplicate.id);
        } else {
            this.infoMessageService.showError(
                "The search style configuration could not be duplicated; the local library may be full.");
        }
    }

    /** Deletes the selected configuration and its generated projection. */
    deleteConfiguration(): void {
        const configuration = this.selectedConfiguration;
        if (!configuration || !window.confirm(`Delete search style configuration “${configuration.name}”?`)) {
            return;
        }
        this.configurationsService.remove(configuration.id);
    }

    /** Marks reusable-editor output as an unsaved configuration edit. */
    onDraftsChange(drafts: FeatureSearchStyleRuleDraft[]): void {
        this.drafts = drafts;
        this.dirty = true;
    }

    /** Writes editor rules back to JSON AppState and regenerates canonical YAML. */
    saveConfiguration(): void {
        if (!this.selectedConfigurationId) {
            return;
        }
        const updated = this.configurationsService.update(
            this.selectedConfigurationId,
            this.codec.fromDrafts(this.drafts),
            this.editedName
        );
        if (!updated) {
            this.infoMessageService.showError(
                "The search style configuration could not be updated; it may exceed the local library size limit.");
            return;
        }
        this.dirty = false;
        this.loadConfiguration(updated);
        this.infoMessageService.showSuccess(`Saved search style configuration “${updated.name}”.`);
    }

    /** Discards the working copy and restores the last saved configuration revision. */
    cancelConfigurationEdits(): void {
        if (this.selectedConfigurationId) {
            const saved = this.configurationsService.get(this.selectedConfigurationId);
            if (saved) {
                this.loadConfiguration(saved);
            }
        }
    }

    /** Exports the generated YAML from the separate search-generated style collection. */
    exportGeneratedStyle(): void {
        if (!this.selectedConfigurationId
            || !this.styleService.exportSearchGeneratedStyleYamlFile(this.selectedConfigurationId)) {
            this.infoMessageService.showError("The generated search stylesheet could not be exported.");
        }
    }

    /** Requests a transient YAML editor session whose save target is a normal imported style. */
    copyGeneratedStyleToEditor(): void {
        if (!this.generatedStyle?.valid) {
            return;
        }
        this.copyToEdit.emit({
            source: this.generatedStyle.source,
            styleId: this.generatedStyle.styleId
        });
    }

    /** Returns the parser status of the current canonical sheet. */
    generatedStatusLabel(): string {
        if (!this.generatedStyle) {
            return "Unavailable";
        }
        return this.generatedStyle.valid ? "Parsed" : "Invalid";
    }

    /** Replaces the working copy from one detached saved configuration. */
    private loadConfiguration(configuration: SearchStyleConfigurationV1): void {
        this.selectedConfigurationId = configuration.id;
        this.selectedConfiguration = configuration;
        this.editedName = configuration.name;
        this.drafts = this.codec.toDrafts(configuration.rules);
        this.dirty = false;
        this.refreshGeneratedStyle();
    }

    /** Resolves the generated projection matching the current configuration. */
    private refreshGeneratedStyle(): void {
        this.generatedStyle = this.selectedConfigurationId
            ? this.styleService.getSearchGeneratedStyle(this.selectedConfigurationId)
            : undefined;
    }

    /** Clears the selected configuration and all transient editor state. */
    private clearSelection(): void {
        this.selectedConfigurationId = null;
        this.selectedConfiguration = undefined;
        this.generatedStyle = undefined;
        this.editedName = "";
        this.drafts = [];
        this.dirty = false;
    }

    /** Protects an unsaved JSON working copy before selection-changing actions. */
    private confirmDiscardDirtyConfiguration(): boolean {
        if (!this.dirty) {
            return true;
        }
        const discard = window.confirm("Discard unsaved search style configuration changes?");
        if (discard) {
            this.dirty = false;
        }
        return discard;
    }
}
