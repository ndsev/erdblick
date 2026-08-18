import {
    Component,
    EventEmitter,
    Input,
    OnChanges,
    Output,
    SimpleChanges
} from "@angular/core";
import {OverlayOptions} from "primeng/api";

import {
    DEFAULT_FEATURE_SEARCH_LABEL_BACKGROUND_COLOR,
    FeatureSearchMapLayerRef,
    FeatureSearchScope
} from "../shared/feature-search-state";
import type {SearchValueSummariesState, SearchValueSummary} from "./search.model";
import {
    isNumericStyleValueKind,
    normalizeHexColor,
    SearchStyleColorDraft,
    SearchStyleFieldOption
} from "./search-style-color.util";
import {
    FeatureSearchStyleFilterDraft,
    FeatureSearchStyleRuleDraft,
    searchStyleRuleDisplayItems,
    SearchStyleRuleDraftCodec
} from "./search-style-rule-editor.model";
import type {QuickStyleWarning} from "./search-style-sheet.converter";

/** Search-independent editor UI for canonical high-fidelity search style rules. */
@Component({
    selector: "search-style-rule-editor",
    template: `
        <div class="feature-search-style-rule-editor">
            @if (showAddButton) {
                <div class="search-style-rule-editor-toolbar">
                    <p-button class="feature-search-add-rule-button"
                              icon="pi pi-plus"
                              label="Add Rule"
                              size="small"
                              severity="secondary"
                              [outlined]="true"
                              (click)="addStyleRule()">
                    </p-button>
                </div>
            }
            @if (drafts.length === 0 && readOnlyRuleIndices.length === 0) {
                <div class="search-style-rule-editor-empty">No high-fidelity rules configured.</div>
            }
            <p-accordion class="feature-search-style-accordion"
                         [multiple]="true"
                         [(value)]="accordionValue">
                @for (item of displayItems(); track item.key; let ruleIndex = $index) {
                  @if (item.rule; as rule) {
                    <p-accordion-panel class="feature-search-style-panel"
                                       [value]="panelValue(rule)"
                                       [attr.data-testid]="'feature-search-style-panel-' + rule.id">
                        <p-accordion-header>
                            <div class="feature-search-style-rule-header">
                                <div class="feature-search-style-rule-title">
                                    @if (showRuleNames) {
                                        <input class="feature-search-style-rule-name"
                                               type="text"
                                               [ngModel]="rule.name"
                                               [placeholder]="'Rule ' + (drafts.length - ruleIndex)"
                                               [attr.aria-label]="'Rule name ' + (drafts.length - ruleIndex)"
                                               (ngModelChange)="setStyleRuleName(rule, $event)"
                                               (click)="$event.stopPropagation()"
                                               (mousedown)="$event.stopPropagation()">
                                    } @else {
                                        <span class="feature-search-style-rule-label">Rule {{ item.sourceIndex + 1 }}</span>
                                    }
                                    @if (notesFor(item.sourceIndex).length) {
                                        <span class="material-symbols-outlined search-style-rule-help"
                                              tabindex="0"
                                              role="img"
                                              [attr.data-testid]="'quick-rule-help-' + item.sourceIndex"
                                              [attr.aria-label]="'Quick editing notes for rule ' + (item.sourceIndex + 1)"
                                              [pTooltip]="noteTooltip(item.sourceIndex)"
                                              tooltipStyleClass="search-style-rule-help-tooltip"
                                              tooltipPosition="bottom"
                                              (click)="$event.stopPropagation()"
                                              (mousedown)="$event.stopPropagation()">help</span>
                                    }
                                    <div class="feature-search-style-rule-summary" aria-hidden="true">
                                        @for (chip of summaryChips(rule); track chip) {
                                            <span class="feature-search-style-summary-chip">{{ chip }}</span>
                                        }
                                        @if (previewColors(rule).length > 0) {
                                            <span class="feature-search-style-summary-chip feature-search-style-summary-colors">
                                                @for (color of previewColors(rule); track $index) {
                                                    <span class="feature-search-style-summary-color"
                                                          [style.background]="color"></span>
                                                }
                                            </span>
                                        }
                                    </div>
                                </div>
                                <span class="feature-search-style-rule-actions">
                                    <p-button class="feature-search-style-rule-action"
                                              icon="pi pi-refresh"
                                              ariaLabel="Reset style rule"
                                              size="small"
                                              severity="secondary"
                                              [outlined]="true"
                                              pTooltip="Reset style"
                                              tooltipPosition="bottom"
                                              (click)="$event.stopPropagation(); resetStyleRule(rule)"
                                              (mousedown)="$event.stopPropagation()">
                                    </p-button>
                                    <p-button class="feature-search-style-rule-action"
                                              icon="pi pi-trash"
                                              ariaLabel="Delete style rule"
                                              size="small"
                                              severity="danger"
                                              [outlined]="true"
                                              pTooltip="Delete rule"
                                              tooltipPosition="bottom"
                                              (click)="$event.stopPropagation(); deleteStyleRule(rule)"
                                              (mousedown)="$event.stopPropagation()">
                                    </p-button>
                                </span>
                            </div>
                        </p-accordion-header>
                        <p-accordion-content>
                            <section class="feature-search-style-section">
                                <div class="feature-search-style-section-rail">Filter</div>
                                <div class="feature-search-style-section-body">
                                    <div class="feature-search-style-condition-list">
                                        @for (filter of rule.filters; track filter.id) {
                                            <div class="feature-search-style-filter-row">
                                                <button type="button"
                                                        class="search-style-expression-toggle feature-search-style-condition-mode"
                                                        [class.search-style-expression-toggle-active]="filter.customExpression"
                                                        [attr.aria-pressed]="filter.customExpression"
                                                        title="Custom expression"
                                                        (click)="toggleFilterExpressionMode(rule, filter)">
                                                    *
                                                </button>
                                                @if (filter.customExpression || fieldOptions.length === 0) {
                                                    <simfil-expression-input class="feature-search-style-manual-condition"
                                                                             [value]="filter.attributeField"
                                                                             (valueChange)="setFilterExpression(rule, filter, $event)"
                                                                             [singleLine]="true"
                                                                             [completionOwnerId]="filterCompletionOwnerId(filter)"
                                                                             [completionScope]="completionScope"
                                                                             [completionMapLayers]="completionMapLayers"
                                                                             [completionZIndex]="completionZIndex"
                                                                             placeholder="Custom expression">
                                                    </simfil-expression-input>
                                                } @else {
                                                    <p-select class="feature-search-style-attribute"
                                                              [options]="scalarFieldOptions"
                                                              [(ngModel)]="filter.attributeField"
                                                              (ngModelChange)="markEdited(rule)"
                                                              optionLabel="label"
                                                              optionValue="value"
                                                              [filter]="true"
                                                              appendTo="body">
                                                    </p-select>
                                                }
                                                @if (!filter.customExpression) {
                                                    <p-select class="feature-search-style-operator"
                                                              [options]="operatorOptionsFor(filter)"
                                                              [(ngModel)]="filter.operator"
                                                              (ngModelChange)="markEdited(rule)"
                                                              optionLabel="label"
                                                              optionValue="value"
                                                              appendTo="body">
                                                    </p-select>
                                                    @if (filterFieldIsNumeric(filter)) {
                                                        <p-inputNumber class="feature-search-style-number"
                                                                       [(ngModel)]="filter.filterValue"
                                                                       (ngModelChange)="markEdited(rule)">
                                                        </p-inputNumber>
                                                    } @else if (filterEnumOptions(filter).length > 0) {
                                                        <p-select class="feature-search-style-value-select"
                                                                  [options]="filterEnumOptions(filter)"
                                                                  [editable]="true"
                                                                  [(ngModel)]="filter.filterValue"
                                                                  (ngModelChange)="markEdited(rule)"
                                                                  optionLabel="label"
                                                                  optionValue="value"
                                                                  appendTo="body">
                                                        </p-select>
                                                    } @else {
                                                        <input class="feature-search-style-value-input"
                                                               type="text"
                                                               [(ngModel)]="filter.filterValue"
                                                               (ngModelChange)="markEdited(rule)">
                                                    }
                                                }
                                                <p-button class="feature-search-style-condition-delete"
                                                          icon="pi pi-times"
                                                          size="small"
                                                          severity="danger"
                                                          [outlined]="true"
                                                          pTooltip="Delete condition"
                                                          tooltipPosition="bottom"
                                                          (click)="deleteCondition(rule, filter)">
                                                </p-button>
                                            </div>
                                        }
                                    </div>
                                    <p-button class="feature-search-add-condition-button"
                                              icon="pi pi-plus"
                                              label="Add condition"
                                              size="small"
                                              severity="secondary"
                                              [outlined]="true"
                                              (click)="addCondition(rule)">
                                    </p-button>
                                </div>
                            </section>

                            <section class="feature-search-style-section">
                                <div class="feature-search-style-section-rail">Geom</div>
                                <div class="feature-search-style-section-body">
                                    <div class="feature-search-style-visualization-row">
                                        <p-select class="feature-search-style-visualization"
                                                  [options]="visualizationOptions"
                                                  [ngModel]="rule.visualization"
                                                  (ngModelChange)="setVisualization(rule, $event)"
                                                  optionLabel="label"
                                                  optionValue="value"
                                                  appendTo="body">
                                        </p-select>
                                        <label [for]="'feature-search-style-width-' + rule.id">
                                            {{ sizeLabel(rule) }}
                                        </label>
                                        <p-inputNumber [inputId]="'feature-search-style-width-' + rule.id"
                                                       class="feature-search-style-number"
                                                       [ngModel]="sizeValue(rule)"
                                                       (ngModelChange)="setSizeValue(rule, $event)"
                                                       [min]="1"
                                                       [max]="rule.visualization === 'point' ? 128 : (isLabel(rule) ? 96 : 32)">
                                        </p-inputNumber>
                                    </div>
                                    @if (isLabel(rule)) {
                                        <div class="feature-search-style-label-row">
                                            <button type="button"
                                                    class="search-style-expression-toggle feature-search-style-label-mode"
                                                    [class.search-style-expression-toggle-active]="rule.labelCustomExpression"
                                                    [attr.aria-pressed]="rule.labelCustomExpression"
                                                    title="Custom label expression"
                                                    (click)="toggleLabelExpressionMode(rule)">
                                                *
                                            </button>
                                            @if (rule.labelCustomExpression || scalarFieldOptions.length === 0) {
                                                <simfil-expression-input class="feature-search-style-label-expression"
                                                                         [value]="rule.labelExpression"
                                                                         (valueChange)="setLabelExpression(rule, $event)"
                                                                         [singleLine]="true"
                                                                         [completionOwnerId]="labelCompletionOwnerId(rule)"
                                                                         [completionScope]="completionScope"
                                                                         [completionMapLayers]="completionMapLayers"
                                                                         [completionZIndex]="completionZIndex"
                                                                         placeholder="Label Text Expression">
                                                </simfil-expression-input>
                                            } @else {
                                                <label [for]="'feature-search-style-label-' + rule.id">Label Text</label>
                                                <p-select [inputId]="'feature-search-style-label-' + rule.id"
                                                          class="feature-search-style-label-expression"
                                                          [options]="scalarFieldOptions"
                                                          [ngModel]="rule.labelExpression"
                                                          (ngModelChange)="setLabelExpression(rule, $event)"
                                                          optionLabel="label"
                                                          optionValue="value"
                                                          [filter]="true"
                                                          appendTo="body">
                                                </p-select>
                                            }
                                            <label [for]="'feature-search-style-label-background-' + rule.id">Background</label>
                                            <p-colorpicker [inputId]="'feature-search-style-label-background-' + rule.id"
                                                           class="feature-search-style-label-background-picker"
                                                           [ngModel]="rule.labelBackgroundColor"
                                                           appendTo="body"
                                                           [overlayOptions]="colorPickerOverlayOptions"
                                                           (ngModelChange)="setLabelBackgroundColor(rule, $event)">
                                            </p-colorpicker>
                                        </div>
                                    }
                                </div>
                            </section>

                            <section class="feature-search-style-section">
                                <div class="feature-search-style-section-rail">Color</div>
                                <div class="feature-search-style-section-body">
                                    <search-style-color
                                        [draft]="rule.color"
                                        [fieldOptions]="scalarFieldOptions"
                                        [completionScope]="completionScope"
                                        [completionMapLayers]="completionMapLayers"
                                        [completionZIndex]="completionZIndex"
                                        [colorPickerOverlayOptions]="colorPickerOverlayOptions"
                                        [dataSummary]="valueSummary(rule.color.field)"
                                        [dataSummaryStatus]="dataSummaryStatus"
                                        [canUpdateFromData]="canRefreshValueSummaries"
                                        (updateFromDataRequested)="updateFromDataRequested.emit()"
                                        (draftChange)="onColorChange(rule, $event)">
                                        <div searchStyleColorInlineControl class="feature-search-style-opacity">
                                            <label [for]="'feature-search-style-opacity-' + rule.id">Opacity</label>
                                            <p-inputNumber [inputId]="'feature-search-style-opacity-' + rule.id"
                                                           class="feature-search-style-number"
                                                           [(ngModel)]="rule.opacity"
                                                           (ngModelChange)="markEdited(rule)"
                                                           [min]="0"
                                                           [max]="100"
                                                           suffix=" %">
                                            </p-inputNumber>
                                            <p-slider [(ngModel)]="rule.opacity"
                                                      (ngModelChange)="markEdited(rule)"
                                                      [min]="0"
                                                      [max]="100"
                                                      class="feature-search-style-opacity-slider">
                                            </p-slider>
                                        </div>
                                    </search-style-color>
                                </div>
                            </section>
                        </p-accordion-content>
                    </p-accordion-panel>
                  } @else {
                    <div class="search-style-rule-editor-read-only-placeholder">
                        <span>Rule {{ item.sourceIndex + 1 }} is preserved and editable in Advanced only.</span>
                        @if (notesFor(item.sourceIndex).length) {
                            <span class="material-symbols-outlined search-style-rule-help"
                                  tabindex="0"
                                  role="img"
                                  [attr.data-testid]="'quick-rule-help-' + item.sourceIndex"
                                  [attr.aria-label]="'Why rule ' + (item.sourceIndex + 1) + ' is Advanced-only'"
                                  [pTooltip]="noteTooltip(item.sourceIndex)"
                                  tooltipStyleClass="search-style-rule-help-tooltip"
                                  tooltipPosition="bottom"
                                  (click)="$event.stopPropagation()"
                                  (mousedown)="$event.stopPropagation()">help</span>
                        }
                    </div>
                  }
                }
            </p-accordion>
        </div>
    `,
    standalone: false
})
export class SearchStyleRuleEditorComponent implements OnChanges {
    @Input() drafts: FeatureSearchStyleRuleDraft[] = [];
    @Input() fieldOptions: SearchStyleFieldOption[] = [];
    @Input() completionScope?: FeatureSearchScope;
    @Input() completionMapLayers: FeatureSearchMapLayerRef[] = [];
    @Input() completionZIndex = 30050;
    @Input() completionOwnerPrefix = "search-style-rule";
    @Input() colorPickerOverlayOptions?: OverlayOptions;
    @Input() dataSummaryStatus: SearchValueSummariesState["status"] = "idle";
    @Input() valueSummaryForExpression?: (expression: string) => SearchValueSummary | undefined;
    @Input() showAddButton = true;
    @Input() showRuleNames = true;
    @Input() canRefreshValueSummaries = true;
    @Input() expandRulesByDefault = false;
    @Input() expansionContext = "";
    /** Source indices let Quick retain the authoritative YAML rule ordering. */
    @Input() sourceRuleIndices: Record<number, number> = {};
    @Input() readOnlyRuleIndices: number[] = [];
    @Input() notesBySourceIndex: Record<number, readonly QuickStyleWarning[]> = {};
    @Output() draftsChange = new EventEmitter<FeatureSearchStyleRuleDraft[]>();
    @Output() updateFromDataRequested = new EventEmitter<void>();

