import {
    Component,
    EventEmitter,
    Input,
    OnChanges,
    Output,
    SimpleChanges
} from "@angular/core";
import {FeatureSearchMapLayerRef, FeatureSearchScope} from "../shared/feature-search-state";
import {
    autoInitializeSearchStyleColorDraft,
    cloneSearchStyleColorDraft,
    defaultSearchStyleColorDraft,
    DEFAULT_SEARCH_STYLE_SOLID_COLOR,
    gradientPreviewCss,
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

                @if (viewDraft.mode !== 'solid') {
                    <p-selectbutton class="search-style-color-field-mode"
                                    [options]="fieldModeOptions"
                                    [ngModel]="viewDraft.customField ? 'custom' : 'field'"
                                    (ngModelChange)="setFieldMode($event)"
                                    optionLabel="label"
                                    optionValue="value"
                                    [allowEmpty]="false">
                    </p-selectbutton>

                    @if (viewDraft.customField) {
                        <simfil-expression-input class="search-style-color-field-input"
                                                 [value]="viewDraft.field"
                                                 (valueChange)="setCustomField($event)"
                                                 [singleLine]="true"
                                                 [completionOwnerId]="customFieldCompletionOwnerId"
                                                 [completionScope]="completionScope"
                                                 [completionMapLayers]="completionMapLayers"
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
            </div>

            @if (colorWarning) {
                <div class="search-style-color-warning">{{ colorWarning }}</div>
            }

            @if (viewDraft.mode === 'solid') {
                <div class="search-style-color-solid-row">
                    <p-colorpicker [ngModel]="viewDraft.solidColor"
                                   appendTo="body"
                                   (ngModelChange)="setSolidColor($event)">
                    </p-colorpicker>
                </div>
            } @else if (viewDraft.mode === 'gradient') {
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
                </div>
                <div class="search-style-color-stop-list">
                    @for (stop of viewDraft.gradientStops; track stop.id; let stopIndex = $index) {
                        <div class="search-style-color-stop-row">
                            <p-colorpicker [ngModel]="stop.color"
                                           appendTo="body"
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
                </div>
                <div class="search-style-color-stop-list">
                    @for (stop of viewDraft.categoryStops; track stop.id; let stopIndex = $index) {
                        <div class="search-style-color-stop-row">
                            <p-colorpicker [ngModel]="stop.color"
                                           appendTo="body"
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
    @Output() draftChange = new EventEmitter<SearchStyleColorDraft>();

    private static nextComponentId = 1;

    protected readonly modeInputId: string;
    protected readonly fieldInputId: string;
    protected readonly customFieldCompletionOwnerId: string;
    private readonly modeOptions: Array<{label: string; value: SearchStyleColorMode}> = [
        {label: "Gradient", value: "gradient"},
        {label: "Solid", value: "solid"},
        {label: "Categories", value: "categories"}
    ];
    protected readonly fieldModeOptions = [
        {label: "Field", value: "field"},
        {label: "Custom", value: "custom"}
    ];

    private nextStopId = 1;

    protected viewDraft = defaultSearchStyleColorDraft("");
    protected colorWarning = "";

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
        if (this.viewDraft.mode === "gradient" && !this.fieldSupportsGradient(field)) {
            this.colorWarning = "Gradient color requires a numeric field.";
            return;
        }
        this.viewDraft = this.autoInitializedDraft({...this.viewDraft, field, customField: false});
        this.updateColorWarning();
        this.emitChange();
    }

    protected setFieldMode(mode: "field" | "custom"): void {
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

    protected setCustomField(field: string): void {
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
        this.viewDraft = {
            ...this.viewDraft,
            gradientStops: this.viewDraft.gradientStops.map(candidate => candidate.id === stop.id
                ? {...candidate, color: normalizeHexColor(color)}
                : candidate)
        };
        this.emitChange();
    }

    protected setGradientStopValue(stop: SearchStyleGradientStopDraft, value: number | string | null): void {
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
        this.viewDraft = {
            ...this.viewDraft,
            gradientStops: sortedGradientStopDrafts(this.viewDraft.gradientStops)
        };
        this.emitChange();
    }

    protected addCategoryStop(): void {
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
        this.viewDraft = {
            ...this.viewDraft,
            categoryStops: this.viewDraft.categoryStops.map(candidate => candidate.id === stop.id
                ? {...candidate, color: normalizeHexColor(color)}
                : candidate)
        };
        this.emitChange();
    }

    protected setCategoryStopValue(stop: SearchStyleCategoryStopDraft, value: string): void {
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
        this.viewDraft = {
            ...this.viewDraft,
            categoryStops: this.viewDraft.categoryStops.filter(candidate => candidate.id !== stop.id)
        };
        this.emitChange();
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

    private updateColorWarning(): void {
        const gradientWarning = this.viewDraft.mode === "gradient"
            && !this.viewDraft.customField
            && !this.selectedFieldSupportsGradient()
            ? "Gradient color requires a numeric field."
            : "";
        if (gradientWarning) {
            this.colorWarning = gradientWarning;
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
