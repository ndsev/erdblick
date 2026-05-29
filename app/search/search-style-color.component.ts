import {
    Component,
    EventEmitter,
    Input,
    OnChanges,
    Output,
    SimpleChanges
} from "@angular/core";
import {
    cloneSearchStyleColorDraft,
    defaultSearchStyleColorDraft,
    DEFAULT_SEARCH_STYLE_SOLID_COLOR,
    gradientPreviewCss,
    gradientStopsNeedSorting,
    gradientValueTags,
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
                          [options]="modeOptions"
                          [ngModel]="viewDraft.mode"
                          (ngModelChange)="setMode($event)"
                          optionLabel="label"
                          optionValue="value"
                          appendTo="body">
                </p-select>

                @if (viewDraft.mode !== 'solid') {
                    <label [for]="fieldInputId">Field</label>
                    <p-select [inputId]="fieldInputId"
                              class="search-style-color-field"
                              [options]="fieldOptions"
                              [ngModel]="viewDraft.field"
                              (ngModelChange)="setField($event)"
                              optionLabel="label"
                              optionValue="value"
                              [filter]="true"
                              appendTo="body">
                    </p-select>
                }
            </div>

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
                            <input class="search-style-color-value-input"
                                   type="text"
                                   [ngModel]="stop.valueText"
                                   (ngModelChange)="setCategoryStopValue(stop, $event)"
                                   placeholder="Value"
                                   [attr.aria-label]="'Category value ' + (stopIndex + 1)">
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
    @Output() draftChange = new EventEmitter<SearchStyleColorDraft>();

    private static nextComponentId = 1;

    protected readonly modeInputId: string;
    protected readonly fieldInputId: string;
    protected readonly modeOptions: Array<{label: string; value: SearchStyleColorMode}> = [
        {label: "Gradient", value: "gradient"},
        {label: "Solid", value: "solid"},
        {label: "Categories", value: "categories"}
    ];

    private nextStopId = 1;

    protected viewDraft = defaultSearchStyleColorDraft("");

    constructor() {
        const componentId = SearchStyleColorComponent.nextComponentId++;
        this.modeInputId = `search-style-color-mode-${componentId}`;
        this.fieldInputId = `search-style-color-field-${componentId}`;
    }

    ngOnChanges(changes: SimpleChanges): void {
        if (!changes["draft"] || !this.draft) {
            return;
        }
        this.viewDraft = cloneSearchStyleColorDraft(this.draft);
        this.nextStopId = this.maxStopId(this.viewDraft) + 1;
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
        this.viewDraft = {...this.viewDraft, mode};
        this.emitChange();
    }

    protected setField(field: string): void {
        this.viewDraft = {...this.viewDraft, field};
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
}
