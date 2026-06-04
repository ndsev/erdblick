import {
    Component,
    EventEmitter,
    Input,
    OnChanges,
    Output,
    SimpleChanges
} from "@angular/core";
import {OverlayOptions} from "primeng/api";
import {FeatureSearchMapLayerRef, FeatureSearchScope} from "../shared/feature-search-state";
import type {SearchValueSummariesState, SearchValueSummary} from "./search.model";
import {
    autoInitializeSearchStyleColorDraft,
    categoryStopsForObservedValues,
    cloneSearchStyleColorDraft,
    defaultSearchStyleColorDraft,
    DEFAULT_SEARCH_STYLE_SOLID_COLOR,
    gradientPreviewCss,
    gradientStopsForObservedNumericRange,
    gradientStopsNeedSorting,
    gradientValueTags,
    isNumericStyleValueKind,
    isSerializableColorDraft,
    normalizeHexColor,
    SearchStyleCategoryStopDraft,
    SearchStyleColorDraft,
    SearchStyleColorMode,
    SearchStyleFieldOption,
    SearchStyleGradientStopDraft,
    sortedGradientStopDrafts
} from "./search-style-color.util";

@Component({
    selector: "search-style-color",
    template: `
        <div class="search-style-color">
            <div class="search-style-color-mode-row">
                <label [for]="modeInputId">Mode</label>
                <p-select [inputId]="modeInputId"
                          class="search-style-color-mode"
                          [options]="availableModeOptions"
                          [ngModel]="viewDraft.mode"
                          (ngModelChange)="setMode($event)"
                          optionLabel="label"
                          optionValue="value"
                          appendTo="body">
                </p-select>

                @if (viewDraft.mode === 'solid') {
                    <p-colorpicker class="search-style-color-solid-picker"
                                   [ngModel]="viewDraft.solidColor"
                                   appendTo="body"
                                   [overlayOptions]="colorPickerOverlayOptions"
                                   (ngModelChange)="setSolidColor($event)">
                    </p-colorpicker>
                }

                @if (viewDraft.mode !== 'solid') {
                    <button type="button"
                            class="search-style-expression-toggle search-style-color-field-mode"
                            [class.search-style-expression-toggle-active]="viewDraft.customField"
                            [attr.aria-pressed]="viewDraft.customField"
                            title="Custom expression"
                            (click)="toggleFieldMode()">
                        *
                    </button>

                    @if (viewDraft.customField) {
                        <simfil-expression-input class="search-style-color-field-input"
                                                 [value]="viewDraft.field"
                                                 (valueChange)="setCustomField($event)"
                                                 [singleLine]="true"
                                                 [completionOwnerId]="customFieldCompletionOwnerId"
                                                 [completionScope]="completionScope"
                                                 [completionMapLayers]="completionMapLayers"
                                                 [completionZIndex]="completionZIndex"
                                                 placeholder="Custom expression">
                        </simfil-expression-input>
                    } @else {
                        <label [for]="fieldInputId">Field</label>
                        <p-select [inputId]="fieldInputId"
                                  class="search-style-color-field"
                                  [options]="fieldOptionsForCurrentMode"
                                  [ngModel]="viewDraft.field"
                                  (ngModelChange)="setField($event)"
                                  optionLabel="label"
                                  optionValue="value"
                                  [filter]="true"
                                  appendTo="body">
                        </p-select>
                    }
                }
                <ng-content select="[searchStyleColorInlineControl]"></ng-content>
            </div>

            @if (colorWarning) {
                <div class="search-style-color-warning">{{ colorWarning }}</div>
            }

            @if (viewDraft.mode === 'gradient') {
                <div class="search-style-color-preview-wrap">
                    <div class="search-style-color-preview"
                         aria-hidden="true"
                         [style.background]="gradientPreview"></div>
                    @if (gradientTags.length > 0) {
                        <div class="search-style-color-gradient-tags" aria-hidden="true">
                            @for (tag of gradientTags; track tag.id) {
                                <span class="search-style-color-gradient-tag"
                                      [class.edge-start]="tag.edge === 'start'"
                                      [class.edge-end]="tag.edge === 'end'"
                                      [style.left.%]="tag.offsetPercent">
                                    {{ tag.label }}
                                </span>
                            }
                        </div>
                    }
                </div>
                <div class="search-style-color-actions">
                    <p-button icon="pi pi-plus"
                              label="Add value"
                              severity="secondary"
                              [outlined]="true"
                              (click)="addGradientStop()">
                    </p-button>
                    <p-button icon="pi pi-sort-amount-down"
                              label="Sort"
                              severity="secondary"
                              [outlined]="true"
                              [disabled]="!canSortGradientStops"
                              (click)="sortGradientStops()">
                    </p-button>
                    <p-button icon="pi pi-database"
                              label="Update from data"
                              severity="secondary"
                              [outlined]="true"
                              (click)="updateStopsFromData()">
                    </p-button>
                </div>
                <div class="search-style-color-stop-list">
                    @for (stop of viewDraft.gradientStops; track stop.id; let stopIndex = $index) {
                        <div class="search-style-color-stop-row">
                            <p-colorpicker [ngModel]="stop.color"
                                           appendTo="body"
                                           [overlayOptions]="colorPickerOverlayOptions"
                                           [attr.aria-label]="'Gradient color ' + (stopIndex + 1)"
                                           (ngModelChange)="setGradientStopColor(stop, $event)">
                            </p-colorpicker>
                            <input class="search-style-color-value-input"
                                   type="number"
                                   [ngModel]="stop.value"
                                   (ngModelChange)="setGradientStopValue(stop, $event)"
                                   [attr.aria-label]="'Gradient value ' + (stopIndex + 1)">
                            <p-button class="search-style-color-delete"
                                      icon="pi pi-times"
                                      severity="danger"
                                      [outlined]="true"
                                      pTooltip="Delete value"
                                      tooltipPosition="bottom"
                                      (click)="deleteGradientStop(stop)">
                            </p-button>
                        </div>
                    }
                </div>
            } @else if (viewDraft.mode === 'categories') {
                <div class="search-style-color-actions">
                    <p-button icon="pi pi-plus"
                              label="Add value"
                              severity="secondary"
                              [outlined]="true"
                              (click)="addCategoryStop()">
                    </p-button>
                    <p-button icon="pi pi-database"
                              label="Update from data"
                              severity="secondary"
                              [outlined]="true"
                              (click)="updateStopsFromData()">
                    </p-button>
                </div>
                <div class="search-style-color-stop-list">
                    @for (stop of viewDraft.categoryStops; track stop.id; let stopIndex = $index) {
                        <div class="search-style-color-stop-row">
                            <p-colorpicker [ngModel]="stop.color"
                                           appendTo="body"
                                           [overlayOptions]="colorPickerOverlayOptions"
                                           [attr.aria-label]="'Category color ' + (stopIndex + 1)"
                                           (ngModelChange)="setCategoryStopColor(stop, $event)">
                            </p-colorpicker>
                            @if (categoryValueOptions.length > 0) {
                                <p-select class="search-style-color-value-select"
                                          [options]="categoryValueOptions"
                                          [editable]="true"
                                          [ngModel]="stop.valueText"
                                          (ngModelChange)="setCategoryStopValue(stop, $event)"
                                          optionLabel="label"
                                          optionValue="value"
                                          appendTo="body"
                                          [attr.aria-label]="'Category value ' + (stopIndex + 1)">
                                </p-select>
                            } @else {
                                <input class="search-style-color-value-input"
                                       [type]="categoryValueInputType"
                                       [ngModel]="stop.valueText"
                                       (ngModelChange)="setCategoryStopValue(stop, $event)"
                                       placeholder="Value"
                                       [attr.aria-label]="'Category value ' + (stopIndex + 1)">
                            }
                            <p-button class="search-style-color-delete"
                                      icon="pi pi-times"
                                      severity="danger"
                                      [outlined]="true"
                                      pTooltip="Delete value"
                                      tooltipPosition="bottom"
                                      (click)="deleteCategoryStop(stop)">
                            </p-button>
                        </div>
                    }
                </div>
            }
        </div>
    `,
    standalone: false
})
export class SearchStyleColorComponent implements OnChanges {
    @Input({required: true}) draft!: SearchStyleColorDraft;
    @Input() fieldOptions: SearchStyleFieldOption[] = [];
    @Input() completionScope?: FeatureSearchScope;
    @Input() completionMapLayers: FeatureSearchMapLayerRef[] = [];
    @Input() completionZIndex = 30050;
    @Input() colorPickerOverlayOptions?: OverlayOptions;
    @Input() dataSummary?: SearchValueSummary;
    @Input() dataSummaryStatus: SearchValueSummariesState["status"] = "idle";
    @Output() draftChange = new EventEmitter<SearchStyleColorDraft>();
    @Output() updateFromDataRequested = new EventEmitter<void>();