    protected accordionValue: string[] = [];
    protected scalarFieldOptions: SearchStyleFieldOption[] = [];
    protected readonly visualizationOptions = [
        {label: "Any geometry", value: "any"},
        {label: "Line", value: "line"},
        {label: "Surface group", value: "surface"},
        {label: "Polygon", value: "polygon"},
        {label: "Mesh", value: "mesh"},
        {label: "Point", value: "point"},
        {label: "Label", value: "label"}
    ];
    private readonly operatorOptions = [
        {label: ">", value: ">"},
        {label: ">=", value: ">="},
        {label: "=", value: "="},
        {label: "!=", value: "!="},
        {label: "<=", value: "<="},
        {label: "<", value: "<"},
        {label: "contains", value: "contains"}
    ];
    private readonly codec = new SearchStyleRuleDraftCodec();
    private knownPanelValues = new Set<string>();

    /** Interleaves editable rows and Advanced-only placeholders in YAML order. */
    protected displayItems(): Array<{
        key: string;
        sourceIndex: number;
        rule?: FeatureSearchStyleRuleDraft;
    }> {
        return searchStyleRuleDisplayItems(
            this.drafts,
            this.sourceRuleIndices,
            this.readOnlyRuleIndices
        );
    }

    /** Returns notes owned by one authoritative YAML rule. */
    protected notesFor(sourceIndex: number): readonly QuickStyleWarning[] {
        return this.notesBySourceIndex[sourceIndex] ?? [];
    }

