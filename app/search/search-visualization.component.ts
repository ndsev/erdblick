import { ChangeDetectorRef, Component, Input, OnChanges, OnDestroy } from "@angular/core";
import { OverlayOptions } from "primeng/api";
import { Subscription } from "rxjs";
import { InfoMessageService } from "../diagnostics/info.service";
import { MapDataService } from "../mapdata/mapdata.service";
import { ErdblickStyle } from "../mapstyle/mapstyle.model";
import { MapStyleService } from "../mapstyle/mapstyle.service";
import { StyleEditorRequestService } from "../mapstyle/style-editor-request.service";
import { MapViewState } from "../mapview/mapview.state";
import type { FeatureSearchAutoStyleOption } from "./feature-search-auto-style.util";
import {
    defaultSearchStyleFieldOptionsForAnalysis,
    preferredSearchAutoStyleField,
    searchAutoStyleFieldOptions,
    searchAutoStyleFieldOptionsArePortable
} from "./feature-search-auto-style.util";
import type { FeatureSearchResolvedDefinition } from "./feature-search-runtime-state.model";
import { FeatureSearchSchemaService } from "./feature-search-schema.service";
import type {
    FeatureSearchMapLayerRef,
    FeatureSearchRenderStrategy,
    FeatureSearchScope,
    FeatureSearchStateEntry,
    FeatureSearchStyleRule
} from "./search-definition.model";
import {
    DEFAULT_FEATURE_SEARCH_LABEL_BACKGROUND_COLOR,
    DEFAULT_FEATURE_SEARCH_RENDER_STRATEGY
} from "./search-definition.model";
import type { FeatureSearchSession, FeatureSearchSessionSchemaAnalysis } from "./search-session.model";
import {
    autoInitializeSearchStyleColorDraft,
    DEFAULT_SEARCH_STYLE_SOLID_COLOR,
    defaultSearchStyleColorDraft,
    isNumericStyleValueKind,
    normalizeHexColor,
    SearchStyleColorDraft
} from "./search-style-color.util";
import {
    FeatureSearchStyleFilterDraft,
    FeatureSearchStyleRuleDraft,
    SearchStyleRuleDraftCodec
} from "./search-style-rule-editor.model";
import type { SearchStyleSaveRequest } from "./search-style-save-dialog.component";
import {
    convertSearchStyleRulesToYaml,
    projectStyleSourceForSearch,
    SearchStyleApplicationProjection
} from "./search-style-sheet.converter";
import type { FeatureSearchAttributeScopeCandidate, FeatureSearchStyleFieldCandidate } from "./search.model";
import { SearchValueSummariesState, SearchValueSummary } from "./search.model";
import { SearchService } from "./search.service";

type FeatureSearchStyleOption = FeatureSearchAutoStyleOption;

interface FeatureSearchSavedStyleOption {
    label: string;
    value: string;
    disabled: boolean;
    summary: string;
    projection?: SearchStyleApplicationProjection;
}
/** Owns one search's visualization drafts, schema field requests, and save workflow. */
@Component({selector: "search-visualization", standalone: false, host: {style: "display:contents"}, template: `                        <div class="feature-search-style-rules" data-testid="feature-search-style-rules">
                            <section class="feature-search-visualization-controls">
                                <div class="feature-search-style-control-group feature-search-density-map">
                                    <div class="feature-search-style-control-header feature-search-density-header">
                                        <p-toggleswitch [ngModel]="searchRenderStrategy().showLowFiDots"
                                                        inputId="feature-search-show-density-map"
                                                        ariaLabel="Toggle result density map"
                                                        (ngModelChange)="patchRenderStrategy('showLowFiDots', $event)">
                                        </p-toggleswitch>
                                        <h3>Result Density Map</h3>
                                        <p-colorpicker inputId="feature-search-density-color"
                                                       [ngModel]="session?.pointColor ?? '#ea4336'"
                                                       appendTo="body"
                                                       [overlayOptions]="featureSearchColorPickerOverlayOptions"
                                                       pTooltip="Density and pin color"
                                                       tooltipPosition="bottom"
                                                       (ngModelChange)="onSearchColorChange($event)">
                                        </p-colorpicker>
                                    </div>
                                    <div class="feature-search-density-map-grid">
                                        <label for="feature-search-show-density-labels">Density Labels</label>
                                        <p-toggleswitch [ngModel]="searchRenderStrategy().showBucketLabels"
                                                        inputId="feature-search-show-density-labels"
                                                        [disabled]="!searchRenderStrategy().showLowFiDots"
                                                        (ngModelChange)="patchRenderStrategy('showBucketLabels', $event)">
                                        </p-toggleswitch>

                                        <label for="feature-search-density-gradient">Gradient</label>
                                        <p-toggleswitch [ngModel]="searchRenderStrategy().densityHeatGradient"
                                                        inputId="feature-search-density-gradient"
                                                        [disabled]="!searchRenderStrategy().showLowFiDots"
                                                        (ngModelChange)="patchRenderStrategy('densityHeatGradient', $event)">
                                        </p-toggleswitch>
                                    </div>

                                    <div class="feature-search-density-size-row">
                                        <label for="feature-search-density-size">Marker Size</label>
                                        <div class="feature-search-density-size-control">
                                            <p-slider inputId="feature-search-density-size"
                                                      [ngModel]="searchRenderStrategy().densitySizeMultiplier"
                                                      (ngModelChange)="patchRenderStrategy('densitySizeMultiplier', $event)"
                                                      [min]="0.5"
                                                      [max]="3"
                                                      [step]="0.1"
                                                      [disabled]="!searchRenderStrategy().showLowFiDots">
                                            </p-slider>
                                            <span>{{ searchRenderStrategy().densitySizeMultiplier | number:'1.1-1' }}x</span>
                                        </div>
                                    </div>
                                </div>
                                <div class="feature-search-style-control-group feature-search-highfi-controls">
                                    <div class="feature-search-style-control-header feature-search-highfi-header">
                                        <p-toggleswitch [ngModel]="searchRenderStrategy().showHighFiGeometry"
                                                        inputId="feature-search-show-highfi-geometry"
                                                        data-testid="feature-search-show-highfi-geometry"
                                                        ariaLabel="Toggle styled result geometry"
                                                        (ngModelChange)="patchRenderStrategy('showHighFiGeometry', $event)">
                                        </p-toggleswitch>
                                        <h3>High-fi Visualization</h3>
                                        <div class="feature-search-style-control-header-actions">
                                            <p-select class="feature-search-saved-style-select"
                                                      [options]="searchStyleOptions"
                                                      [ngModel]="selectedSearchStyleId"
                                                      (ngModelChange)="applySearchStyle($event)"
                                                      size="small"
                                                      optionLabel="label"
                                                      optionValue="value"
                                                      optionDisabled="disabled"
                                                      placeholder="Saved styles"
                                                      [showClear]="true"
                                                      appendTo="body">
                                                <ng-template pTemplate="item" let-option>
                                                    <div class="feature-search-saved-style-option"
                                                         [class.incompatible]="option.disabled"
                                                         [title]="option.summary">
                                                        <span>{{ option.label }}</span>
                                                        <small>{{ option.summary }}</small>
                                                    </div>
                                                </ng-template>
                                            </p-select>
                                            <p-button class="feature-search-save-style-button"
                                                      data-testid="feature-search-save-style"
                                                      icon="pi pi-save"
                                                      label="Save"
                                                      size="small"
                                                      severity="secondary"
                                                      [outlined]="true"
                                                      pTooltip="Save high-fidelity rules as an imported search stylesheet"
                                                      tooltipPosition="bottom"
                                                      (click)="saveSearchStyle()">
                                            </p-button>
                                            <p-button class="feature-search-add-rule-button"
                                                      icon="pi pi-plus"
                                                      label="Add Rule"
                                                      size="small"
                                                      severity="secondary"
                                                      [outlined]="true"
                                                      (click)="addStyleRule()">
                                            </p-button>
                                        </div>
                                    </div>
                                    <div class="feature-search-highfi-grid">
                                        <label for="feature-search-show-highfi-pins">Per-feature result pins</label>
                                        <div class="feature-search-highfi-pin-controls">
                                            <p-toggleswitch [ngModel]="searchRenderStrategy().showHighFiResultDots"
                                                            inputId="feature-search-show-highfi-pins"
                                                            [disabled]="!searchRenderStrategy().showHighFiGeometry"
                                                            (ngModelChange)="patchRenderStrategy('showHighFiResultDots', $event)">
                                            </p-toggleswitch>
                                            <p-colorpicker inputId="feature-search-pin-color"
                                                           [ngModel]="session?.pointColor ?? '#ea4336'"
                                                           appendTo="body"
                                                           [overlayOptions]="featureSearchColorPickerOverlayOptions"
                                                           pTooltip="Density and pin color"
                                                           tooltipPosition="bottom"
                                                           (ngModelChange)="onSearchColorChange($event)">
                                            </p-colorpicker>
                                        </div>
                                    </div>
                                </div>
                            </section>
                            @if (searchStyleApplicationMessage) {
                                <div class="feature-search-style-application-message"
                                     [class.warning]="searchStyleApplicationWarning">
                                    {{ searchStyleApplicationMessage }}
                                </div>
                            }
                            <search-style-rule-editor
                                [drafts]="styleRuleDrafts"
                                (draftsChange)="onSharedStyleRuleDraftsChange($event)"
                                [fieldOptions]="styleScalarAttributeOptions"
                                [completionScope]="featureSearchScope"
                                [completionMapLayers]="session?.definition?.selectedMapLayers ?? []"
                                [completionZIndex]="featureSearchCompletionZIndex"
                                [completionOwnerPrefix]="'feature-search-style:' + searchId"
                                [colorPickerOverlayOptions]="featureSearchColorPickerOverlayOptions"
                                [dataSummaryStatus]="valueSummaries.status"
                                [valueSummaryForExpression]="valueSummaryForStyleExpressionCallback"
                                [showAddButton]="false"
                                (updateFromDataRequested)="onStyleColorDataUpdateRequested()">
                            </search-style-rule-editor>
                        </div>

        <search-style-save-dialog
            [visible]="searchStyleSaveVisible"
            (visibleChange)="onSearchStyleSaveVisibleChange($event)"
            [layerIds]="searchStyleSaveLayerIds"
            [initialLayerIds]="searchStyleSaveInitialLayerIds"
            [saving]="searchStyleSavePending"
            (saveRequested)="confirmSearchStyleSave($event)">
        </search-style-save-dialog>
`})
export class SearchVisualizationComponent implements OnChanges, OnDestroy {
    @Input({required: true}) searchId!: string;
    @Input() session?: Readonly<FeatureSearchSession>;
    @Input() definition?: FeatureSearchStateEntry;
    @Input() analysis?: FeatureSearchSessionSchemaAnalysis;
    @Input() active = false;
    @Input() summaries?: SearchValueSummariesState;
    @Input() featureSearchCompletionZIndex = 30050;
    private readonly subscriptions = new Subscription();
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private destroyed = false;
    private staticSessionSyncSignature = "";
    private readonly emptySummaries: SearchValueSummariesState = {status: "idle", revision: 0, processedTiles: 0, totalTiles: 0, resultFields: [], traces: []};
    get valueSummaries(): SearchValueSummariesState { return this.session?.results.valueSummaries ?? this.emptySummaries; }
    get featureSearchScope(): FeatureSearchScope { return this.session?.definition.scope ?? "auto"; }

