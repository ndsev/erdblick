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
import {CompletionCandidate, DiagnosticsMessage, TraceResult} from "./search.worker";
import {coreLib} from "../integrations/wasm";
import {AppStateService, SEARCH_DOCK_TAB_ID} from "../shared/appstate.service";
import {Tree} from "primeng/tree";
import {Scroller} from "primeng/scroller";
import {DialogStackService} from "../shared/dialog-stack.service";
import {AppDialogComponent} from "../shared/app-dialog.component";
import {debounceTime, distinctUntilChanged, map, of, startWith, Subject, Subscription, switchMap, timer} from "rxjs";
import {AppPanelComponent} from "../shared/app-panel.component";
import getCaretCoordinates from "../shared/caret.util";
import type {AppSurfaceHeaderAction} from "../shared/app-surface-header.component";
import type {FeatureSearchScope} from "../shared/feature-search-state";

interface FeatureSearchGroupingOption {
    name: string;
    value: number;
}

interface FeatureSearchStyleOption {
    label: string;
    value: string;
}

interface FeatureSearchScopeOption {
    label: string;
    value: FeatureSearchScope;
}

interface FeatureSearchStyleColorStop {
    id: number;
    label: string;
    value: number;
    color: string;
}

interface FeatureSearchStyleFilterMockState {
    id: number;
    attributeField: string;
    operator: string;
    filterValue: number;
    manualConditionEnabled: boolean;
    manualCondition: string;
}