    private static nextComponentId = 1;

    protected readonly modeInputId: string;
    protected readonly fieldInputId: string;
    protected readonly customFieldCompletionOwnerId: string;
    private readonly modeOptions: Array<{label: string; value: SearchStyleColorMode}> = [
        {label: "Gradient", value: "gradient"},
        {label: "Solid", value: "solid"},
        {label: "Categories", value: "categories"}
    ];
    private nextStopId = 1;

    protected viewDraft = defaultSearchStyleColorDraft("");
    protected colorWarning = "";
    private dataColorWarning = "";
    private pendingUpdateFromData = false;

    constructor() {
        const componentId = SearchStyleColorComponent.nextComponentId++;
        this.modeInputId = `search-style-color-mode-${componentId}`;
        this.fieldInputId = `search-style-color-field-${componentId}`;
        this.customFieldCompletionOwnerId = `search-style-color-field-${componentId}`;
    }

    ngOnChanges(changes: SimpleChanges): void {
        if (!this.draft) {
            return;
        }
        if (changes["draft"]) {
            this.viewDraft = cloneSearchStyleColorDraft(this.draft);
            this.nextStopId = this.maxStopId(this.viewDraft) + 1;
        }
        if ((changes["dataSummary"] || changes["dataSummaryStatus"]) && this.dataSummary) {
            this.dataColorWarning = "";
            if (this.pendingUpdateFromData && this.dataSummaryStatus === "ready") {
                this.pendingUpdateFromData = false;
                this.updateStopsFromData();
                return;
            }
        }
        this.updateColorWarning();
    }