    /** Formats all preserved/read-only details for one compact tooltip. */
    protected noteTooltip(sourceIndex: number): string {
        return this.notesFor(sourceIndex)
            .map(note => `${note.path}: ${note.message}`)
            .join("\n");
    }

    /** Refreshes schema hints and identity allocation when host inputs change. */
    ngOnChanges(changes: SimpleChanges): void {
        if (changes["fieldOptions"]) {
            this.scalarFieldOptions = this.fieldOptions.filter(option =>
                option.valueKind !== "object" && option.valueKind !== "array");
            this.codec.setFieldOptions(this.scalarFieldOptions);
        }
        if (changes["drafts"]) {
            this.drafts = this.codec.cloneDrafts(this.drafts);
            this.codec.synchronizeIds(this.drafts);
        }
        if (changes["drafts"] || changes["expandRulesByDefault"] || changes["expansionContext"]) {
            const panels = new Set(this.drafts.map(rule => this.panelValue(rule)));
            const contextChanged = !!changes["expansionContext"];
            const expanded = contextChanged
                ? []
                : this.accordionValue.filter(value => panels.has(value));
            if (this.expandRulesByDefault) {
                for (const panel of panels) {
                    if (contextChanged || !this.knownPanelValues.has(panel)) {
                        expanded.push(panel);
                    }
                }
            }
            this.accordionValue = [...new Set(expanded)];
            this.knownPanelValues = panels;
        }
    }

