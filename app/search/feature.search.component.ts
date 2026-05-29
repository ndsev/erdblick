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
import {MapInfoService} from "../mapdata/map-info.service";
import {FeatureSearchSchemaService} from "../mapdata/feature-search-schema.service";
import {InspectionSelectionService} from "../inspection/inspection-selection.service";
import type {
    FeatureSearchAttributeScopeCandidate,
    FeatureSearchStyleFieldCandidate
} from "../mapdata/map-runtime.model";
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
import {DEFAULT_FEATURE_SEARCH_RENDER_STRATEGY} from "../shared/feature-search-state";
import type {
    FeatureSearchColorMode,
    FeatureSearchGeometryKind,
    FeatureSearchMapLayerRef,
    FeatureSearchRenderStrategy,
    FeatureSearchRuleFilter,
    FeatureSearchScope,
    FeatureSearchStyleRule
} from "../shared/feature-search-state";
import {
    defaultSearchStyleColorDraft,
    DEFAULT_SEARCH_STYLE_SOLID_COLOR,
    gradientStopsToDraft,
    isNumericStyleValueKind,
    normalizeHexColor,
    SearchStyleCategoryStopDraft,
    SearchStyleColorDraft,
    SearchStyleFieldValueKind,
    serializableCategoryStops,
    serializableGradientStops
} from "./search-style-color.util";
import {
    featureSearchDefinitionExport,
    featureSearchJsonReplacer,
    featureSearchResultsExport,
    safeFeatureSearchExportId,
    type FeatureSearchGroupingExportOption
} from "./feature-search-export.util";

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
    valueKind?: SearchStyleFieldValueKind;
    enumValues?: string[];
}

interface FeatureSearchLayerOption extends FeatureSearchMapLayerRef {
    key: string;
    label: string;
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
    tileId: string;
    resultKey: string;
    mapTileKey: string;
    hoverFeatureId: string;
}

interface FeatureSearchStyleFilterDraft {
    id: number;
    attributeField: string;
    operator: string;
    filterValue: unknown;
}

interface FeatureSearchStyleRuleDraft {
    id: number;
    name: string;
    filters: FeatureSearchStyleFilterDraft[];
    visualization: string;
    lineWidth: number;
    opacity: number;
    color: SearchStyleColorDraft;
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
                                [hasColorPicker]="false"
                                [dockMode]="isDocked() ? 'undock' : 'dock'"
                                [sizeToggleVisible]="isDocked()"
                                [sizeToggleDisabled]="dockedPanelCount <= 1"
                                [expanded]="featureSearchExpanded"
                                [dragEnabled]="isDocked()"
                                [extraActions]="featureSearchHeaderActions()"
                                (focusRequest)="bringSurfaceToFront()"
                                (dockRequest)="toggleDocked()"
                                (sizeToggleRequest)="toggleExpanded()"
                                (closeRequest)="closeSearch()"
                                (dragPointerDown)="onHeaderPointerDown($event)">
            </app-surface-header>
        </ng-template>