    protected get availableModeOptions(): Array<{label: string; value: SearchStyleColorMode}> {
        return this.modeOptions;
    }

    protected get fieldOptionsForCurrentMode(): SearchStyleFieldOption[] {
        if (this.viewDraft.mode !== "gradient") {
            return this.fieldOptions;
        }
        return this.fieldOptions.filter(option => isNumericStyleValueKind(option.valueKind));
    }

    protected get categoryValueOptions(): Array<{label: string; value: string}> {
        return (this.selectedFieldOption()?.enumValues ?? []).map(value => ({label: value, value}));
    }

    protected get categoryValueInputType(): string {
        return this.selectedFieldIsNumeric() ? "number" : "text";
    }

    protected get gradientPreview(): string {
        return gradientPreviewCss(this.viewDraft);
    }

    protected get gradientTags() {
        return gradientValueTags(this.viewDraft);
    }

    protected get canSortGradientStops(): boolean {
        return gradientStopsNeedSorting(this.viewDraft);
    }

    protected setMode(mode: SearchStyleColorMode): void {
        this.clearDataWarning();
        let nextField = this.viewDraft.field;
        if (mode === "gradient" && !this.viewDraft.customField) {
            nextField = this.selectedFieldSupportsGradient()
                ? nextField
                : this.firstGradientField();
            if (!nextField) {
                this.colorWarning = "Gradient color requires a numeric field.";
                return;
            }
        }
        this.viewDraft = this.autoInitializedDraft({...this.viewDraft, mode, field: nextField});
        this.updateColorWarning();
        this.emitChange();
    }