    /** Adds a fresh editor rule. */
    protected addStyleRule(): void {
        const rule = this.codec.createRule();
        this.drafts = [rule, ...this.drafts];
        const panel = this.panelValue(rule);
        this.accordionValue = this.expandRulesByDefault
            ? [...new Set([...this.accordionValue, panel])]
            : [panel];
        this.emitDrafts();
    }

    /** Removes one rule and its accordion state. */
    protected deleteStyleRule(rule: FeatureSearchStyleRuleDraft): void {
        this.drafts = this.drafts.filter(candidate => candidate.id !== rule.id);
        this.accordionValue = this.accordionValue.filter(value => value !== this.panelValue(rule));
        this.emitDrafts();
    }

    /** Restores one rule to generic high-fidelity defaults. */
    protected resetStyleRule(rule: FeatureSearchStyleRuleDraft): void {
        const replacement = this.codec.createRule(rule.id);
        this.drafts = this.drafts.map(candidate => candidate.id === rule.id ? replacement : candidate);
        this.emitDrafts();
    }

    /** Appends a structured condition to one rule. */
    protected addCondition(rule: FeatureSearchStyleRuleDraft): void {
        rule.filters = [...rule.filters, this.codec.createFilter()];
        this.markEdited(rule);
    }

    /** Removes one structured or custom condition. */
    protected deleteCondition(rule: FeatureSearchStyleRuleDraft, filter: FeatureSearchStyleFilterDraft): void {
        rule.filters = rule.filters.filter(candidate => candidate.id !== filter.id);
        this.markEdited(rule);
    }

