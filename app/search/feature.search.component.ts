import {
    Component,
    ElementRef,
    EventEmitter,
    Input,
    OnChanges,
    OnDestroy,
    Output,
    SimpleChanges,
    ViewChild,
    ViewContainerRef
} from "@angular/core";
import {FeatureSearchResultEntry, FeatureSearchService, FeatureSearchSession} from "./feature.search.service";
import {JumpTargetService} from "./jump.service";
import {MapDataService} from "../mapdata/map.service";
import {TreeNode} from "primeng/api";
import {InfoMessageService} from "../shared/info.service";
import {CompletionCandidate, DiagnosticsMessage, TraceResult} from "./search.model";
import {coreLib} from "../integrations/wasm";
import {AppStateService, SEARCH_DOCK_TAB_ID} from "../shared/appstate.service";
import {Tree} from "primeng/tree";
import {Scroller} from "primeng/scroller";
import {DialogStackService} from "../shared/dialog-stack.service";
import {AppDialogComponent} from "../shared/app-dialog.component";
import {debounceTime, distinctUntilChanged, Subject, Subscription} from "rxjs";
import {AppPanelComponent} from "../shared/app-panel.component";
import getCaretCoordinates from "../shared/caret.util";
import type {AppSurfaceHeaderAction} from "../shared/app-surface-header.component";
import type {
    FeatureSearchColorMode,
    FeatureSearchGeometryKind,
    FeatureSearchRuleFilter,
    FeatureSearchScope,
    FeatureSearchStyleRule
} from "../shared/feature-search-state";

interface FeatureSearchGroupingOption {
    name: string;
    value: number;
}

interface FeatureSearchStyleOption {
    label: string;
    value: string;
    mapId?: string;
    layerId?: string;
    attrName?: string;
    featureType?: string;
}

interface FeatureSearchScopeOption {
    label: string;
    value: FeatureSearchScope;
}

interface FeatureSearchResultTreeItem {
    label: string;
    mapId: string;
    layerId: string;
    featureId: string;
    featureType: string;
    tileId: number;
}

interface FeatureSearchStyleColorStop {
    id: number;
    label: string;
    value: number;
    color: string;
}

interface FeatureSearchStyleFilterDraft {
    id: number;
    attributeField: string;
    operator: string;
    filterValue: number;
}

interface FeatureSearchStyleRuleDraft {
    id: number;
    filters: FeatureSearchStyleFilterDraft[];
    visualization: string;
    lineWidth: number;
    opacity: number;
    colorMode: string;
    colorField: string;
    solidColor: string;
    colorStops: FeatureSearchStyleColorStop[];
    categoryStops: FeatureSearchStyleColorStop[];
}