    protected setField(field: string): void {
        this.clearDataWarning();
        if (this.viewDraft.mode === "gradient" && !this.fieldSupportsGradient(field)) {
            this.colorWarning = "Gradient color requires a numeric field.";
            return;
        }
        this.viewDraft = this.autoInitializedDraft({...this.viewDraft, field, customField: false});
        this.updateColorWarning();
        this.emitChange();
    }

    protected setFieldMode(mode: "field" | "custom"): void {
        this.clearDataWarning();
        if (mode === "custom") {
            this.viewDraft = {...this.viewDraft, customField: true};
            this.updateColorWarning();
            this.emitChange();
            return;
        }
        let nextField = this.viewDraft.field;
        if (!this.fieldExists(nextField)) {
            nextField = this.firstFieldForCurrentMode();
        }
        if (this.viewDraft.mode === "gradient" && !this.fieldSupportsGradient(nextField)) {
            nextField = this.firstGradientField();
            if (!nextField) {
                this.colorWarning = "Gradient color requires a numeric field.";
                return;
            }
        }
        this.viewDraft = this.autoInitializedDraft({...this.viewDraft, customField: false, field: nextField});
        this.updateColorWarning();
        this.emitChange();
    }

    /** Toggles between schema-field selection and a free SIMFIL expression. */
    protected toggleFieldMode(): void {
        this.setFieldMode(this.viewDraft.customField ? "field" : "custom");
    }

    protected setCustomField(field: string): void {
        this.clearDataWarning();
        this.viewDraft = {...this.viewDraft, field: field ?? "", customField: true};
        this.updateColorWarning();
        this.emitChange();
    }

    protected setSolidColor(color: string): void {
        const solidColor = normalizeHexColor(color);
        this.viewDraft = {
            ...this.viewDraft,
            solidColor,
            fallbackColor: solidColor
        };
        this.emitChange();
    }

    protected addGradientStop(): void {
        this.clearDataWarning();
        this.viewDraft = {
            ...this.viewDraft,
            gradientStops: [
                ...this.viewDraft.gradientStops,
                {
                    id: this.nextStopId++,
                    value: null,
                    color: DEFAULT_SEARCH_STYLE_SOLID_COLOR
                }
            ]
        };
        this.emitChange();
    }

    protected setGradientStopColor(stop: SearchStyleGradientStopDraft, color: string): void {
        this.clearDataWarning();
        this.viewDraft = {
            ...this.viewDraft,
            gradientStops: this.viewDraft.gradientStops.map(candidate => candidate.id === stop.id
                ? {...candidate, color: normalizeHexColor(color)}
                : candidate)
        };
        this.emitChange();
    }

    protected setGradientStopValue(stop: SearchStyleGradientStopDraft, value: number | string | null): void {
        this.clearDataWarning();
        const numberValue = value === null || value === "" ? Number.NaN : Number(value);
        this.viewDraft = {
            ...this.viewDraft,
            gradientStops: this.viewDraft.gradientStops.map(candidate => candidate.id === stop.id
                ? {...candidate, value: Number.isFinite(numberValue) ? numberValue : null}
                : candidate)
        };
        this.emitChange();
    }

    protected deleteGradientStop(stop: SearchStyleGradientStopDraft): void {
        this.clearDataWarning();
        this.viewDraft = {
            ...this.viewDraft,
            gradientStops: this.viewDraft.gradientStops.filter(candidate => candidate.id !== stop.id)
        };
        this.emitChange();
    }