    /** Toggles a condition between field/operator controls and a raw expression. */
    protected toggleFilterExpressionMode(
        rule: FeatureSearchStyleRuleDraft,
        filter: FeatureSearchStyleFilterDraft
    ): void {
        filter.customExpression = !filter.customExpression;
        if (!filter.customExpression && !this.fieldOption(filter.attributeField)) {
            filter.attributeField = this.scalarFieldOptions[0]?.value ?? filter.attributeField;
        }
        this.markEdited(rule);
    }

    /** Updates a raw condition expression without requiring schema context. */
    protected setFilterExpression(
        rule: FeatureSearchStyleRuleDraft,
        filter: FeatureSearchStyleFilterDraft,
        expression: string
    ): void {
        filter.attributeField = expression ?? "";
        if (this.fieldOptions.length > 0) {
            filter.customExpression = true;
        }
        this.markEdited(rule);
    }

    /** Changes geometry kind while applying only a label-size UI default. */
    protected setVisualization(rule: FeatureSearchStyleRuleDraft, value: FeatureSearchStyleRuleDraft["visualization"]): void {
        const wasLabel = this.isLabel(rule);
        rule.visualization = value ?? "any";
        if (!wasLabel && this.isLabel(rule) && rule.lineWidth <= 5) {
            rule.lineWidth = 22;
        }
        this.markEdited(rule);
    }