@Component({
    selector: "feature-search",
    template: `
        @if (session) {
            @if (isDocked()) {
                <app-panel #featureSearchPanel class="feature-search-panel" data-testid="feature-search-docked-panel"
                           [layoutId]="session.layoutId" [persistLayout]="true"
                           [dockedPanelCount]="dockedPanelCount"
                           [expanded]="featureSearchExpanded"
                           (onShow)="onDockedPanelShow()">
                    <ng-template #header>
                        <ng-container *ngTemplateOutlet="searchHeader"></ng-container>
                    </ng-template>
                    <ng-template #content>
                        <ng-container *ngTemplateOutlet="searchContent"></ng-container>
                    </ng-template>
                </app-panel>
            } @else {
                <app-dialog #featureSearchDialog class="feature-search-dialog" data-testid="feature-search-dialog"
                          [closeOnEscape]="false" [modal]="false" [closable]="false"
                          [visible]="featureSearchDialogVisible" (visibleChange)="onPanelVisibleChange($event)"
                          [draggable]="true" [resizable]="true"
                          [persistLayout]="true" [persistOpenState]="false" [layoutId]="session.layoutId"
                          (onShow)="onDialogShow($event)"
                          (onDragEnd)="onDialogDragEnd()"
                          (onResizeEnd)="syncTreeScrollHeight($event)" (onHide)="onHide($event)">
                    <ng-template #header>
                        <ng-container *ngTemplateOutlet="searchHeader"></ng-container>
                    </ng-template>
                    <ng-template #content>
                        <ng-container *ngTemplateOutlet="searchContent"></ng-container>
                    </ng-template>
                </app-dialog>
            }
        }

        <ng-template #searchHeader>
            <app-surface-header class="feature-search-surface-header"
                                title="Search Loaded Features"
                                titleIcon="search"
                                [hasColorPicker]="true"
                                [color]="session?.pointColor ?? '#ea4336'"
                                [dockMode]="isDocked() ? 'undock' : 'dock'"
                                [sizeToggleVisible]="isDocked()"
                                [sizeToggleDisabled]="dockedPanelCount <= 1"
                                [expanded]="featureSearchExpanded"
                                [dragEnabled]="isDocked()"
                                [extraActions]="featureSearchHeaderActions()"
                                (focusRequest)="bringSurfaceToFront()"
                                (colorChange)="onSearchColorChange($event)"
                                (dockRequest)="toggleDocked()"
                                (sizeToggleRequest)="toggleExpanded()"
                                (closeRequest)="closeSearch()"
                                (dragPointerDown)="onHeaderPointerDown($event)">
            </app-surface-header>
        </ng-template>

        <ng-template #searchContent>
            <div class="feature-search-query search-input">
                <textarea #featureSearchQueryTextarea
                          class="feature-search-query-input"
                          [class.single-line]="!featureSearchQueryExpanded"
                          pTextarea
                          [rows]="featureSearchQueryExpanded ? 3 : 1"
                          [(ngModel)]="featureSearchQuery"
                          (click)="expandFeatureSearchQueryInput()"
                          (focus)="expandFeatureSearchQueryInput()"
                          (blur)="shrinkFeatureSearchQueryInput()"
                          (keydown)="onFeatureSearchQueryKeydown($event)"
                          (keyup)="onFeatureSearchQueryKeyup($event)"
                          (scroll)="updateFeatureSearchCompletionCursor()"
                          placeholder="Search query">
                </textarea>
                <search-completion-popup
                    [visible]="completion.visible"
                    [pending]="false"
                    [items]="completionItems"
                    [selectionIndex]="completion.selectionIndex"
                    [top]="completion.top"
                    [left]="completion.left"
                    [zIndex]="completion.zIndex"
                    (popupMouseDown)="onCompletionPopupDown($event)"
                    (candidateSelected)="applyFeatureSearchCompletion($event)">
                </search-completion-popup>
            </div>
            <div class="feature-search-scope-control">
                <span>Search scope</span>
                <p-selectbutton [options]="featureSearchScopeOptions"
                                [(ngModel)]="featureSearchScope"
                                optionLabel="label"
                                optionValue="value"
                                [allowEmpty]="false"
                                (ngModelChange)="onFeatureSearchScopeChange($event)">
                </p-selectbutton>
            </div>
            <div class="feature-search-area-control">
                <label for="feature-search-auto-update-toggle">Auto-update area</label>
                <p-toggleswitch [ngModel]="session?.definition?.autoUpdate"
                                (ngModelChange)="onFeatureSearchAutoUpdateChange($event)"
                                inputId="feature-search-auto-update-toggle"
                                data-testid="feature-search-auto-update-toggle">
                </p-toggleswitch>
                @if (!session?.definition?.autoUpdate) {
                    <p-button icon="pi pi-refresh"
                              label="Update Area"
                              severity="secondary"
                              [outlined]="true"
                              data-testid="feature-search-update-area-button"
                              (click)="updateSearchInArea()">
                    </p-button>
                }
            </div>
            <div class="feature-search-controls">
                <div class="progress-bar-container">
                    <p-progressBar [value]="percentDone">
                        <ng-template pTemplate="content">
                            <span>{{ doneTiles }} / {{ totalTiles }} tiles</span>
                        </ng-template>
                    </p-progressBar>
                </div>
            </div>
            @if (awaitedTilesToLoad > 0) {
                <div class="feature-search-awaiting">
                    <span>Awaited tiles to load:</span>
                    <span>{{ awaitedTilesToLoad }}</span>
                    <p-progress-spinner strokeWidth="10" fill="transparent" animationDuration=".5s"
                                        [style]="{ width: '1em', height: '1em', margin: '0' }"/>
                </div>
            }
            <p-tabs [value]="resultPanelIndex"
                    (valueChange)="onResultPanelIndexChange($event)"
                    class="feature-search-tabs"
                    data-testid="feature-search-panel"
                    scrollable>
                <p-tablist>
                    <p-tab value="results">
                        <span>Results </span>
                        <p-badge [value]="results.length"/>
                    </p-tab>
                    <p-tab value="style">
                        <span>Styles </span>
                        <p-badge [value]="styleRuleDrafts.length"/>
                    </p-tab>
                    <p-tab value="diagnostics">
                        <span>Diagnostics </span>
                        <p-badge [value]="diagnostics.length"/>
                    </p-tab>
                    <p-tab value="traces" *ngIf="traces.length > 0">
                        <span>Traces </span>
                        <p-badge [value]="traces.length"/>
                    </p-tab>
                </p-tablist>

                <p-tabpanels>
                    <!-- Results -->
                    <p-tabpanel value="results">
                        <div class="feature-search-results-panel">
                            <div class="feature-search-grouping">
                                <span>Group:</span>
                                <p-multiSelect [options]="grouping" [(ngModel)]="selectedGroupingOptions" [filter]="false"
                                               [showToggleAll]="false" (ngModelChange)="onGroupingOptionsChange($event)"
                                               placeholder="Select Grouping" [maxSelectedLabels]="5"
                                               display="chip" optionLabel="name">
                                </p-multiSelect>
                            </div>

                            <div class="feature-search-tree-host">
                                <p-tree #tree [value]="resultsTree" data-testid="feature-search-tree"
                                        selectionMode="single"
                                        [metaKeySelection]="false"
                                        [lazy]="true"
                                        [virtualScroll]="true"
                                        [virtualScrollItemSize]="stateService.baseFontSize * 2"
                                        [filter]="showFilter"
                                        filterPlaceholder="Filter matched features"
                                        [scrollHeight]="scrollHeight"
                                        [highlightOnSelect]="true"
                                        (onNodeSelect)="selectResult($event)"
                                        [emptyMessage]="resultsStatus">
                                </p-tree>
                            </div>
                        </div>
                    </p-tabpanel>

                    <!-- Style -->
                    <p-tabpanel value="style">
                        <div class="feature-search-style-rules" data-testid="feature-search-style-rules">
                            <div class="feature-search-style-actions feature-search-style-actions-top">
                                <p-button icon="pi pi-plus"
                                          label="Add Rule"
                                          severity="secondary"
                                          [outlined]="true"
                                          (click)="addStyleRule()">
                                </p-button>
                            </div>
                            <p-accordion class="feature-search-style-accordion"
                                         [multiple]="true"
                                         [(value)]="styleRuleAccordionValue">
                                @for (rule of styleRuleDrafts; track rule.id; let ruleIndex = $index) {
                                    <p-accordion-panel class="feature-search-style-panel"
                                                       [value]="styleRulePanelValue(rule)"
                                                       [attr.data-testid]="'feature-search-style-panel-' + rule.id">
                                        <p-accordion-header>
                                            <div class="feature-search-style-rule-header">
                                                <span>Rule {{ styleRuleDrafts.length - ruleIndex }}</span>
                                                <span class="feature-search-style-rule-actions">
                                                    <p-button icon="pi pi-refresh"
                                                              label="Reset Style"
                                                              severity="secondary"
                                                              [outlined]="true"
                                                              (click)="$event.stopPropagation(); resetStyleRule(rule)"
                                                              (mousedown)="$event.stopPropagation()">
                                                    </p-button>
                                                    <p-button icon="pi pi-trash"
                                                              label="Delete Rule"
                                                              severity="danger"
                                                              [outlined]="true"
                                                              (click)="$event.stopPropagation(); deleteStyleRule(rule)"
                                                              (mousedown)="$event.stopPropagation()">
                                                    </p-button>
                                                </span>
                                            </div>
                                        </p-accordion-header>
                                        <p-accordion-content>
                                            <section class="feature-search-style-section">
                                                <h3>1. Filter</h3>
                                                <div class="feature-search-style-condition-list">
                                                    @for (filter of rule.filters; track filter.id) {
                                                        <div class="feature-search-style-filter-row">
                                                            <p-select class="feature-search-style-attribute"
                                                                      [options]="styleAttributeOptions"
                                                                      [(ngModel)]="filter.attributeField"
                                                                      (ngModelChange)="onStyleRulesChanged()"
                                                                      optionLabel="label"
                                                                      optionValue="value"
                                                                      [filter]="true"
                                                                      appendTo="body">
                                                            </p-select>
                                                            <p-select class="feature-search-style-operator"
                                                                      [options]="styleOperatorOptions"
                                                                      [(ngModel)]="filter.operator"
                                                                      (ngModelChange)="onStyleRulesChanged()"
                                                                      optionLabel="label"
                                                                      optionValue="value"
                                                                      appendTo="body">
                                                            </p-select>
                                                            <p-inputNumber class="feature-search-style-number"
                                                                           [(ngModel)]="filter.filterValue"
                                                                           (ngModelChange)="onStyleRulesChanged()"
                                                                           [min]="0"
                                                                           [max]="300">
                                                            </p-inputNumber>
                                                            <p-button class="feature-search-style-condition-delete"
                                                                      icon="pi pi-times"
                                                                      severity="danger"
                                                                      [outlined]="true"
                                                                      pTooltip="Delete condition"
                                                                      tooltipPosition="bottom"
                                                                      (click)="deleteStyleCondition(rule, filter)">
                                                            </p-button>
                                                        </div>
                                                    }
                                                </div>
                                                <p-button icon="pi pi-plus"
                                                          label="Add condition"
                                                          severity="secondary"
                                                          [outlined]="true"
                                                          (click)="addStyleCondition(rule)">
                                                </p-button>
                                            </section>

                                            <section class="feature-search-style-section">
                                                <h3>2. Visualization</h3>
                                                <div class="feature-search-style-visualization-row">
                                                    <p-select class="feature-search-style-visualization"
                                                              [options]="styleVisualizationOptions"
                                                              [(ngModel)]="rule.visualization"
                                                              (ngModelChange)="onStyleRulesChanged()"
                                                              optionLabel="label"
                                                              optionValue="value"
                                                              [filter]="true"
                                                              appendTo="body">
                                                    </p-select>
                                                    <label [for]="'feature-search-style-width-' + rule.id">Width</label>
                                                    <p-inputNumber [inputId]="'feature-search-style-width-' + rule.id"
                                                                   class="feature-search-style-number"
                                                                   [(ngModel)]="rule.lineWidth"
                                                                   (ngModelChange)="onStyleRulesChanged()"
                                                                   [min]="1"
                                                                   [max]="32">
                                                    </p-inputNumber>
                                                    <label [for]="'feature-search-style-opacity-' + rule.id">Opacity</label>
                                                    <div class="feature-search-style-opacity">
                                                       <p-inputNumber [inputId]="'feature-search-style-opacity-' + rule.id"
                                                                       class="feature-search-style-number"
                                                                       [(ngModel)]="rule.opacity"
                                                                       (ngModelChange)="onStyleRulesChanged()"
                                                                       [min]="0"
                                                                       [max]="100"
                                                                       suffix=" %">
                                                        </p-inputNumber>
                                                        <p-slider [(ngModel)]="rule.opacity"
                                                                  (ngModelChange)="onStyleRulesChanged()"
                                                                  [min]="0"
                                                                  [max]="100"
                                                                  class="feature-search-style-opacity-slider">
                                                        </p-slider>
                                                    </div>
                                                </div>
                                            </section>

                                            <section class="feature-search-style-section">
                                                <h3>3. Color</h3>
                                                <div class="feature-search-style-color-mode-row">
                                                    <label [for]="'feature-search-style-color-mode-' + rule.id">Mode</label>
                                                    <p-select [inputId]="'feature-search-style-color-mode-' + rule.id"
                                                              class="feature-search-style-color-mode"
                                                              [options]="styleColorModeOptions"
                                                              [(ngModel)]="rule.colorMode"
                                                              (ngModelChange)="onStyleRulesChanged()"
                                                              optionLabel="label"
                                                              optionValue="value"
                                                              appendTo="body">
                                                    </p-select>
                                                    <label [for]="'feature-search-style-color-field-' + rule.id">Field</label>
                                                    <p-select [inputId]="'feature-search-style-color-field-' + rule.id"
                                                              class="feature-search-style-color-field"
                                                              [options]="styleAttributeOptions"
                                                              [(ngModel)]="rule.colorField"
                                                              (ngModelChange)="onStyleRulesChanged()"
                                                              optionLabel="label"
                                                              optionValue="value"
                                                              [filter]="true"
                                                              appendTo="body">
                                                    </p-select>
                                                </div>

                                                @if (rule.colorMode === 'gradient') {
                                                    <div class="feature-search-style-gradient"
                                                         [style.background]="styleGradientPreview(rule)"
                                                         aria-hidden="true"></div>
                                                    <div class="feature-search-style-gradient-stops">
                                                        @for (stop of rule.colorStops; track stop.id) {
                                                            <div class="feature-search-style-gradient-stop">
                                                                <span class="feature-search-style-gradient-marker"
                                                                      [style.border-bottom-color]="stop.color"></span>
                                                                <div class="feature-search-style-gradient-stop-controls">
                                                                    <p-inputNumber class="feature-search-style-stop-number"
                                                                                   [(ngModel)]="stop.value"
                                                                                   (ngModelChange)="onStyleRulesChanged()"
                                                                                   [min]="0"
                                                                                   [max]="300">
                                                                    </p-inputNumber>
                                                                    <p-colorpicker [(ngModel)]="stop.color"
                                                                                   (ngModelChange)="onStyleRulesChanged()"
                                                                                   appendTo="body"></p-colorpicker>
                                                                </div>
                                                            </div>
                                                        }
                                                    </div>
                                                } @else if (rule.colorMode === 'solid') {
                                                    <div class="feature-search-style-solid-color-row">
                                                        <span>Color</span>
                                                        <p-colorpicker [(ngModel)]="rule.solidColor"
                                                                       (ngModelChange)="onStyleRulesChanged()"
                                                                       appendTo="body"></p-colorpicker>
                                                    </div>
                                                } @else if (rule.colorMode === 'categories') {
                                                    <div class="feature-search-style-category-actions">
                                                        <p-button icon="pi pi-plus"
                                                                  label="Add category"
                                                                  severity="secondary"
                                                                  [outlined]="true"
                                                                  (click)="addStyleCategory(rule)">
                                                        </p-button>
                                                    </div>
                                                    <div class="feature-search-style-category-list">
                                                        @for (category of rule.categoryStops; track category.id) {
                                                            <div class="feature-search-style-category-row">
                                                                <p-colorpicker [(ngModel)]="category.color"
                                                                               (ngModelChange)="onStyleRulesChanged()"
                                                                               appendTo="body"></p-colorpicker>
                                                                <p-inputNumber class="feature-search-style-category-value"
                                                                               [(ngModel)]="category.value"
                                                                               (ngModelChange)="onStyleRulesChanged()"
                                                                               [min]="0"
                                                                               [max]="300">
                                                                </p-inputNumber>
                                                                <p-button class="feature-search-style-category-delete"
                                                                          icon="pi pi-times"
                                                                          severity="danger"
                                                                          [outlined]="true"
                                                                          pTooltip="Delete category"
                                                                          tooltipPosition="bottom"
                                                                          (click)="deleteStyleCategory(rule, category)">
                                                                </p-button>
                                                            </div>
                                                        }
                                                    </div>
                                                }
                                            </section>
                                        </p-accordion-content>
                                    </p-accordion-panel>
                                }
                            </p-accordion>
                        </div>
                    </p-tabpanel>

                    <!-- Diagnostics -->
                    <p-tabpanel value="diagnostics">
                        <div id="searchDiagnosticsPanel">
                            <div>
                                <span class="section-heading">Results</span>
                                <ul>
                                    <li><span>Elapsed time:</span><span>{{ session?.timeElapsed ?? '0ms' }}</span></li>
                                    <li><span>Features:</span><span>{{ session?.totalFeatureCount ?? 0 }}</span></li>
                                    <li><span>Matched:</span><span>{{ session?.searchResults?.length ?? 0 }}</span></li>
                                </ul>
                            </div>
                            <div *ngIf="diagnostics.length > 0">
                                <span class="section-heading">Diagnostics</span>
                                <ul>
                                    @for (message of diagnostics; track message) {
                                        <li>
                                            <div>
                                                <span>{{ message.message }}</span>
                                                <div *ngIf="message.query.length > 0">
                                                    <span>Here: </span>
                                                    <code style="width: 100%;"
                                                          [innerHTML]="message.query | highlightRegion: message.location?.offset:message.location?.size:25"></code>
                                                </div>
                                            </div>
                                            <p-button size="small" label="Fix" *ngIf="message.fix"
                                                      (onClick)="onApplyFix(message)"/>
                                        </li>
                                    }
                                </ul>
                            </div>
                        </div>
                    </p-tabpanel>

                    <!-- Traces -->
                    <p-tabpanel value="traces">
                        <div id="searchTracesPanel">
                            <table>
                                <tr>
                                    <th>Name</th>
                                    <th>Calls</th>
                                    <th>Time</th>
                                </tr>
                                @for (trace of traces; track trace; let first = $first) {
                                    <tr>
                                        <td>{{ trace.name }}</td>
                                        <td>{{ trace.calls }}</td>
                                        <td>{{ trace.totalus }} &mu;s</td>
                                    </tr>
                                }
                            </table>
                        </div>
                    </p-tabpanel>
                </p-tabpanels>
            </p-tabs>
        </ng-template>
        <div #alert></div>
    `,
    styles: [``],
    standalone: false
})
/**
 * Dialog that presents long-running feature-search progress, result grouping, diagnostics, and traces.
 */