    protected sortGradientStops(): void {
        if (!this.canSortGradientStops) {
            return;
        }
        this.clearDataWarning();
        this.viewDraft = {
            ...this.viewDraft,
            gradientStops: sortedGradientStopDrafts(this.viewDraft.gradientStops)
        };
        this.emitChange();
    }

    protected addCategoryStop(): void {
        this.clearDataWarning();
        this.viewDraft = {
            ...this.viewDraft,
            categoryStops: [
                ...this.viewDraft.categoryStops,
                {
                    id: this.nextStopId++,
                    valueText: "",
                    color: DEFAULT_SEARCH_STYLE_SOLID_COLOR,
                    pending: true
                }
            ]
        };
        this.emitChange();
    }

    protected setCategoryStopColor(stop: SearchStyleCategoryStopDraft, color: string): void {
        this.clearDataWarning();
        this.viewDraft = {
            ...this.viewDraft,
            categoryStops: this.viewDraft.categoryStops.map(candidate => candidate.id === stop.id
                ? {...candidate, color: normalizeHexColor(color)}
                : candidate)
        };
        this.emitChange();
    }

    protected setCategoryStopValue(stop: SearchStyleCategoryStopDraft, value: string): void {
        this.clearDataWarning();
        const valueText = value ?? "";
        this.viewDraft = {
            ...this.viewDraft,
            categoryStops: this.viewDraft.categoryStops.map(candidate => candidate.id === stop.id
                ? {...candidate, valueText, pending: valueText.trim().length === 0}
                : candidate)
        };
        this.emitChange();
    }

    protected deleteCategoryStop(stop: SearchStyleCategoryStopDraft): void {
        this.clearDataWarning();
        this.viewDraft = {
            ...this.viewDraft,
            categoryStops: this.viewDraft.categoryStops.filter(candidate => candidate.id !== stop.id)
        };
        this.emitChange();
    }

    /** Replaces gradient/category stops with values observed in the current search results. */
    protected updateStopsFromData(): void {
        const summary = this.dataSummary;
        if (!summary) {
            this.pendingUpdateFromData = true;
            this.updateFromDataRequested.emit();
            this.dataColorWarning = this.dataSummaryMissingMessage();
            this.updateColorWarning();
            return;
        }

        if (this.viewDraft.mode === "gradient") {
            this.updateGradientStopsFromData(summary);
            return;
        }
        if (this.viewDraft.mode === "categories") {
            this.updateCategoryStopsFromData(summary);
        }
    }

    private emitChange(): void {
        if (!isSerializableColorDraft(this.viewDraft)) {
            return;
        }
        this.draftChange.emit(cloneSearchStyleColorDraft(this.viewDraft));
    }

    private maxStopId(draft: SearchStyleColorDraft): number {
        return Math.max(
            0,
            ...draft.gradientStops.map(stop => stop.id),
            ...draft.categoryStops.map(stop => stop.id)
        );
    }

    private selectedFieldOption(): SearchStyleFieldOption | undefined {
        return this.fieldOptions.find(option => option.value === this.viewDraft.field);
    }

    private selectedFieldIsNumeric(): boolean {
        return isNumericStyleValueKind(this.selectedFieldOption()?.valueKind);
    }

    private selectedFieldSupportsGradient(): boolean {
        if (this.viewDraft.customField) {
            return true;
        }
        return this.fieldSupportsGradient(this.viewDraft.field);
    }

    private firstGradientField(): string {
        return this.fieldOptions.find(option => isNumericStyleValueKind(option.valueKind))?.value ?? "";
    }

    private firstFieldForCurrentMode(): string {
        return this.fieldOptionsForCurrentMode[0]?.value ?? "";
    }

    private fieldExists(field: string): boolean {
        return this.fieldOptions.some(candidate => candidate.value === field);
    }