    /** Returns the geometry-kind-specific size shown in the shared control. */
    protected sizeValue(rule: FeatureSearchStyleRuleDraft): number {
        return rule.visualization === "point"
            ? rule.pointRadius ?? Math.max(3, rule.lineWidth * 1.5)
            : rule.lineWidth;
    }

    /** Writes width or point radius without conflating their persisted values. */
    protected setSizeValue(rule: FeatureSearchStyleRuleDraft, value: number): void {
        if (rule.visualization === "point") {
            rule.pointRadius = Number(value);
        } else {
            rule.lineWidth = Number(value);
        }
        this.markEdited(rule);
    }

    /** Toggles a label between field-selection and raw-expression intent. */
    protected toggleLabelExpressionMode(rule: FeatureSearchStyleRuleDraft): void {
        rule.labelCustomExpression = !rule.labelCustomExpression;
        if (!rule.labelCustomExpression && !this.fieldOption(rule.labelExpression)) {
            rule.labelExpression = this.scalarFieldOptions[0]?.value ?? rule.labelExpression;
        }
        this.markEdited(rule);
    }

    /** Updates one label expression. */
    protected setLabelExpression(rule: FeatureSearchStyleRuleDraft, expression: string): void {
        rule.labelExpression = expression ?? "";
        this.markEdited(rule);
    }

    /** Normalizes and updates one label background color. */
    protected setLabelBackgroundColor(rule: FeatureSearchStyleRuleDraft, color: string): void {
        rule.labelBackgroundColor = normalizeHexColor(color, DEFAULT_FEATURE_SEARCH_LABEL_BACKGROUND_COLOR);
        this.markEdited(rule);
    }

    /** Accepts a detached color-editor draft. */
    protected onColorChange(rule: FeatureSearchStyleRuleDraft, color: SearchStyleColorDraft): void {
        rule.color = color;
        this.markEdited(rule);
    }