export class FeatureSearchComponent implements OnChanges, OnDestroy {
    @Input({required: true}) searchId!: string;
    @Input() dockedPanelCount = 1;
    @Output() panelDragRequest = new EventEmitter<{session: FeatureSearchSession, event: PointerEvent}>();

    session?: FeatureSearchSession;
    private readonly subscriptions = new Subscription();
    private completionSubscriptions = new Subscription();
    private readonly featureSearchQueryChanged = new Subject<void>();
    featureSearchDialogVisible = true;
    traces: Array<TraceResult> = [];
    diagnostics: Array<DiagnosticsMessage> = [];
    percentDone: number = 0;
    totalTiles: number = 0;
    doneTiles: number = 0;
    awaitedTilesToLoad: number = 0;
    isSearchPaused: boolean = false;
    canPauseStopSearch: boolean = false;
    results: FeatureSearchResultEntry[] = [];
    resultsTree: TreeNode[] = [];
    grouping: FeatureSearchGroupingOption[] = [
        {name: 'Maps', value: 1},
        {name: 'Layers', value: 2},
        {name: 'Features', value: 3},
        {name: 'Tiles', value: 4}
    ];
    selectedGroupingOptions: FeatureSearchGroupingOption[] = [];
    styleAttributeOptions: FeatureSearchStyleOption[] = [];
    styleOperatorOptions: FeatureSearchStyleOption[] = [
        {label: '>', value: '>'},
        {label: '>=', value: '>='},
        {label: '=', value: '='},
        {label: '!=', value: '!='},
        {label: '<=', value: '<='},
        {label: '<', value: '<'},
        {label: 'contains', value: 'contains'}
    ];
    styleVisualizationOptions: FeatureSearchStyleOption[] = [
        {label: 'Any geometry', value: 'any'},
        {label: 'Line', value: 'line'},
        {label: 'Polygon', value: 'polygon'},
        {label: 'Mesh', value: 'mesh'},
        {label: 'Point', value: 'point'}
    ];
    styleColorModeOptions: FeatureSearchStyleOption[] = [
        {label: 'Gradient', value: 'gradient'},
        {label: 'Solid', value: 'solid'},
        {label: 'Categories', value: 'categories'}
    ];
    private nextStyleRuleId = 1;
    private nextStyleConditionId = 1;
    private nextStyleColorStopId = 1;
    styleRuleDrafts: FeatureSearchStyleRuleDraft[] = [];
    styleRuleAccordionValue: string[] = [];
    private styleRulesStateSignature = "";

    // Active result panel index
    resultPanelIndex: string = "results";

    showFilter: boolean = false;
    resultsStatus: string = "Loading...";
    scrollHeight: string = "28.5em";
    featureSearchExpanded = false;
    featureSearchQuery = "";
    featureSearchQueryExpanded = false;
    featureSearchScope: FeatureSearchScope = 'auto';
    featureSearchScopeOptions: FeatureSearchScopeOption[] = [
        {label: 'Feature', value: 'feature'},
        {label: 'Attribute', value: 'attribute'},
        {label: 'Auto', value: 'auto'}
    ];
    completionItems: CompletionCandidate[] = [];
    completion = {
        top: 0,
        left: 0,
        selectionIndex: 0,
        visible: false,
        completionDelay: 150,
        zIndex: 30050,
    };
    private lastSearchQuery = "";
    private activeSearchGroupId = "";
    private completedSearchGroupId = "";
    private lastErrorAlertSignature = "";
    private surfacedDockedSearchId = "";
    private completionOwnerId = "";
    private resultTreeInputLength = 0;
    private resultTreeGroupingSignature = "";
    private resultTreeRunId = "";
    private resultTreeGroupNodesByKey = new Map<string, TreeNode>();
    private resultTreeAppendRaf: number | null = null;
    private readonly resultTreeAppendBatchSize = 1000;
    private readonly resultTreeAppendFrameBudgetMs = 8;
    private styleAttributeOptionsSessionSignature = "";

    @ViewChild('alert', { read: ViewContainerRef, static: true }) alertContainer!: ViewContainerRef;
    @ViewChild('tree') tree!: Tree;
    @ViewChild('featureSearchQueryTextarea') featureSearchQueryTextarea?: ElementRef<HTMLTextAreaElement>;
    @ViewChild('featureSearchDialog') featureSearchDialog: AppDialogComponent | undefined;
    @ViewChild('featureSearchPanel') featureSearchPanel: AppPanelComponent | undefined;

    /**
     * Subscribes to search progress and keeps the dialog state synchronized with the active search.
     */
    constructor(public searchService: FeatureSearchService,
                public jumpService: JumpTargetService,
                public mapService: MapDataService,
                public stateService: AppStateService,
                private infoMessageService: InfoMessageService,
                private dialogStack: DialogStackService) {
        this.selectedGroupingOptions = this.groupingOptionsFromValues(this.stateService.featureSearchGrouping);
        this.subscriptions.add(this.stateService.featureSearchGroupingState.subscribe(groupingValues => {
            const nextOptions = this.groupingOptionsFromValues(groupingValues);
            if (this.sameGroupingOptions(this.selectedGroupingOptions, nextOptions)) {
                return;
            }
            this.selectedGroupingOptions = nextOptions;
            this.rebuildResultsTreeIncrementally();
        }));

        this.subscriptions.add(this.searchService.progress.subscribe(updatedSession => {
            if (!updatedSession || updatedSession.id !== this.searchId) {
                return;
            }
            this.syncFromSession(updatedSession);
        }));
        this.subscriptions.add(this.searchService.sessionsChanged.subscribe(() => {
            const session = this.searchService.getSession(this.searchId);
            if (!session) {
                return;
            }
            this.syncFromSession(session);
        }));
        this.subscriptions.add(this.mapService.maps$.subscribe(() => {
            this.styleAttributeOptionsSessionSignature = "";
            if (this.session) {
                this.refreshStyleAttributeOptionsIfNeeded(this.session);
            }
        }));
        this.subscriptions.add(this.featureSearchQueryChanged
            .pipe(debounceTime(this.completion.completionDelay))
            .subscribe(() => this.completeFeatureSearchQuery()));
    }

    /** Creates one empty rule condition using the current schema-backed default field when available. */
    private createDefaultStyleFilter(): FeatureSearchStyleFilterDraft {
        return {
            id: this.nextStyleConditionId++,
            attributeField: this.defaultStyleField(),
            operator: '>',
            filterValue: 80
        };
    }