    private fieldSupportsGradient(field: string): boolean {
        const option = this.fieldOptions.find(candidate => candidate.value === field);
        return isNumericStyleValueKind(option?.valueKind);
    }

    private autoInitializedDraft(draft: SearchStyleColorDraft): SearchStyleColorDraft {
        const result = autoInitializeSearchStyleColorDraft(
            draft,
            this.fieldOptions.find(candidate => candidate.value === draft.field),
            () => this.nextStopId++
        );
        this.colorWarning = result.message;
        return result.draft;
    }

    /** Clears transient data-derived messages after the user edits the color configuration manually. */
    private clearDataWarning(): void {
        this.dataColorWarning = "";
    }

    /** Uses observed numeric min/max to rebuild gradient stops. */
    private updateGradientStopsFromData(summary: SearchValueSummary): void {
        if (!summary.numeric || summary.numeric.count <= 0) {
            this.dataColorWarning = "Observed data for this expression is not numeric.";
            this.updateColorWarning();
            return;
        }

        const gradientStops = gradientStopsForObservedNumericRange({
            min: summary.numeric.min,
            max: summary.numeric.max
        }, () => this.nextStopId++);
        if (gradientStops.length === 0) {
            this.dataColorWarning = "Observed numeric values do not provide a usable range.";
            this.updateColorWarning();
            return;
        }

        this.viewDraft = {
            ...this.viewDraft,
            gradientStops,
            categoryStops: []
        };
        this.dataColorWarning = "";
        this.emitChange();
        this.updateColorWarning();
    }

    /** Uses observed histogram buckets to rebuild category stops for enum or string-like values. */
    private updateCategoryStopsFromData(summary: SearchValueSummary): void {
        const values = summary.histogram
            .map(bucket => bucket.value)
            .filter(value => value.trim().length > 0);
        if (values.length === 0) {
            this.dataColorWarning = "Observed data for this expression has no category histogram.";
            this.updateColorWarning();
            return;
        }

        this.viewDraft = {
            ...this.viewDraft,
            gradientStops: [],
            categoryStops: categoryStopsForObservedValues(
                values,
                this.selectedFieldOption()?.valueKind,
                () => this.nextStopId++
            )
        };
        this.dataColorWarning = summary.distinctLimitReached || summary.otherCount > 0
            ? "Using the most frequent observed values; more distinct values exist."
            : "";
        this.emitChange();
        this.updateColorWarning();
    }

    /** Explains why observed data is not available yet and kicks off lazy aggregation. */
    private dataSummaryMissingMessage(): string {
        if (this.dataSummaryStatus === "loading") {
            return "Summarizing observed values...";
        }
        if (this.dataSummaryStatus === "error") {
            return "Observed value summary failed. See Diagnostics.";
        }
        if (this.dataSummaryStatus === "empty" || this.dataSummaryStatus === "ready") {
            return "No observed values are available for this expression.";
        }
        return "Summarizing observed values; click again when ready.";
    }

    private updateColorWarning(): void {
        if (this.dataColorWarning) {
            this.colorWarning = this.dataColorWarning;
            return;
        }
        const gradientWarning = this.viewDraft.mode === "gradient"
            && !this.viewDraft.customField
            && !this.selectedFieldSupportsGradient()
            ? "Gradient color requires a numeric field."
            : "";
        if (gradientWarning) {
            this.colorWarning = gradientWarning;
            return;
        }
        if (this.viewDraft.mode === "gradient" && this.viewDraft.gradientStops.length > 0) {
            this.colorWarning = "";
            return;
        }
        if (this.viewDraft.mode === "categories"
            && this.viewDraft.categoryStops.some(stop => stop.valueText.trim().length > 0)) {
            this.colorWarning = "";
            return;
        }
        const result = autoInitializeSearchStyleColorDraft(
            this.viewDraft,
            this.selectedFieldOption(),
            () => this.nextStopId
        );
        this.colorWarning = result.success ? "" : result.message;
    }
}