    /** Updates the optional human-readable rule name. */
    protected setStyleRuleName(rule: FeatureSearchStyleRuleDraft, value: string): void {
        rule.name = value ?? "";
        this.markEdited(rule);
    }

    /** Marks a generated rule as user-owned and emits a detached draft list. */
    protected markEdited(rule: FeatureSearchStyleRuleDraft): void {
        rule.autoGenerated = false;
        this.emitDrafts();
    }

    /** Returns whether transient schema metadata marks a filter field numeric. */
    protected filterFieldIsNumeric(filter: FeatureSearchStyleFilterDraft): boolean {
        return isNumericStyleValueKind(this.fieldOption(filter.attributeField)?.valueKind);
    }

    /** Converts transient enum metadata into select options. */
    protected filterEnumOptions(filter: FeatureSearchStyleFilterDraft): Array<{label: string; value: string}> {
        return (this.fieldOption(filter.attributeField)?.enumValues ?? [])
            .map(value => ({label: value, value}));
    }

    /** Returns schema-advised operators while retaining all operators without schema. */
    protected operatorOptionsFor(filter: FeatureSearchStyleFilterDraft): Array<{label: string; value: string}> {
        if (!this.fieldOption(filter.attributeField)) {
            return this.operatorOptions;
        }
        return this.filterFieldIsNumeric(filter)
            ? this.operatorOptions
            : this.operatorOptions.filter(option => ["=", "!=", "contains"].includes(option.value));
    }

    /** Returns whether a rule uses label geometry. */
    protected isLabel(rule: FeatureSearchStyleRuleDraft): boolean {
        return rule.visualization === "label";
    }

    /** Returns the geometry-specific size-control label. */
    protected sizeLabel(rule: FeatureSearchStyleRuleDraft): string {
        if (rule.visualization === "point") {
            return "Radius";
        }
        return this.isLabel(rule) ? "Size" : "Width";
    }

    /** Returns a stable transient accordion identity. */
    protected panelValue(rule: FeatureSearchStyleRuleDraft): string {
        return String(rule.id);
    }

    /** Builds compact rule-header summaries. */
    protected summaryChips(rule: FeatureSearchStyleRuleDraft): string[] {
        return [
            rule.filters.length ? `${rule.filters.length} Filter${rule.filters.length === 1 ? "" : "s"}` : "No filter",
            this.visualizationOptions.find(option => option.value === rule.visualization)?.label ?? "Any geometry",
            rule.color.mode === "gradient" ? "Gradient" : rule.color.mode === "categories" ? "Categories" : "Solid"
        ];
    }

    /** Returns bounded normalized colors for the rule-header preview. */
    protected previewColors(rule: FeatureSearchStyleRuleDraft): string[] {
        if (rule.color.mode === "solid") {
            return [normalizeHexColor(rule.color.solidColor)];
        }
        const stops = rule.color.mode === "gradient"
            ? rule.color.gradientStops
            : rule.color.categoryStops;
        return stops.slice(0, 10).map(stop =>
            normalizeHexColor(stop.color, rule.color.fallbackColor || rule.color.solidColor));
    }

    /** Returns an isolated completion owner for one condition. */
    protected filterCompletionOwnerId(filter: FeatureSearchStyleFilterDraft): string {
        return `${this.completionOwnerPrefix}:filter:${filter.id}`;
    }

    /** Returns an isolated completion owner for one label. */
    protected labelCompletionOwnerId(rule: FeatureSearchStyleRuleDraft): string {
        return `${this.completionOwnerPrefix}:label:${rule.id}`;
    }

    /** Delegates optional live-value lookup to the host. */
    protected valueSummary(expression: string): SearchValueSummary | undefined {
        return this.valueSummaryForExpression?.(expression);
    }

    /** Resolves transient schema metadata for one expression. */
    private fieldOption(field: string): SearchStyleFieldOption | undefined {
        return this.fieldOptions.find(option => option.value === field);
    }

    /** Emits an immutable deep copy of all editor drafts. */
    private emitDrafts(): void {
        this.draftsChange.emit(this.codec.cloneDrafts(this.drafts));
    }
}