    /** Creates a UI-owned color stop with a stable row id for Angular tracking. */
    private createStyleColorStop(label: string, value: number, color: string): FeatureSearchStyleColorStop {
        return {
            id: this.nextStyleColorStopId++,
            label,
            value,
            color
        };
    }

    /** Creates the editor draft for a new search-result style rule. */
    private createStyleRule(id: number): FeatureSearchStyleRuleDraft {
        return {
            id,
            filters: [],
            visualization: 'any',
            lineWidth: 10,
            opacity: 40,
            colorMode: 'gradient',
            colorField: this.defaultStyleField(),
            solidColor: '#2f73ff',
            colorStops: [
                this.createStyleColorStop('low', 30, '#2f73ff'),
                this.createStyleColorStop('mid', 80, '#ffd43b'),
                this.createStyleColorStop('high', 120, '#ff3347')
            ],
            categoryStops: [
                this.createStyleColorStop('category 1', 30, '#2f73ff'),
                this.createStyleColorStop('category 2', 80, '#ff3347')
            ]
        };
    }

    /** Returns the first currently valid result-field path for newly created controls. */
    private defaultStyleField(): string {
        return this.styleAttributeOptions[0]?.value ?? "";
    }

    /** Adds a new style rule to the top of the editor and persists it immediately. */
    protected addStyleRule(): void {
        const rule = this.createStyleRule(this.nextStyleRuleId++);
        const panelValue = this.styleRulePanelValue(rule);
        this.styleRuleDrafts = [rule, ...this.styleRuleDrafts];
        this.styleRuleAccordionValue = [
            panelValue,
            ...this.styleRuleAccordionValue.filter(value => value !== panelValue)
        ];
        this.onStyleRulesChanged();
    }

    /** Deletes one style rule draft and persists the remaining rule list. */
    protected deleteStyleRule(rule: FeatureSearchStyleRuleDraft): void {
        const panelValue = this.styleRulePanelValue(rule);
        this.styleRuleDrafts = this.styleRuleDrafts.filter(candidate => candidate.id !== rule.id);
        this.styleRuleAccordionValue = this.styleRuleAccordionValue.filter(value => value !== panelValue);
        this.onStyleRulesChanged();
    }

    /** Returns the stable accordion key for one draft rule. */
    protected styleRulePanelValue(rule: FeatureSearchStyleRuleDraft): string {
        return `${rule.id}`;
    }

    /** Adds a filter condition to one rule draft. */
    protected addStyleCondition(rule: FeatureSearchStyleRuleDraft): void {
        rule.filters = [...rule.filters, this.createDefaultStyleFilter()];
        this.onStyleRulesChanged();
    }

    /** Deletes one filter condition from one rule draft. */
    protected deleteStyleCondition(rule: FeatureSearchStyleRuleDraft, filter: FeatureSearchStyleFilterDraft): void {
        rule.filters = rule.filters.filter(candidate => candidate.id !== filter.id);
        this.onStyleRulesChanged();
    }

    /** Adds a category color stop to one rule draft. */
    protected addStyleCategory(rule: FeatureSearchStyleRuleDraft): void {
        const nextIndex = rule.categoryStops.length + 1;
        rule.categoryStops = [
            ...rule.categoryStops,
            this.createStyleColorStop(`category ${nextIndex}`, nextIndex * 10, '#2f73ff')
        ];
        this.onStyleRulesChanged();
    }

    /** Deletes one category color stop from one rule draft. */
    protected deleteStyleCategory(rule: FeatureSearchStyleRuleDraft, category: FeatureSearchStyleColorStop): void {
        rule.categoryStops = rule.categoryStops.filter(candidate => candidate.id !== category.id);
        this.onStyleRulesChanged();
    }

    /** Returns the CSS preview gradient for the rule's current numeric color stops. */
    protected styleGradientPreview(rule: FeatureSearchStyleRuleDraft): string {
        if (!rule.colorStops.length) {
            return rule.solidColor;
        }
        const denominator = Math.max(rule.colorStops.length - 1, 1);
        const stops = rule.colorStops
            .map((stop, index) => `${stop.color} ${Math.round((index / denominator) * 100)}%`)
            .join(', ');
        return `linear-gradient(90deg, ${stops})`;
    }