interface FeatureSearchStyleMockState {
    id: number;
    filters: FeatureSearchStyleFilterMockState[];
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
                    [pending]="completion.pending"
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
            <p-tabs [(value)]="resultPanelIndex" class="feature-search-tabs" data-testid="feature-search-panel" scrollable>
                <p-tablist>
                    <p-tab value="results">
                        <span>Results </span>
                        <p-badge [value]="results.length"/>
                    </p-tab>
                    <p-tab value="style">
                        <span>Styles </span>
                        <p-badge [value]="styleRulesMock.length"/>
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
                                @for (rule of styleRulesMock; track rule.id; let ruleIndex = $index) {
                                    <p-accordion-panel class="feature-search-style-panel"
                                                       [value]="styleRulePanelValue(rule)"
                                                       [attr.data-testid]="'feature-search-style-panel-' + rule.id">
                                        <p-accordion-header>
                                            <div class="feature-search-style-rule-header">
                                                <span>Rule {{ styleRulesMock.length - ruleIndex }}</span>
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
                                                            @if (filter.manualConditionEnabled) {
                                                                <p-button class="feature-search-style-condition-mode"
                                                                          label=""
                                                                          severity="success"
                                                                          pTooltip="Use structured condition"
                                                                          tooltipPosition="bottom"
                                                                          [style]="{'width': '2em', 'height': '2em'}"
                                                                          (click)="toggleStyleConditionMode(filter)">
                                                                    <span class="material-symbols-outlined" style="font-size: 1em; margin: 0 auto;">
                                                                        asterisk
                                                                    </span>
                                                                </p-button>
                                                            } @else {
                                                                <p-button class="feature-search-style-condition-mode"
                                                                          label=""
                                                                          pTooltip="Use rich simfil condition"
                                                                          tooltipPosition="bottom"
                                                                          [style]="{'width': '2em', 'height': '2em'}"
                                                                          (click)="toggleStyleConditionMode(filter)">
                                                                    <span class="material-symbols-outlined" style="font-size: 1em; margin: 0 auto;">
                                                                        asterisk
                                                                    </span>
                                                                </p-button>
                                                            }
                                                            @if (filter.manualConditionEnabled) {
                                                                <input class="feature-search-style-manual-condition"
                                                                       type="text"
                                                                       pInputText
                                                                       [(ngModel)]="filter.manualCondition"
                                                                       placeholder="Simfil condition"/>
                                                            } @else {
                                                                <p-select class="feature-search-style-attribute"
                                                                          [options]="styleAttributeOptions"
                                                                          [(ngModel)]="filter.attributeField"
                                                                          optionLabel="label"
                                                                          optionValue="value"
                                                                          appendTo="body">
                                                                </p-select>
                                                                <p-select class="feature-search-style-operator"
                                                                          [options]="styleOperatorOptions"
                                                                          [(ngModel)]="filter.operator"
                                                                          optionLabel="label"
                                                                          optionValue="value"
                                                                          appendTo="body">
                                                                </p-select>
                                                                <p-inputNumber class="feature-search-style-number"
                                                                               [(ngModel)]="filter.filterValue"
                                                                               [min]="0"
                                                                               [max]="300">
                                                                </p-inputNumber>
                                                            }
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
                                                              optionLabel="label"
                                                              optionValue="value"
                                                              appendTo="body">
                                                    </p-select>
                                                    <label [for]="'feature-search-style-width-' + rule.id">Width</label>
                                                    <p-inputNumber [inputId]="'feature-search-style-width-' + rule.id"
                                                                   class="feature-search-style-number"
                                                                   [(ngModel)]="rule.lineWidth"
                                                                   [min]="1"
                                                                   [max]="32">
                                                    </p-inputNumber>
                                                    <label [for]="'feature-search-style-opacity-' + rule.id">Opacity</label>
                                                    <div class="feature-search-style-opacity">
                                                        <p-inputNumber [inputId]="'feature-search-style-opacity-' + rule.id"
                                                                       class="feature-search-style-number"
                                                                       [(ngModel)]="rule.opacity"
                                                                       [min]="0"
                                                                       [max]="100"
                                                                       suffix=" %">
                                                        </p-inputNumber>
                                                        <p-slider [(ngModel)]="rule.opacity"
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
                                                              optionLabel="label"
                                                              optionValue="value"
                                                              appendTo="body">
                                                    </p-select>
                                                    <label [for]="'feature-search-style-color-field-' + rule.id">Field</label>
                                                    <p-select [inputId]="'feature-search-style-color-field-' + rule.id"
                                                              class="feature-search-style-color-field"
                                                              [options]="styleAttributeOptions"
                                                              [(ngModel)]="rule.colorField"
                                                              optionLabel="label"
                                                              optionValue="value"
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
                                                                                   [min]="0"
                                                                                   [max]="300">
                                                                    </p-inputNumber>
                                                                    <p-colorpicker [(ngModel)]="stop.color" appendTo="body"></p-colorpicker>
                                                                </div>
                                                            </div>
                                                        }
                                                    </div>
                                                } @else if (rule.colorMode === 'solid') {
                                                    <div class="feature-search-style-solid-color-row">
                                                        <span>Color</span>
                                                        <p-colorpicker [(ngModel)]="rule.solidColor" appendTo="body"></p-colorpicker>
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
                                                                <p-colorpicker [(ngModel)]="category.color" appendTo="body"></p-colorpicker>
                                                                <p-inputNumber class="feature-search-style-category-value"
                                                                               [(ngModel)]="category.value"
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
    styleAttributeOptions: FeatureSearchStyleOption[] = [
        {label: 'speedLimit', value: 'speedLimit'},
        {label: 'functionalRoadClass', value: 'functionalRoadClass'},
        {label: 'laneCount', value: 'laneCount'},
        {label: 'elevation', value: 'elevation'}
    ];
    styleOperatorOptions: FeatureSearchStyleOption[] = [
        {label: '>', value: '>'},
        {label: '>=', value: '>='},
        {label: '=', value: '='},
        {label: '<=', value: '<='},
        {label: '<', value: '<'}
    ];
    styleVisualizationOptions: FeatureSearchStyleOption[] = [
        {label: 'Line', value: 'line'},
        {label: 'Mesh', value: 'mesh'},
        {label: 'Point', value: 'point'},
        {label: 'Text', value: 'text'}
    ];
    styleColorModeOptions: FeatureSearchStyleOption[] = [
        {label: 'Gradient', value: 'gradient'},
        {label: 'Solid', value: 'solid'},
        {label: 'Categories', value: 'categories'}
    ];
    private nextStyleRuleId = 1;
    private nextStyleConditionId = 1;
    private nextStyleColorStopId = 1;
    styleRulesMock: FeatureSearchStyleMockState[] = [this.createDefaultStyleRule()];
    styleRuleAccordionValue: string[] = ['1'];

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
        pending: false,
        pendingDelay: 600,
        completionDelay: 150,
        zIndex: 30050,
    };
    private lastSearchQuery = "";
    private activeSearchGroupId = "";
    private completedSearchGroupId = "";
    private lastErrorAlertSignature = "";
    private surfacedDockedSearchId = "";
    private completionOwnerId = "";

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
            this.recalculateResultsByGroups();
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
        this.subscriptions.add(this.featureSearchQueryChanged
            .pipe(debounceTime(this.completion.completionDelay))
            .subscribe(() => this.completeFeatureSearchQuery()));
    }

    private createDefaultStyleFilter(): FeatureSearchStyleFilterMockState {
        return {
            id: this.nextStyleConditionId++,
            attributeField: 'speedLimit',
            operator: '>',
            filterValue: 80,
            manualConditionEnabled: false,
            manualCondition: ''
        };
    }

    private createStyleColorStop(label: string, value: number, color: string): FeatureSearchStyleColorStop {
        return {
            id: this.nextStyleColorStopId++,
            label,
            value,
            color
        };
    }

    private createStyleRule(id: number): FeatureSearchStyleMockState {
        return {
            id,
            filters: [this.createDefaultStyleFilter()],
            visualization: 'line',
            lineWidth: 10,
            opacity: 40,
            colorMode: 'gradient',
            colorField: 'speedLimit',
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

    private createDefaultStyleRule(): FeatureSearchStyleMockState {
        return this.createStyleRule(this.nextStyleRuleId++);
    }

    protected addStyleRule(): void {
        const rule = this.createDefaultStyleRule();
        const panelValue = this.styleRulePanelValue(rule);
        this.styleRulesMock = [rule, ...this.styleRulesMock];
        this.styleRuleAccordionValue = [
            panelValue,
            ...this.styleRuleAccordionValue.filter(value => value !== panelValue)
        ];
    }

    protected deleteStyleRule(rule: FeatureSearchStyleMockState): void {
        const panelValue = this.styleRulePanelValue(rule);
        this.styleRulesMock = this.styleRulesMock.filter(candidate => candidate.id !== rule.id);
        this.styleRuleAccordionValue = this.styleRuleAccordionValue.filter(value => value !== panelValue);
    }

    protected styleRulePanelValue(rule: FeatureSearchStyleMockState): string {
        return `${rule.id}`;
    }

    protected addStyleCondition(rule: FeatureSearchStyleMockState): void {
        rule.filters = [...rule.filters, this.createDefaultStyleFilter()];
    }

    protected deleteStyleCondition(rule: FeatureSearchStyleMockState, filter: FeatureSearchStyleFilterMockState): void {
        rule.filters = rule.filters.filter(candidate => candidate.id !== filter.id);
    }

    protected addStyleCategory(rule: FeatureSearchStyleMockState): void {
        const nextIndex = rule.categoryStops.length + 1;
        rule.categoryStops = [
            ...rule.categoryStops,
            this.createStyleColorStop(`category ${nextIndex}`, nextIndex * 10, '#2f73ff')
        ];
    }

    protected deleteStyleCategory(rule: FeatureSearchStyleMockState, category: FeatureSearchStyleColorStop): void {
        rule.categoryStops = rule.categoryStops.filter(candidate => candidate.id !== category.id);
    }

    protected styleGradientPreview(rule: FeatureSearchStyleMockState): string {
        if (!rule.colorStops.length) {
            return rule.solidColor;
        }
        const denominator = Math.max(rule.colorStops.length - 1, 1);
        const stops = rule.colorStops
            .map((stop, index) => `${stop.color} ${Math.round((index / denominator) * 100)}%`)
            .join(', ');
        return `linear-gradient(90deg, ${stops})`;
    }

    protected toggleStyleConditionMode(filter: FeatureSearchStyleFilterMockState): void {
        filter.manualConditionEnabled = !filter.manualConditionEnabled;
        if (filter.manualConditionEnabled && !filter.manualCondition.trim()) {
            filter.manualCondition = `${filter.attributeField} ${filter.operator} ${filter.filterValue}`;
        }
    }

    protected resetStyleRule(rule: FeatureSearchStyleMockState): void {
        const resetRule = this.createStyleRule(rule.id);
        this.styleRulesMock = this.styleRulesMock.map(candidate =>
            candidate.id === rule.id ? resetRule : candidate
        );
    }

    protected resetStyleRules(): void {
        this.nextStyleRuleId = 1;
        this.nextStyleConditionId = 1;
        this.nextStyleColorStopId = 1;
        const rule = this.createDefaultStyleRule();
        this.styleRulesMock = [rule];
        this.styleRuleAccordionValue = [this.styleRulePanelValue(rule)];
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
        this.completionSubscriptions.add(completionState.pending.pipe(
            switchMap(pending => pending ? timer(this.completion.pendingDelay).pipe(map(() => true)) : of(false)),
            startWith(false),
            distinctUntilChanged()
        ).subscribe((pending: boolean) => {
            this.completion.pending = pending;
        }));
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
        this.lastSearchQuery = session.query;
        this.featureSearchScope = session.definition.scope;
        if (this.activeSearchGroupId !== session.search.id) {
            this.activeSearchGroupId = session.search.id;
            this.completedSearchGroupId = "";
            this.lastErrorAlertSignature = "";
            this.featureSearchQuery = session.query;
            this.results = [];
            this.resultsTree = [];
            this.resultPanelIndex = 'results';
        }
        this.percentDone = session.search.percentDone();
        this.totalTiles = session.search.getTaskCount();
        this.doneTiles = session.search.getCompletedCount();
        this.awaitedTilesToLoad = session.search.getPendingTileCount();
        this.isSearchPaused = session.search.paused;
        this.diagnostics = session.diagnostics;
        if (this.isDocked()) {
            this.stateService.isDockOpen = true;
            if (this.surfacedDockedSearchId !== session.id) {
                this.stateService.dockActiveTab = SEARCH_DOCK_TAB_ID;
                this.surfacedDockedSearchId = session.id;
            }
        }
        if (session.search.isComplete()) {
            this.searchResultReady();
            this.canPauseStopSearch = false;
        } else {
            this.resultsStatus = "Loading...";
            this.canPauseStopSearch = true;
            if (session.search.paused) {
                this.traces = session.traceResults;
                this.results = session.searchResults;
                this.recalculateResultsByGroups();
            }
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
        } else if (event.key === 'Escape' && (this.completion.visible || this.completion.pending)) {
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
        this.completion.pending = false;
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
        return this.featureSearchQuery.trim() || this.session?.query || this.lastSearchQuery;
    }

    protected onFeatureSearchScopeChange(scope: FeatureSearchScope): void {
        this.featureSearchScope = scope;
        if (this.session && this.session.definition.scope !== scope) {
            this.stateService.patchFeatureSearch(this.session.id, {scope});
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
    searchResultReady() {
        const session = this.session;
        if (!session) {
            return;
        }
        this.completedSearchGroupId = session.search.id;
        const results = session.searchResults;
        const traces = session.traceResults;
        const errors = session.errors;

        this.canPauseStopSearch = false;
        this.resultPanelIndex = 'results';

        const errorSignature = Array.from(errors).join('\n');
        const errorAlertSignature = `${session.search.id}:${errorSignature}`;
        if (errorSignature && this.lastErrorAlertSignature !== errorAlertSignature) {
            this.lastErrorAlertSignature = errorAlertSignature;
            this.infoMessageService.showAlertDialog(
                this.alertContainer,
                'Feature Search Errors',
                errorSignature);

        } else if (results.length == 0) {
            if (this.diagnostics.length > 0)
                this.resultPanelIndex = 'diagnostics';
            else if (traces.length > 0)
                this.resultPanelIndex = 'traces';
        }

        this.traces = traces
        this.results = results;
        this.diagnostics = session.diagnostics;
        this.recalculateResultsByGroups();
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
     * Pauses or resumes worker dispatch while keeping already collected results visible.
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
            this.recalculateResultsByGroups();
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
            this.recalculateResultsByGroups();

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
        this.completion.pending = false;
        this.completion.selectionIndex = 0;
        this.activeSearchGroupId = "";
        this.completedSearchGroupId = "";
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
        this.recalculateResultsByGroups();
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

    /**
     * Rebuilds the PrimeNG tree according to the currently selected grouping dimensions.
     */
    recalculateResultsByGroups() {
        // Convert results into PrimeNG TreeNodes based on selected grouping
        const results = this.results.map(result => {
            const featureIdParts = result.featureId.split('.')
            return {
                label: result.label,
                mapId: result.mapId,
                layerId: result.layerId,
                featureId: result.featureId,
                featureType: featureIdParts[0] ?? "",
                tileId: Number(featureIdParts[1] ?? 0)
            };
        });

        // Selected grouping values as ordered list following the grouping options
        const selected = new Set(this.selectedGroupingOptions.map(o => o.value));
        const selectedOrder: number[] = this.grouping.filter(o => selected.has(o.value)).map(o => o.value);

        type ResultItem = typeof results[number];

        const accessors: Record<number, { label: string, get: (r: ResultItem) => string | number }> = {
            1: { label: 'Map',     get: (r) => r.mapId },
            2: { label: 'Layer',   get: (r) => r.layerId },
            3: { label: 'Features', get: (r) => r.featureType },
            4: { label: 'Tiles',    get: (r) => r.tileId }
        };

        /** Builds the feature search result tree with aggregate counts. */
        const buildTreeWithCounts = (items: ResultItem[], depth: number, parentKey: string): [TreeNode[], number] => {
            if (depth >= selectedOrder.length || selectedOrder.length === 0) {
                const leaves = items.map((it, idx) => ({
                    key: `${parentKey}/leaf:${idx}:${it.featureId}`,
                    label: it.label,
                    data: { mapId: it.mapId, featureId: it.featureId },
                    leaf: true,
                    selectable: true
                } as TreeNode));
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
            const partitions = new Map<string | number, ResultItem[]>();
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
                nodes.push({
                    key: nodeKey,
                    label: `${acc.label}: ${String(value)} (${childCount})`,
                    selectable: false,
                    expanded: true,
                    children
                } as TreeNode);
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