    /** Reuses the existing style editors and converter; catalog observers belong to this dialog section. */
    constructor(public searchService: SearchService, public mapService: MapDataService,
        private readonly searchSchema: FeatureSearchSchemaService, private readonly styleService: MapStyleService,
        private readonly styleEditorRequestService: StyleEditorRequestService,
        private readonly infoMessageService: InfoMessageService, public readonly viewSettings: MapViewState,
        private readonly changeDetector: ChangeDetectorRef) {
        this.subscriptions.add(this.styleService.styleGroups.subscribe(() => this.scheduleRefresh()));
        this.subscriptions.add(this.mapService.maps$.subscribe(() => {
            this.styleAttributeOptionsSessionSignature = "";
            this.scheduleRefresh();
        }));
    }

    /** Defers auto-rule commits until the current Angular input check has finished. */
    ngOnChanges(): void { this.scheduleRefresh(); }

    /** Retires pending field responses and local editor schedules together. */
    ngOnDestroy(): void {
        this.destroyed = true;
        this.subscriptions.unsubscribe();
        if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
        if (this.styleAttributeOptionsRefreshTimer !== null) clearTimeout(this.styleAttributeOptionsRefreshTimer);
        this.styleAttributeOptionsSessionSignature = "";
    }

    /** Coalesces session/catalog changes without rebuilding drafts on every streamed result. */
    private scheduleRefresh(): void {
        if (this.destroyed || this.refreshTimer !== null) return;
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            const session = this.session;
            if (this.destroyed || !session || session.id !== this.searchId) return;
            this.changeDetector.markForCheck();
            this.refreshSearchStyleOptions();
            const signature = this.staticSessionSyncSignatureFor(session);
            const changed = signature !== this.staticSessionSyncSignature;
            if (changed) {
                this.staticSessionSyncSignature = signature;
                this.syncStyleRulesFromSession(session.definition.searchStyleRules ?? []);
            }
            const hasRules = (session.definition.searchStyleRules?.length ?? 0) > 0;
            const fieldsScheduled = this.refreshStyleAttributeOptionsIfNeeded(session, hasRules);
            if (changed && !fieldsScheduled) {
                if (hasRules && this.applyDefaultStyleFieldIfMissing()) this.onStyleRulesChanged();
                else if (!hasRules) this.tryCreateAutoStyleRule(session);
            }
        }, 0);
    }

    /** Requests native summaries through the controller when a color editor needs data. */
    private requestDiagnosticsValueSummaries(): void {
        if (this.session) this.searchService.requestValueSummaries(this.session.id);
    }

    /** Creates one empty rule condition using the current schema-backed default field when available. */
    private createDefaultStyleFilter(): FeatureSearchStyleFilterDraft {
        const field = this.defaultStyleField();
        return {
            id: this.nextStyleConditionId++,
            attributeField: field,
            customExpression: false,
            operator: '>',
            filterValue: this.defaultFilterValue(field)
        };
    }

    /** Returns the first currently valid result-field path for newly created controls. */
    private defaultStyleField(): string {
        return this.defaultStyleFieldOption()?.value ?? "";
    }

    /** Returns the preferred schema field for initial style rules and new filter conditions. */
    private defaultStyleFieldOption(session = this.session): FeatureSearchStyleOption | undefined {
        const options = this.defaultStyleFieldOptionsForSession(session);
        return preferredSearchAutoStyleField(options, session?.schemaAnalysis)
            ?? options[0]
            ?? (session?.schemaAnalysis.status === "ready" ? undefined : this.styleScalarAttributeOptions[0]);
    }

    /** Limits automatic defaults to fields that belong to the resolved query scope. */
    private defaultStyleFieldOptionsForSession(session: FeatureSearchSession | undefined): FeatureSearchStyleOption[] {
        return defaultSearchStyleFieldOptionsForAnalysis(
            this.styleScalarAttributeOptions,
            session?.schemaAnalysis);
    }

    styleScalarAttributeOptions: FeatureSearchStyleOption[] = [];

    private nextStyleConditionId = 1;

    /** Returns a non-destructive default filter value for the selected field type. */
    private defaultFilterValue(field: string): unknown {
        const option = this.styleFieldOption(field);
        if (isNumericStyleValueKind(option?.valueKind)) {
            return 80;
        }
        return option?.enumValues?.[0] ?? "";
    }

    private styleFieldOption(field: string): FeatureSearchStyleOption | undefined {
        return this.styleAttributeOptions.find(option => option.value === field);
    }

    styleAttributeOptions: FeatureSearchStyleOption[] = [];

    /** Creates the editor draft for a new search-result style rule. */
    private createStyleRule(
        id: number,
        fieldOption: FeatureSearchStyleOption | null | undefined = this.defaultStyleFieldOption()
    ): FeatureSearchStyleRuleDraft {
        return {
            id,
            name: "",
            filters: [],
            visualization: ['any'],
            lineWidth: 5,
            pointRadius: 20,
            opacity: 60,
            labelExpression: fieldOption?.value ?? this.defaultStyleField(),
            labelCustomExpression: false,
            labelBackgroundColor: DEFAULT_FEATURE_SEARCH_LABEL_BACKGROUND_COLOR,
            color: this.createDefaultStyleColorDraft(fieldOption)
        };
    }

    /** Creates a schema-initialized color draft for a new rule when possible. */
    private createDefaultStyleColorDraft(fieldOption: FeatureSearchStyleOption | null | undefined): SearchStyleColorDraft {
        const field = fieldOption?.value ?? "";
        const mode = this.defaultColorModeForField(fieldOption);
        const draft: SearchStyleColorDraft = {
            ...defaultSearchStyleColorDraft(field),
            mode
        };
        if (mode === "solid") {
            return draft;
        }
        return autoInitializeSearchStyleColorDraft(
            draft,
            fieldOption ?? undefined,
            () => this.nextStyleColorStopId++
        ).draft;
    }

    /** Chooses the initial color mode from schema metadata. */
    private defaultColorModeForField(fieldOption: FeatureSearchStyleOption | null | undefined): "solid" | "gradient" | "categories" {
        if (fieldOption?.valueKind === "enum") {
            return "categories";
        }
        if (isNumericStyleValueKind(fieldOption?.valueKind)) {
            return "gradient";
        }
        return "solid";
    }

    private nextStyleColorStopId = 1;

    private isScalarStyleField(option: FeatureSearchStyleOption): boolean {
        return option.valueKind !== "object" && option.valueKind !== "array";
    }

    protected filterFieldIsNumeric(filter: FeatureSearchStyleFilterDraft): boolean {
        return isNumericStyleValueKind(this.styleFieldOption(filter.attributeField)?.valueKind);
    }

    protected filterFieldEnumOptions(filter: FeatureSearchStyleFilterDraft): Array<{ label: string; value: string }> {
        return (this.styleFieldOption(filter.attributeField)?.enumValues ?? []).map(value => ({ label: value, value }));
    }

    protected styleOperatorOptionsForFilter(filter: FeatureSearchStyleFilterDraft): FeatureSearchStyleOption[] {
        if (filter.customExpression) {
            return this.styleOperatorOptions;
        }
        if (this.filterFieldIsNumeric(filter)) {
            return this.styleOperatorOptions;
        }
        return this.styleOperatorOptions.filter(option => ["=", "!=", "contains"].includes(option.value));
    }

    styleOperatorOptions: FeatureSearchStyleOption[] = [
        { label: '>', value: '>' },
        { label: '>=', value: '>=' },
        { label: '=', value: '=' },
        { label: '!=', value: '!=' },
        { label: '<=', value: '<=' },
        { label: '<', value: '<' },
        { label: 'contains', value: 'contains' }
    ];

    protected setStyleFilterExpressionMode(
        rule: FeatureSearchStyleRuleDraft,
        filter: FeatureSearchStyleFilterDraft,
        mode: "field" | "custom"
    ): void {
        const customExpression = mode === "custom";
        if (!customExpression
            && (this.fieldNeedsDefault(filter.attributeField) || this.fieldMissingFromPicker(filter.attributeField))) {
            const field = this.defaultStyleField();
            filter.attributeField = field;
            filter.filterValue = this.defaultFilterValue(field);
        }
        filter.customExpression = customExpression;
        this.markStyleRuleEdited(rule);
    }

    /** Returns whether an editor field should be replaced by a schema-backed default. */
    private fieldNeedsDefault(field: string): boolean {
        return !field;
    }

    /** Returns whether a non-empty field is not one of the currently selectable scalar schema fields. */
    private fieldMissingFromPicker(field: string): boolean {
        const scalarOptions = this.styleScalarAttributeOptions;
        return !!field
            && scalarOptions.length > 0
            && !scalarOptions.some(option => option.value === field);
    }

    /** Marks an automatic rule as user-owned before persisting a control edit. */
    protected markStyleRuleEdited(rule: FeatureSearchStyleRuleDraft): void {
        rule.autoGenerated = false;
        this.onStyleRulesChanged();
    }

    /** Serializes the editor drafts into persisted search style rules if the semantic value changed. */
    protected onStyleRulesChanged(): void {
        const session = this.session;
        if (!session) {
            return;
        }
        const searchStyleRules = this.serializeStyleRuleDrafts();
        const signature = JSON.stringify(searchStyleRules);
        if (signature === this.styleRulesStateSignature) {
            return;
        }
        this.styleRulesStateSignature = signature;
        if (this.selectedSearchStyleId) {
            this.searchStyleApplicationMessage = "The applied stylesheet was copied into this search; these rules are now customized.";
            this.searchStyleApplicationWarning = false;
        }
        this.selectedSearchStyleId = null;
        this.searchService.state.patchFeatureSearch(session.id, { searchStyleRules });
    }

    /** Serializes drafts through the same lossless adapter used by the standalone editor. */
    private serializeStyleRuleDrafts(): FeatureSearchStyleRule[] {
        this.styleRuleDraftCodec.setFieldOptions(this.styleScalarAttributeOptions);
        return this.styleRuleDraftCodec.fromDrafts(this.styleRuleDrafts);
    }

    private readonly styleRuleDraftCodec = new SearchStyleRuleDraftCodec();

    styleRuleDrafts: FeatureSearchStyleRuleDraft[] = [];

    private styleRulesStateSignature = "";

    selectedSearchStyleId: string | null = null;

    searchStyleApplicationMessage = "";

    searchStyleApplicationWarning = false;

    /** Switches one filter row between picker-backed fields and a custom SIMFIL expression. */
    protected toggleStyleFilterExpressionMode(
        rule: FeatureSearchStyleRuleDraft,
        filter: FeatureSearchStyleFilterDraft
    ): void {
        this.setStyleFilterExpressionMode(rule, filter, filter.customExpression ? "field" : "custom");
    }

    protected setStyleFilterExpression(
        rule: FeatureSearchStyleRuleDraft,
        filter: FeatureSearchStyleFilterDraft,
        expression: string
    ): void {
        filter.attributeField = expression ?? "";
        filter.customExpression = true;
        this.markStyleRuleEdited(rule);
    }

    /** Returns an isolated completion owner id for one custom style filter expression. */
    protected styleFilterCompletionOwnerId(filter: FeatureSearchStyleFilterDraft): string {
        return `feature-search-style-filter:${this.searchId}:${filter.id}`;
    }

    /** Adds a new style rule to the top of the editor and persists it immediately. */
    protected addStyleRule(): void {
        const rule = this.createStyleRule(this.nextStyleRuleId++);
        const panelValue = this.styleRulePanelValue(rule);
        this.styleRuleDrafts = [rule, ...this.styleRuleDrafts];
        this.styleRuleAccordionValue = [panelValue];
        this.onStyleRulesChanged();
    }

    private nextStyleRuleId = 1;

    /** Returns the stable accordion key for one draft rule. */
    protected styleRulePanelValue(rule: FeatureSearchStyleRuleDraft): string {
        return `${rule.id}`;
    }

    styleRuleAccordionValue: string[] = [];

    /** Deletes one style rule draft and persists the remaining rule list. */
    protected deleteStyleRule(rule: FeatureSearchStyleRuleDraft): void {
        const panelValue = this.styleRulePanelValue(rule);
        this.styleRuleDrafts = this.styleRuleDrafts.filter(candidate => candidate.id !== rule.id);
        this.styleRuleAccordionValue = this.styleRuleAccordionValue.filter(value => value !== panelValue);
        this.onStyleRulesChanged();
    }

    /** Adds a filter condition to one rule draft. */
    protected addStyleCondition(rule: FeatureSearchStyleRuleDraft): void {
        rule.filters = [...rule.filters, this.createDefaultStyleFilter()];
        this.markStyleRuleEdited(rule);
    }

    /** Deletes one filter condition from one rule draft. */
    protected deleteStyleCondition(rule: FeatureSearchStyleRuleDraft, filter: FeatureSearchStyleFilterDraft): void {
        rule.filters = rule.filters.filter(candidate => candidate.id !== filter.id);
        this.markStyleRuleEdited(rule);
    }

    /** Persists one normalized color draft emitted by the search-local color editor. */
    protected onRuleColorDraftChange(rule: FeatureSearchStyleRuleDraft, color: SearchStyleColorDraft): void {
        rule.color = color;
        this.markStyleRuleEdited(rule);
    }

    /** Persists an optional user-facing name for one style rule. */
    protected setStyleRuleName(rule: FeatureSearchStyleRuleDraft, value: string): void {
        rule.name = value ?? "";
        this.markStyleRuleEdited(rule);
    }

    /** Resets one rule draft to the default visual style while preserving its UI identity. */
    protected resetStyleRule(rule: FeatureSearchStyleRuleDraft): void {
        const resetRule = this.createStyleRule(rule.id);
        this.styleRuleDrafts = this.styleRuleDrafts.map(candidate =>
            candidate.id === rule.id ? resetRule : candidate
        );
        this.markStyleRuleEdited(resetRule);
    }

    /** Replaces all search-result style rules with one fresh default rule. */
    protected resetStyleRules(): void {
        this.nextStyleRuleId = 1;
        this.nextStyleConditionId = 1;
        this.nextStyleColorStopId = 1;
        const rule = this.createStyleRule(this.nextStyleRuleId++);
        this.styleRuleDrafts = [rule];
        this.styleRuleAccordionValue = [this.styleRulePanelValue(rule)];
        this.onStyleRulesChanged();
    }

    /** Accepts detached drafts emitted by the reusable rule editor. */
    protected onSharedStyleRuleDraftsChange(drafts: FeatureSearchStyleRuleDraft[]): void {
        this.styleRuleDrafts = drafts;
        this.onStyleRulesChanged();
    }

    /** Rebuilds dropdown compatibility from the current authoritative imported YAML sources. */
    private refreshSearchStyleOptions(): void {
        const scope = this.resolvedStyleSearchScope();
        const searchStyles: ErdblickStyle[] = [...this.styleService.styles.values()]
            .filter(style => style.category === "search")
            .sort((left, right) => left.id.localeCompare(right.id));
        this.searchStyleOptions = searchStyles.map(style => {
            try {
                const projection = projectStyleSourceForSearch(style.source, scope);
                const disabled = projection.rules.length === 0;
                const summary = disabled
                    ? projection.omissions[0]?.message ?? "No compatible rules."
                    : projection.omissions.length
                        ? `${projection.rules.length} of ${projection.totalRuleCount} rules can be applied.`
                        : `${projection.rules.length} compatible rule${projection.rules.length === 1 ? "" : "s"}.`;
                return { label: style.id, value: style.id, disabled, summary, projection };
            } catch (error) {
                return {
                    label: style.id,
                    value: style.id,
                    disabled: true,
                    summary: error instanceof Error ? error.message : String(error)
                };
            }
        });
        if (this.selectedSearchStyleId
            && !this.searchStyleOptions.some(option => option.value === this.selectedSearchStyleId && !option.disabled)) {
            this.selectedSearchStyleId = null;
        }
    }

    /** Resolves pending Auto scope conservatively to the same feature fallback used by search runtime setup. */
    private resolvedStyleSearchScope(): "feature" | "attribute" {
        if (this.session?.schemaAnalysis.status === "ready") {
            return this.session.schemaAnalysis.concreteScope;
        }
        return this.featureSearchScope === "attribute" ? "attribute" : "feature";
    }

    searchStyleOptions: FeatureSearchSavedStyleOption[] = [];

    /** Applies compatible rules from an authoritative imported search stylesheet as a detached copy. */
    protected applySearchStyle(styleId: string | null): void {
        if (!styleId || !this.session) {
            this.selectedSearchStyleId = null;
            this.searchStyleApplicationMessage = "";
            return;
        }
        const style = this.styleService.styles.get(styleId);
        if (!style || style.category !== "search") {
            this.infoMessageService.showError("The selected search stylesheet is no longer available.");
            this.changeDetector.markForCheck();
            this.refreshSearchStyleOptions();
            return;
        }
        let projection: SearchStyleApplicationProjection;
        try {
            projection = this.searchStyleOptions.find(option => option.value === styleId)?.projection
                ?? projectStyleSourceForSearch(style.source, this.resolvedStyleSearchScope());
        } catch (error) {
            this.infoMessageService.showError(error instanceof Error ? error.message : String(error));
            this.changeDetector.markForCheck();
            this.refreshSearchStyleOptions();
            return;
        }
        if (!projection.rules.length) {
            this.infoMessageService.showError("This stylesheet has no rules compatible with the current search scope and rules GUI.");
            this.changeDetector.markForCheck();
            this.refreshSearchStyleOptions();
            return;
        }
        const detachedRules = structuredClone(projection.rules);
        this.styleRuleDrafts = this.styleRuleDraftCodec.toDrafts(detachedRules);
        this.styleRulesStateSignature = JSON.stringify(detachedRules);
        this.searchService.state.patchFeatureSearch(this.session.id, { searchStyleRules: detachedRules });
        this.selectedSearchStyleId = styleId;
        this.searchStyleApplicationWarning = projection.omissions.length > 0;
        this.searchStyleApplicationMessage = projection.omissions.length
            ? `Applied ${projection.rules.length} of ${projection.totalRuleCount} rules. Omitted ${projection.omissions.map(item => item.message).join(" ")}`
            : `Applied all ${projection.rules.length} rules from “${style.id}” as a detached copy.`;
    }

    /** Captures resolved membership and visual rules before opening the save dialog. */
    protected saveSearchStyle(): void {
        const rules = this.serializeStyleRuleDrafts();
        if (!rules.length) {
            this.infoMessageService.showError("Add at least one high-fidelity rule before saving a search stylesheet.");
            return;
        }
        if (!this.session) {
            return;
        }
        try {
            this.pendingSearchStyle = this.searchService.getStyleExportSnapshot(this.session.id, rules);
        } catch (error) {
            this.infoMessageService.showError(error instanceof Error ? error.message : String(error));
            return;
        }
        this.searchStyleSaveLayerIds = Array.from(new Set(
            Array.from(this.mapService.maps.allFeatureLayers(), layer => layer.id)
                .filter(layerId => layerId.length > 0)
        )).sort();
        this.searchStyleSaveInitialLayerIds = Array.from(new Set(
            this.pendingSearchStyle.selectedMapLayers.map(layer => layer.layerId)
        )).sort();
        this.searchStyleSaveVisible = true;
    }

    private pendingSearchStyle?: FeatureSearchResolvedDefinition;

    protected searchStyleSaveLayerIds: string[] = [];

    protected searchStyleSaveInitialLayerIds: string[] = [];

    protected searchStyleSaveVisible = false;

    /** Persists one dialog payload through the ordinary transactional style import path. */
    protected confirmSearchStyleSave(request: Readonly<SearchStyleSaveRequest>): void {
        if (this.searchStyleSavePending || !this.searchStyleSaveVisible || !this.pendingSearchStyle) {
            return;
        }
        const { options, action } = request;
        const conflict = this.styleService.styleIdentityConflict(options.name);
        if (conflict) {
            this.infoMessageService.showError(
                `A style named or resolved by “${options.name}” already exists. Edit that style or choose another name.`);
            return;
        }
        this.searchStyleSavePending = true;
        try {
            const generated = convertSearchStyleRulesToYaml(
                options, this.pendingSearchStyle.searchStyleRules, this.pendingSearchStyle);
            const importedStyleId = this.styleService.importStyleYamlSource(
                generated.source,
                options.defaultEnabled);
            if (!importedStyleId) {
                return;
            }
            this.selectedSearchStyleId = importedStyleId;
            this.searchStyleApplicationWarning = false;
            this.searchStyleApplicationMessage = `Saved “${importedStyleId}” as an imported search stylesheet. This search remains a detached copy.`;
            this.infoMessageService.showSuccess(`Saved search stylesheet “${importedStyleId}”.`);
            this.searchStyleSaveVisible = false;
            this.pendingSearchStyle = undefined;
            if (action === "save-and-open") {
                queueMicrotask(() => this.styleEditorRequestService.open(importedStyleId));
            }
        } catch (error) {
            this.infoMessageService.showError(error instanceof Error ? error.message : String(error));
        } finally {
            this.searchStyleSavePending = false;
        }
    }

    protected searchStyleSavePending = false;

    protected onSearchStyleSaveVisibleChange(visible: boolean): void {
        this.searchStyleSaveVisible = visible;
        if (!visible && !this.searchStyleSavePending) {
            this.pendingSearchStyle = undefined;
        }
    }

    /** Returns the current search rendering controls with defaults for older persisted states. */
    protected searchRenderStrategy(): FeatureSearchRenderStrategy {
        return this.session?.definition.renderStrategy ?? DEFAULT_FEATURE_SEARCH_RENDER_STRATEGY;
    }

    /** Persists one render-strategy control while preserving the other rendering choices. */
    protected patchRenderStrategy<K extends keyof FeatureSearchRenderStrategy>(
        key: K,
        value: FeatureSearchRenderStrategy[K]
    ): void {
        const session = this.session;
        if (!session) {
            return;
        }
        const nextValue = this.normalizedRenderStrategyValue(key, value);
        const renderStrategy: FeatureSearchRenderStrategy = { ...this.searchRenderStrategy() };
        renderStrategy[key] = nextValue;
        if (key === "showHighFiGeometry" && nextValue === false) {
            renderStrategy.showHighFiResultDots = false;
        }
        this.searchService.state.patchFeatureSearch(session.id, {
            renderStrategy
        });
    }

    /** Normalizes one render-strategy form value before writing it to app state. */
    private normalizedRenderStrategyValue<K extends keyof FeatureSearchRenderStrategy>(
        key: K,
        value: FeatureSearchRenderStrategy[K]
    ): FeatureSearchRenderStrategy[K] {
        if (key === "highFidelityMaxVisibleTiles") {
            return this.clampNumber(
                value,
                1,
                65536,
                DEFAULT_FEATURE_SEARCH_RENDER_STRATEGY.highFidelityMaxVisibleTiles
            ) as FeatureSearchRenderStrategy[K];
        }
        if (key === "densitySizeMultiplier") {
            return this.clampNumber(
                value,
                0.5,
                3,
                DEFAULT_FEATURE_SEARCH_RENDER_STRATEGY.densitySizeMultiplier
            ) as FeatureSearchRenderStrategy[K];
        }
        return (!!value) as FeatureSearchRenderStrategy[K];
    }

    /** Parses and clamps one numeric UI value, keeping a stable fallback for incomplete form edits. */
    private clampNumber(value: unknown, min: number, max: number, fallback: number): number {
        const numberValue = Number(value);
        return Number.isFinite(numberValue)
            ? Math.min(max, Math.max(min, numberValue))
            : fallback;
    }

    /** Rebuilds local editor drafts from the persisted search style rules. */
    private syncStyleRulesFromSession(rules: FeatureSearchStyleRule[]): void {
        const signature = JSON.stringify(rules ?? []);
        if (signature === this.styleRulesStateSignature) {
            return;
        }
        const previousPanelValues = this.styleRuleAccordionValue;
        this.styleRulesStateSignature = signature;
        this.styleRuleDraftCodec.setFieldOptions(this.styleScalarAttributeOptions);
        this.styleRuleDrafts = this.styleRuleDraftCodec.toDrafts(rules);
        this.nextStyleRuleId = Math.max(1, ...this.styleRuleDrafts.map(rule => rule.id + 1));
        this.nextStyleConditionId = Math.max(1, ...this.styleRuleDrafts.flatMap(rule =>
            rule.filters.map(filter => filter.id + 1)));
        this.nextStyleColorStopId = Math.max(1, ...this.styleRuleDrafts.flatMap(rule => [
            ...rule.color.gradientStops.map(stop => stop.id + 1),
            ...rule.color.categoryStops.map(stop => stop.id + 1)
        ]));
        const availablePanels = new Set(this.styleRuleDrafts.map(rule => this.styleRulePanelValue(rule)));
        this.styleRuleAccordionValue = previousPanelValues.filter(value => availablePanels.has(value));
    }

    /**
     * Refreshes the style-rule field picker from schema metadata.
     *
     * Existing drafts keep their current raw values, but invalid values are not
     * reintroduced into the picker; this prevents old demo fields from staying selectable.
     */
    private refreshStyleAttributeOptions(session: FeatureSearchSession, patchMissingFields = true): void {
        const signature = this.styleAttributeOptionsSessionSignature;
        this.searchSchema.requestSearchStyleFields(
            session.definition.query,
            this.styleFieldRequestScope(session),
            session.definition.selectedMapLayers
        ).then(rawOptions => {
            if (this.destroyed || this.session?.id !== session.id || signature !== this.styleAttributeOptionsSessionSignature) {
                return;
            }
            const currentSession = this.session?.id === session.id
                ? this.session
                : this.searchService.getSession(session.id);
            if (this.destroyed || !currentSession) {
                this.styleAttributeOptionsLoading = false;
                return;
            }
            this.applyStyleAttributeOptions(currentSession, rawOptions, patchMissingFields);
            this.changeDetector.markForCheck();
        });
    }

    private styleAttributeOptionsSessionSignature = "";

    /** Uses resolved schema analysis for style fields once available; raw `auto` is only a pending fallback. */
    private styleFieldRequestScope(session: FeatureSearchSession): FeatureSearchScope {
        return session.schemaAnalysis.status === "ready"
            ? session.schemaAnalysis.concreteScope
            : session.definition.scope;
    }

    styleAttributeOptionsLoading = false;

    /** Applies worker-produced schema field candidates to the style-field dropdowns. */
    private applyStyleAttributeOptions(
        session: FeatureSearchSession,
        rawOptions: FeatureSearchStyleFieldCandidate[],
        patchMissingFields: boolean
    ): void {
        const activeOptions = rawOptions.filter(option => this.isStyleFieldCandidateActive(option.mapId, option.layerId));
        const sourceOptions = activeOptions.length ? activeOptions : rawOptions;
        const byValue = new Map<string, { option: FeatureSearchStyleOption, contexts: Set<string> }>();
        for (const option of sourceOptions) {
            const key = this.searchStyleFieldAggregationKey(option);
            let entry = byValue.get(key);
            if (!entry) {
                entry = {
                    option: {
                        label: option.path,
                        value: option.path,
                        mapId: option.mapId,
                        layerId: option.layerId,
                        attrName: option.attrName,
                        attrLayerName: option.attrLayerName,
                        featureType: option.featureType,
                        valueKind: option.valueKind,
                        enumValues: option.enumValues,
                        numericRange: option.numericRange,
                        mapLayers: [{
                            mapId: option.mapId,
                            layerId: option.layerId
                        }]
                    },
                    contexts: new Set<string>()
                };
                byValue.set(key, entry);
            }
            this.mergeSearchStyleFieldMetadata(entry.option, option);
            const context = this.searchStyleFieldContextLabel(option);
            if (context) {
                entry.contexts.add(context);
            }
        }
        const nextOptions = Array.from(byValue.values())
            .map(entry => ({
                ...entry.option,
                label: this.searchStyleFieldOptionLabel(entry.option.value, entry.contexts)
            }))
            .sort((lhs, rhs) =>
                this.searchStyleFieldSortRank(lhs) - this.searchStyleFieldSortRank(rhs)
                || lhs.label.localeCompare(rhs.label));
        if (JSON.stringify(nextOptions) !== JSON.stringify(this.styleAttributeOptions)) {
            this.styleAttributeOptions = nextOptions;
        }
        const nextScalarOptions = nextOptions.filter(option => this.isScalarStyleField(option));
        if (JSON.stringify(nextScalarOptions) !== JSON.stringify(this.styleScalarAttributeOptions)) {
            this.styleScalarAttributeOptions = nextScalarOptions;
        }
        this.styleAttributeOptionsLoading = false;
        if (this.shouldRefreshAutoStyleRule()) {
            this.refreshAutoStyleRule(session);
            return;
        }
        if ((session.definition.searchStyleRules?.length ?? 0) === 0) {
            this.tryCreateAutoStyleRule(session);
            return;
        }
        if (patchMissingFields
            && (session.definition.searchStyleRules?.length ?? 0) > 0
            && this.applyDefaultStyleFieldIfMissing()) {
            this.onStyleRulesChanged();
        }
    }

    /** Returns whether a field candidate belongs to a currently visible map/layer context. */
    private isStyleFieldCandidateActive(mapId: string, layerId: string): boolean {
        for (let viewIndex = 0; viewIndex < this.viewSettings.numViews; ++viewIndex) {
            if (this.mapService.maps.getMapLayerVisibility(viewIndex, mapId, layerId)) {
                return true;
            }
        }
        return false;
    }

    /** Merges the same semantic attribute field across attribute and source layers. */
    private searchStyleFieldAggregationKey(option: FeatureSearchStyleFieldCandidate): string {
        return option.attrName
            ? [
                option.path,
                option.attrName
            ].join("\n")
            : option.path;
    }

    /** Merges schema metadata from every selected layer that exposes the same result-field path. */
    private mergeSearchStyleFieldMetadata(
        target: FeatureSearchStyleOption,
        source: FeatureSearchStyleFieldCandidate
    ): void {
        target.valueKind = this.mergedStyleFieldValueKind(target.valueKind, source.valueKind);
        const enumValues = new Set([...(target.enumValues ?? []), ...(source.enumValues ?? [])]);
        target.enumValues = Array.from(enumValues).sort();
        if (source.numericRange) {
            target.numericRange = target.numericRange
                ? {
                    min: Math.min(target.numericRange.min, source.numericRange.min),
                    max: Math.max(target.numericRange.max, source.numericRange.max)
                }
                : { ...source.numericRange };
        }
        if (target.featureType !== source.featureType) {
            // A shared path across feature types cannot use one portable type
            // guard; retain no misleading source-specific discriminator.
            target.featureType = undefined;
        }
        if (target.attrLayerName !== source.attrLayerName) {
            target.attrLayerName = undefined;
        }
        const mapLayers = target.mapLayers ?? [];
        if (!mapLayers.some(ref =>
            ref.mapId === source.mapId &&
            ref.layerId === source.layerId)) {
            mapLayers.push({ mapId: source.mapId, layerId: source.layerId });
            mapLayers.sort((left, right) =>
                left.mapId.localeCompare(right.mapId) ||
                left.layerId.localeCompare(right.layerId));
        }
        target.mapLayers = mapLayers;
    }

    /** Keeps enum and numeric metadata useful when the same path appears in several schemas. */
    private mergedStyleFieldValueKind(
        lhs: FeatureSearchStyleOption["valueKind"],
        rhs: FeatureSearchStyleFieldCandidate["valueKind"]
    ): FeatureSearchStyleOption["valueKind"] {
        if (lhs === rhs) {
            return lhs;
        }
        if (lhs === "enum" || rhs === "enum") {
            return "enum";
        }
        if (isNumericStyleValueKind(lhs) && isNumericStyleValueKind(rhs)) {
            return lhs === "number" || rhs === "number" ? "number" : "integer";
        }
        return lhs === "unknown" ? rhs : lhs;
    }

    /** Returns the attribute context suffix shown in search-style field pickers. */
    private searchStyleFieldContextLabel(option: FeatureSearchStyleFieldCandidate): string {
        if (!option.attrName) {
            return "";
        }
        const layerPrefix = option.attrLayerName ? `${option.attrLayerName}.` : "";
        return option.featureType
            ? `${layerPrefix}${option.attrName}/${option.featureType}`
            : `${layerPrefix}${option.attrName}`;
    }

    /** Builds a field-picker label that makes multi-attribute scope explicit. */
    private searchStyleFieldOptionLabel(path: string, contexts: Set<string>): string {
        if (contexts.size === 0) {
            return path;
        }
        const sortedContexts = Array.from(contexts).sort();
        if (sortedContexts.length === 1) {
            return `${path} (${sortedContexts[0]})`;
        }
        return `${path} (${sortedContexts.length} scopes)`;
    }

    /** Keeps generated `$...` overlay fields below native schema fields in dropdowns. */
    private searchStyleFieldSortRank(option: FeatureSearchStyleOption): number {
        return option.value.startsWith("$") ? 1 : 0;
    }

    /** Returns whether all existing style rules still belong to automatic query-derived styling. */
    private shouldRefreshAutoStyleRule(): boolean {
        return this.styleRuleDrafts.length > 0 && this.styleRuleDrafts.every(rule => rule.autoGenerated === true);
    }

    /** Rebuilds automatic rules after the query or selected layer context changes. */
    private refreshAutoStyleRule(session: FeatureSearchSession): boolean {
        if (!this.shouldRefreshAutoStyleRule()) {
            return false;
        }
        const existingIds = this.styleRuleDrafts.map(rule => rule.id);
        this.styleRuleDrafts = this.createAutoStyleRules(session, existingIds);
        this.styleRuleAccordionValue = [];
        this.onStyleRulesChanged();
        return true;
    }

    /**
     * Creates point and non-point variants for each differentiated auto style,
     * or two generic variants matching the search color when no field is safe.
     */
    private createAutoStyleRules(session: FeatureSearchSession, existingIds: number[] = []): FeatureSearchStyleRuleDraft[] {
        const fieldOptions = this.autoStyleFieldOptions(session);
        const portableFieldOptions = fieldOptions.length > 0
            && searchAutoStyleFieldOptionsArePortable(fieldOptions, session.schemaAnalysis)
            ? fieldOptions
            : [null];
        const rules: FeatureSearchStyleRuleDraft[] = [];
        for (const fieldOption of portableFieldOptions) {
            const pointRule = fieldOption
                ? this.createAutoStyleRule(existingIds[rules.length] ?? this.nextStyleRuleId++, fieldOption)
                : this.createSolidAutoStyleRule(existingIds[rules.length] ?? this.nextStyleRuleId++, session);
            pointRule.name += " (points)";
            pointRule.visualization = ["point"];
            pointRule.pointRadius = 20;
            rules.push(pointRule);

            const geometryRule = fieldOption
                ? this.createAutoStyleRule(existingIds[rules.length] ?? this.nextStyleRuleId++, fieldOption)
                : this.createSolidAutoStyleRule(existingIds[rules.length] ?? this.nextStyleRuleId++, session);
            geometryRule.name += " (lines/surfaces)";
            geometryRule.visualization = ["line", "surface"];
            geometryRule.lineWidth = 5;
            rules.push(geometryRule);
        }
        return rules;
    }

    /** Selects all schema fields that should get an automatically generated style rule. */
    private autoStyleFieldOptions(session: FeatureSearchSession): FeatureSearchStyleOption[] {
        return searchAutoStyleFieldOptions(this.styleScalarAttributeOptions, session.schemaAnalysis);
    }

    /** Creates one collapsed automatic style rule for the selected schema field. */
    private createAutoStyleRule(id: number, fieldOption: FeatureSearchStyleOption): FeatureSearchStyleRuleDraft {
        const rule = this.createStyleRule(id, fieldOption);
        rule.name = this.autoStyleRuleName(fieldOption);
        rule.autoGenerated = true;
        if (fieldOption.attrName) {
            rule.filters = [{
                id: this.nextStyleConditionId++,
                attributeField: "$name",
                customExpression: false,
                operator: "=",
                filterValue: fieldOption.attrName
            }];
            if (fieldOption.featureType) {
                rule.filters.push({
                    id: this.nextStyleConditionId++,
                    attributeField: `$feature.typeId == ${JSON.stringify(fieldOption.featureType)}`,
                    customExpression: true,
                    operator: "=",
                    filterValue: true
                });
            }
        }
        return rule;
    }

    /** Returns a portable user-facing name without embedding a source map or layer identity. */
    private autoStyleRuleName(fieldOption: FeatureSearchStyleOption): string {
        const context = fieldOption.attrName
            ? `${fieldOption.attrName}.${fieldOption.value}`
            : fieldOption.value;
        return `Auto: ${context}`;
    }

    /** Creates one generic auto-generated rule that does not depend on schema field enumeration. */
    private createSolidAutoStyleRule(id: number, session: FeatureSearchSession): FeatureSearchStyleRuleDraft {
        const rule = this.createStyleRule(id, null);
        const solidColor = this.searchColorForAutoStyle(session);
        rule.name = "Auto: solid";
        rule.autoGenerated = true;
        rule.color = {
            ...rule.color,
            mode: "solid",
            solidColor,
            fallbackColor: solidColor
        };
        return rule;
    }

    /** Returns the color shared by density markers, pins, and generic automatic style rules. */
    private searchColorForAutoStyle(session: FeatureSearchSession): string {
        return normalizeHexColor(session.pointColor || session.definition.pinColor, DEFAULT_SEARCH_STYLE_SOLID_COLOR);
    }

    /** Creates the initial schema-backed style rule for a search that has no explicit rules yet. */
    private tryCreateAutoStyleRule(session: FeatureSearchSession): boolean {
        if (!this.shouldAttemptAutoStyleRule(session)) {
            return false;
        }
        this.autoStyleRuleAttemptSignatures.add(this.autoStyleRuleAttemptSignature(session));
        this.styleRuleDrafts = this.createAutoStyleRules(session);
        this.styleRuleAccordionValue = [];
        this.onStyleRulesChanged();
        return true;
    }

    /** Returns whether this session still needs its one-shot automatic style rule attempt. */
    private shouldAttemptAutoStyleRule(session: FeatureSearchSession): boolean {
        return (session.definition.searchStyleRules?.length ?? 0) === 0
            && session.schemaAnalysis.status === "ready"
            && !this.autoStyleRuleAttemptSignatures.has(this.autoStyleRuleAttemptSignature(session));
    }

    private readonly autoStyleRuleAttemptSignatures = new Set<string>();

    /** Signature for the user-visible query scope that an automatic style rule would represent. */
    private autoStyleRuleAttemptSignature(session: FeatureSearchSession): string {
        return [
            session.id,
            session.id,
            session.definition.query,
            session.definition.scope,
            this.selectedSearchMapLayerSignature(session.definition.selectedMapLayers)
        ].join("\n");
    }

    /** Builds a stable signature for selected search map/layer references. */
    private selectedSearchMapLayerSignature(refs: FeatureSearchMapLayerRef[]): string {
        return refs
            .map(ref => this.searchLayerKey(ref.mapId, ref.layerId))
            .sort()
            .join("|");
    }

    private searchLayerKey(mapId: string, layerId: string): string {
        return JSON.stringify([mapId, layerId]);
    }

    /** Applies the current default style field to drafts that still point at missing fields. */
    private applyDefaultStyleFieldIfMissing(): boolean {
        const field = this.defaultStyleField();
        if (!field) {
            return false;
        }
        let changed = false;
        for (const rule of this.styleRuleDrafts) {
            if (rule.color.mode !== "solid" && !rule.color.customField) {
                if (this.fieldNeedsDefault(rule.color.field)) {
                    rule.color.field = field;
                    changed = true;
                } else if (this.fieldMissingFromPicker(rule.color.field)) {
                    rule.color.customField = true;
                    changed = true;
                }
            }
            if (rule.color.mode === "gradient"
                && !rule.color.customField
                && !isNumericStyleValueKind(this.styleFieldOption(rule.color.field)?.valueKind)) {
                rule.color.mode = "categories";
                changed = true;
            }
            if (rule.visualization.length === 1
                && rule.visualization[0] === "label"
                && !rule.labelCustomExpression) {
                if (this.fieldNeedsDefault(rule.labelExpression)) {
                    rule.labelExpression = field;
                    changed = true;
                } else if (this.fieldMissingFromPicker(rule.labelExpression)) {
                    rule.labelCustomExpression = true;
                    changed = true;
                }
            }
            for (const filter of rule.filters) {
                if (!filter.customExpression) {
                    if (this.fieldNeedsDefault(filter.attributeField)) {
                        filter.attributeField = field;
                        filter.filterValue = this.defaultFilterValue(field);
                        changed = true;
                    } else if (this.fieldMissingFromPicker(filter.attributeField)) {
                        filter.customExpression = true;
                        changed = true;
                    }
                }
                if (!this.styleOperatorOptionsForFilter(filter).some(option => option.value === filter.operator)) {
                    filter.operator = "=";
                    changed = true;
                }
            }
        }
        return changed;
    }

    /** Refreshes schema-backed fields when the editor or automatic rules need them. */
    private refreshStyleAttributeOptionsIfNeeded(session: FeatureSearchSession, patchMissingFields = true): boolean {
        if (session.schemaAnalysis.status !== "ready") {
            return false;
        }
        if (session.schemaAnalysis.rewriteSuppressed) {
            this.styleAttributeOptionsSessionSignature = [
                session.definition.query,
                session.definition.scope,
                "rewrite-suppressed",
                session.schemaAnalysis.rewriteSuppressionReason,
                this.selectedSearchMapLayerSignature(session.definition.selectedMapLayers)
            ].join("\n");
            if (this.styleAttributeOptionsRefreshTimer) {
                clearTimeout(this.styleAttributeOptionsRefreshTimer);
                this.styleAttributeOptionsRefreshTimer = null;
            }
            this.styleAttributeOptionsRefreshPatchMissing = false;
            this.styleAttributeOptionsLoading = false;
            this.styleAttributeOptions = [];
            this.styleScalarAttributeOptions = [];
            if (this.shouldAttemptAutoStyleRule(session)) {
                this.tryCreateAutoStyleRule(session);
            } else if (this.shouldRefreshAutoStyleRule()) {
                this.refreshAutoStyleRule(session);
            }
            return false;
        }
        // Paint a generic result immediately. Schema-field enumeration may be
        // delayed behind a broad Classic query; once it completes below, the
        // auto-generated solid rule is replaced with the richer field rule.
        if (this.styleAttributeOptions.length === 0 &&
            this.shouldAttemptAutoStyleRule(session)) {
            this.tryCreateAutoStyleRule(session);
        }
        if (!this.active
            && session.schemaAnalysis.concreteScope !== "attribute") {
            return false;
        }
        if (!this.active
            && this.styleAttributeOptions.length === 0
            && !this.shouldAttemptAutoStyleRule(session)
            && !this.shouldRefreshAutoStyleRule()) {
            return false;
        }
        const signature = [
            session.id,
            session.definition.query,
            session.definition.scope,
            this.styleFieldRequestScope(session),
            session.schemaAnalysis.status,
            session.schemaAnalysis.normalizedQuery,
            this.attributeScopeSyncSignature(session.schemaAnalysis.attributeScopes),
            this.selectedSearchMapLayerSignature(session.definition.selectedMapLayers),
            this.visibleMapLayerSignature()
        ].join("\n");
        if (signature === this.styleAttributeOptionsSessionSignature) {
            if (this.styleAttributeOptionsRefreshTimer && patchMissingFields) {
                this.styleAttributeOptionsRefreshPatchMissing = true;
            }
            return !!this.styleAttributeOptionsRefreshTimer || this.styleAttributeOptionsLoading;
        }
        this.styleAttributeOptionsSessionSignature = signature;
        this.scheduleStyleAttributeOptionsRefresh(session.id, patchMissingFields);
        return true;
    }

    private styleAttributeOptionsRefreshTimer: ReturnType<typeof setTimeout> | null = null;

    private styleAttributeOptionsRefreshPatchMissing = false;

    /** Keeps schema-analysis signature checks cheap while still detecting changed inferred attribute scopes. */
    private attributeScopeSyncSignature(scopes: FeatureSearchAttributeScopeCandidate[]): string {
        return scopes.map(scope => [
            scope.mapId,
            scope.layerId,
            scope.attrName,
            scope.attrLayerName ?? "",
            scope.featureType ?? ""
        ].join("/")).sort().join("|");
    }

    /** Returns a compact signature for map/layer visibility that affects preferred field-picker ordering. */
    private visibleMapLayerSignature(): string {
        const visibleLayerKeys: string[] = [];
        for (const [mapId, mapInfo] of this.mapService.maps.maps) {
            for (const layer of mapInfo.allFeatureLayers()) {
                for (let viewIndex = 0; viewIndex < this.viewSettings.numViews; ++viewIndex) {
                    if (this.mapService.maps.getMapLayerVisibility(viewIndex, mapId, layer.id)) {
                        visibleLayerKeys.push(`${viewIndex}:${mapId}:${layer.id}`);
                    }
                }
            }
        }
        return visibleLayerKeys.sort().join("|");
    }

    /** Defers expensive WASM-backed field enumeration until the browser can paint the style tab. */
    private scheduleStyleAttributeOptionsRefresh(sessionId: string, patchMissingFields: boolean): void {
        if (this.styleAttributeOptionsRefreshTimer) {
            clearTimeout(this.styleAttributeOptionsRefreshTimer);
        }
        this.styleAttributeOptionsRefreshPatchMissing = patchMissingFields;
        this.styleAttributeOptionsLoading = true;
        this.styleAttributeOptionsRefreshTimer = setTimeout(() => {
            this.styleAttributeOptionsRefreshTimer = null;
            const shouldPatchMissingFields = this.styleAttributeOptionsRefreshPatchMissing;
            this.styleAttributeOptionsRefreshPatchMissing = false;
            const session = this.session?.id === sessionId
                ? this.session
                : this.searchService.getSession(sessionId);
            if (!session) {
                this.styleAttributeOptionsLoading = false;
                return;
            }
            this.refreshStyleAttributeOptions(session, shouldPatchMissingFields);
        }, 0);
    }

    /** Keeps generic automatic rules visually tied to the density-map/pin color while user-edited rules stay stable. */
    private syncAutoGeneratedSolidRulesToSearchColor(color: string): boolean {
        let changed = false;
        this.styleRuleDrafts = this.styleRuleDrafts.map(rule => {
            if (!rule.autoGenerated || rule.color.mode !== "solid") {
                return rule;
            }
            if (rule.color.solidColor === color && rule.color.fallbackColor === color) {
                return rule;
            }
            changed = true;
            return {
                ...rule,
                color: {
                    ...rule.color,
                    solidColor: color,
                    fallbackColor: color
                }
            };
        });
        return changed;
    }

    protected onSearchColorChange(color: string) {
        if (this.session) {
            const normalizedColor = normalizeHexColor(color, DEFAULT_SEARCH_STYLE_SOLID_COLOR);
            if (this.syncAutoGeneratedSolidRulesToSearchColor(normalizedColor)) {
                this.onStyleRulesChanged();
            }
            this.searchService.setSearchColor(this.session.id, normalizedColor);
        }
    }

    /** Returns the diagnostics value summary for one persisted withFields expression. */
    protected valueSummaryForStyleExpression(expression: string): SearchValueSummary | undefined {
        const trimmedExpression = (expression ?? "").trim();
        if (!trimmedExpression || this.valueSummaries.status !== "ready") {
            return undefined;
        }
        return this.valueSummaries.resultFields.find(field =>
            field.expression.trim() === trimmedExpression
        )?.summary;
    }

    protected readonly valueSummaryForStyleExpressionCallback = (expression: string) =>
        this.valueSummaryForStyleExpression(expression);

    /** Lets style controls lazily trigger the same value aggregation used by Diagnostics/Values. */
    protected onStyleColorDataUpdateRequested(): void {
        this.requestDiagnosticsValueSummaries();
    }

    /** Captures session fields that affect static controls, excluding high-frequency result/progress counters. */
    private staticSessionSyncSignatureFor(session: FeatureSearchSession): string {
        const analysis = session.schemaAnalysis;
        return [
            session.id,
            session.definition.query,
            session.definition.scope,
            this.selectedSearchMapLayerSignature(session.definition.selectedMapLayers),
            JSON.stringify(session.definition.selectedFeatureTypes ?? []),
            JSON.stringify(session.definition.selectedViewIndices ?? []),
            JSON.stringify(session.definition.searchStyleRules ?? []),
            JSON.stringify(session.definition.renderStrategy),
            analysis.signature,
            analysis.status,
            analysis.concreteScope,
            analysis.normalizedQuery,
            String(analysis.attributeScopeCandidateCount ?? 0),
            String(analysis.rewriteSuppressed ?? false),
            analysis.rewriteSuppressionReason ?? "",
            analysis.error ?? "",
            this.attributeScopeSyncSignature(analysis.attributeScopes),
            JSON.stringify(analysis.matchedFieldNames),
            JSON.stringify(analysis.matchedEnumValues),
            JSON.stringify(analysis.matchedFeatureTypes)
        ].join("\n");
    }

    protected readonly featureSearchColorPickerOverlayOptions: OverlayOptions = {
        styleClass: "feature-search-colorpicker-overlay"
    };
}