    /** Resets one rule draft to the default visual style while preserving its UI identity. */
    protected resetStyleRule(rule: FeatureSearchStyleRuleDraft): void {
        const resetRule = this.createStyleRule(rule.id);
        this.styleRuleDrafts = this.styleRuleDrafts.map(candidate =>
            candidate.id === rule.id ? resetRule : candidate
        );
        this.onStyleRulesChanged();
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

    /** Serializes the editor drafts into persisted search style rules if the semantic value changed. */
    protected onStyleRulesChanged(): void {
        const session = this.session;
        if (!session) {
            return;
        }
        const searchStyleRules = this.styleRuleDrafts.map(rule => this.styleRuleFromDraft(rule));
        const signature = JSON.stringify(searchStyleRules);
        if (signature === this.styleRulesStateSignature) {
            return;
        }
        this.styleRulesStateSignature = signature;
        this.stateService.patchFeatureSearch(session.id, {searchStyleRules});
    }

    /** Rebuilds local editor drafts from the persisted search style rules. */
    private syncStyleRulesFromSession(rules: FeatureSearchStyleRule[]): void {
        const signature = JSON.stringify(rules ?? []);
        if (signature === this.styleRulesStateSignature) {
            return;
        }
        this.styleRulesStateSignature = signature;
        this.nextStyleRuleId = 1;
        this.nextStyleConditionId = 1;
        this.nextStyleColorStopId = 1;
        this.styleRuleDrafts = rules.map(rule => this.styleRuleToDraft(rule));
        this.styleRuleAccordionValue = this.styleRuleDrafts.map(rule => this.styleRulePanelValue(rule));
    }

    /** Converts one editor draft into the persisted/search-request style-rule shape. */
    private styleRuleFromDraft(rule: FeatureSearchStyleRuleDraft): FeatureSearchStyleRule {
        const width = this.clampNumber(rule.lineWidth, 1, 32, 4);
        const color = this.colorModeFromDraft(rule);
        return {
            geometry: this.geometryFromUiValue(rule.visualization),
            filter: rule.filters
                .filter(filter => !!filter.attributeField)
                .map(filter => this.filterFromDraft(filter)),
            color,
            width,
            pointRadius: Math.max(3, width * 1.5),
            opacity: this.clampNumber(rule.opacity, 0, 100, 100) / 100
        };
    }

    /** Converts one persisted style rule into a UI-friendly editor draft. */
    private styleRuleToDraft(rule: FeatureSearchStyleRule): FeatureSearchStyleRuleDraft {
        const color = rule.color;
        const colorField = color.mode === "solid" ? this.defaultStyleField() : color.field || this.defaultStyleField();
        return {
            id: this.nextStyleRuleId++,
            filters: rule.filter.map(filter => this.filterToDraft(filter)),
            visualization: rule.geometry ?? "any",
            lineWidth: this.clampNumber(rule.width, 1, 32, 4),
            opacity: this.clampNumber((rule.opacity ?? 1) * 100, 0, 100, 100),
            colorMode: color.mode,
            colorField,
            solidColor: color.mode === "solid" ? color.color : color.fallbackColor ?? "#2f73ff",
            colorStops: color.mode === "gradient"
                ? this.colorStopsToDraft(color.stops)
                : [
                    this.createStyleColorStop('low', 30, '#2f73ff'),
                    this.createStyleColorStop('mid', 80, '#ffd43b'),
                    this.createStyleColorStop('high', 120, '#ff3347')
                ],
            categoryStops: color.mode === "categories"
                ? this.colorStopsToDraft(color.stops)
                : [
                    this.createStyleColorStop('category 1', 30, '#2f73ff'),
                    this.createStyleColorStop('category 2', 80, '#ff3347')
                ]
        };
    }

    /** Converts the editor's flat color controls into the persisted color-mode union. */
    private colorModeFromDraft(rule: FeatureSearchStyleRuleDraft): FeatureSearchColorMode {
        if (rule.colorMode === "solid") {
            return {mode: "solid", color: this.normalizeUiColor(rule.solidColor, "#2f73ff")};
        }
        if (rule.colorMode === "categories") {
            return {
                mode: "categories",
                field: rule.colorField,
                stops: rule.categoryStops.map(stop => ({
                    value: stop.value,
                    color: this.normalizeUiColor(stop.color, "#2f73ff")
                })),
                fallbackColor: this.normalizeUiColor(rule.solidColor, "#2f73ff")
            };
        }
        return {
            mode: "gradient",
            field: rule.colorField,
            stops: rule.colorStops.map(stop => ({
                value: stop.value,
                color: this.normalizeUiColor(stop.color, "#2f73ff")
            })),
            fallbackColor: this.normalizeUiColor(rule.solidColor, "#2f73ff")
        };
    }

    /** Converts one editor filter condition into its persisted predicate shape. */
    private filterFromDraft(filter: FeatureSearchStyleFilterDraft): FeatureSearchRuleFilter {
        return {
            field: filter.attributeField,
            op: filter.operator,
            value: filter.filterValue
        };
    }

    /** Converts one persisted predicate into an editor filter row. */
    private filterToDraft(filter: FeatureSearchRuleFilter): FeatureSearchStyleFilterDraft {
        return {
            id: this.nextStyleConditionId++,
            attributeField: filter.field || this.defaultStyleField(),
            operator: filter.op || "=",
            filterValue: this.clampNumber(Number(filter.value), 0, 300, 0)
        };
    }

    /** Converts persisted color stops into editor rows with stable Angular ids. */
    private colorStopsToDraft(stops: Array<{value: unknown; color: string}>): FeatureSearchStyleColorStop[] {
        return stops.map((stop, index) =>
            this.createStyleColorStop(
                `stop ${index + 1}`,
                this.clampNumber(Number(stop.value), 0, 300, 0),
                this.normalizeUiColor(stop.color, "#2f73ff")
            )
        );
    }

    /**
     * Refreshes the style-rule field picker from schema metadata.
     *
     * Existing drafts keep their current raw values, but invalid values are not
     * reintroduced into the picker; this prevents old demo fields from staying selectable.
     */
    private refreshStyleAttributeOptions(session: FeatureSearchSession, patchMissingFields = true): void {
        const rawOptions = this.mapService.searchStyleFieldsForQuery(
            session.definition.query,
            session.definition.scope
        );
        const activeOptions = rawOptions.filter(option => this.isStyleFieldCandidateActive(option.mapId, option.layerId));
        const sourceOptions = activeOptions.length ? activeOptions : rawOptions;
        const byValue = new Map<string, FeatureSearchStyleOption>();
        for (const option of sourceOptions) {
            if (!byValue.has(option.path)) {
                byValue.set(option.path, {
                    label: option.path,
                    value: option.path,
                    mapId: option.mapId,
                    layerId: option.layerId,
                    attrName: option.attrName,
                    featureType: option.featureType
                });
            }
        }
        const nextOptions = Array.from(byValue.values()).sort((lhs, rhs) => lhs.label.localeCompare(rhs.label));
        if (JSON.stringify(nextOptions) !== JSON.stringify(this.styleAttributeOptions)) {
            this.styleAttributeOptions = nextOptions;
        }
        if (patchMissingFields
            && (session.definition.searchStyleRules?.length ?? 0) > 0
            && this.applyDefaultStyleFieldIfMissing()) {
            this.onStyleRulesChanged();
        }
    }

    /** Refreshes schema-backed style fields only when the style editor can consume them. */
    private refreshStyleAttributeOptionsIfNeeded(session: FeatureSearchSession, patchMissingFields = true): void {
        if (this.resultPanelIndex !== "style" && this.styleAttributeOptions.length === 0) {
            return;
        }
        const signature = [
            session.definition.query,
            session.definition.scope,
            this.visibleMapLayerSignature()
        ].join("\n");
        if (signature === this.styleAttributeOptionsSessionSignature) {
            return;
        }
        this.styleAttributeOptionsSessionSignature = signature;
        this.refreshStyleAttributeOptions(session, patchMissingFields);
    }

    /** Returns a compact signature for map/layer visibility that affects preferred field-picker ordering. */
    private visibleMapLayerSignature(): string {
        const visibleLayerKeys: string[] = [];
        for (const [mapId, mapInfo] of this.mapService.maps.maps) {
            for (const layer of mapInfo.allFeatureLayers()) {
                for (let viewIndex = 0; viewIndex < this.stateService.numViews; ++viewIndex) {
                    if (this.mapService.maps.getMapLayerVisibility(viewIndex, mapId, layer.id)) {
                        visibleLayerKeys.push(`${viewIndex}:${mapId}:${layer.id}`);
                    }
                }
            }
        }
        return visibleLayerKeys.sort().join("|");
    }

    /** Returns whether a field candidate belongs to a currently visible map/layer context. */
    private isStyleFieldCandidateActive(mapId: string, layerId: string): boolean {
        for (let viewIndex = 0; viewIndex < this.stateService.numViews; ++viewIndex) {
            if (this.mapService.maps.getMapLayerVisibility(viewIndex, mapId, layerId)) {
                return true;
            }
        }
        return false;
    }

    /** Returns whether an editor field should be replaced by a schema-backed default. */
    private fieldNeedsDefault(field: string): boolean {
        return !field
            || (this.styleAttributeOptions.length > 0
                && !this.styleAttributeOptions.some(option => option.value === field));
    }

    /** Applies the current default style field to drafts that still point at missing fields. */
    private applyDefaultStyleFieldIfMissing(): boolean {
        const field = this.defaultStyleField();
        if (!field) {
            return false;
        }
        let changed = false;
        for (const rule of this.styleRuleDrafts) {
            if (rule.colorMode !== "solid" && this.fieldNeedsDefault(rule.colorField)) {
                rule.colorField = field;
                changed = true;
            }
            for (const filter of rule.filters) {
                if (this.fieldNeedsDefault(filter.attributeField)) {
                    filter.attributeField = field;
                    changed = true;
                }
            }
        }
        return changed;
    }

    /** Maps the UI geometry selector value to the persisted search-style geometry kind. */
    private geometryFromUiValue(value: string): FeatureSearchGeometryKind {
        return ["any", "point", "line", "polygon", "mesh"].includes(value)
            ? value as FeatureSearchGeometryKind
            : "any";
    }

    private normalizeUiColor(value: string | undefined, fallback: string): string {
        const trimmed = (value ?? "").trim();
        return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : fallback;
    }

    private clampNumber(value: unknown, min: number, max: number, fallback: number): number {
        const numberValue = Number(value);
        return Number.isFinite(numberValue)
            ? Math.min(max, Math.max(min, numberValue))
            : fallback;
    }

    /** Rebinds this visual wrapper when the owning session id changes. */
    ngOnChanges(changes: SimpleChanges): void {
        if (changes['searchId']) {
            this.bindSession();
            this.bindCompletionOwner();
        }
    }

    /** Loads the current session snapshot for this component instance. */
    private bindSession(): void {
        const session = this.searchService.getSession(this.searchId);
        if (!session) {
            this.session = undefined;
            this.resetLocalState();
            return;
        }
        this.syncFromSession(session);
    }

    /** Rebinds completion streams to this search instance so inputs do not share stale candidates. */
    private bindCompletionOwner(): void {
        const ownerId = `feature-search:${this.searchId}`;
        if (this.completionOwnerId === ownerId) {
            return;
        }
        if (this.completionOwnerId) {
            this.searchService.clearCurrentCompletion(this.completionOwnerId);
        }
        this.completionOwnerId = ownerId;
        this.completionSubscriptions.unsubscribe();
        this.completionSubscriptions = new Subscription();
        const completionState = this.searchService.completionStateForOwner(ownerId);
        this.completionSubscriptions.add(completionState.candidates.pipe(distinctUntilChanged()).subscribe(value => {
            this.completionItems = value.filter(item =>
                item.query !== this.featureSearchQuery && item.source === this.featureSearchQuery
            );
            if (this.completion.selectionIndex >= this.completionItems.length) {
                this.completion.selectionIndex = Math.max(0, this.completionItems.length - 1);
            }
            const input = this.featureSearchQueryTextarea?.nativeElement;
            const focusValid = this.completion.visible || input === document.activeElement;
            if (this.completionItems.length > 0 && focusValid) {
                this.refreshCompletionZIndex();
            }
            this.completion.visible = this.completionItems.length > 0 && focusValid;
        }));
    }

    /** Copies session state into the local view model without crossing streams between searches. */
    private syncFromSession(session: FeatureSearchSession): void {
        this.session = session;
        this.featureSearchDialogVisible = true;
        const previousQuery = this.lastSearchQuery;
        const previousScope = this.featureSearchScope;
        this.lastSearchQuery = session.definition.query;
        this.featureSearchScope = session.definition.scope;
        this.refreshStyleAttributeOptionsIfNeeded(session, false);
        this.syncStyleRulesFromSession(session.definition.searchStyleRules ?? []);
        if ((session.definition.searchStyleRules?.length ?? 0) > 0 && this.applyDefaultStyleFieldIfMissing()) {
            this.onStyleRulesChanged();
        }
        if (this.activeSearchGroupId !== session.runId) {
            this.activeSearchGroupId = session.runId;
            this.completedSearchGroupId = "";
            this.lastErrorAlertSignature = "";
            this.featureSearchQuery = session.definition.query;
            this.results = [];
            this.resultsTree = [];
            if (previousQuery !== session.definition.query
                || previousScope !== session.definition.scope
                || this.resultPanelIndex !== 'style') {
                this.resultPanelIndex = 'results';
            }
        }
        this.percentDone = session.progressTotal > 0
            ? Math.round((session.progressDone / session.progressTotal) * 100)
            : 0;
        this.totalTiles = session.progressTotal;
        this.doneTiles = session.progressDone;
        this.awaitedTilesToLoad = 0;
        this.isSearchPaused = session.paused;
        this.diagnostics = session.diagnostics;
        this.syncStreamingResults(session);
        if (this.isDocked()) {
            this.stateService.isDockOpen = true;
            if (this.surfacedDockedSearchId !== session.id) {
                this.stateService.dockActiveTab = SEARCH_DOCK_TAB_ID;
                this.surfacedDockedSearchId = session.id;
            }
        }
        if (session.complete) {
            this.searchResultReady(this.completedSearchGroupId !== session.runId);
            this.completedSearchGroupId = session.runId;
            this.canPauseStopSearch = false;
        } else {
            this.resultsStatus = "Loading...";
            this.canPauseStopSearch = true;
            this.completedSearchGroupId = "";
        }
    }

    /** Stops feature search subscriptions when the component is destroyed. */
    ngOnDestroy() {
        this.subscriptions.unsubscribe();
        this.completionSubscriptions.unsubscribe();
        if (this.completionOwnerId) {
            this.searchService.clearCurrentCompletion(this.completionOwnerId);
        }
    }

    protected isDocked(): boolean {
        return !!this.session && this.searchService.isSessionDocked(this.session.id);
    }

    /**
     * Recomputes the virtual tree height once the dialog becomes measurable.
     */
    onDialogShow(event: any) {
        this.syncTreeScrollHeight(event);
        this.dialogStack.bringToFront(this.featureSearchDialog);
    }

    protected onDialogDragEnd() {
        const session = this.session;
        if (!session || !this.shouldDockDialog()) {
            this.dialogStack.bringToFront(this.featureSearchDialog);
            return;
        }
        this.searchService.setSessionDocked(session.id, true);
    }

    protected onDockedPanelShow() {
        this.syncTreeScrollHeight();
    }

    protected bringSurfaceToFront() {
        if (!this.isDocked()) {
            this.dialogStack.bringToFront(this.featureSearchDialog);
        }
    }

    private refreshCompletionZIndex() {
        const container = this.featureSearchDialog?.container();
        const inlineZIndex = container ? Number.parseInt(container.style.zIndex, 10) : Number.NaN;
        const computedZIndex = container ? Number.parseInt(window.getComputedStyle(container).zIndex, 10) : Number.NaN;
        const surfaceZIndex = Number.isFinite(inlineZIndex)
            ? inlineZIndex
            : (Number.isFinite(computedZIndex) ? computedZIndex : 30050);
        this.completion.zIndex = this.isDocked() ? 30050 : surfaceZIndex + 1;
    }

    private shouldDockDialog(): boolean {
        const dialog = this.featureSearchDialog?.container();
        const dock = document.querySelector('.collapsible-dock') as HTMLElement | null;
        if (!dialog || !dock) {
            return false;
        }
        const dialogRect = dialog.getBoundingClientRect();
        const dockRect = dock.getBoundingClientRect();
        const overlapWidth = Math.max(0, Math.min(dialogRect.right, dockRect.right) - Math.max(dialogRect.left, dockRect.left));
        const overlapHeight = Math.max(0, Math.min(dialogRect.bottom, dockRect.bottom) - Math.max(dialogRect.top, dockRect.top));
        return overlapWidth >= this.stateService.baseFontSize * 2 && overlapHeight > 0;
    }

    protected toggleDocked() {
        const session = this.session;
        if (!session) {
            return;
        }
        this.searchService.setSessionDocked(session.id, !this.isDocked());
        if (!this.isDocked()) {
            this.featureSearchExpanded = false;
            setTimeout(() => this.dialogStack.bringToFront(this.featureSearchDialog), 0);
        } else {
            setTimeout(() => this.syncTreeScrollHeight(), 0);
        }
    }

    protected toggleExpanded() {
        if (this.dockedPanelCount <= 1) {
            return;
        }
        this.featureSearchExpanded = !this.featureSearchExpanded;
        setTimeout(() => this.syncTreeScrollHeight(), 0);
    }

    protected onSearchColorChange(color: string) {
        if (this.session) {
            this.searchService.setSearchColor(this.session.id, color);
        }
    }

    protected onHeaderPointerDown(event: PointerEvent) {
        const session = this.session;
        if (!session || !this.isDocked() || event.button !== 0) {
            return;
        }
        this.panelDragRequest.emit({session, event});
    }

    protected expandFeatureSearchQueryInput() {
        this.featureSearchQueryExpanded = true;
        this.updateFeatureSearchCompletionCursor();
    }

    protected shrinkFeatureSearchQueryInput() {
        this.featureSearchQueryExpanded = false;
        setTimeout(() => {
            this.completion.visible = false;
        }, 0);
    }

    protected onFeatureSearchQueryKeydown(event: KeyboardEvent) {
        if (this.handleFeatureSearchCompletionKeydown(event)) {
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            this.rerunSearch();
        } else if (event.key === 'Escape' && this.completion.visible) {
            event.preventDefault();
            event.stopPropagation();
            this.resetFeatureSearchCompletion();
        }
    }

    protected onFeatureSearchQueryKeyup(event: KeyboardEvent) {
        this.updateFeatureSearchCompletionCursor();
        const ignoredKeys = [
            'Home', 'End', 'PageUp', 'PageDown', 'Escape',
            'Enter', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'
        ];
        if (!ignoredKeys.includes(event.key)) {
            this.featureSearchQueryChanged.next();
        }
    }

    protected updateFeatureSearchCompletionCursor() {
        const textarea = this.featureSearchQueryTextarea?.nativeElement;
        if (!textarea) {
            return;
        }
        const rect = textarea.getBoundingClientRect();
        const cursor = textarea.selectionStart || 0;
        const style = window.getComputedStyle(textarea);
        const fontSizePx = parseFloat(style.fontSize);
        const offset = (1 + 0.75) * fontSizePx;
        const caret = getCaretCoordinates(textarea, cursor);
        const containingBlockRect = this.completionFixedContainingBlock(textarea)?.getBoundingClientRect();
        const blockTop = containingBlockRect?.top ?? 0;
        const blockLeft = containingBlockRect?.left ?? 0;
        if (caret) {
            this.completion.top = rect.top + caret.top + offset - blockTop;
            this.completion.left = rect.left + caret.left - blockLeft;
        } else {
            this.completion.top = rect.bottom - blockTop;
            this.completion.left = rect.left - blockLeft;
        }
    }

    private completionFixedContainingBlock(textarea: HTMLElement): HTMLElement | null {
        let element = textarea.parentElement;
        while (element && element !== document.body) {
            const style = window.getComputedStyle(element);
            const backdropFilter = style.getPropertyValue('backdrop-filter');
            if (style.transform !== 'none'
                || style.perspective !== 'none'
                || style.filter !== 'none'
                || (!!backdropFilter && backdropFilter !== 'none')
                || style.contain.includes('paint')
                || style.contain.includes('layout')) {
                return element;
            }
            element = element.parentElement;
        }
        return null;
    }

    protected onCompletionPopupDown(event: MouseEvent) {
        event.preventDefault();
    }

    protected applyFeatureSearchCompletion(candidate?: CompletionCandidate) {
        const item = candidate ?? this.completionItems[this.completion.selectionIndex];
        const textarea = this.featureSearchQueryTextarea?.nativeElement;
        if (!item || !textarea) {
            return;
        }
        this.featureSearchQuery = item.query;
        this.completion.visible = false;
        this.completionItems = [];
        const cursor = item.begin + item.text.length;
        setTimeout(() => {
            textarea.focus();
            textarea.setSelectionRange(cursor, cursor, "forward");
            this.updateFeatureSearchCompletionCursor();
        }, 0);
    }

    private completeFeatureSearchQuery() {
        if (!this.featureSearchQuery.trim()) {
            this.resetFeatureSearchCompletion();
            return;
        }
        const textarea = this.featureSearchQueryTextarea?.nativeElement;
        this.searchService.completeQueryForOwner(
            this.completionOwnerId || `feature-search:${this.searchId}`,
            this.featureSearchQuery,
            textarea?.selectionStart ?? this.featureSearchQuery.length
        );
        this.completion.selectionIndex = 0;
    }

    private resetFeatureSearchCompletion() {
        if (this.completionOwnerId) {
            this.searchService.clearCurrentCompletion(this.completionOwnerId);
        }
        this.completion.selectionIndex = 0;
        this.completionItems = [];
        this.completion.visible = false;
    }

    private handleFeatureSearchCompletionKeydown(event: KeyboardEvent): boolean {
        if (!this.completion.visible) {
            return false;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            event.stopPropagation();
            this.applyFeatureSearchCompletion();
            return true;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            const count = this.completionItems.length;
            if (count > 0) {
                this.completion.selectionIndex = (this.completion.selectionIndex + direction + count) % count;
            }
            return true;
        }
        return false;
    }

    protected rerunSearch() {
        const query = this.searchQueryForRerun();
        if (!query || !this.session) {
            return;
        }
        this.featureSearchQuery = query;
        this.searchService.rerunSearch(this.session.id, query);
    }

    protected searchQueryForRerun(): string {
        return this.featureSearchQuery.trim() || this.session?.definition.query || this.lastSearchQuery;
    }

    protected onFeatureSearchScopeChange(scope: FeatureSearchScope): void {
        this.featureSearchScope = scope;
        if (this.session && this.session.definition.scope !== scope) {
            this.styleAttributeOptionsSessionSignature = "";
            this.stateService.patchFeatureSearch(this.session.id, {scope});
        }
    }

    /** Tracks tab changes and refreshes expensive style-field metadata only when the style tab becomes visible. */
    protected onResultPanelIndexChange(value: string | number | undefined): void {
        this.resultPanelIndex = String(value ?? "results");
        if (this.resultPanelIndex === "style" && this.session) {
            this.refreshStyleAttributeOptionsIfNeeded(this.session);
        }
    }

    protected onFeatureSearchAutoUpdateChange(autoUpdate: boolean): void {
        if (this.session) {
            this.searchService.setSearchAutoUpdate(this.session.id, autoUpdate);
        }
    }

    protected updateSearchInArea(): void {
        if (this.session) {
            this.searchService.updateSearchInArea(this.session.id);
        }
    }

    protected featureSearchHeaderActions(): AppSurfaceHeaderAction[] {
        return [
            {
                label: 'Rerun search',
                tooltip: 'Rerun search',
                icon: 'pi pi-refresh',
                disabled: !this.searchQueryForRerun(),
                command: () => this.rerunSearch()
            },
            {
                label: this.isSearchPaused ? 'Resume search' : 'Pause search',
                tooltip: this.isSearchPaused ? 'Resume search' : 'Pause search',
                icon: this.isSearchPaused ? 'pi pi-play-circle' : 'pi pi-pause-circle',
                disabled: !this.canPauseStopSearch,
                command: () => this.toggleSearchPaused()
            },
            {
                label: 'Stop search',
                tooltip: 'Stop search',
                icon: 'pi pi-stop-circle',
                disabled: !this.canPauseStopSearch,
                command: () => this.stopSearch()
            }
        ];
    }

    protected closeSearch() {
        if (this.session) {
            this.searchService.closeSearch(this.session.id);
        }
    }

    /**
     * Terminates active search work as soon as PrimeNG starts closing the dialog.
     */
    onPanelVisibleChange(visible: boolean) {
        this.featureSearchDialogVisible = visible;
        if (!visible) {
            this.closeSearch();
        }
    }

    /**
     * Finalizes the result tabs once the active search group reports completion.
     */
    searchResultReady(firstCompletionForRun = true) {
        const session = this.session;
        if (!session) {
            return;
        }
        const results = session.searchResults;
        const traces = session.traceResults;
        const errors = session.errors;

        this.canPauseStopSearch = false;
        if (firstCompletionForRun && this.resultPanelIndex !== 'style') {
            this.resultPanelIndex = 'results';
        }

        const errorSignature = Array.from(errors).join('\n');
        const errorAlertSignature = `${session.runId}:${errorSignature}`;
        if (errorSignature && this.lastErrorAlertSignature !== errorAlertSignature) {
            this.lastErrorAlertSignature = errorAlertSignature;
            this.infoMessageService.showAlertDialog(
                this.alertContainer,
                'Feature Search Errors',
                errorSignature);

        } else if (firstCompletionForRun && this.resultPanelIndex !== 'style' && results.length == 0) {
            if (this.diagnostics.length > 0)
                this.resultPanelIndex = 'diagnostics';
            else if (traces.length > 0)
                this.resultPanelIndex = 'traces';
        }

        this.traces = traces
        this.results = results;
        this.diagnostics = session.diagnostics;
    }

    /**
     * Highlights the selected result regardless of whether it came from the tree or a simple list event.
     */
    selectResult(event: any) {
        // Support both listbox change and tree node select events
        const selected = event?.value || event?.node?.data || event;
        if (selected && selected.mapId && selected.featureId) {
            this.jumpService.highlightByJumpTargetFilter(selected.mapId, selected.featureId,
                coreLib.HighlightMode.SELECTION_HIGHLIGHT, this.stateService.focusedView).then();
        }
    }

    /**
     * Pauses or resumes server-side search while keeping already collected results visible.
     */
    toggleSearchPaused() {
        const session = this.session;
        if (!this.canPauseStopSearch || !session) {
            return;
        }
        if (this.isSearchPaused) {
            this.searchService.resumeSearch(session.id);
            this.isSearchPaused = false;
        } else {
            this.searchService.pauseSearch(session.id);
            this.results = session.searchResults;
            this.rebuildResultsTreeIncrementally();
            this.isSearchPaused = true;
        }
    }

    /**
     * Stops the active search, freezes the partial result set, and surfaces any accumulated errors.
     */
    stopSearch() {
        const session = this.session;
        if (this.canPauseStopSearch && session) {
            this.searchService.stopSearch(session.id);
            this.canPauseStopSearch = false;
            this.results = session.searchResults;
            this.rebuildResultsTreeIncrementally();

            if (session.errors.size) {
                this.infoMessageService.showAlertDialog(
                    this.alertContainer,
                    'Feature Search Errors',
                    Array.from(session.errors).join('\n'))
            }
        }
    }

    /**
     * Resets dialog-local state after the dialog closes.
     */
    onHide(_: any) {
        const sessionId = this.session?.id;
        if (sessionId) {
            this.searchService.closeSearch(sessionId);
        }
        this.resetLocalState();
        this.featureSearchDialogVisible = false;
    }

    /** Clears local rendering state after the owning session disappears. */
    private resetLocalState(): void {
        this.traces = [];
        this.diagnostics = [];
        this.isSearchPaused = false;
        this.canPauseStopSearch = false;
        this.awaitedTilesToLoad = 0;
        this.results = [];
        this.resultsTree = [];
        this.showFilter = false;
        this.resultsStatus = "Loading...";
        this.featureSearchExpanded = false;
        this.featureSearchQueryExpanded = false;
        this.featureSearchQuery = "";
        this.featureSearchScope = "auto";
        this.completionItems = [];
        this.completion.visible = false;
        this.completion.selectionIndex = 0;
        this.styleRulesStateSignature = "";
        this.nextStyleRuleId = 1;
        this.nextStyleConditionId = 1;
        this.nextStyleColorStopId = 1;
        this.styleRuleDrafts = [];
        this.styleRuleAccordionValue = [];
        this.activeSearchGroupId = "";
        this.completedSearchGroupId = "";
        this.resultTreeInputLength = 0;
        this.resultTreeGroupingSignature = "";
        this.resultTreeRunId = "";
        this.resultTreeGroupNodesByKey.clear();
        this.cancelResultTreeAppend();
        this.lastErrorAlertSignature = "";
        this.surfacedDockedSearchId = "";
    }

    /**
     * Pushes a suggested query fix back into the omnibox workflow.
     */
    onApplyFix(message: DiagnosticsMessage) {
        if (message.fix) {
            this.searchService.fixedDiagnosticsSearchQuery.next(message.fix);
        }
    }

    /** Applies user changes to feature search grouping options. */
    onGroupingOptionsChange(options: FeatureSearchGroupingOption[]) {
        const groupingValues = this.groupingValuesFromOptions(options);
        this.selectedGroupingOptions = this.groupingOptionsFromValues(groupingValues);
        this.stateService.featureSearchGrouping = groupingValues;
        this.rebuildResultsTreeIncrementally();
    }

    /** Converts persisted grouping values into dropdown options. */
    private groupingOptionsFromValues(values: number[]): FeatureSearchGroupingOption[] {
        const selected = new Set(values);
        return this.grouping.filter(option => selected.has(option.value));
    }

    /** Converts dropdown options into persisted grouping values. */
    private groupingValuesFromOptions(options: FeatureSearchGroupingOption[] | null | undefined): number[] {
        const selected = new Set((options ?? []).map(option => option.value));
        return this.grouping.filter(option => selected.has(option.value)).map(option => option.value);
    }

    /** Checks whether two grouping option lists are equivalent. */
    private sameGroupingOptions(lhs: FeatureSearchGroupingOption[], rhs: FeatureSearchGroupingOption[]): boolean {
        return lhs.length === rhs.length && lhs.every((option, index) => option.value === rhs[index]?.value);
    }

    /** Returns the result grouping accessors keyed by persisted grouping option id. */
    private currentResultAccessors(): Record<number, { label: string, get: (r: FeatureSearchResultTreeItem) => string | number }> {
        return {
            1: { label: 'Map', get: (r) => r.mapId },
            2: { label: 'Layer', get: (r) => r.layerId },
            3: { label: 'Features', get: (r) => r.featureType },
            4: { label: 'Tiles', get: (r) => r.tileId }
        };
    }

    /** Normalizes a flat streamed result into the fields used by the result tree. */
    private resultTreeItem(result: FeatureSearchResultEntry): FeatureSearchResultTreeItem {
        const featureIdParts = result.featureId.split('.');
        return {
            label: result.label,
            mapId: result.mapId,
            layerId: result.layerId,
            featureId: result.featureId,
            featureType: featureIdParts[0] ?? "",
            tileId: Number(featureIdParts[1] ?? 0)
        };
    }

    /** Creates one selectable result-tree leaf for a streamed result entry. */
    private resultLeafNode(item: FeatureSearchResultTreeItem, index: number, parentKey: string): TreeNode {
        return {
            key: `${parentKey}/leaf:${index}:${item.featureId}`,
            label: item.label,
            data: {mapId: item.mapId, featureId: item.featureId},
            leaf: true,
            selectable: true
        } as TreeNode;
    }

    /** Reads the cached aggregate count stored on a grouping node. */
    private groupNodeCount(node: TreeNode): number {
        const data = node.data as {count?: number} | undefined;
        return typeof data?.count === "number" ? data.count : 0;
    }

    /** Updates the displayed label and cached count for one grouping node. */
    private setGroupNodeCount(node: TreeNode, label: string, value: string | number, count: number): void {
        node.data = {...(node.data ?? {}), count};
        node.label = `${label}: ${String(value)} (${count})`;
    }

    /** Appends one streamed result into the existing tree without rebuilding prior groups. */
    private appendResultToTree(
        item: FeatureSearchResultTreeItem,
        index: number,
        selectedOrder: number[],
        accessors: Record<number, { label: string, get: (r: FeatureSearchResultTreeItem) => string | number }>
    ): void {
        if (selectedOrder.length === 0) {
            this.resultsTree.push(this.resultLeafNode(item, index, 'root'));
            return;
        }
        this.appendResultToGroup(this.resultsTree, item, index, selectedOrder, accessors, 0, 'root');
    }

    /**
     * Recursively appends one streamed result to the matching grouping branch.
     *
     * Missing groups are created on demand and indexed by full tree key. This keeps
     * streaming updates proportional to grouping depth instead of sibling count.
     */
    private appendResultToGroup(
        nodes: TreeNode[],
        item: FeatureSearchResultTreeItem,
        index: number,
        selectedOrder: number[],
        accessors: Record<number, { label: string, get: (r: FeatureSearchResultTreeItem) => string | number }>,
        depth: number,
        parentKey: string
    ): void {
        const accessor = accessors[selectedOrder[depth]];
        if (!accessor) {
            nodes.push(this.resultLeafNode(item, index, parentKey));
            return;
        }

        const value = accessor.get(item);
        const nodeKey = `${parentKey}/${accessor.label}:${String(value)}`;
        let node = this.resultTreeGroupNodesByKey.get(nodeKey);
        if (!node) {
            node = {
                key: nodeKey,
                selectable: false,
                expanded: true,
                children: [],
                data: {count: 0}
            } as TreeNode;
            this.setGroupNodeCount(node, accessor.label, value, 0);
            nodes.push(node);
            this.resultTreeGroupNodesByKey.set(nodeKey, node);
        }

        const nextCount = this.groupNodeCount(node) + 1;
        this.setGroupNodeCount(node, accessor.label, value, nextCount);
        const children = node.children ?? [];
        node.children = children;
        if (depth + 1 >= selectedOrder.length) {
            children.push(this.resultLeafNode(item, index, nodeKey));
        } else {
            this.appendResultToGroup(children, item, index, selectedOrder, accessors, depth + 1, nodeKey);
        }
    }

    /** Cancels a scheduled streamed result-tree append pass after resets or full rebuilds. */
    private cancelResultTreeAppend(): void {
        if (this.resultTreeAppendRaf === null) {
            return;
        }
        cancelAnimationFrame(this.resultTreeAppendRaf);
        this.resultTreeAppendRaf = null;
    }

    /** Clears tree state so the next append pass can rebuild from the current session in chunks. */
    private resetStreamingResultTree(runId: string, groupingSignature: string): void {
        this.cancelResultTreeAppend();
        this.resultsTree = [];
        this.resultTreeGroupNodesByKey.clear();
        this.resultTreeInputLength = 0;
        this.resultTreeRunId = runId;
        this.resultTreeGroupingSignature = groupingSignature;
        this.showFilter = false;
        this.resultsStatus = "Loading...";
    }

    /** Rebuilds the result tree from scratch through the frame-budgeted streaming path. */
    private rebuildResultsTreeIncrementally(): void {
        const session = this.session;
        if (!session) {
            this.recalculateResultsByGroups();
            return;
        }
        this.results = session.searchResults;
        this.traces = session.traceResults;
        const groupingSignature = this.groupingValuesFromOptions(this.selectedGroupingOptions).join(',');
        this.resetStreamingResultTree(session.runId, groupingSignature);
        this.appendStreamingResultsChunk();
    }

    /** Schedules another frame-budgeted streamed result-tree append pass. */
    private scheduleResultTreeAppend(): void {
        if (this.resultTreeAppendRaf !== null) {
            return;
        }
        this.resultTreeAppendRaf = requestAnimationFrame(() => {
            this.resultTreeAppendRaf = null;
            this.appendStreamingResultsChunk();
        });
    }

    /** Updates the empty-message and filter state after streamed result-tree changes. */
    private updateResultTreeStatus(searchComplete: boolean): void {
        if (this.resultsTree.length) {
            this.showFilter = true;
            this.resultsStatus = "No entries found.";
        } else if (searchComplete) {
            this.showFilter = false;
            this.resultsStatus = "No matches found.";
        }
    }

    /** Appends pending streamed results for a bounded amount of work to keep the UI responsive. */
    private appendStreamingResultsChunk(): void {
        const session = this.session;
        if (!session) {
            return;
        }
        const results = session.searchResults;
        if (results.length <= this.resultTreeInputLength) {
            this.updateResultTreeStatus(session.complete);
            return;
        }

        const selectedOrder = this.groupingValuesFromOptions(this.selectedGroupingOptions);
        const accessors = this.currentResultAccessors();
        const startedAt = performance.now();
        let appended = 0;
        while (this.resultTreeInputLength < results.length) {
            const index = this.resultTreeInputLength;
            this.appendResultToTree(this.resultTreeItem(results[index]), index, selectedOrder, accessors);
            this.resultTreeInputLength = index + 1;
            appended += 1;
            if (appended >= this.resultTreeAppendBatchSize
                || performance.now() - startedAt >= this.resultTreeAppendFrameBudgetMs) {
                break;
            }
        }

        if (appended > 0) {
            this.resultsTree = [...this.resultsTree];
        }
        if (this.resultTreeInputLength < results.length) {
            this.scheduleResultTreeAppend();
        }
        this.updateResultTreeStatus(session.complete);
    }

    /**
     * Synchronizes streamed result entries into the tree incrementally.
     *
     * Run, grouping, and eviction changes reset the destination tree, but the
     * expensive node creation still happens through frame-budgeted append chunks.
     */
    private syncStreamingResults(session: FeatureSearchSession): void {
        this.traces = session.traceResults;
        const results = session.searchResults;
        const groupingSignature = this.groupingValuesFromOptions(this.selectedGroupingOptions).join(',');
        const needsFullRebuild = this.resultTreeRunId !== session.runId
            || this.resultTreeGroupingSignature !== groupingSignature
            || results.length < this.resultTreeInputLength;

        this.results = results;
        if (needsFullRebuild) {
            this.resetStreamingResultTree(session.runId, groupingSignature);
            this.appendStreamingResultsChunk();
            return;
        }

        if (results.length > this.resultTreeInputLength && this.resultTreeAppendRaf === null) {
            this.appendStreamingResultsChunk();
        }
        this.updateResultTreeStatus(session.complete);
    }

    /**
     * Rebuilds the PrimeNG tree according to the currently selected grouping dimensions.
     */
    recalculateResultsByGroups() {
        this.cancelResultTreeAppend();
        // Convert results into PrimeNG TreeNodes based on selected grouping
        const results = this.results.map(result => this.resultTreeItem(result));

        // Selected grouping values as ordered list following the grouping options
        const selectedOrder = this.groupingValuesFromOptions(this.selectedGroupingOptions);
        const accessors = this.currentResultAccessors();
        this.resultTreeGroupNodesByKey.clear();

        /** Builds the feature search result tree with aggregate counts. */
        const buildTreeWithCounts = (items: FeatureSearchResultTreeItem[], depth: number, parentKey: string): [TreeNode[], number] => {
            if (depth >= selectedOrder.length || selectedOrder.length === 0) {
                const leaves = items.map((it, idx) => this.resultLeafNode(it, idx, parentKey));
                return [leaves, items.length];
            }

            const key = selectedOrder[depth];
            const acc = accessors[key];
            if (!acc) {
                const leaves = items.map((it, idx) => ({
                    key: `${parentKey}/leaf:${idx}:${it.featureId}`,
                    label: it.label,
                    data: { mapId: it.mapId, featureId: it.featureId },
                    leaf: true,
                    selectable: true
                } as TreeNode));
                return [leaves, items.length];
            }

            // Partition items by current accessor
            const partitions = new Map<string | number, FeatureSearchResultTreeItem[]>();
            for (const it of items) {
                const k = acc.get(it);
                const arr = partitions.get(k) || [];
                arr.push(it);
                partitions.set(k, arr);
            }

            const nodes: TreeNode[] = [];
            let total = 0;
            for (const [value, groupItems] of partitions) {
                const nodeKey = `${parentKey}/${acc.label}:${String(value)}`;
                const [children, childCount] = buildTreeWithCounts(groupItems, depth + 1, nodeKey);
                total += childCount;
                const node = {
                    key: nodeKey,
                    label: `${acc.label}: ${String(value)} (${childCount})`,
                    selectable: false,
                    expanded: true,
                    data: {count: childCount},
                    children
                } as TreeNode;
                nodes.push(node);
                this.resultTreeGroupNodesByKey.set(nodeKey, node);
            }
            return [nodes, total];
        };

        const [tree] = buildTreeWithCounts(results, 0, 'root');
        this.resultsTree = tree;
        if (this.resultsTree.length) {
            this.showFilter = true;
            this.resultsStatus = "No entries found.";
        } else {
            this.showFilter = false;
            this.resultsStatus = "No matches found.";
        }
        this.resultTreeInputLength = this.results.length;
        this.resultTreeGroupingSignature = selectedOrder.join(',');
    }

    /**
     * Derives the tree scroller height from the dialog size so virtual scrolling stays usable while resizing.
     */
    syncTreeScrollHeight(event?: MouseEvent) {
        const target = event?.target as HTMLElement | null;
        const wrapper = target?.closest('.feature-search-dialog') as HTMLElement | null;
        const dialog = this.featureSearchDialog?.container()
            ?? (wrapper?.querySelector('.p-dialog') as HTMLElement | null);
        const panel = this.featureSearchPanel?.container();
        const container = dialog ?? wrapper ?? panel;
        if (!container || !container.offsetHeight || !this.stateService.baseFontSize) {
            return;
        }

        // Compute scrollable height in em units to respect base font size
        const currentEmHeight = container.offsetHeight / this.stateService.baseFontSize;
        // Linear equation to compensate for the slight difference in the content height
        // when the values are smaller or larger
        this.scrollHeight = `${currentEmHeight + 0.0887574 * currentEmHeight - 14.9763}em`;

        // Nudge the internal scroller to recalculate
        setTimeout(() => {
            const scroller = (this.tree as any)?.scroller as Scroller | undefined;
            if (scroller) {
                scroller.scrollHeight = this.scrollHeight;
                scroller.calculateAutoSize();
            }
        }, 1);
    }
}