        <ng-template #searchContent>
            <div class="feature-search-content" [class.feature-search-content-disabled]="!searchEnabled()">
            <div class="feature-search-query search-input">
                <textarea #featureSearchQueryTextarea
                          class="feature-search-query-input"
                          [class.single-line]="!featureSearchQueryExpanded"
                          pTextarea
                          [disabled]="!searchEnabled()"
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
                                [disabled]="!searchEnabled()"
                                (ngModelChange)="onFeatureSearchScopeChange($event)">
                </p-selectbutton>
                @if (featureSearchScopeSummary) {
                    <span class="feature-search-scope-summary"
                          [title]="featureSearchScopeSummaryTitle">
                        {{ featureSearchScopeSummary }}
                    </span>
                }
            </div>
            <div class="feature-search-layer-control">
                <span>Map layers</span>
                <p-multiSelect [options]="mapLayerOptions"
                               [(ngModel)]="selectedMapLayerOptions"
                               (ngModelChange)="onSearchMapLayersChange($event)"
                               optionLabel="label"
                               placeholder="Select Map Layers"
                               [filter]="true"
                               [showToggleAll]="true"
                               [maxSelectedLabels]="3"
                               [disabled]="!searchEnabled()"
                               display="chip"
                               appendTo="body">
                </p-multiSelect>
            </div>
            <div class="feature-search-area-control">
                <label for="feature-search-auto-update-toggle">Auto-update area</label>
                <p-toggleswitch [ngModel]="session?.definition?.autoUpdate"
                                [disabled]="!searchEnabled()"
                                (ngModelChange)="onFeatureSearchAutoUpdateChange($event)"
                                inputId="feature-search-auto-update-toggle"
                                data-testid="feature-search-auto-update-toggle">
                </p-toggleswitch>
                @if (!session?.definition?.autoUpdate) {
                    <p-button icon="pi pi-refresh"
                              label="Update Area"
                              severity="secondary"
                              [outlined]="true"
                              [disabled]="!searchEnabled()"
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
                                        (onFilter)="onResultTreeFilter($event)"
                                        (onNodeSelect)="selectResult($event)"
                                        [emptyMessage]="resultsStatus">
                                    <ng-template let-node pTemplate="default">
                                        <span class="feature-search-tree-node-label"
                                              [title]="node.label"
                                              (mouseenter)="hoverResultNode(node)"
                                              (mouseleave)="clearHoveredResultNode()">
                                            {{ node.label }}
                                        </span>
                                    </ng-template>
                                </p-tree>
                            </div>
                        </div>
                    </p-tabpanel>

                    <!-- Style -->
                    <p-tabpanel value="style">
                        <div class="feature-search-style-rules" data-testid="feature-search-style-rules">
                            <section class="feature-search-render-strategy">
                                <h3>Render Strategy</h3>
                                <div class="feature-search-render-strategy-grid">
                                    <label for="feature-search-show-lowfi-dots">Low-fi dots</label>
                                    <div class="feature-search-lowfi-controls">
                                        <p-toggleswitch [ngModel]="searchRenderStrategy().showLowFiDots"
                                                        inputId="feature-search-show-lowfi-dots"
                                                        (ngModelChange)="patchRenderStrategy('showLowFiDots', $event)">
                                        </p-toggleswitch>
                                        @if (searchRenderStrategy().showLowFiDots) {
                                            <p-colorpicker inputId="feature-search-pin-color"
                                                           [ngModel]="session?.pointColor ?? '#ea4336'"
                                                           appendTo="body"
                                                           pTooltip="Pin color"
                                                           tooltipPosition="bottom"
                                                           (ngModelChange)="onSearchColorChange($event)">
                                            </p-colorpicker>
                                        }
                                    </div>

                                    <label for="feature-search-show-bucket-labels">Bucket labels</label>
                                    <p-toggleswitch [ngModel]="searchRenderStrategy().showBucketLabels"
                                                    inputId="feature-search-show-bucket-labels"
                                                    (ngModelChange)="patchRenderStrategy('showBucketLabels', $event)">
                                    </p-toggleswitch>

                                    <label for="feature-search-show-highfi-geometry">High-fi geometry</label>
                                    <p-toggleswitch [ngModel]="searchRenderStrategy().showHighFiGeometry"
                                                    inputId="feature-search-show-highfi-geometry"
                                                    (ngModelChange)="patchRenderStrategy('showHighFiGeometry', $event)">
                                    </p-toggleswitch>

                                    <label for="feature-search-show-highfi-dots">Dots during high-fi</label>
                                    <p-toggleswitch [ngModel]="searchRenderStrategy().showHighFiResultDots"
                                                    inputId="feature-search-show-highfi-dots"
                                                    (ngModelChange)="patchRenderStrategy('showHighFiResultDots', $event)">
                                    </p-toggleswitch>

                                    <label for="feature-search-highfi-threshold">High-fi tile limit</label>
                                    <p-inputNumber class="feature-search-style-number"
                                                   inputId="feature-search-highfi-threshold"
                                                   [ngModel]="searchRenderStrategy().highFidelityMaxVisibleTiles"
                                                   (ngModelChange)="patchRenderStrategy('highFidelityMaxVisibleTiles', $event)"
                                                   [min]="1"
                                                   [max]="65536"
                                                   [showButtons]="true">
                                    </p-inputNumber>
                                </div>
                            </section>
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
                                                <input class="feature-search-style-rule-name"
                                                       type="text"
                                                       [ngModel]="rule.name"
                                                       [placeholder]="'Rule ' + (styleRuleDrafts.length - ruleIndex)"
                                                       [attr.aria-label]="'Rule name ' + (styleRuleDrafts.length - ruleIndex)"
                                                       (ngModelChange)="setStyleRuleName(rule, $event)"
                                                       (click)="$event.stopPropagation()"
                                                       (mousedown)="$event.stopPropagation()">
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
                                                                      [options]="styleOperatorOptionsForFilter(filter)"
                                                                      [(ngModel)]="filter.operator"
                                                                      (ngModelChange)="onStyleRulesChanged()"
                                                                      optionLabel="label"
                                                                      optionValue="value"
                                                                      appendTo="body">
                                                            </p-select>
                                                            @if (filterFieldIsNumeric(filter)) {
                                                                <p-inputNumber class="feature-search-style-number"
                                                                               [(ngModel)]="filter.filterValue"
                                                                               (ngModelChange)="onStyleRulesChanged()">
                                                                </p-inputNumber>
                                                            } @else if (filterFieldEnumOptions(filter).length > 0) {
                                                                <p-select class="feature-search-style-value-select"
                                                                          [options]="filterFieldEnumOptions(filter)"
                                                                          [editable]="true"
                                                                          [(ngModel)]="filter.filterValue"
                                                                          (ngModelChange)="onStyleRulesChanged()"
                                                                          optionLabel="label"
                                                                          optionValue="value"
                                                                          appendTo="body">
                                                                </p-select>
                                                            } @else {
                                                                <input class="feature-search-style-value-input"
                                                                       type="text"
                                                                       [(ngModel)]="filter.filterValue"
                                                                       (ngModelChange)="onStyleRulesChanged()">
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
                                                <search-style-color
                                                    [draft]="rule.color"
                                                    [fieldOptions]="styleAttributeOptions"
                                                    (draftChange)="onRuleColorDraftChange(rule, $event)">
                                                </search-style-color>
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
            </div>
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
    mapLayerOptions: FeatureSearchLayerOption[] = [];
    selectedMapLayerOptions: FeatureSearchLayerOption[] = [];
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
    featureSearchScopeSummary = "";
    featureSearchScopeSummaryTitle = "";
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
    private resultTreeFilterValue = "";
    private resultTreeGroupNodesByKey = new Map<string, TreeNode>();
    private resultTreeAppendRaf: number | null = null;
    private readonly resultTreeAppendBatchSize = 1000;
    private readonly resultTreeAppendFrameBudgetMs = 8;
    private styleAttributeOptionsSessionSignature = "";
    private mapLayerOptionsSignature = "";
    private selectedMapLayersSignature = "";
    private confirmingClose = false;
    private confirmedCloseSessionIds = new Set<string>();

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
                public mapService: MapInfoService,
                private readonly searchSchema: FeatureSearchSchemaService,
                private readonly inspectionSelection: InspectionSelectionService,
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
            this.refreshMapLayerOptions();
            if (this.session) {
                this.refreshFeatureSearchScopeSummary(this.session);
                this.refreshStyleAttributeOptionsIfNeeded(this.session);
                this.syncSelectedMapLayersFromSession(this.session);
            }
        }));
        this.subscriptions.add(this.featureSearchQueryChanged
            .pipe(debounceTime(this.completion.completionDelay))
            .subscribe(() => this.completeFeatureSearchQuery()));
    }

    /** Creates one empty rule condition using the current schema-backed default field when available. */
    private createDefaultStyleFilter(): FeatureSearchStyleFilterDraft {
        const field = this.defaultStyleField();
        return {
            id: this.nextStyleConditionId++,
            attributeField: field,
            operator: '>',
            filterValue: this.defaultFilterValue(field)
        };
    }

    /** Creates the editor draft for a new search-result style rule. */
    private createStyleRule(id: number): FeatureSearchStyleRuleDraft {
        return {
            id,
            name: "",
            filters: [],
            visualization: 'any',
            lineWidth: 10,
            opacity: 40,
            color: defaultSearchStyleColorDraft(this.defaultStyleField())
        };
    }

    /** Returns the first currently valid result-field path for newly created controls. */
    private defaultStyleField(): string {
        return this.styleAttributeOptions[0]?.value ?? "";
    }

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

    protected filterFieldIsNumeric(filter: FeatureSearchStyleFilterDraft): boolean {
        return isNumericStyleValueKind(this.styleFieldOption(filter.attributeField)?.valueKind);
    }

    protected filterFieldEnumOptions(filter: FeatureSearchStyleFilterDraft): Array<{label: string; value: string}> {
        return (this.styleFieldOption(filter.attributeField)?.enumValues ?? []).map(value => ({label: value, value}));
    }

    protected styleOperatorOptionsForFilter(filter: FeatureSearchStyleFilterDraft): FeatureSearchStyleOption[] {
        if (this.filterFieldIsNumeric(filter)) {
            return this.styleOperatorOptions;
        }
        return this.styleOperatorOptions.filter(option => ["=", "!=", "contains"].includes(option.value));
    }

    /** Refreshes the compact scope label from the same schema metadata used by the style field picker. */
    private refreshFeatureSearchScopeSummary(session: FeatureSearchSession): void {
        this.updateFeatureSearchScopeSummary(session.definition.query, session.definition.scope);
    }

    /** Updates the scope label for the current query and selected persisted scope mode. */
    private updateFeatureSearchScopeSummary(query: string, scope: FeatureSearchScope): void {
        if (scope === "feature") {
            this.featureSearchScopeSummary = "Feature scope";
            this.featureSearchScopeSummaryTitle = "Search runs over feature-level fields.";
            return;
        }

        const attributeScopes = this.searchSchema.getAttributeScopeForQuery(query);
        if (attributeScopes.length > 0) {
            this.featureSearchScopeSummary = this.attributeScopeSummaryLabel(scope, attributeScopes);
            this.featureSearchScopeSummaryTitle = this.attributeScopeSummaryTitle(attributeScopes);
            return;
        }

        if (scope === "attribute") {
            this.featureSearchScopeSummary = "Attribute scope: all attributes";
            this.featureSearchScopeSummaryTitle =
                "No single attribute was inferred from the query; attribute fields from all schema-backed attributes remain available.";
            return;
        }

        this.featureSearchScopeSummary = "Auto: feature scope";
        this.featureSearchScopeSummaryTitle =
            "No single attribute was inferred from the query; auto scope resolves to feature-level search.";
    }

    /** Builds the user-facing summary for an inferred attribute scope. */
    private attributeScopeSummaryLabel(
        scope: FeatureSearchScope,
        attributeScopes: FeatureSearchAttributeScopeCandidate[]
    ): string {
        const representative = attributeScopes[0];
        const prefix = scope === "auto" ? "Auto: attribute" : "Attribute";
        const attributeNames = this.uniqueAttributeScopeNames(attributeScopes);
        if (attributeNames.length > 1) {
            const visibleNames = attributeNames.slice(0, 3).join(", ");
            const remaining = attributeNames.length > 3 ? `, +${attributeNames.length - 3}` : "";
            return `${prefix}s: ${visibleNames}${remaining} (${attributeScopes.length} scopes)`;
        }

        const attributeName = this.attributeScopeDisplayName(representative);
        const contextSuffix = attributeScopes.length > 1
            ? ` across ${attributeScopes.length} layers`
            : "";
        return `${prefix}: ${attributeName}${contextSuffix}`;
    }

    /** Builds the tooltip with the concrete map/layer contexts behind an inferred attribute scope. */
    private attributeScopeSummaryTitle(attributeScopes: FeatureSearchAttributeScopeCandidate[]): string {
        return attributeScopes
            .map(scope => {
                const featureType = scope.featureType ? `, feature ${scope.featureType}` : "";
                return `${this.attributeScopeDisplayName(scope)} in ${scope.mapId}/${scope.layerId}${featureType}`;
            })
            .join("\n");
    }

    /** Formats the attribute and attribute-layer names without inventing display aliases. */
    private attributeScopeDisplayName(scope: FeatureSearchAttributeScopeCandidate): string {
        return scope.attrLayerName
            ? `${scope.attrName} (${scope.attrLayerName})`
            : scope.attrName;
    }

    /** Returns sorted distinct attribute names inferred for one query. */
    private uniqueAttributeScopeNames(attributeScopes: FeatureSearchAttributeScopeCandidate[]): string[] {
        return Array.from(new Set(attributeScopes.map(scope => scope.attrName).filter(Boolean))).sort();
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

    /** Persists one normalized color draft emitted by the search-local color editor. */
    protected onRuleColorDraftChange(rule: FeatureSearchStyleRuleDraft, color: SearchStyleColorDraft): void {
        rule.color = color;
        this.onStyleRulesChanged();
    }

    /** Persists an optional user-facing name for one style rule. */
    protected setStyleRuleName(rule: FeatureSearchStyleRuleDraft, value: string): void {
        rule.name = value ?? "";
        this.onStyleRulesChanged();
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
        const nextValue = key === "highFidelityMaxVisibleTiles"
            ? this.clampNumber(value, 1, 65536, DEFAULT_FEATURE_SEARCH_RENDER_STRATEGY.highFidelityMaxVisibleTiles)
            : !!value;
        this.stateService.patchFeatureSearch(session.id, {
            renderStrategy: {
                ...this.searchRenderStrategy(),
                [key]: nextValue
            }
        });
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
            ...(rule.name.trim() ? {name: rule.name.trim()} : {}),
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
        return {
            id: this.nextStyleRuleId++,
            name: rule.name ?? "",
            filters: rule.filter.map(filter => this.filterToDraft(filter)),
            visualization: rule.geometry ?? "any",
            lineWidth: this.clampNumber(rule.width, 1, 32, 4),
            opacity: this.clampNumber((rule.opacity ?? 1) * 100, 0, 100, 100),
            color: this.colorDraftFromState(rule.color)
        };
    }

    /** Converts the editor's color draft into the persisted color-mode union. */
    private colorModeFromDraft(rule: FeatureSearchStyleRuleDraft): FeatureSearchColorMode {
        const color = rule.color;
        const fallbackColor = normalizeHexColor(color.fallbackColor, color.solidColor);
        if (color.mode === "solid") {
            return {mode: "solid", color: normalizeHexColor(color.solidColor)};
        }
        if (color.mode === "categories") {
            const valueKind = this.styleFieldOption(color.field)?.valueKind;
            return {
                mode: "categories",
                field: color.field,
                stops: serializableCategoryStops(color, valueKind),
                fallbackColor
            };
        }
        if (!isNumericStyleValueKind(this.styleFieldOption(color.field)?.valueKind)) {
            return {
                mode: "categories",
                field: color.field,
                stops: serializableCategoryStops(color, this.styleFieldOption(color.field)?.valueKind),
                fallbackColor
            };
        }
        return {
            mode: "gradient",
            field: color.field,
            stops: serializableGradientStops(color) ?? [],
            fallbackColor
        };
    }

    /** Converts one editor filter condition into its persisted predicate shape. */
    private filterFromDraft(filter: FeatureSearchStyleFilterDraft): FeatureSearchRuleFilter {
        return {
            field: filter.attributeField,
            op: filter.operator,
            value: this.filterValueFromDraft(filter)
        };
    }

    /** Converts one persisted predicate into an editor filter row. */
    private filterToDraft(filter: FeatureSearchRuleFilter): FeatureSearchStyleFilterDraft {
        return {
            id: this.nextStyleConditionId++,
            attributeField: filter.field || this.defaultStyleField(),
            operator: filter.op || "=",
            filterValue: filter.value ?? ""
        };
    }

    private filterValueFromDraft(filter: FeatureSearchStyleFilterDraft): unknown {
        const valueKind = this.styleFieldOption(filter.attributeField)?.valueKind;
        if (isNumericStyleValueKind(valueKind)) {
            const numeric = Number(filter.filterValue);
            return Number.isFinite(numeric) ? numeric : filter.filterValue;
        }
        if (valueKind === "boolean") {
            const lower = String(filter.filterValue ?? "").trim().toLowerCase();
            if (lower === "true") {
                return true;
            }
            if (lower === "false") {
                return false;
            }
        }
        return String(filter.filterValue ?? "");
    }

    /** Converts a persisted color union into the search-local color editor draft. */
    private colorDraftFromState(color: FeatureSearchColorMode): SearchStyleColorDraft {
        const field = color.mode === "solid" ? this.defaultStyleField() : color.field || this.defaultStyleField();
        const draft = defaultSearchStyleColorDraft(field);
        if (color.mode === "solid") {
            const solidColor = normalizeHexColor(color.color, DEFAULT_SEARCH_STYLE_SOLID_COLOR);
            return {
                ...draft,
                mode: "solid",
                solidColor,
                fallbackColor: solidColor
            };
        }
        const fallbackColor = normalizeHexColor(color.fallbackColor, DEFAULT_SEARCH_STYLE_SOLID_COLOR);
        if (color.mode === "categories") {
            return {
                ...draft,
                mode: "categories",
                field,
                solidColor: fallbackColor,
                fallbackColor,
                categoryStops: this.categoryStopsToDraft(color.stops)
            };
        }
        return {
            ...draft,
            mode: "gradient",
            field,
            solidColor: fallbackColor,
            fallbackColor,
            gradientStops: gradientStopsToDraft(color.stops, () => this.nextStyleColorStopId++)
        };
    }

    /** Converts persisted category stops without numeric coercion. */
    private categoryStopsToDraft(stops: Array<{value: unknown; color: string}>): SearchStyleCategoryStopDraft[] {
        return stops.map(stop => {
            const valueText = stop.value === null || stop.value === undefined ? "" : String(stop.value);
            return {
                id: this.nextStyleColorStopId++,
                valueText,
                color: normalizeHexColor(stop.color, DEFAULT_SEARCH_STYLE_SOLID_COLOR),
                pending: valueText.trim().length === 0
            };
        });
    }

    /**
     * Refreshes the style-rule field picker from schema metadata.
     *
     * Existing drafts keep their current raw values, but invalid values are not
     * reintroduced into the picker; this prevents old demo fields from staying selectable.
     */
    private refreshStyleAttributeOptions(session: FeatureSearchSession, patchMissingFields = true): void {
        const rawOptions = this.searchSchema.searchStyleFieldsForQuery(
            session.definition.query,
            session.definition.scope
        );
        const activeOptions = rawOptions.filter(option => this.isStyleFieldCandidateActive(option.mapId, option.layerId));
        const sourceOptions = activeOptions.length ? activeOptions : rawOptions;
        const byValue = new Map<string, {option: FeatureSearchStyleOption, contexts: Set<string>}>();
        for (const option of sourceOptions) {
            let entry = byValue.get(option.path);
            if (!entry) {
                entry = {
                    option: {
                        label: option.path,
                        value: option.path,
                        mapId: option.mapId,
                        layerId: option.layerId,
                        attrName: option.attrName,
                        featureType: option.featureType,
                        valueKind: option.valueKind,
                        enumValues: option.enumValues
                    },
                    contexts: new Set<string>()
                };
                byValue.set(option.path, entry);
            }
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
            .sort((lhs, rhs) => lhs.label.localeCompare(rhs.label));
        if (JSON.stringify(nextOptions) !== JSON.stringify(this.styleAttributeOptions)) {
            this.styleAttributeOptions = nextOptions;
        }
        if (patchMissingFields
            && (session.definition.searchStyleRules?.length ?? 0) > 0
            && this.applyDefaultStyleFieldIfMissing()) {
            this.onStyleRulesChanged();
        }
    }

    /** Returns the attribute context suffix shown in search-style field pickers. */
    private searchStyleFieldContextLabel(option: FeatureSearchStyleFieldCandidate): string {
        if (!option.attrName) {
            return "";
        }
        return option.featureType ? `${option.attrName}/${option.featureType}` : option.attrName;
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

    private searchLayerKey(mapId: string, layerId: string): string {
        return JSON.stringify([mapId, layerId]);
    }

    private refreshMapLayerOptions(): void {
        const options: FeatureSearchLayerOption[] = [];
        for (const [mapId, map] of this.mapService.maps.maps) {
            for (const layer of map.allFeatureLayers()) {
                options.push({
                    mapId,
                    layerId: layer.id,
                    key: this.searchLayerKey(mapId, layer.id),
                    label: `${mapId} - ${layer.id}`
                });
            }
        }
        options.sort((lhs, rhs) => lhs.label.localeCompare(rhs.label));
        const signature = JSON.stringify(options.map(option => option.key));
        if (signature === this.mapLayerOptionsSignature) {
            return;
        }
        this.mapLayerOptionsSignature = signature;
        this.mapLayerOptions = options;
    }

    private activeMapLayerOptions(): FeatureSearchLayerOption[] {
        return this.mapLayerOptions.filter(option => this.isStyleFieldCandidateActive(option.mapId, option.layerId));
    }

    private syncSelectedMapLayersFromSession(session: FeatureSearchSession): void {
        this.refreshMapLayerOptions();
        const selectedRefs = session.definition.selectedMapLayers;
        const selectedKeys = new Set(selectedRefs.map(ref => this.searchLayerKey(ref.mapId, ref.layerId)));
        const nextOptions = this.mapLayerOptions.filter(option => selectedKeys.has(option.key));
        const signature = JSON.stringify(nextOptions.map(option => option.key));
        if (signature === this.selectedMapLayersSignature) {
            return;
        }
        this.selectedMapLayersSignature = signature;
        this.selectedMapLayerOptions = nextOptions;
    }

    protected onSearchMapLayersChange(options: FeatureSearchLayerOption[]): void {
        const session = this.session;
        if (!session || !this.searchEnabled()) {
            return;
        }
        this.selectedMapLayerOptions = options ?? [];
        this.selectedMapLayersSignature = JSON.stringify(this.selectedMapLayerOptions.map(option => option.key));
        this.searchService.setSearchMapLayers(
            session.id,
            this.selectedMapLayerOptions.map(option => ({mapId: option.mapId, layerId: option.layerId}))
        );
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
            if (rule.color.mode !== "solid" && this.fieldNeedsDefault(rule.color.field)) {
                rule.color.field = field;
                changed = true;
            }
            if (rule.color.mode === "gradient"
                && !isNumericStyleValueKind(this.styleFieldOption(rule.color.field)?.valueKind)) {
                rule.color.mode = "categories";
                changed = true;
            }
            for (const filter of rule.filters) {
                if (this.fieldNeedsDefault(filter.attributeField)) {
                    filter.attributeField = field;
                    filter.filterValue = this.defaultFilterValue(field);
                    changed = true;
                }
                if (!this.styleOperatorOptionsForFilter(filter).some(option => option.value === filter.operator)) {
                    filter.operator = "=";
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
        this.syncSelectedMapLayersFromSession(session);
        this.refreshFeatureSearchScopeSummary(session);
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

    protected searchEnabled(): boolean {
        return this.session?.definition.enabled ?? true;
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
        if (!query || !this.session || !this.searchEnabled()) {
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
        if (this.session) {
            this.updateFeatureSearchScopeSummary(this.session.definition.query, scope);
        }
        if (this.session && this.searchEnabled() && this.session.definition.scope !== scope) {
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
        if (this.session && this.searchEnabled()) {
            this.searchService.setSearchAutoUpdate(this.session.id, autoUpdate);
        }
    }

    protected updateSearchInArea(): void {
        if (this.session && this.searchEnabled()) {
            this.searchService.updateSearchInArea(this.session.id);
        }
    }

    protected featureSearchHeaderActions(): AppSurfaceHeaderAction[] {
        const bookmarked = !!this.session?.definition.bookmarked;
        const enabled = this.searchEnabled();
        return [
            {
                label: bookmarked ? 'Remove bookmark' : 'Bookmark search',
                tooltip: bookmarked ? 'Remove bookmark' : 'Bookmark search',
                icon: bookmarked ? 'pi pi-bookmark-fill' : 'pi pi-bookmark',
                command: () => this.toggleSearchBookmarked()
            },
            {
                label: enabled ? 'Disable search' : 'Enable search',
                tooltip: enabled ? 'Disable search' : 'Enable search',
                icon: enabled ? 'pi pi-toggle-on' : 'pi pi-toggle-off',
                command: () => this.toggleSearchEnabled()
            },
            {
                label: 'Export as JSON',
                tooltip: 'Export as JSON',
                icon: 'pi pi-download',
                disabled: !this.session,
                command: () => this.exportSearchAsJson()
            },
            {
                label: 'Rerun search',
                tooltip: 'Rerun search',
                icon: 'pi pi-refresh',
                disabled: !enabled || !this.searchQueryForRerun(),
                command: () => this.rerunSearch()
            },
            {
                label: this.isSearchPaused ? 'Resume search' : 'Pause search',
                tooltip: this.isSearchPaused ? 'Resume search' : 'Pause search',
                icon: this.isSearchPaused ? 'pi pi-play-circle' : 'pi pi-pause-circle',
                disabled: !enabled || !this.canPauseStopSearch,
                command: () => this.toggleSearchPaused()
            },
            {
                label: 'Stop search',
                tooltip: 'Stop search',
                icon: 'pi pi-stop-circle',
                disabled: !enabled || !this.canPauseStopSearch,
                command: () => this.stopSearch()
            }
        ];
    }

    protected toggleSearchBookmarked(): void {
        if (this.session) {
            this.searchService.setSearchBookmarked(this.session.id, !this.session.definition.bookmarked);
        }
    }

    protected toggleSearchEnabled(): void {
        if (this.session) {
            this.searchService.setSearchEnabled(this.session.id, !this.searchEnabled());
        }
    }

    protected exportSearchAsJson(): void {
        const session = this.session;
        if (!session) {
            return;
        }
        const safeId = safeFeatureSearchExportId(session.id);
        this.downloadJsonFile(
            `feature-search-${safeId}-definition.json`,
            featureSearchDefinitionExport(session.definition)
        );
        this.downloadJsonFile(
            `feature-search-${safeId}-results.json`,
            featureSearchResultsExport(session.searchResults, this.currentExportGrouping(), this.resultTreeFilterValue)
        );
        this.infoMessageService.showSuccess('Feature search JSON export started');
    }

    private currentExportGrouping(): FeatureSearchGroupingExportOption[] {
        return this.groupingValuesFromOptions(this.selectedGroupingOptions).map(id => ({
            id,
            name: this.grouping.find(option => option.value === id)?.name ?? String(id)
        }));
    }

    private downloadJsonFile(filename: string, payload: unknown): void {
        const source = JSON.stringify(payload, featureSearchJsonReplacer, 2) ?? "null";
        const blob = new Blob(
            [source],
            {type: 'application/json;charset=utf-8'}
        );
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    protected async closeSearch() {
        if (this.session) {
            const sessionId = this.session.id;
            if (this.session.definition.bookmarked && !this.confirmedCloseSessionIds.has(sessionId)) {
                if (this.confirmingClose) {
                    return;
                }
                this.confirmingClose = true;
                const confirmed = await this.infoMessageService.showConfirmDialog(
                    this.alertContainer,
                    'Close Bookmarked Search',
                    'This search is bookmarked. Close it anyway?'
                );
                this.confirmingClose = false;
                if (!confirmed) {
                    this.featureSearchDialogVisible = true;
                    return;
                }
                this.confirmedCloseSessionIds.add(sessionId);
            }
            this.confirmedCloseSessionIds.add(sessionId);
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
        this.diagnostics = session.diagnostics;

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

    /** Mirrors result-tree hover into the map hover highlighter, including attribute-validity suffixes. */
    protected hoverResultNode(node: TreeNode): void {
        const data = node.data as {mapTileKey?: string; hoverFeatureId?: string} | undefined;
        if (!data?.mapTileKey || !data.hoverFeatureId) {
            return;
        }
        this.inspectionSelection.setHoveredFeatures([{
            mapTileKey: data.mapTileKey,
            featureId: data.hoverFeatureId
        }]);
    }

    /** Clears map hover state when leaving a result-tree row. */
    protected clearHoveredResultNode(): void {
        this.inspectionSelection.setHoveredFeatures([]);
    }

    protected onResultTreeFilter(event: {filter?: string | null | undefined}): void {
        this.resultTreeFilterValue = String(event?.filter ?? "");
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
    async onHide(_: any) {
        const sessionId = this.session?.id;
        if (sessionId) {
            await this.closeSearch();
        }
        if (!this.session || this.confirmedCloseSessionIds.has(sessionId ?? "")) {
            this.resetLocalState();
            this.featureSearchDialogVisible = false;
        }
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
        this.resultTreeFilterValue = "";
        this.resultTreeGroupNodesByKey.clear();
        this.cancelResultTreeAppend();
        this.lastErrorAlertSignature = "";
        this.surfacedDockedSearchId = "";
        this.selectedMapLayerOptions = [];
        this.selectedMapLayersSignature = "";
        this.confirmingClose = false;
        this.confirmedCloseSessionIds.clear();
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
        this.selectedGroupingOptions = groupingValues
            .map(value => this.grouping.find(option => option.value === value))
            .filter((option): option is FeatureSearchGroupingOption => !!option);
        this.stateService.featureSearchGrouping = groupingValues;
        this.rebuildResultsTreeIncrementally();
    }

    /** Converts persisted grouping values into dropdown options. */
    private groupingOptionsFromValues(values: number[]): FeatureSearchGroupingOption[] {
        return values
            .map(value => this.grouping.find(option => option.value === value))
            .filter((option): option is FeatureSearchGroupingOption => !!option);
    }

    /** Converts dropdown options into persisted grouping values. */
    private groupingValuesFromOptions(options: FeatureSearchGroupingOption[] | null | undefined): number[] {
        const seen = new Set<number>();
        const result: number[] = [];
        for (const option of options ?? []) {
            if (!this.grouping.some(candidate => candidate.value === option.value) || seen.has(option.value)) {
                continue;
            }
            seen.add(option.value);
            result.push(option.value);
        }
        return result;
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
            tileId: result.sourceTileId.toString(),
            resultKey: result.resultKey,
            mapTileKey: result.mapTileKey,
            hoverFeatureId: result.hoverFeatureId
        };
    }

    /** Creates one selectable result-tree leaf for a streamed result entry. */
    private resultLeafNode(item: FeatureSearchResultTreeItem, index: number, parentKey: string): TreeNode {
        return {
            key: `${parentKey}/leaf:${index}:${item.resultKey}`,
            label: item.label,
            data: {
                mapId: item.mapId,
                featureId: item.featureId,
                mapTileKey: item.mapTileKey,
                hoverFeatureId: item.hoverFeatureId
            },
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
        const runChanged = this.resultTreeRunId !== runId;
        this.cancelResultTreeAppend();
        this.resultsTree = [];
        this.resultTreeGroupNodesByKey.clear();
        this.resultTreeInputLength = 0;
        this.resultTreeRunId = runId;
        this.resultTreeGroupingSignature = groupingSignature;
        if (runChanged) {
            this.resultTreeFilterValue = "";
            this.tree?.resetFilter();
        }
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
                    key: `${parentKey}/leaf:${idx}:${it.resultKey}`,
                    label: it.label,
                    data: {
                        mapId: it.mapId,
                        featureId: it.featureId,
                        mapTileKey: it.mapTileKey,
                        hoverFeatureId: it.hoverFeatureId
                    },
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
