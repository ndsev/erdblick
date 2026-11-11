import {
    ChangeDetectionStrategy,
    Component,
    EventEmitter,
    Input,
    OnChanges,
    Output,
    SimpleChanges
} from "@angular/core";
import {OverlayOptions} from "primeng/api";
import {FeatureSearchMapLayerRef, FeatureSearchScope} from "./search-definition.model";
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
    SearchStyleFieldValueKind,
    SearchStyleGradientStopDraft,
    sortedGradientStopDrafts,
    specialStopsForType
} from "./search-style-color.util";

@Component({
    selector: "search-style-color",
    changeDetection: ChangeDetectionStrategy.OnPush,
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

                    @if (viewDraft.customField || fieldOptions.length === 0) {
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
                                  [virtualScroll]="fieldOptionsForCurrentMode.length > 100"
                                  [virtualScrollItemSize]="36"
                                  appendTo="body">
                        </p-select>
                    }
                }
                <ng-content select="[searchStyleColorInlineControl]"></ng-content>
            </div>

            @if (viewDraft.mode !== 'solid') {
                <div class="search-style-color-fallback">
                    <label [for]="modeInputId + '-fallback'">Fallback color</label>
                    <p-toggleswitch [inputId]="modeInputId + '-fallback'"
                                   [ngModel]="viewDraft.fallbackEnabled !== false"
                                   (ngModelChange)="setFallbackEnabled($event)"></p-toggleswitch>
                    @if (viewDraft.fallbackEnabled !== false) {
                        <p-colorpicker [ngModel]="viewDraft.fallbackColor" appendTo="body"
                                       [overlayOptions]="colorPickerOverlayOptions"
                                       aria-label="Fallback color"
                                       (ngModelChange)="setFallbackColor($event)"></p-colorpicker>
                    }
                </div>
            }

            @if (colorWarning) {
                <div class="search-style-color-warning">{{ colorWarning }}</div>
            }
            @if (viewDraft.mode !== 'solid' && viewDraft.specialStops?.length) {
                <div class="search-style-color-stop-list">
                    <span>Special values</span>
                    @for (stop of viewDraft.specialStops; track stop.id) {
                        <div class="search-style-color-stop-row">
                            <p-colorpicker [ngModel]="stop.color" appendTo="body"
                                           [overlayOptions]="colorPickerOverlayOptions"
                                           [attr.aria-label]="specialColorLabel(stop)"
                                           (ngModelChange)="setSpecialStopColor(stop, $event)"></p-colorpicker>
                            <span>{{ specialColorLabel(stop) }}</span>
                            <p-button icon="pi pi-times" severity="danger" [outlined]="true"
                                      pTooltip="Use fallback for this special value"
                                      (click)="deleteSpecialStop(stop)"></p-button>
                        </div>
                    }
                </div>
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
                    @if (canUpdateFromData) {
                        <p-button icon="pi pi-database"
                                  label="Update from data"
                                  severity="secondary"
                                  [outlined]="true"
                                  (click)="updateStopsFromData()">
                        </p-button>
                    }
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
                    @if (canUpdateFromData) {
                        <p-button icon="pi pi-database"
                                  label="Update from data"
                                  severity="secondary"
                                  [outlined]="true"
                                  (click)="updateStopsFromData()">
                        </p-button>
                    }
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
    @Input() canUpdateFromData = true;
    @Output() draftChange = new EventEmitter<SearchStyleColorDraft>();
    @Output() updateFromDataRequested = new EventEmitter<void>();

    private static nextComponentId = 1;

    protected readonly modeInputId: string;
    protected readonly fieldInputId: string;
    protected readonly customFieldCompletionOwnerId: string;
    private readonly modeOptions: Array<{label: string; value: SearchStyleColorMode}> = [
        {label: "Solid", value: "solid"},
        {label: "Gradient", value: "gradient"},
        {label: "Categories", value: "categories"}
    ];
    private nextStopId = 1;

    protected viewDraft = defaultSearchStyleColorDraft("");
    protected colorWarning = "";
    protected categoryValueOptions: Array<{label: string; value: string}> = [];
    private currentModeFieldOptions: SearchStyleFieldOption[] = [];
    private dataColorWarning = "";
    private pendingUpdateFromData = false;

    constructor() {
        const componentId = SearchStyleColorComponent.nextComponentId++;
        this.modeInputId = `search-style-color-mode-${componentId}`;
        this.fieldInputId = `search-style-color-field-${componentId}`;
        this.customFieldCompletionOwnerId = `search-style-color-field-${componentId}`;
    }

    /**
     * Refresh the local editable copy on parent changes. Complete an explicitly
     * requested data refresh when its summary arrives; metadata updates alone do
     * not regenerate the user's saved stops.
     */
    ngOnChanges(changes: SimpleChanges): void {
        if (!this.draft) {
            return;
        }
        if (changes["draft"]) {
            this.viewDraft = cloneSearchStyleColorDraft(this.draft);
            this.nextStopId = this.maxStopId(this.viewDraft) + 1;
        }
        if (changes["draft"] || changes["fieldOptions"]) {
            this.refreshCurrentModeFieldOptions();
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
        return this.currentModeFieldOptions;
    }

    protected get categoryValueInputType(): string {
        return this.selectedFieldIsNumeric() ? "number" : "text";
    }

    protected get gradientPreview(): string {
        return gradientPreviewCss(this.viewDraft);
    }

    protected get gradientTags() {
        const numeric = this.selectedFieldOption()?.schemaType?.numeric;
        return gradientValueTags(this.viewDraft).map(tag => ({...tag,
            label: numeric?.unit
                ? `${Number((Number(tag.label) * numeric.scale + numeric.offset).toPrecision(8))} ${numeric.unit}`
                : tag.label
        }));
    }

    /** Explain exceptional raw codes using the current field's metadata. */
    protected specialColorLabel(stop: SearchStyleGradientStopDraft): string {
        const names = this.selectedFieldOption()?.schemaType?.namedValues
            .filter(named => named.role === "special" && named.value === stop.value).map(named => named.name) ?? [];
        return `${stop.value}${names.length ? ` (${names.join(", ")})` : ""}`;
    }

    /** Editing a special color preserves its raw code and the ordinary stops. */
    protected setSpecialStopColor(stop: SearchStyleGradientStopDraft, color: string): void {
        this.viewDraft = {...this.viewDraft, specialStops: this.viewDraft.specialStops?.map(candidate =>
            candidate.id === stop.id ? {...candidate, color: normalizeHexColor(color)} : candidate)};
        this.emitChange();
    }

    /** Removing an override deliberately exposes the scale's fallback for that code. */
    protected deleteSpecialStop(stop: SearchStyleGradientStopDraft): void {
        this.viewDraft = {...this.viewDraft, specialStops: this.viewDraft.specialStops?.filter(candidate => candidate.id !== stop.id)};
        this.emitChange();
    }

    protected get canSortGradientStops(): boolean {
        return gradientStopsNeedSorting(this.viewDraft);
    }

    /**
     * Switch modes and regenerate defaults from the selected schema field, choosing
     * a numeric field for gradients or keeping the previous mode when none exists.
     */
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
        this.refreshCurrentModeFieldOptions();
        this.updateColorWarning();
        this.emitChange();
    }

    /** Select a schema field and rebuild defaults only when its type supports the mode. */
    protected setField(field: string): void {
        this.clearDataWarning();
        if (this.viewDraft.mode === "gradient" && !this.fieldSupportsGradient(field)) {
            this.colorWarning = "Gradient color requires a numeric field.";
            return;
        }
        this.viewDraft = this.autoInitializedDraft({...this.viewDraft, field, customField: false});
        this.refreshCurrentModeFieldOptions();
        this.updateColorWarning();
        this.emitChange();
    }

    /**
     * Switch between free expressions and schema choices. Returning to the field
     * picker resolves a compatible current field before regenerating its stops.
     */
    protected setFieldMode(mode: "field" | "custom"): void {
        this.clearDataWarning();
        if (mode === "custom") {
            this.viewDraft = {
                ...this.viewDraft,
                customField: true,
                categoryValueKind: undefined
            };
            this.refreshCurrentModeFieldOptions();
            this.updateColorWarning();
            this.emitChange();
            return;
        }
        if (this.fieldOptions.length === 0) {
            this.viewDraft = {...this.viewDraft, customField: false};
            this.refreshCurrentModeFieldOptions();
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
        this.refreshCurrentModeFieldOptions();
        this.updateColorWarning();
        this.emitChange();
    }

    /** Toggles between schema-field selection and a free SIMFIL expression. */
    protected toggleFieldMode(): void {
        this.setFieldMode(this.viewDraft.customField ? "field" : "custom");
    }

    /**
     * Retain edited stops while changing the expression, but discard saved type
     * guards and special-value overrides when they refer to the previous expression.
     */
    protected setCustomField(field: string): void {
        this.clearDataWarning();
        this.viewDraft = {
            ...this.viewDraft,
            ...(field !== this.viewDraft.field ? {specialStops: undefined} : {}),
            field: field ?? "",
            customField: this.viewDraft.customField || this.fieldOptions.length > 0,
            categoryValueKind: this.fieldOptions.length > 0
                ? undefined
                : this.viewDraft.categoryValueKind
        };
        this.refreshCurrentModeFieldOptions();
        this.updateColorWarning();
        this.emitChange();
    }

    /** Keep the fallback synchronized with the selected solid color for later mode changes. */
    protected setSolidColor(color: string): void {
        const solidColor = normalizeHexColor(color);
        this.viewDraft = {
            ...this.viewDraft,
            solidColor,
            fallbackColor: solidColor
        };
        this.emitChange();
    }

    protected setFallbackEnabled(enabled: boolean): void {
        this.viewDraft = {...this.viewDraft, fallbackEnabled: enabled};
        this.emitChange();
    }

    protected setFallbackColor(color: string): void {
        this.viewDraft = {...this.viewDraft, fallbackColor: normalizeHexColor(color)};
        this.emitChange();
    }

    /** Append an incomplete numeric row with its own stable editor ID. */
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

    /** Keep blank or non-finite input as null so the editor can show an incomplete row. */
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

    /** Apply an explicit user-requested sort while preserving stop IDs and colors. */
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

    /** Append a pending category row; its empty text is not yet an authored key. */
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

    /** Keep category text editable and mark whitespace-only input as pending. */
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
            ...draft.categoryStops.map(stop => stop.id),
            ...(draft.specialStops ?? []).map(stop => stop.id)
        );
    }

    private selectedFieldOption(): SearchStyleFieldOption | undefined {
        return this.fieldOptions.find(option => option.value === this.viewDraft.field);
    }

    private selectedFieldIsNumeric(): boolean {
        return isNumericStyleValueKind(
            this.selectedFieldOption()?.valueKind ??
                this.viewDraft.categoryValueKind
        );
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

    /** Keeps picker inputs referentially stable between actual field/schema changes. */
    private refreshCurrentModeFieldOptions(): void {
        this.currentModeFieldOptions = this.viewDraft.mode === "gradient"
            ? this.fieldOptions.filter(option =>
                isNumericStyleValueKind(option.valueKind))
            : this.fieldOptions;
        const enumValues = this.selectedFieldOption()?.enumValues ?? [];
        if (this.categoryValueOptions.length !== enumValues.length ||
            enumValues.some((value, index) =>
                this.categoryValueOptions[index]?.value !== value)) {
            this.categoryValueOptions = enumValues.map(value => ({
                label: value,
                value
            }));
        }
    }

    private fieldExists(field: string): boolean {
        return this.fieldOptions.some(candidate => candidate.value === field);
    }

    private fieldSupportsGradient(field: string): boolean {
        const option = this.fieldOptions.find(candidate => candidate.value === field);
        return isNumericStyleValueKind(option?.valueKind);
    }

    /**
     * Generate schema defaults using this editor's ID sequence and surface the
     * reason when automatic initialization cannot produce a usable scale.
     */
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

    /**
     * Result summaries expose a type only when every value has that exact ID.
     * Several maps can instead share equivalent types verified by the field
     * picker. Use that metadata to initialize missing exception colors, without
     * binding the scale to the current source. Updating ordinary stops preserves
     * edited or deleted special colors.
     */
    private observedColorBinding(summary: SearchValueSummary) {
        const field = this.selectedFieldOption();
        const type = summary.schemaType ?? field?.schemaType;
        return {
            type,
            specialStops: this.viewDraft.specialStops
                ?? (type ? specialStopsForType(type, () => this.nextStopId++) : undefined)
        };
    }

    /** Uses observed numeric min/max to rebuild gradient stops. */
    private updateGradientStopsFromData(summary: SearchValueSummary): void {
        if (!summary.numeric || summary.numeric.count <= 0) {
            this.dataColorWarning = "Observed data for this expression is not numeric.";
            this.updateColorWarning();
            return;
        }

        const binding = this.observedColorBinding(summary);
        const gradientStops = gradientStopsForObservedNumericRange({
            min: summary.numeric.min,
            max: summary.numeric.max
        }, () => this.nextStopId++, binding.type?.numeric);
        if (gradientStops.length === 0) {
            this.dataColorWarning = "Observed numeric values do not provide a usable range.";
            this.updateColorWarning();
            return;
        }

        this.viewDraft = {
            ...this.viewDraft,
            gradientStops,
            categoryStops: [],
            specialStops: binding.specialStops
        };
        this.dataColorWarning = "";
        this.emitChange();
        this.updateColorWarning();
    }

    /** Rebuilds category stops from observed numeric, boolean, or string values. */
    private updateCategoryStopsFromData(summary: SearchValueSummary): void {
        if (summary.kinds.bitmask > 0) {
            this.dataColorWarning = "Choose a named flag from the field picker to color its presence. Raw mask combinations are not categories.";
            this.updateColorWarning();
            return;
        }
        const binding = this.observedColorBinding(summary);
        const specialValues = new Set(binding.type?.namedValues
            .filter(named => named.role === "special").map(named => String(named.value)) ?? []);
        const values = summary.histogram
            .map(bucket => bucket.value)
            .filter(value => value.trim().length > 0 && !specialValues.has(value));
        if (values.length === 0) {
            this.dataColorWarning = "Observed data for this expression has no category histogram.";
            this.updateColorWarning();
            return;
        }

        const valueKind = this.observedCategoryValueKind(summary)
            ?? this.selectedFieldOption()?.valueKind;
        if (summary.kinds.integer > 0 && values.some(value =>
            /^-?\d+$/.test(value) && !Number.isSafeInteger(Number(value)))) {
            this.dataColorWarning = "Some observed integers exceed the editor's exact numeric range. Their raw values remain available in Diagnostics.";
            this.updateColorWarning();
            return;
        }
        // Refreshing observed categories changes ordinary stops only. Preserve
        // edited or deleted special colors across equivalent source versions.
        this.viewDraft = {
            ...this.viewDraft,
            categoryValueKind: valueKind,
            specialStops: binding.specialStops,
            gradientStops: [],
            categoryStops: categoryStopsForObservedValues(
                values,
                valueKind,
                () => this.nextStopId++
            )
        };
        this.dataColorWarning = summary.distinctLimitReached || summary.otherCount > 0
            ? "Using the most frequent observed values; more distinct values exist."
            : "";
        this.emitChange();
        this.updateColorWarning();
    }

    /** Infers one safe scalar category type from the value-summary kind counters. */
    private observedCategoryValueKind(
        summary: SearchValueSummary
    ): SearchStyleFieldValueKind | undefined {
        const numeric = summary.kinds.integer + summary.kinds.number;
        const boolean = summary.kinds.boolean;
        const string = summary.kinds.string;
        const scalar = numeric + boolean + string;
        if (numeric > 0 && scalar === numeric) {
            return "number";
        }
        if (boolean > 0 && scalar === boolean) {
            return "boolean";
        }
        if (string > 0 && scalar === string) {
            return "string";
        }
        return undefined;
    }

    /**
     * Explains why observed data is not available yet. The requesting action starts
     * lazy aggregation; this method only reports its current state.
     */
    private dataSummaryMissingMessage(): string {
        if (this.dataSummaryStatus === "loading") {
            return "Summarizing observed values...";
        }
        if (this.dataSummaryStatus === "error") {
            return "Observed value summary failed. See Diagnostics.";
        }
        if (this.dataSummaryStatus === "ready") {
            return "No single observed value type is available. Check Diagnostics for missing values or mixed types.";
        }
        if (this.dataSummaryStatus === "empty") {
            return "No observed values are available for this expression.";
        }
        return "Summarizing observed values; click again when ready.";
    }

    /**
     * Prioritize data failures, then mode compatibility.
     * If no stops exist, ask the initializer for an explanation without applying it.
     */
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
