import {
    AfterViewInit,
    ChangeDetectorRef,
    Component,
    ElementRef,
    EventEmitter,
    Input,
    OnChanges,
    OnDestroy,
    NgZone,
    Output,
    SimpleChanges,
    ViewChild,
    ViewContainerRef
} from "@angular/core";
import {
    FeatureSearchExportGroupingOption,
    FeatureSearchResultEntry,
    FeatureSearchService,
    FeatureSearchSession,
    featureSearchActionPayloadFromCompletion,
    featureSearchSelectedMapLayersFromPayload
} from "./feature.search.service";
import {JumpTargetService} from "./jump.service";
import {MapInfoService} from "../mapdata/map-info.service";
import {FeatureSearchSchemaService} from "../mapdata/feature-search-schema.service";
import {GroupTreeNode, LayerTreeNode, MapTreeNode, removeGroupPrefix} from "../mapdata/map.tree.model";
import {InspectionSelectionService} from "../inspection/inspection-selection.service";
import type {
    FeatureSearchAttributeScopeCandidate,
    FeatureSearchStyleFieldCandidate
} from "../mapdata/map-runtime.model";
import {OverlayOptions, TreeNode} from "primeng/api";
import type {MeterItem} from "primeng/types/metergroup";
import {InfoMessageService} from "../shared/info.service";
import {AppConfirmPopupService} from "../shared/app-confirm-popup.service";
import {
    CompletionCandidate,
    DiagnosticsMessage,
    SearchResultFieldValueSummary,
    SearchValueSummariesState,
    SearchValueSummary
} from "./search.model";
import {coreLib} from "../integrations/wasm";
import {AppStateService, SEARCH_DOCK_TAB_ID} from "../shared/appstate.service";
import {Tree} from "primeng/tree";
import {Scroller} from "primeng/scroller";
import {DialogStackService} from "../shared/dialog-stack.service";
import {AppDialogComponent} from "../shared/app-dialog.component";
import {Subscription} from "rxjs";
import {AppPanelComponent} from "../shared/app-panel.component";
import type {AppSurfaceHeaderAction} from "../shared/app-surface-header.component";
import {
    DEFAULT_FEATURE_SEARCH_LABEL_BACKGROUND_COLOR,
    DEFAULT_FEATURE_SEARCH_RENDER_STRATEGY,
    DEFAULT_FEATURE_SEARCH_TILE_LEVELS,
    MAX_FEATURE_SEARCH_TILE_LEVEL,
    MIN_FEATURE_SEARCH_TILE_LEVEL,
    normalizeFeatureSearchFeatureTypes
} from "../shared/feature-search-state";
import type {
    FeatureSearchMapLayerRef,
    FeatureSearchRenderStrategy,
    FeatureSearchScope,
    FeatureSearchStyleRule
} from "../shared/feature-search-state";
import {
    autoInitializeSearchStyleColorDraft,
    defaultSearchStyleColorDraft,
    DEFAULT_SEARCH_STYLE_SOLID_COLOR,
    isNumericStyleValueKind,
    normalizeHexColor,
    SearchStyleColorDraft
} from "./search-style-color.util";
import {SimfilExpressionInputComponent} from "./simfil-expression-input.component";
import {
    defaultSearchStyleFieldOptionsForAnalysis,
    preferredSearchAutoStyleField,
    searchAutoStyleFieldOptions,
    searchAutoStyleFieldOptionsArePortable
} from "./feature-search-auto-style.util";
import type {FeatureSearchAutoStyleOption} from "./feature-search-auto-style.util";
import {
    FeatureSearchStyleFilterDraft,
    FeatureSearchStyleRuleDraft,
    SearchStyleRuleDraftCodec
} from "./search-style-rule-editor.model";
import {ErdblickStyle, StyleService} from "../styledata/style.service";
import {StyleEditorRequestService} from "../styledata/style-editor-request.service";
import type {SearchStyleSaveRequest} from "./search-style-save.dialog.component";
import {
    convertSearchStyleRulesToYaml,
    projectStyleSourceForSearch,
    SearchStyleApplicationProjection
} from "./search-style-sheet.converter";

interface FeatureSearchGroupingOption {
    name: string;
    value: number;
}

type FeatureSearchStyleOption = FeatureSearchAutoStyleOption;

interface FeatureSearchSavedStyleOption {
    label: string;
    value: string;
    disabled: boolean;
    summary: string;
    projection?: SearchStyleApplicationProjection;
}

const INTERNAL_SEARCH_RESULT_FIELDS = new Set(["$layer", "$name", "$validityCount", "$validityIndex"]);

interface FeatureSearchScopeOption {
    label: string;
    value: FeatureSearchScope;
}

interface FeatureSearchLayerTreeNodeData {
    kind: "group" | "map" | "layer";
    mapId?: string;
    layerId?: string;
}

interface FeatureSearchLayerTreeNodeSelectionState {
    selectedLeafCount: number;
    totalLeafCount: number;
    checked: boolean;
    partial: boolean;
}

interface FeatureSearchViewOption {
    label: string;
    value: number;
}

interface FeatureSearchTileLevelOption {
    label: string;
    value: number;
}

interface FeatureSearchFeatureTypeOption {
    label: string;
    value: string;
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

@Component({
    selector: "feature-search",
    template: `
        @if (session) {
            @if (isDocked()) {
                <app-panel #featureSearchPanel class="feature-search-panel" data-testid="feature-search-docked-panel"
                           [layoutId]="session.layoutId" [persistLayout]="true"
                           [dockedPanelCount]="dockedPanelCount"
                           [expanded]="featureSearchExpanded"
                           (expandedChange)="featureSearchExpanded = $event"
                           [preferredBodyHeightEm]="measurePreferredFeatureSearchHeightEm"
                           [maxBodyHeightEm]="60"
                           (onShow)="onDockedPanelShow()"
                           (bodySizeChange)="onDockedPanelBodySizeChange()">
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
                          [dockDropCue]="true"
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
                                [title]="featureSearchTitle()"
                                titleIcon="search"
                                [titleTooltipDisabled]="true"
                                [hasSmartControl]="true"
                                [dockMode]="isDocked() ? 'undock' : 'dock'"
                                [sizeToggleVisible]="isDocked()"
                                [sizeToggleDisabled]="dockedPanelCount <= 1"
                                [expanded]="featureSearchExpanded"
                                [dragEnabled]="true"
                                [extraActions]="featureSearchHeaderActions()"
                                (focusRequest)="bringSurfaceToFront()"
                                (dockRequest)="toggleDocked()"
                                (sizeToggleRequest)="toggleExpanded()"
                                (closeRequest)="closeSearch($event)"
                                (dragPointerDown)="onHeaderPointerDown($event)">
                <p-toggleswitch surfaceHeaderSmartControl
                                [ngModel]="searchEnabled()"
                                [disabled]="!session"
                                inputId="feature-search-enabled-toggle"
                                data-testid="feature-search-enabled-toggle"
                                (click)="$event.stopPropagation()"
                                (mousedown)="$event.stopPropagation()"
                                (ngModelChange)="onSearchEnabledChange($event)">
                </p-toggleswitch>
            </app-surface-header>
        </ng-template>

        <ng-template #searchContent>
            <div #featureSearchContentContainer class="feature-search-content" [class.feature-search-content-disabled]="!searchEnabled()">
            <div class="feature-search-query search-input">
                <simfil-expression-input #featureSearchQueryInput
                                         class="feature-search-query-input"
                                         [value]="featureSearchQuery"
                                         (valueChange)="onFeatureSearchQueryChange($event)"
                                         [singleLine]="!featureSearchQueryExpanded"
                                         [disabled]="!searchEnabled()"
                                         [submitOnEnter]="true"
                                         [completionOwnerId]="featureSearchCompletionOwnerId"
                                         [completionScope]="featureSearchScope"
                                         [completionMapLayers]="selectedSearchMapLayers()"
                                         [completionZIndex]="featureSearchCompletionZIndex"
                                         placeholder="Search query"
                                         (clicked)="expandFeatureSearchQueryInput()"
                                         (focused)="expandFeatureSearchQueryInput()"
                                         (blurred)="shrinkFeatureSearchQueryInput()"
                                         (completionAccepted)="onFeatureSearchQueryCompletionAccepted($event)"
                                         (submitted)="rerunSearch()">
                </simfil-expression-input>
            </div>
            <div class="feature-search-layer-control"
                 [class.feature-search-layer-control-with-view]="showSearchViewControl()">
                <p-iftalabel class="feature-search-layer-select">
                    <p-treeselect inputId="feature-search-map-layers"
                                  [options]="mapLayerTreeOptions"
                                  [selectionMode]="mapLayerTreeSelectionMode"
                                  placeholder="No layers selected"
                                  [filter]="true"
                                  [showClear]="false"
                                  [disabled]="!searchEnabled()"
                                  scrollHeight="24em"
                                  appendTo="body"
                                  (onNodeExpand)="onSearchMapLayerTreeNodeExpansionChange($event, true)"
                                  (onNodeCollapse)="onSearchMapLayerTreeNodeExpansionChange($event, false)">
                        <ng-template #value let-placeholder="placeholder">
                            {{ selectedMapLayerTreeValueLabel(selectedMapLayerTreeNodes, placeholder) }}
                        </ng-template>
                        <ng-template let-node pTemplate="default">
                            <span class="feature-search-map-layer-tree-node"
                                  (click)="onSearchMapLayerTreeNodeToggle(node, $event)">
                                <p-checkbox [ngModel]="isSearchMapLayerTreeNodeChecked(node)"
                                            [binary]="true"
                                            [indeterminate]="isSearchMapLayerTreeNodePartial(node)"
                                            [readonly]="true"
                                            [disabled]="!searchEnabled()"
                                            [tabindex]="-1"
                                            [ariaLabel]="node.label"
                                            (click)="$event.preventDefault()">
                                </p-checkbox>
                                <span class="feature-search-map-layer-tree-node-label">{{ node.label }}</span>
                            </span>
                        </ng-template>
                    </p-treeselect>
                    <label for="feature-search-map-layers">Map Layers</label>
                </p-iftalabel>
                <p-iftalabel class="feature-search-feature-type-select">
                    <p-multiSelect inputId="feature-search-feature-type"
                                   [options]="featureSearchFeatureTypeOptions"
                                   [(ngModel)]="selectedFeatureTypes"
                                   optionLabel="label"
                                   optionValue="value"
                                   [filter]="true"
                                   [showToggleAll]="false"
                                   [maxSelectedLabels]="1"
                                   placeholder="Any"
                                   selectedItemsLabel="{0} types"
                                   [disabled]="!searchEnabled()"
                                   appendTo="body"
                                   (ngModelChange)="onSearchFeatureTypesChange($event)">
                    </p-multiSelect>
                    <label for="feature-search-feature-type">Feature Type</label>
                </p-iftalabel>
                <p-iftalabel class="feature-search-level-select">
                    <p-multiSelect inputId="feature-search-levels"
                                   [options]="featureSearchTileLevelOptions"
                                   [(ngModel)]="selectedTileLevels"
                                   optionLabel="label"
                                   optionValue="value"
                                   [filter]="false"
                                   [showToggleAll]="false"
                                   [maxSelectedLabels]="1"
                                   placeholder="Auto"
                                   selectedItemsLabel="{0} levels"
                                   [disabled]="!searchEnabled()"
                                   appendTo="body"
                                   (ngModelChange)="onSearchTileLevelsChange($event)">
                    </p-multiSelect>
                    <label for="feature-search-levels">Level</label>
                </p-iftalabel>
                <p-iftalabel class="feature-search-scope-select">
                    <p-select inputId="feature-search-scope"
                              [options]="featureSearchScopeOptions"
                              [(ngModel)]="featureSearchScope"
                              optionLabel="label"
                              optionValue="value"
                              [disabled]="!searchEnabled()"
                              appendTo="body"
                              (ngModelChange)="onFeatureSearchScopeChange($event)">
                    </p-select>
                    <label for="feature-search-scope">Scope</label>
                </p-iftalabel>
                @if (showSearchViewControl()) {
                    <p-iftalabel class="feature-search-view-select">
                        <p-multiSelect inputId="feature-search-views"
                                       [options]="featureSearchViewOptions"
                                       [(ngModel)]="selectedViewIndices"
                                       optionLabel="label"
                                       optionValue="value"
                                       [filter]="false"
                                       [showToggleAll]="false"
                                       [maxSelectedLabels]="1"
                                       selectedItemsLabel="All"
                                       [disabled]="!searchEnabled()"
                                       appendTo="body"
                                       (ngModelChange)="onSearchViewIndicesChange($event)">
                        </p-multiSelect>
                        <label for="feature-search-views">View</label>
                    </p-iftalabel>
                }
            </div>
            <div class="feature-search-controls">
                <div class="feature-search-progress-meter" [title]="progressTooltip">
                    <p-metergroup [value]="progressMeterItems"
                                  [min]="0"
                                  [max]="100"
                                  labelPosition="end"
                                  labelOrientation="horizontal">
                    </p-metergroup>
                    <span class="feature-search-progress-label"
                          [style.--feature-search-progress]="progressDisplayPercent + '%'">
                        {{ progressLabel }}
                    </span>
                </div>
            </div>
            <p-tabs [value]="resultPanelIndex"
                    (valueChange)="onResultPanelIndexChange($event)"
                    class="feature-search-tabs"
                    data-testid="feature-search-panel"
                    scrollable>
                <p-tablist>
                    <p-tab value="results">
                        <span>Results </span>
                        <p-badge [value]="resultCount"/>
                    </p-tab>
                    <p-tab value="style">
                        <span>Visualization </span>
                        <p-badge [value]="styleRuleDrafts.length"/>
                    </p-tab>
                    <p-tab value="diagnostics">
                        <span>Diagnostics </span>
                        <p-badge [value]="diagnosticsBadgeCount()"/>
                    </p-tab>
                </p-tablist>

                <p-tabpanels>
                    <!-- Results -->
                    <p-tabpanel value="results">
                        <div class="feature-search-results-panel">
                            <div style="width: 100%; display: flex; gap: 0.25em; flex-direction: row; align-items: center; padding: 0.25em 0">
                                <label for="feature-search-grouping">Group</label>
                                <p-multiSelect inputId="feature-search-grouping"
                                               style="width: 100%"
                                               [options]="grouping"
                                               [(ngModel)]="selectedGroupingOptions"
                                               [filter]="false"
                                               [showToggleAll]="false"
                                               (ngModelChange)="onGroupingOptionsChange($event)"
                                               placeholder="Select Grouping"
                                               [maxSelectedLabels]="5"
                                               display="chip"
                                               optionLabel="name">
                                </p-multiSelect> 
                            </div>
                            

                            <div #featureSearchTreeHost class="feature-search-tree-host">
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
                                [completionMapLayers]="selectedSearchMapLayers()"
                                [completionZIndex]="featureSearchCompletionZIndex"
                                [completionOwnerPrefix]="'feature-search-style:' + searchId"
                                [colorPickerOverlayOptions]="featureSearchColorPickerOverlayOptions"
                                [dataSummaryStatus]="valueSummaries.status"
                                [valueSummaryForExpression]="valueSummaryForStyleExpressionCallback"
                                [showAddButton]="false"
                                (updateFromDataRequested)="onStyleColorDataUpdateRequested()">
                            </search-style-rule-editor>
                        </div>
                    </p-tabpanel>

                    <!-- Diagnostics -->
                    <p-tabpanel value="diagnostics">
                        <div id="searchDiagnosticsPanel">
                            @if (diagnostics.length > 0) {
                                <section class="feature-search-diagnostics-section">
                                    <h3>Messages</h3>
                                    <ul class="feature-search-diagnostics-list">
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
                                </section>
                            }

                            <section class="feature-search-diagnostics-section">
                                <h3>Query</h3>
                                <div class="feature-search-query-diagnostics-grid">
                                    <span>Query</span>
                                    <code>{{ session?.definition?.query ?? '' }}</code>
                                    <span>Backend query</span>
                                    <code>{{ session?.schemaAnalysis?.normalizedQuery || session?.definition?.query || '' }}</code>
                                    <span>Scope</span>
                                    <span [title]="featureSearchScopeSummaryTitle">
                                        {{ featureSearchScopeSummary || 'Unknown' }}
                                    </span>
                                    <span>Attribute candidates</span>
                                    <span>{{ session?.schemaAnalysis?.attributeScopeCandidateCount ?? 0 }}</span>
                                    <span>Elapsed</span>
                                    <span>{{ searchTimeElapsed }}</span>
                                    <span>Features</span>
                                    <span>{{ searchTotalFeatureCount }}</span>
                                    <span>Matched</span>
                                    <span>{{ resultCount }}</span>
                                </div>
                            </section>

                            <section class="feature-search-diagnostics-section">
                                <div class="feature-search-values-heading">
                                    <h3>Values</h3>
                                    @if (valueSummaryWaitingForIngress()) {
                                        <span class="feature-search-values-waiting">{{ valueSummaryWaitLabel() }}</span>
                                    } @else if (valueSummaries.status === 'idle') {
                                        <p-button size="small" label="Load" severity="secondary"
                                                  (onClick)="requestDiagnosticsValueSummaries()"/>
                                    }
                                </div>
                                @if (valueSummaries.status === 'loading') {
                                    <div class="feature-search-values-loading">
                                        <p-progress-spinner strokeWidth="10" fill="transparent" animationDuration=".7s"
                                                            [style]="{ width: '1.2em', height: '1.2em', margin: '0' }"/>
                                        <span>Summarizing {{ valueSummaries.processedTiles }} / {{ valueSummaries.totalTiles }} result tiles...</span>
                                    </div>
                                } @else if (valueSummaries.status === 'error') {
                                    <div class="feature-search-values-empty">
                                        Failed to summarize values.
                                        <pre *ngIf="valueSummaries.error">{{ valueSummaries.error }}</pre>
                                    </div>
                                } @else if (valueSummaries.status === 'empty') {
                                    <div class="feature-search-values-empty">No withFields or trace values available.</div>
                                } @else if (valueSummaries.status === 'ready') {
                                    @if (diagnosticsVisibleResultFields().length === 0 && valueSummaries.traces.length === 0) {
                                        <div class="feature-search-values-empty">No user-visible style or trace values available.</div>
                                    } @else {
                                        <div class="feature-search-value-card-grid">
                                            @for (field of diagnosticsVisibleResultFields(); track field.index + ':' + field.expression) {
                                                <article class="feature-search-value-card">
                                                    <header>
                                                        <span>Field</span>
                                                        <code>{{ field.expression }}</code>
                                                    </header>
                                                    <ng-container *ngTemplateOutlet="valueSummaryTemplate; context: {$implicit: field.summary}"/>
                                                </article>
                                            }
                                            @for (trace of valueSummaries.traces; track trace.name) {
                                                <article class="feature-search-value-card">
                                                    <header>
                                                        <span>Trace</span>
                                                        <code>{{ trace.name }}</code>
                                                    </header>
                                                    <div class="feature-search-value-card-meta">
                                                        <span>{{ trace.calls }} calls</span>
                                                        <span>{{ trace.totalus }} &mu;s</span>
                                                    </div>
                                                    <ng-container *ngTemplateOutlet="valueSummaryTemplate; context: {$implicit: trace.summary}"/>
                                                </article>
                                            }
                                        </div>
                                    }
                                }
                            </section>
                        </div>

                        <ng-template #valueSummaryTemplate let-summary>
                            <div class="feature-search-value-summary">
                                <div class="feature-search-value-summary-row">
                                    <span>Samples</span>
                                    <strong>{{ summary.count }}</strong>
                                </div>
                                @if (summary.numeric) {
                                    <div class="feature-search-value-summary-row">
                                        <span>Numeric</span>
                                        <strong>{{ numericSummaryLabel(summary) }}</strong>
                                    </div>
                                }
                                <div class="feature-search-value-kind-list">
                                    @for (entry of summaryKindEntries(summary); track entry.label) {
                                        <span>{{ entry.label }} {{ entry.count }}</span>
                                    }
                                </div>
                                @if (summary.histogram.length > 0) {
                                    <div class="feature-search-value-histogram">
                                        @for (bucket of visibleHistogramBuckets(summary); track bucket.value) {
                                            <div>
                                                <span>{{ bucket.value }}</span>
                                                <strong>{{ bucket.count }}</strong>
                                            </div>
                                        }
                                        @if (summary.otherCount > 0 || summary.distinctLimitReached) {
                                            <div>
                                                <span>Other</span>
                                                <strong>{{ summary.otherCount }}{{ summary.distinctLimitReached ? '+' : '' }}</strong>
                                            </div>
                                        }
                                    </div>
                                }
                            </div>
                        </ng-template>
                    </p-tabpanel>
                </p-tabpanels>
            </p-tabs>
            </div>
        </ng-template>
        <app-confirm-popup [key]="bookmarkedCloseConfirmKey"
                           styleClass="feature-search-close-confirm-popup">
            <ng-template #extraActions>
                <p-button label="Export"
                          size="small"
                          severity="secondary"
                          [outlined]="true"
                          (click)="exportBookmarkedCloseSearch()">
                </p-button>
            </ng-template>
        </app-confirm-popup>
        <search-style-save-dialog
            [visible]="searchStyleSaveVisible"
            (visibleChange)="onSearchStyleSaveVisibleChange($event)"
            [layerIds]="searchStyleSaveLayerIds"
            [initialLayerIds]="searchStyleSaveInitialLayerIds"
            [saving]="searchStyleSavePending"
            (saveRequested)="confirmSearchStyleSave($event)">
        </search-style-save-dialog>
        <div #alert></div>
    `,
    standalone: false
})
/**
 * Dialog that presents long-running feature-search progress, result grouping, styles, and diagnostics.
 */
export class FeatureSearchComponent implements AfterViewInit, OnChanges, OnDestroy {
    @Input({required: true}) searchId!: string;
    @Input() dockedPanelCount = 1;
    @Output() panelDragRequest = new EventEmitter<{session: FeatureSearchSession, event: PointerEvent}>();

    session?: FeatureSearchSession;
    private readonly subscriptions = new Subscription();
    featureSearchDialogVisible = true;
    diagnostics: Array<DiagnosticsMessage> = [];
    valueSummaries: SearchValueSummariesState = this.emptyValueSummariesState();
    percentDone: number = 0;
    resultTileIngressPercent: number = 0;
    resultTreeIngressPercent: number = 0;
    progressMeterItems: MeterItem[] = [];
    totalTiles: number = 0;
    doneTiles: number = 0;
    resultTileIngressDone: number = 0;
    resultTileIngressTotal: number = 0;
    resultTreeIngressDone: number = 0;
    resultTreeIngressTotal: number = 0;
    progressDisplayPercent = 0;
    progressLabel = "Preparing search...";
    progressTooltip = "";
    canStopSearch: boolean = false;
    results: FeatureSearchResultEntry[] = [];
    resultCount = 0;
    searchTimeElapsed = "0ms";
    searchTotalFeatureCount = 0;
    resultsTree: TreeNode[] = [];
    grouping: FeatureSearchGroupingOption[] = [
        {name: 'Maps', value: 1},
        {name: 'Layers', value: 2},
        {name: 'Features', value: 3},
        {name: 'Tiles', value: 4}
    ];
    selectedGroupingOptions: FeatureSearchGroupingOption[] = [];
    styleAttributeOptions: FeatureSearchStyleOption[] = [];
    styleScalarAttributeOptions: FeatureSearchStyleOption[] = [];
    styleAttributeOptionsLoading = false;
    mapLayerTreeOptions: TreeNode<FeatureSearchLayerTreeNodeData>[] = [];
    selectedMapLayerTreeNodes: TreeNode<FeatureSearchLayerTreeNodeData>[] = [];
    featureSearchFeatureTypeOptions: FeatureSearchFeatureTypeOption[] = [];
    selectedFeatureTypes: string[] = [];
    featureSearchTileLevelOptions: FeatureSearchTileLevelOption[] = [];
    selectedTileLevels: number[] = [...DEFAULT_FEATURE_SEARCH_TILE_LEVELS];
    featureSearchViewOptions: FeatureSearchViewOption[] = [];
    selectedViewIndices: number[] = [];
    styleOperatorOptions: FeatureSearchStyleOption[] = [
        {label: '>', value: '>'},
        {label: '>=', value: '>='},
        {label: '=', value: '='},
        {label: '!=', value: '!='},
        {label: '<=', value: '<='},
        {label: '<', value: '<'},
        {label: 'contains', value: 'contains'}
    ];
    private nextStyleRuleId = 1;
    private nextStyleConditionId = 1;
    private nextStyleColorStopId = 1;
    styleRuleDrafts: FeatureSearchStyleRuleDraft[] = [];
    styleRuleAccordionValue: string[] = [];
    searchStyleOptions: FeatureSearchSavedStyleOption[] = [];
    selectedSearchStyleId: string | null = null;
    searchStyleApplicationMessage = "";
    searchStyleApplicationWarning = false;
    protected searchStyleSaveVisible = false;
    protected searchStyleSavePending = false;
    protected searchStyleSaveLayerIds: string[] = [];
    protected searchStyleSaveInitialLayerIds: string[] = [];
    private pendingSearchStyleRules: FeatureSearchStyleRule[] = [];
    protected readonly featureSearchColorPickerOverlayOptions: OverlayOptions = {
        styleClass: "feature-search-colorpicker-overlay"
    };
    private styleRulesStateSignature = "";
    private readonly styleRuleDraftCodec = new SearchStyleRuleDraftCodec();
    private staticSessionSyncSignature = "";
    protected readonly valueSummaryForStyleExpressionCallback = (expression: string) =>
        this.valueSummaryForStyleExpression(expression);

    // Active result panel index
    resultPanelIndex: string = "results";

    showFilter: boolean = false;
    resultsStatus: string = "Loading...";
    scrollHeight: string = "28.5em";
    featureSearchExpanded = false;
    featureSearchQuery = "";
    featureSearchQueryDirty = false;
    featureSearchQueryExpanded = false;
    featureSearchCompletionOwnerId = "";
    featureSearchCompletionZIndex = 30050;
    featureSearchScope: FeatureSearchScope = 'auto';
    featureSearchScopeSummary = "";
    featureSearchScopeSummaryTitle = "";
    featureSearchScopeOptions: FeatureSearchScopeOption[] = [
        {label: 'Auto', value: 'auto'},
        {label: 'Attribute', value: 'attribute'},
        {label: 'Feature', value: 'feature'}
    ];
    private lastSearchQuery = "";
    private activeSearchGroupId = "";
    private completedSearchGroupId = "";
    private lastErrorAlertSignature = "";
    private surfacedDockedSearchId = "";
    private resultTreeInputLength = 0;
    private resultTreeGroupingSignature = "";
    private resultTreeRunId = "";
    private resultTreeAutoExpandedSignature = "";
    private resultTreeFilterValue = "";
    private resultTreeGroupNodesByKey = new Map<string, TreeNode>();
    private resultTreeAppendRaf: number | null = null;
    private closingSearchId: string | null = null;
    private readonly resultTreeAppendBatchSize = 1000;
    private readonly resultTreeAppendFrameBudgetMs = 8;
    private readonly progressPhaseWeights = {
        search: 70,
        ingress: 20,
        tree: 10
    };
    private styleAttributeOptionsSessionSignature = "";
    private styleAttributeOptionsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private styleAttributeOptionsRefreshPatchMissing = false;
    private readonly autoStyleRuleAttemptSignatures = new Set<string>();
    private mapLayerTreeOptionsSignature = "";
    // PrimeNG supports null at runtime to disable tree selection, but its TreeSelect type excludes it.
    protected readonly mapLayerTreeSelectionMode = null as unknown as "single";
    private mapLayerTreeSelectionState = new Map<string, FeatureSearchLayerTreeNodeSelectionState>();
    private mapLayerTreeExpandedKeys = new Set<string>();
    private mapLayerTreeExpansionInitialized = false;
    private selectedMapLayersSignature = "";
    private selectedSearchMapLayersCacheSignature = "";
    private selectedSearchMapLayersCache: FeatureSearchMapLayerRef[] = [];
    private initializedMapLayerSelectionSessionId = "";
    private featureSearchFeatureTypeOptionsSignature = "";
    private selectedFeatureTypesSignature = "";
    private searchTileLevelOptionsSignature = "";
    private selectedTileLevelsSignature = "";
    private searchViewOptionsSignature = "";
    private selectedViewIndicesSignature = "";
    private pendingBookmarkedCloseSessionId: string | null = null;
    private featureSearchHeaderActionsSignature = "";
    private featureSearchHeaderActionsCache: AppSurfaceHeaderAction[] = [];
    private sessionSyncTimer: ReturnType<typeof setTimeout> | null = null;
    private progressDisplayRefreshQueued = false;
    private pendingProgressDisplaySession?: FeatureSearchSession;
    private destroyed = false;
    private resizeObserver?: ResizeObserver;
    private treeScrollHeightRaf?: number;
    protected readonly measurePreferredFeatureSearchHeightEm = () => this.measurePreferredBodyHeightEm();

    @ViewChild('alert', { read: ViewContainerRef, static: true }) alertContainer!: ViewContainerRef;
    @ViewChild('tree') tree!: Tree;
    @ViewChild('featureSearchContentContainer') featureSearchContentContainer?: ElementRef<HTMLElement>;
    @ViewChild('featureSearchTreeHost') featureSearchTreeHost?: ElementRef<HTMLElement>;
    @ViewChild('featureSearchQueryInput') featureSearchQueryInput?: SimfilExpressionInputComponent;
    @ViewChild('featureSearchDialog') featureSearchDialog: AppDialogComponent | undefined;
    @ViewChild('featureSearchPanel') featureSearchPanel: AppPanelComponent | undefined;

    /**
     * Subscribes to search progress and keeps the dialog state synchronized with the active search.
     */
    constructor(public searchService: FeatureSearchService,
                public jumpService: JumpTargetService,
                public mapService: MapInfoService,
                private readonly searchSchema: FeatureSearchSchemaService,
                private readonly styleService: StyleService,
                private readonly styleEditorRequestService: StyleEditorRequestService,
                private readonly inspectionSelection: InspectionSelectionService,
                public stateService: AppStateService,
                private infoMessageService: InfoMessageService,
                private dialogStack: DialogStackService,
                private confirmPopupService: AppConfirmPopupService,
                private readonly changeDetector: ChangeDetectorRef,
                private readonly ngZone: NgZone) {
        this.selectedGroupingOptions = this.groupingOptionsFromValues(this.stateService.featureSearchGrouping);
        this.subscriptions.add(this.styleService.styleGroups.subscribe(() => this.refreshSearchStyleOptions()));
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
            this.scheduleSessionSync();
        }));
        this.subscriptions.add(this.searchService.sessionsChanged.subscribe(() => {
            this.scheduleSessionSync();
        }));
        this.subscriptions.add(this.mapService.maps$.subscribe(() => {
            this.styleAttributeOptionsSessionSignature = "";
            this.refreshMapLayerTreeOptions();
            this.refreshSearchFeatureTypeOptions(this.session);
            this.refreshSearchTileLevelOptions(this.session);
            if (this.session) {
                this.refreshFeatureSearchScopeSummary(this.session);
                this.refreshStyleAttributeOptionsIfNeeded(this.session);
                this.syncMapLayerTreeSelection(this.session);
                this.syncSelectedFeatureTypesFromSession(this.session);
                this.syncSelectedTileLevelsFromSession(this.session);
            }
        }));
        this.subscriptions.add(this.stateService.numViewsState.subscribe(() => {
            this.refreshSearchViewOptions();
            if (this.session) {
                this.syncSelectedViewIndicesFromSession(this.session);
            }
        }));
    }

    /** Returns a blank Diagnostics/Values state for sessions without computed summaries yet. */
    private emptyValueSummariesState(): SearchValueSummariesState {
        return {
            status: "idle",
            revision: 0,
            processedTiles: 0,
            totalTiles: 0,
            resultFields: [],
            traces: []
        };
    }

    /** Number shown in the Diagnostics tab badge. */
    protected diagnosticsBadgeCount(): number {
        return this.diagnostics.length;
    }

    /** Starts lazy value-summary loading for the active search session. */
    protected requestDiagnosticsValueSummaries(): void {
        if (this.session) {
            this.searchService.requestValueSummaries(this.session.id);
        }
    }

    /** Returns value-summary fields that represent user-facing style/trace expressions, not internal selectors. */
    protected diagnosticsVisibleResultFields(): SearchResultFieldValueSummary[] {
        if (this.valueSummaries.status !== "ready") {
            return [];
        }
        return this.valueSummaries.resultFields.filter(field =>
            !this.isInternalSearchResultField(field.expression) || this.userStyleRulesReferenceField(field.expression));
    }

    /** Internal attribute-overlay fields are useful for search transport but noisy in the diagnostics UI. */
    private isInternalSearchResultField(expression: string): boolean {
        return INTERNAL_SEARCH_RESULT_FIELDS.has(expression.trim());
    }

    /** Keep an internal field visible if the user explicitly referenced it in a non-generated style rule. */
    private userStyleRulesReferenceField(expression: string): boolean {
        const trimmedExpression = expression.trim();
        return (this.session?.definition.searchStyleRules ?? []).some(rule => {
            if (rule.autoGenerated) {
                return false;
            }
            const colorField = rule.color.mode === "gradient" || rule.color.mode === "categories"
                ? rule.color.field.trim()
                : "";
            const labelField = rule.geometry.length === 1 && rule.geometry[0] === "label"
                ? (rule.labelExpression ?? "").trim()
                : "";
            const filterFields = (rule.filter ?? []).map(filter => filter.field.trim());
            return [colorField, labelField, ...filterFields].includes(trimmedExpression);
        });
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

    /** Lets style controls lazily trigger the same value aggregation used by Diagnostics/Values. */
    protected onStyleColorDataUpdateRequested(): void {
        this.requestDiagnosticsValueSummaries();
    }

    /** Returns whether Values must wait for result-tile ingress before native aggregation can start. */
    protected valueSummaryWaitingForIngress(): boolean {
        return !!this.session && !this.session.complete;
    }

    /** Human-readable wait label for deferred value summaries. */
    protected valueSummaryWaitLabel(): string {
        const total = this.resultTileIngressTotal || this.totalTiles;
        if (this.resultTileIngressDone < total) {
            return `Waiting for result chunks: ${this.resultTileIngressDone} / ${total} ingested.`;
        }
        return "Waiting for backend search to finish.";
    }

    /** Compact numeric summary label used in value cards. */
    protected numericSummaryLabel(summary: SearchValueSummary): string {
        if (!summary.numeric) {
            return "";
        }
        return `min ${this.formatSummaryNumber(summary.numeric.min)}, `
            + `max ${this.formatSummaryNumber(summary.numeric.max)}, `
            + `avg ${this.formatSummaryNumber(summary.numeric.average)}`;
    }

    /** Returns non-zero kind counters in display order. */
    protected summaryKindEntries(summary: SearchValueSummary): Array<{label: string; count: number}> {
        return [
            {label: "int", count: summary.kinds.integer},
            {label: "number", count: summary.kinds.number},
            {label: "bool", count: summary.kinds.boolean},
            {label: "string", count: summary.kinds.string},
            {label: "object", count: summary.kinds.object},
            {label: "list", count: summary.kinds.list},
            {label: "blob", count: summary.kinds.blob},
            {label: "null", count: summary.nulls},
            {label: "missing", count: summary.missing},
            {label: "unknown", count: summary.kinds.unknown}
        ].filter(entry => entry.count > 0);
    }

    /** Limits per-card histogram rows to keep dense searches readable. */
    protected visibleHistogramBuckets(summary: SearchValueSummary): Array<{value: string; count: number}> {
        return summary.histogram.slice(0, 8);
    }

    /** Formats summary numbers without losing obvious integer values. */
    private formatSummaryNumber(value: number): string {
        if (!Number.isFinite(value)) {
            return String(value);
        }
        if (Number.isInteger(value)) {
            return String(value);
        }
        return value.toLocaleString(undefined, {maximumFractionDigits: 3});
    }

    /** Converts a done/total pair into a clamped progress percentage. */
    private progressPercent(done: number, total: number): number {
        if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) {
            return 0;
        }
        return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    }

    /** Scales one phase completion percentage to its visual share in the metered progress bar. */
    private progressPhaseValue(percent: number, share: number): number {
        return Math.max(0, Math.min(share, (percent / 100) * share));
    }

    /** Updates the compact multi-phase progress display from the current session and tree state. */
    private refreshProgressDisplay(session: FeatureSearchSession): void {
        this.percentDone = this.progressPercent(session.progressDone, session.progressTotal);
        this.totalTiles = session.progressTotal;
        this.doneTiles = session.progressDone;
        this.resultTileIngressDone = session.resultTileIngressDone;
        this.resultTileIngressTotal = session.resultTileIngressTotal;
        this.resultTileIngressPercent = this.progressPercent(
            session.resultTileIngressDone,
            session.resultTileIngressTotal || session.progressTotal
        );
        this.refreshResultTreeIngressProgress(session);
        const ingressPercent = this.resultTileIngressTotal > 0
            ? this.resultTileIngressPercent
            : (session.backendComplete ? 100 : 0);
        const treePercent = this.resultTreeIngressTotal > 0
            ? this.resultTreeIngressPercent
            : (session.complete ? 100 : 0);
        this.progressMeterItems = session.complete
            ? [{label: "Complete", value: 100, color: "var(--p-primary-color)"}]
            : [
                {
                    label: "Search",
                    value: this.progressPhaseValue(this.percentDone, this.progressPhaseWeights.search),
                    color: "var(--p-blue-500)"
                },
                {
                    label: "Ingress",
                    value: this.progressPhaseValue(ingressPercent, this.progressPhaseWeights.ingress),
                    color: "var(--p-cyan-500)"
                },
                {
                    label: "Result tree",
                    value: this.progressPhaseValue(treePercent, this.progressPhaseWeights.tree),
                    color: "var(--p-primary-color)"
                }
            ].filter(item => (item.value ?? 0) > 0);
        this.progressDisplayPercent = session.complete
            ? 100
            : Math.round(this.progressMeterItems.reduce((sum, item) => sum + Number(item.value ?? 0), 0));
        const tileTotal = this.resultTileIngressTotal || this.totalTiles;
        const treeSuffix = this.resultTreeIngressTotal > 0 && this.resultTreeIngressDone < this.resultTreeIngressTotal
            ? `, tree ${this.resultTreeIngressDone}/${this.resultTreeIngressTotal}`
            : "";
        this.progressLabel = session.complete
            ? `Complete, ${this.doneTiles}/${this.totalTiles} tiles`
            : `Search ${this.doneTiles}/${this.totalTiles}, ingress ${this.resultTileIngressDone}/${tileTotal} chunks${treeSuffix}`;
        this.progressTooltip = [
            `Search backend: ${this.doneTiles} / ${this.totalTiles} tiles`,
            `Result chunk ingress: ${this.resultTileIngressDone} / ${tileTotal} chunks`,
            `Result tree: ${this.resultTreeIngressDone} / ${this.resultTreeIngressTotal} entries`
        ].join("\n");
    }

    /**
     * Publishes all template-visible progress fields after the current Angular check.
     *
     * Search ingress and result-tree assembly can both request a refresh during one
     * turn. Coalescing here keeps the meter, label, and tooltip on one session
     * snapshot and prevents a late child lifecycle hook from changing one of these
     * bindings between Angular's check and check-no-changes passes.
     */
    private scheduleProgressDisplayRefresh(session: FeatureSearchSession): void {
        this.pendingProgressDisplaySession = session;
        if (this.progressDisplayRefreshQueued) {
            return;
        }
        this.progressDisplayRefreshQueued = true;
        queueMicrotask(() => {
            this.progressDisplayRefreshQueued = false;
            const pendingSession = this.pendingProgressDisplaySession;
            this.pendingProgressDisplaySession = undefined;
            if (this.destroyed || !pendingSession || pendingSession !== this.session) {
                return;
            }
            this.ngZone.run(() => {
                if (this.destroyed || pendingSession !== this.session) {
                    return;
                }
                this.refreshProgressDisplay(pendingSession);
                this.changeDetector.markForCheck();
            });
        });
    }

    /** Tracks how far the PrimeNG result tree has consumed the streamed result array. */
    private refreshResultTreeIngressProgress(session: FeatureSearchSession): void {
        this.resultTreeIngressTotal = session.searchResults.length;
        this.resultTreeIngressDone = Math.min(this.resultTreeInputLength, this.resultTreeIngressTotal);
        this.resultTreeIngressPercent = this.resultTreeIngressTotal > 0
            ? this.progressPercent(this.resultTreeIngressDone, this.resultTreeIngressTotal)
            : this.resultTileIngressPercent;
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

    /** Limits automatic defaults to fields that belong to the resolved query scope. */
    private defaultStyleFieldOptionsForSession(session: FeatureSearchSession | undefined): FeatureSearchStyleOption[] {
        return defaultSearchStyleFieldOptionsForAnalysis(
            this.styleScalarAttributeOptions,
            session?.schemaAnalysis);
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

    private isScalarStyleField(option: FeatureSearchStyleOption): boolean {
        return option.valueKind !== "object" && option.valueKind !== "array";
    }

    protected filterFieldIsNumeric(filter: FeatureSearchStyleFilterDraft): boolean {
        return isNumericStyleValueKind(this.styleFieldOption(filter.attributeField)?.valueKind);
    }

    protected filterFieldEnumOptions(filter: FeatureSearchStyleFilterDraft): Array<{label: string; value: string}> {
        return (this.styleFieldOption(filter.attributeField)?.enumValues ?? []).map(value => ({label: value, value}));
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

    /** Refreshes the compact scope label from the same schema metadata used by the style field picker. */
    private refreshFeatureSearchScopeSummary(session: FeatureSearchSession): void {
        const analysis = session.schemaAnalysis;
        if (analysis.status === "pending") {
            this.featureSearchScopeSummary = "Auto: resolving scope...";
            this.featureSearchScopeSummaryTitle = "Schema analysis is running in the background.";
            return;
        }
        if (analysis.rewriteSuppressed) {
            const scopeLabel = analysis.concreteScope === "attribute"
                ? "attribute scope"
                : "feature scope";
            this.featureSearchScopeSummary = session.definition.scope === "auto"
                ? `Auto: ${scopeLabel}, generic query`
                : `${scopeLabel[0].toUpperCase()}${scopeLabel.slice(1)}, generic query`;
            this.featureSearchScopeSummaryTitle = analysis.rewriteSuppressionReason
                || "Schema analysis found too many attribute contexts for a specific guarded rewrite.";
            return;
        }
        if (analysis.attributeScopes.length > 0) {
            this.featureSearchScopeSummary = this.attributeScopeSummaryLabel(
                session.definition.scope,
                analysis.attributeScopes
            );
            this.featureSearchScopeSummaryTitle = this.attributeScopeSummaryTitle(analysis.attributeScopes);
            return;
        }
        if (analysis.concreteScope === "attribute") {
            this.featureSearchScopeSummary = session.definition.scope === "auto"
                ? "Auto: attribute scope"
                : "Attribute scope";
            this.featureSearchScopeSummaryTitle =
                "Search runs over attribute-level fields; no narrower attribute set was inferred.";
            return;
        }
        this.featureSearchScopeSummary = session.definition.scope === "auto"
            ? "Auto: feature scope"
            : "Feature scope";
        this.featureSearchScopeSummaryTitle = analysis.error
            ? analysis.error
            : "Search runs over feature-level fields.";
    }

    /** Updates the scope label for an edited query before it has been submitted for schema analysis. */
    private updateDraftFeatureSearchScopeSummary(scope: FeatureSearchScope): void {
        if (scope === "feature") {
            this.featureSearchScopeSummary = "Feature scope";
            this.featureSearchScopeSummaryTitle = "Search runs over feature-level fields.";
            return;
        }
        if (scope === "attribute") {
            this.featureSearchScopeSummary = "Attribute scope";
            this.featureSearchScopeSummaryTitle = "Search will run over attribute-level fields.";
            return;
        }
        this.featureSearchScopeSummary = "Auto: pending";
        this.featureSearchScopeSummaryTitle = "Auto scope will be resolved when the edited query is run.";
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
        this.styleRuleAccordionValue = [panelValue];
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
        this.stateService.patchFeatureSearch(session.id, {searchStyleRules});
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
                return {label: style.id, value: style.id, disabled, summary, projection};
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
            this.refreshSearchStyleOptions();
            return;
        }
        let projection: SearchStyleApplicationProjection;
        try {
            projection = this.searchStyleOptions.find(option => option.value === styleId)?.projection
                ?? projectStyleSourceForSearch(style.source, this.resolvedStyleSearchScope());
        } catch (error) {
            this.infoMessageService.showError(error instanceof Error ? error.message : String(error));
            this.refreshSearchStyleOptions();
            return;
        }
        if (!projection.rules.length) {
            this.infoMessageService.showError("This stylesheet has no rules compatible with the current search scope and rules GUI.");
            this.refreshSearchStyleOptions();
            return;
        }
        const detachedRules = structuredClone(projection.rules);
        this.styleRuleDrafts = this.styleRuleDraftCodec.toDrafts(detachedRules);
        this.styleRulesStateSignature = JSON.stringify(detachedRules);
        this.stateService.patchFeatureSearch(this.session.id, {searchStyleRules: detachedRules});
        this.selectedSearchStyleId = styleId;
        this.searchStyleApplicationWarning = projection.omissions.length > 0;
        this.searchStyleApplicationMessage = projection.omissions.length
            ? `Applied ${projection.rules.length} of ${projection.totalRuleCount} rules. Omitted ${projection.omissions.map(item => item.message).join(" ")}`
            : `Applied all ${projection.rules.length} rules from “${style.id}” as a detached copy.`;
    }

    /** Opens the AppDialog with an immutable snapshot of the current high-fidelity rules. */
    protected saveSearchStyle(): void {
        const rules = this.serializeStyleRuleDrafts();
        if (!rules.length) {
            this.infoMessageService.showError("Add at least one high-fidelity rule before saving a search stylesheet.");
            return;
        }
        this.pendingSearchStyleRules = structuredClone(rules);
        this.searchStyleSaveLayerIds = Array.from(new Set(
            Array.from(this.mapService.maps.allFeatureLayers(), layer => layer.id)
                .filter(layerId => layerId.length > 0)
        )).sort();
        this.searchStyleSaveInitialLayerIds = Array.from(new Set(
            this.selectedSearchMapLayers().map(layer => layer.layerId)
        )).sort();
        this.searchStyleSaveVisible = true;
    }

    /** Persists one dialog payload through the ordinary transactional style import path. */
    protected confirmSearchStyleSave(request: Readonly<SearchStyleSaveRequest>): void {
        if (this.searchStyleSavePending || !this.searchStyleSaveVisible) {
            return;
        }
        const {options, action} = request;
        const conflict = this.styleService.styleIdentityConflict(options.name);
        if (conflict) {
            this.infoMessageService.showError(
                `A style named or resolved by “${options.name}” already exists. Edit that style or choose another name.`);
            return;
        }
        this.searchStyleSavePending = true;
        try {
            const generated = convertSearchStyleRulesToYaml(options, this.pendingSearchStyleRules);
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
            this.pendingSearchStyleRules = [];
            if (action === "save-and-open") {
                queueMicrotask(() => this.styleEditorRequestService.open(importedStyleId));
            }
        } catch (error) {
            this.infoMessageService.showError(error instanceof Error ? error.message : String(error));
        } finally {
            this.searchStyleSavePending = false;
        }
    }

    protected onSearchStyleSaveVisibleChange(visible: boolean): void {
        this.searchStyleSaveVisible = visible;
        if (!visible && !this.searchStyleSavePending) {
            this.pendingSearchStyleRules = [];
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
        const renderStrategy: FeatureSearchRenderStrategy = {...this.searchRenderStrategy()};
        renderStrategy[key] = nextValue;
        if (key === "showHighFiGeometry" && nextValue === false) {
            renderStrategy.showHighFiResultDots = false;
        }
        this.stateService.patchFeatureSearch(session.id, {
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

    /** Serializes drafts through the same lossless adapter used by the standalone editor. */
    private serializeStyleRuleDrafts(): FeatureSearchStyleRule[] {
        this.styleRuleDraftCodec.setFieldOptions(this.styleScalarAttributeOptions);
        return this.styleRuleDraftCodec.fromDrafts(this.styleRuleDrafts);
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
            if (signature !== this.styleAttributeOptionsSessionSignature) {
                return;
            }
            const currentSession = this.session?.id === session.id
                ? this.session
                : this.searchService.getSession(session.id);
            if (!currentSession) {
                this.styleAttributeOptionsLoading = false;
                return;
            }
            this.applyStyleAttributeOptions(currentSession, rawOptions, patchMissingFields);
        });
    }

    /** Applies worker-produced schema field candidates to the style-field dropdowns. */
    private applyStyleAttributeOptions(
        session: FeatureSearchSession,
        rawOptions: FeatureSearchStyleFieldCandidate[],
        patchMissingFields: boolean
    ): void {
        const activeOptions = rawOptions.filter(option => this.isStyleFieldCandidateActive(option.mapId, option.layerId));
        const sourceOptions = activeOptions.length ? activeOptions : rawOptions;
        const byValue = new Map<string, {option: FeatureSearchStyleOption, contexts: Set<string>}>();
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
                : {...source.numericRange};
        }
        if (target.featureType !== source.featureType) {
            // A shared path across feature types cannot use one portable type
            // guard; retain no misleading source-specific discriminator.
            target.featureType = undefined;
        }
        const mapLayers = target.mapLayers ?? [];
        if (!mapLayers.some(ref =>
            ref.mapId === source.mapId &&
            ref.layerId === source.layerId)) {
            mapLayers.push({mapId: source.mapId, layerId: source.layerId});
            mapLayers.sort((left, right) =>
                left.mapId.localeCompare(right.mapId) ||
                left.layerId.localeCompare(right.layerId));
        }
        target.mapLayers = mapLayers;
    }

    /** Keeps attribute fields separate by semantic attribute, while still merging the same attribute across layers. */
    private searchStyleFieldAggregationKey(option: FeatureSearchStyleFieldCandidate): string {
        return option.attrName
            ? [
                option.path,
                option.attrName,
                option.attrLayerName ?? ""
            ].join("\n")
            : option.path;
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
        if (this.resultPanelIndex !== "style"
            && this.styleAttributeOptions.length === 0
            && !this.shouldAttemptAutoStyleRule(session)
            && !this.shouldRefreshAutoStyleRule()) {
            return false;
        }
        const signature = [
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

    /** Uses resolved schema analysis for style fields once available; raw `auto` is only a pending fallback. */
    private styleFieldRequestScope(session: FeatureSearchSession): FeatureSearchScope {
        return session.schemaAnalysis.status === "ready"
            ? session.schemaAnalysis.concreteScope
            : session.definition.scope;
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

    /** Returns whether this session still needs its one-shot automatic style rule attempt. */
    private shouldAttemptAutoStyleRule(session: FeatureSearchSession): boolean {
        return (session.definition.searchStyleRules?.length ?? 0) === 0
            && session.schemaAnalysis.status === "ready"
            && !this.autoStyleRuleAttemptSignatures.has(this.autoStyleRuleAttemptSignature(session));
    }

    /** Signature for the user-visible query scope that an automatic style rule would represent. */
    private autoStyleRuleAttemptSignature(session: FeatureSearchSession): string {
        return [
            session.id,
            session.definition.query,
            session.definition.scope,
            this.selectedSearchMapLayerSignature(session.definition.selectedMapLayers)
        ].join("\n");
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

    /** Selects all schema fields that should get an automatically generated style rule. */
    private autoStyleFieldOptions(session: FeatureSearchSession): FeatureSearchStyleOption[] {
        return searchAutoStyleFieldOptions(this.styleScalarAttributeOptions, session.schemaAnalysis);
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

    /** Keeps generated `$...` overlay fields below native schema fields in dropdowns. */
    private searchStyleFieldSortRank(option: FeatureSearchStyleOption): number {
        return option.value.startsWith("$") ? 1 : 0;
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

    private searchLayerTreeKey(mapId: string, layerId: string): string {
        return `layer:${this.searchLayerKey(mapId, layerId)}`;
    }

    private searchLayerKeyFromTreeNode(node: TreeNode<FeatureSearchLayerTreeNodeData>): string | null {
        return node.data?.kind === "layer" && node.data.mapId && node.data.layerId
            ? this.searchLayerKey(node.data.mapId, node.data.layerId)
            : null;
    }

    private mapLayerTreeNodeForKey(key: string): TreeNode<FeatureSearchLayerTreeNodeData> | null {
        const visit = (
            node: TreeNode<FeatureSearchLayerTreeNodeData>
        ): TreeNode<FeatureSearchLayerTreeNodeData> | null => {
            if (node.key === key) {
                return node;
            }
            for (const child of node.children ?? []) {
                const matched = visit(child as TreeNode<FeatureSearchLayerTreeNodeData>);
                if (matched) {
                    return matched;
                }
            }
            return null;
        };
        for (const node of this.mapLayerTreeOptions) {
            const matched = visit(node);
            if (matched) {
                return matched;
            }
        }
        return null;
    }

    private refreshMapLayerTreeOptions(): void {
        const sourceSignature = this.availableSearchMapLayerSignature();
        if (sourceSignature === this.mapLayerTreeOptionsSignature) {
            return;
        }
        const options = this.mapService.maps.nodes
            .map(node => this.mapTreeNodeToSearchTreeNode(node))
            .filter((node): node is TreeNode<FeatureSearchLayerTreeNodeData> => !!node);
        this.mapLayerTreeOptionsSignature = sourceSignature;
        this.mapLayerTreeOptions = options;
        if (!this.mapLayerTreeExpansionInitialized) {
            this.mapLayerTreeExpandedKeys = this.expandedMapLayerTreeNodeKeys(this.mapLayerTreeOptions);
            this.mapLayerTreeExpansionInitialized = true;
        } else {
            this.applyMapLayerTreeExpandedState(this.mapLayerTreeOptions, this.mapLayerTreeExpandedKeys);
        }
        const selectedKeys = this.selectedMapLayerKeysFromTreeNodes(this.selectedMapLayerTreeNodes);
        this.setSelectedMapLayerTreeLeafKeys(selectedKeys);
    }

    /** Signatures the searchable map/layer set without allocating the PrimeNG tree first. */
    private availableSearchMapLayerSignature(): string {
        const layerKeys: string[] = [];
        for (const [mapId, mapInfo] of this.mapService.maps.maps) {
            for (const layer of mapInfo.allFeatureLayers()) {
                const featureTypeSignature = (layer.info.featureTypes ?? [])
                    .map(featureType => featureType.name)
                    .sort()
                    .join(",");
                layerKeys.push(`${mapId}:${layer.id}:${featureTypeSignature}`);
            }
        }
        return layerKeys.sort().join("|");
    }

    private mapTreeNodeToSearchTreeNode(
        node: GroupTreeNode | MapTreeNode
    ): TreeNode<FeatureSearchLayerTreeNodeData> | null {
        if (node instanceof GroupTreeNode) {
            const children = node.children
                .map(child => this.mapTreeNodeToSearchTreeNode(child))
                .filter((child): child is TreeNode<FeatureSearchLayerTreeNodeData> => !!child);
            if (!children.length) {
                return null;
            }
            return {
                key: `group:${node.key}`,
                label: removeGroupPrefix(node.id),
                data: {kind: "group"},
                expanded: node.expanded,
                children
            };
        }
        const mapLabel = removeGroupPrefix(node.id);
        const children = node.children.map(layer => this.layerTreeNodeToSearchTreeNode(layer, mapLabel));
        if (!children.length) {
            return null;
        }
        return {
            key: `map:${node.key}`,
            label: mapLabel,
            data: {kind: "map", mapId: node.id},
            expanded: node.expanded,
            children
        };
    }

    private layerTreeNodeToSearchTreeNode(
        layer: LayerTreeNode,
        parentLabel: string
    ): TreeNode<FeatureSearchLayerTreeNodeData> {
        return {
            key: this.searchLayerTreeKey(layer.mapId, layer.id),
            label: `${parentLabel}/${layer.id}`,
            data: {
                kind: "layer",
                mapId: layer.mapId,
                layerId: layer.id
            },
            leaf: true
        };
    }

    private selectedMapLayerKeysFromTreeNodes(
        nodes: TreeNode<FeatureSearchLayerTreeNodeData>[] | null | undefined
    ): Set<string> {
        const selectedKeys = new Set<string>();
        const visit = (node: TreeNode<FeatureSearchLayerTreeNodeData>) => {
            const layerKey = this.searchLayerKeyFromTreeNode(node);
            if (layerKey) {
                selectedKeys.add(layerKey);
                return;
            }
            const sourceNode = node.key ? this.mapLayerTreeNodeForKey(node.key) : null;
            if (sourceNode && sourceNode !== node) {
                visit(sourceNode);
                return;
            }
            for (const child of node.children ?? []) {
                visit(child as TreeNode<FeatureSearchLayerTreeNodeData>);
            }
        };
        for (const node of nodes ?? []) {
            visit(node);
        }
        return selectedKeys;
    }

    private selectedMapLayerRefsFromTreeNodes(
        nodes: TreeNode<FeatureSearchLayerTreeNodeData>[] | null | undefined
    ): FeatureSearchMapLayerRef[] {
        const refsByKey = new Map<string, FeatureSearchMapLayerRef>();
        const visit = (node: TreeNode<FeatureSearchLayerTreeNodeData>) => {
            if (node.data?.kind === "layer" && node.data.mapId && node.data.layerId) {
                refsByKey.set(this.searchLayerKey(node.data.mapId, node.data.layerId), {
                    mapId: node.data.mapId,
                    layerId: node.data.layerId
                });
            }
            for (const child of node.children ?? []) {
                visit(child as TreeNode<FeatureSearchLayerTreeNodeData>);
            }
        };
        for (const node of nodes ?? []) {
            visit(node);
        }
        return Array.from(refsByKey.values())
            .sort((lhs, rhs) => lhs.mapId.localeCompare(rhs.mapId) || lhs.layerId.localeCompare(rhs.layerId));
    }

    private selectedMapLayerLabelsFromTreeNodes(
        nodes: TreeNode<FeatureSearchLayerTreeNodeData>[] | null | undefined
    ): string[] {
        const labelsByKey = new Map<string, string>();
        const visit = (node: TreeNode<FeatureSearchLayerTreeNodeData>) => {
            const layerKey = this.searchLayerKeyFromTreeNode(node);
            if (layerKey) {
                labelsByKey.set(layerKey, node.label ?? layerKey);
            }
            for (const child of node.children ?? []) {
                visit(child as TreeNode<FeatureSearchLayerTreeNodeData>);
            }
        };
        for (const node of nodes ?? []) {
            visit(node);
        }
        return Array.from(labelsByKey.entries())
            .sort((lhs, rhs) => lhs[0].localeCompare(rhs[0]))
            .map(([, label]) => label);
    }

    protected selectedMapLayerTreeValueLabel(
        nodes: TreeNode<FeatureSearchLayerTreeNodeData>[] | null | undefined,
        placeholder?: string
    ): string {
        const labels = this.selectedMapLayerLabelsFromTreeNodes(nodes);
        return labels.length ? labels.join(", ") : placeholder || "No layers selected";
    }

    private setSelectedMapLayerTreeLeafKeys(
        selectedKeys: Set<string>,
        expandedKeys = this.expandedMapLayerTreeNodeKeys(this.mapLayerTreeOptions)
    ): void {
        this.mapLayerTreeExpandedKeys = expandedKeys;
        this.mapLayerTreeExpansionInitialized = true;
        this.mapLayerTreeOptions = this.cloneMapLayerTreeNodes(this.mapLayerTreeOptions);
        this.applyMapLayerTreeExpandedState(this.mapLayerTreeOptions, expandedKeys);
        this.selectedMapLayerTreeNodes = this.mapLayerTreeSelectionForLeafKeys(selectedKeys);
    }

    private cloneMapLayerTreeNodes(
        nodes: TreeNode<FeatureSearchLayerTreeNodeData>[] | null | undefined
    ): TreeNode<FeatureSearchLayerTreeNodeData>[] {
        return (nodes ?? []).map(node => ({
            ...node,
            parent: undefined,
            children: node.children
                ? this.cloneMapLayerTreeNodes(node.children as TreeNode<FeatureSearchLayerTreeNodeData>[])
                : undefined
        }));
    }

    private mapLayerTreeSelectionForLeafKeys(
        selectedKeys: Set<string>
    ): TreeNode<FeatureSearchLayerTreeNodeData>[] {
        const selectedNodes: TreeNode<FeatureSearchLayerTreeNodeData>[] = [];
        this.mapLayerTreeSelectionState = this.mapLayerTreeSelectionStateByNodeKey(selectedKeys);
        this.collectSelectedMapLayerLeafNodes(this.mapLayerTreeOptions, selectedKeys, selectedNodes);
        return selectedNodes;
    }

    private collectSelectedMapLayerLeafNodes(
        nodes: TreeNode<FeatureSearchLayerTreeNodeData>[] | null | undefined,
        selectedKeys: Set<string>,
        selectedNodes: TreeNode<FeatureSearchLayerTreeNodeData>[]
    ): void {
        const visit = (node: TreeNode<FeatureSearchLayerTreeNodeData>) => {
            const layerKey = this.searchLayerKeyFromTreeNode(node);
            if (layerKey) {
                if (selectedKeys.has(layerKey)) {
                    selectedNodes.push(node);
                }
                return;
            }
            for (const child of node.children ?? []) {
                visit(child as TreeNode<FeatureSearchLayerTreeNodeData>);
            }
        };
        for (const node of nodes ?? []) {
            visit(node);
        }
    }

    private mapLayerTreeSelectionStateByNodeKey(
        selectedKeys: Set<string>
    ): Map<string, FeatureSearchLayerTreeNodeSelectionState> {
        const stateByNodeKey = new Map<string, FeatureSearchLayerTreeNodeSelectionState>();
        const visit = (node: TreeNode<FeatureSearchLayerTreeNodeData>): {selected: number; total: number} => {
            const layerKey = this.searchLayerKeyFromTreeNode(node);
            if (layerKey) {
                const selected = selectedKeys.has(layerKey);
                const state = {
                    selectedLeafCount: selected ? 1 : 0,
                    totalLeafCount: 1,
                    checked: selected,
                    partial: false
                };
                if (node.key) {
                    stateByNodeKey.set(node.key, state);
                }
                return {selected: selected ? 1 : 0, total: 1};
            }
            let selected = 0;
            let total = 0;
            for (const child of node.children ?? []) {
                const childState = visit(child as TreeNode<FeatureSearchLayerTreeNodeData>);
                selected += childState.selected;
                total += childState.total;
            }
            if (node.key) {
                stateByNodeKey.set(node.key, {
                    selectedLeafCount: selected,
                    totalLeafCount: total,
                    checked: total > 0 && selected === total,
                    partial: selected > 0 && selected < total
                });
            }
            return {selected, total};
        };
        for (const node of this.mapLayerTreeOptions) {
            visit(node);
        }
        return stateByNodeKey;
    }

    private mapLayerTreeSelectionStateForNode(
        node: TreeNode<FeatureSearchLayerTreeNodeData>
    ): FeatureSearchLayerTreeNodeSelectionState | undefined {
        return node.key ? this.mapLayerTreeSelectionState.get(node.key) : undefined;
    }

    protected isSearchMapLayerTreeNodeChecked(node: TreeNode<FeatureSearchLayerTreeNodeData>): boolean {
        return this.mapLayerTreeSelectionStateForNode(node)?.checked ?? false;
    }

    protected isSearchMapLayerTreeNodePartial(node: TreeNode<FeatureSearchLayerTreeNodeData>): boolean {
        return this.mapLayerTreeSelectionStateForNode(node)?.partial ?? false;
    }

    private mapLayerTreeLeafKeysForNode(
        node: TreeNode<FeatureSearchLayerTreeNodeData>
    ): Set<string> {
        const sourceNode = node.key ? this.mapLayerTreeNodeForKey(node.key) ?? node : node;
        const leafKeys = new Set<string>();
        const visit = (candidate: TreeNode<FeatureSearchLayerTreeNodeData>) => {
            const layerKey = this.searchLayerKeyFromTreeNode(candidate);
            if (layerKey) {
                leafKeys.add(layerKey);
                return;
            }
            for (const child of candidate.children ?? []) {
                visit(child as TreeNode<FeatureSearchLayerTreeNodeData>);
            }
        };
        visit(sourceNode);
        return leafKeys;
    }

    private expandedMapLayerTreeNodeKeys(
        nodes: TreeNode<FeatureSearchLayerTreeNodeData>[] | null | undefined
    ): Set<string> {
        const expandedKeys = new Set<string>();
        const visit = (node: TreeNode<FeatureSearchLayerTreeNodeData>) => {
            if (node.expanded && node.key) {
                expandedKeys.add(node.key);
            }
            for (const child of node.children ?? []) {
                visit(child as TreeNode<FeatureSearchLayerTreeNodeData>);
            }
        };
        for (const node of nodes ?? []) {
            visit(node);
        }
        return expandedKeys;
    }

    private applyMapLayerTreeExpandedState(
        nodes: TreeNode<FeatureSearchLayerTreeNodeData>[] | null | undefined,
        expandedKeys: Set<string>,
        expandedNodes: TreeNode<FeatureSearchLayerTreeNodeData>[] = []
    ): TreeNode<FeatureSearchLayerTreeNodeData>[] {
        const visit = (node: TreeNode<FeatureSearchLayerTreeNodeData>) => {
            const expanded = !!node.key && expandedKeys.has(node.key);
            node.expanded = expanded;
            if (expanded) {
                expandedNodes.push(node);
            }
            for (const child of node.children ?? []) {
                visit(child as TreeNode<FeatureSearchLayerTreeNodeData>);
            }
        };
        for (const node of nodes ?? []) {
            visit(node);
        }
        return expandedNodes;
    }

    private mapLayerKeySignature(selectedKeys: Set<string>): string {
        return JSON.stringify(Array.from(selectedKeys).sort());
    }

    private syncMapLayerTreeSelection(session: FeatureSearchSession): void {
        this.refreshMapLayerTreeOptions();
        if (this.initializedMapLayerSelectionSessionId !== session.id) {
            this.initializedMapLayerSelectionSessionId = session.id;
            const selectedKeys = new Set(session.definition.selectedMapLayers
                .map(ref => this.searchLayerKey(ref.mapId, ref.layerId)));
            this.selectedMapLayersSignature = this.mapLayerKeySignature(selectedKeys);
            this.setSelectedMapLayerTreeLeafKeys(selectedKeys);
            return;
        }
        const selectedKeys = this.selectedMapLayerKeysFromTreeNodes(this.selectedMapLayerTreeNodes);
        this.selectedMapLayersSignature = this.mapLayerKeySignature(selectedKeys);
        this.setSelectedMapLayerTreeLeafKeys(selectedKeys);
    }

    protected onSearchMapLayerTreeNodeToggle(
        node: TreeNode<FeatureSearchLayerTreeNodeData>,
        event?: Event
    ): void {
        event?.stopPropagation();
        const session = this.session;
        if (!session || !this.searchEnabled()) {
            return;
        }
        const expandedKeys = new Set(this.mapLayerTreeExpandedKeys);
        const selectedKeys = this.selectedMapLayerKeysFromTreeNodes(this.selectedMapLayerTreeNodes);
        const state = this.mapLayerTreeSelectionStateForNode(node);
        const select = !state?.checked;
        for (const layerKey of this.mapLayerTreeLeafKeysForNode(node)) {
            if (select) {
                selectedKeys.add(layerKey);
            } else {
                selectedKeys.delete(layerKey);
            }
        }
        this.setSelectedMapLayerTreeLeafKeys(selectedKeys, expandedKeys);
        this.selectedMapLayersSignature = this.mapLayerKeySignature(selectedKeys);
        this.refreshSearchFeatureTypeOptions(session);
        this.syncSelectedFeatureTypesFromSession(session);
        this.refreshSearchTileLevelOptions(session);
        this.styleAttributeOptionsSessionSignature = "";
        this.updateDraftFeatureSearchScopeSummary(this.featureSearchScope);
        this.searchService.setSearchMapLayers(
            session.id,
            this.selectedMapLayerRefsFromTreeNodes(this.selectedMapLayerTreeNodes)
        );
    }

    protected onSearchMapLayerTreeNodeExpansionChange(
        event?: {node?: TreeNode<FeatureSearchLayerTreeNodeData>},
        expanded?: boolean
    ): void {
        if (event?.node?.key && expanded !== undefined) {
            if (expanded) {
                this.mapLayerTreeExpandedKeys.add(event.node.key);
            } else {
                this.mapLayerTreeExpandedKeys.delete(event.node.key);
            }
            this.applyMapLayerTreeExpandedState(this.mapLayerTreeOptions, this.mapLayerTreeExpandedKeys);
        } else {
            this.mapLayerTreeExpandedKeys = this.expandedMapLayerTreeNodeKeys(this.mapLayerTreeOptions);
        }
        this.mapLayerTreeExpansionInitialized = true;
    }

    /** Returns the selected search layer scope used by schema completion and field pickers. */
    protected selectedSearchMapLayers(): FeatureSearchMapLayerRef[] {
        const treeRefs = this.selectedMapLayerRefsFromTreeNodes(this.selectedMapLayerTreeNodes);
        const refs = treeRefs.length > 0 ||
            this.selectedMapLayersSignature === this.emptyMapLayerSignature()
            ? treeRefs
            : this.session?.definition.selectedMapLayers ?? [];
        const signature = refs
            .map(ref => `${ref.mapId}\u0000${ref.layerId}`)
            .join("\u0001");
        if (signature !== this.selectedSearchMapLayersCacheSignature) {
            this.selectedSearchMapLayersCacheSignature = signature;
            this.selectedSearchMapLayersCache = refs.map(ref => ({...ref}));
        }
        return this.selectedSearchMapLayersCache;
    }

    /** Rebuilds the feature-type selector from the currently selected map/layer scope. */
    private refreshSearchFeatureTypeOptions(session?: FeatureSearchSession): void {
        const options = this.availableSearchFeatureTypes(session)
            .map(featureType => ({label: featureType, value: featureType}));
        const signature = JSON.stringify(options.map(option => option.value));
        if (signature === this.featureSearchFeatureTypeOptionsSignature) {
            return;
        }
        this.featureSearchFeatureTypeOptionsSignature = signature;
        this.featureSearchFeatureTypeOptions = options;
    }

    /** Returns feature types available in the currently selected source-layer scope. */
    private availableSearchFeatureTypes(session?: FeatureSearchSession): string[] {
        const featureTypes = new Set<string>();
        const selectedRefs = this.selectedMapLayerRefsForFeatureTypeOptions(session);
        const layers = selectedRefs.length
            ? selectedRefs.flatMap(ref => {
                const layer = this.mapService.maps.maps.get(ref.mapId)?.layers.get(ref.layerId);
                return layer ? [layer] : [];
            })
            : Array.from(this.mapService.maps.allFeatureLayers());
        for (const layer of layers) {
            for (const featureType of layer.info.featureTypes ?? []) {
                if (featureType.name) {
                    featureTypes.add(featureType.name);
                }
            }
        }
        return Array.from(featureTypes).sort((lhs, rhs) => lhs.localeCompare(rhs));
    }

    /** Uses tree state when initialized, otherwise falls back to the persisted search scope. */
    private selectedMapLayerRefsForFeatureTypeOptions(session?: FeatureSearchSession): FeatureSearchMapLayerRef[] {
        const treeRefs = this.selectedMapLayerRefsFromTreeNodes(this.selectedMapLayerTreeNodes);
        if (treeRefs.length > 0 || this.selectedMapLayersSignature === this.emptyMapLayerSignature()) {
            return treeRefs;
        }
        return session?.definition.selectedMapLayers ?? [];
    }

    /** Copies the persisted feature-type filter into the multi-select control, dropping no-longer-available types. */
    private syncSelectedFeatureTypesFromSession(session: FeatureSearchSession): void {
        this.refreshSearchFeatureTypeOptions(session);
        const availableTypes = new Set(this.featureSearchFeatureTypeOptions.map(option => option.value));
        const persistedTypes = normalizeFeatureSearchFeatureTypes(session.definition.selectedFeatureTypes);
        const persistedSignature = JSON.stringify(persistedTypes);
        const nextTypes = persistedTypes
            .filter(type => availableTypes.has(type));
        const signature = JSON.stringify(nextTypes);
        if (signature === this.selectedFeatureTypesSignature) {
            if (persistedSignature !== signature) {
                this.searchService.setSearchFeatureTypes(session.id, nextTypes);
            }
            return;
        }
        this.selectedFeatureTypesSignature = signature;
        this.selectedFeatureTypes = nextTypes;
        if (persistedSignature !== signature) {
            this.searchService.setSearchFeatureTypes(session.id, nextTypes);
        }
    }

    /** Stores selected feature types; an empty list intentionally means any type. */
    protected onSearchFeatureTypesChange(featureTypes: unknown): void {
        const session = this.session;
        if (!session || !this.searchEnabled()) {
            return;
        }
        const availableTypes = new Set(this.featureSearchFeatureTypeOptions.map(option => option.value));
        const nextTypes = normalizeFeatureSearchFeatureTypes(featureTypes)
            .filter(type => availableTypes.has(type));
        if (JSON.stringify(session.definition.selectedFeatureTypes) === JSON.stringify(nextTypes)) {
            return;
        }
        this.selectedFeatureTypes = nextTypes;
        this.selectedFeatureTypesSignature = JSON.stringify(nextTypes);
        this.searchService.setSearchFeatureTypes(session.id, nextTypes);
    }

    /** Builds a stable signature for selected search map/layer references. */
    private selectedSearchMapLayerSignature(refs: FeatureSearchMapLayerRef[]): string {
        return refs
            .map(ref => this.searchLayerKey(ref.mapId, ref.layerId))
            .sort()
            .join("|");
    }

    /** Signature used by PrimeNG tree selection when the user has explicitly selected no layers. */
    private emptyMapLayerSignature(): string {
        return this.mapLayerKeySignature(new Set<string>());
    }

    protected showSearchViewControl(): boolean {
        return this.stateService.numViews === 2 && this.featureSearchViewOptions.length === 2;
    }

    private refreshSearchViewOptions(): void {
        const viewLabels = ["Left", "Right"];
        const options = Array.from(
            {length: Math.min(this.stateService.numViews, viewLabels.length)},
            (_, index) => ({label: viewLabels[index], value: index})
        );
        const signature = JSON.stringify(options);
        if (signature === this.searchViewOptionsSignature) {
            return;
        }
        this.searchViewOptionsSignature = signature;
        this.featureSearchViewOptions = options;
        this.selectedViewIndices = this.normalizedSearchViewIndices(this.selectedViewIndices);
    }

    private normalizedSearchViewIndices(indices: number[] | null | undefined): number[] {
        const allowed = new Set(this.featureSearchViewOptions.map(option => option.value));
        const selected = new Set<number>();
        for (const value of indices ?? []) {
            const index = Number(value);
            if (Number.isInteger(index) && allowed.has(index)) {
                selected.add(index);
            }
        }
        return Array.from(selected).sort((lhs, rhs) => lhs - rhs);
    }

    private syncSelectedViewIndicesFromSession(session: FeatureSearchSession): void {
        this.refreshSearchViewOptions();
        const nextIndices = this.normalizedSearchViewIndices(
            this.stateService.numViews === 1 ? [0] : session.definition.selectedViewIndices
        );
        const signature = JSON.stringify(nextIndices);
        if (signature === this.selectedViewIndicesSignature) {
            return;
        }
        this.selectedViewIndicesSignature = signature;
        this.selectedViewIndices = nextIndices;
    }

    protected onSearchViewIndicesChange(indices: number[] | null | undefined): void {
        const session = this.session;
        if (!session || !this.searchEnabled()) {
            return;
        }
        const nextIndices = this.normalizedSearchViewIndices(indices ?? []);
        this.selectedViewIndices = nextIndices;
        this.selectedViewIndicesSignature = JSON.stringify(nextIndices);
        this.searchService.setSearchViewIndices(session.id, nextIndices);
    }

    /** Rebuilds the tile-level options from the supported search tile domain. */
    private refreshSearchTileLevelOptions(session?: FeatureSearchSession): void {
        const levels = new Set<number>();
        for (let level = MIN_FEATURE_SEARCH_TILE_LEVEL; level <= MAX_FEATURE_SEARCH_TILE_LEVEL; level++) {
            levels.add(level);
        }
        for (const level of session?.definition.selectedTileLevels ?? []) {
            if (this.isSupportedFeatureSearchTileLevel(level)) {
                levels.add(level);
            }
        }
        for (const level of this.selectedTileLevels) {
            if (this.isSupportedFeatureSearchTileLevel(level)) {
                levels.add(level);
            }
        }
        const nextLevels = Array.from(levels).sort((lhs, rhs) => lhs - rhs);
        const signature = JSON.stringify(nextLevels);
        if (signature === this.searchTileLevelOptionsSignature) {
            return;
        }
        this.searchTileLevelOptionsSignature = signature;
        this.featureSearchTileLevelOptions = nextLevels.map(level => ({
            label: String(level),
            value: level
        }));
        this.selectedTileLevels = this.normalizedSearchTileLevels(this.selectedTileLevels);
    }

    /** Keeps the UI level selection sorted and de-duplicated; empty means automatic level selection. */
    private normalizedSearchTileLevels(levels: number[] | null | undefined): number[] {
        const selected = new Set<number>();
        for (const value of levels ?? []) {
            const level = Number(value);
            if (this.isSupportedFeatureSearchTileLevel(level)) {
                selected.add(level);
            }
        }
        return Array.from(selected).sort((lhs, rhs) => lhs - rhs);
    }

    /** Accepts the persisted tile-level domain without coupling the UI to one datasource's metadata. */
    private isSupportedFeatureSearchTileLevel(value: unknown): value is number {
        const level = Number(value);
        return Number.isInteger(level)
            && level >= MIN_FEATURE_SEARCH_TILE_LEVEL
            && level <= MAX_FEATURE_SEARCH_TILE_LEVEL;
    }

    /** Synchronizes local tile-level controls from the active persisted search. */
    private syncSelectedTileLevelsFromSession(session: FeatureSearchSession): void {
        this.refreshSearchTileLevelOptions(session);
        const nextLevels = this.normalizedSearchTileLevels(session.definition.selectedTileLevels);
        const signature = JSON.stringify(nextLevels);
        if (signature === this.selectedTileLevelsSignature) {
            if (JSON.stringify(session.definition.selectedTileLevels) !== signature) {
                this.searchService.setSearchTileLevels(session.id, nextLevels);
            }
            return;
        }
        this.selectedTileLevelsSignature = signature;
        this.selectedTileLevels = nextLevels;
        if (JSON.stringify(session.definition.selectedTileLevels) !== signature) {
            this.searchService.setSearchTileLevels(session.id, nextLevels);
        }
        this.refreshSearchTileLevelOptions(session);
    }

    /** Persists user-selected source tile levels for this search definition. */
    protected onSearchTileLevelsChange(levels: number[] | null | undefined): void {
        const session = this.session;
        if (!session || !this.searchEnabled()) {
            return;
        }
        const nextLevels = this.normalizedSearchTileLevels(levels ?? []);
        this.selectedTileLevels = nextLevels;
        this.selectedTileLevelsSignature = JSON.stringify(nextLevels);
        this.refreshSearchTileLevelOptions(session);
        this.searchService.setSearchTileLevels(session.id, nextLevels);
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

    /** Parses and clamps one numeric UI value, keeping a stable fallback for incomplete form edits. */
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
            this.featureSearchCompletionOwnerId = `feature-search:${this.searchId}`;
        }
    }

    /** Starts watching the rendered tree host once Angular has materialized the active surface. */
    ngAfterViewInit(): void {
        this.refreshTreeResizeObserver();
        this.scheduleTreeScrollHeightSync();
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

    /** Coalesces external session emissions behind the active Angular check. */
    private scheduleSessionSync(): void {
        if (this.sessionSyncTimer !== null) {
            return;
        }
        this.sessionSyncTimer = setTimeout(() => {
            this.sessionSyncTimer = null;
            const session = this.searchService.getSession(this.searchId);
            if (session) {
                this.syncFromSession(session);
            }
        }, 0);
    }

    /** Copies session state into the local view model without crossing streams between searches. */
    private syncFromSession(session: FeatureSearchSession): void {
        this.session = session;
        this.refreshSearchStyleOptions();
        // Search sessions are mutable service-owned objects. Snapshot scalar
        // diagnostics only at our deferred synchronization boundary so a
        // service timer cannot mutate a template binding mid Angular check.
        this.searchTimeElapsed = session.timeElapsed;
        this.searchTotalFeatureCount = session.totalFeatureCount;
        this.featureSearchDialogVisible = true;
        const wasQueryDirty = this.featureSearchQueryDirty;
        const previousQuery = this.lastSearchQuery;
        const previousScope = this.featureSearchScope;
        const staticSignature = this.staticSessionSyncSignatureFor(session);
        const staticSessionChanged = staticSignature !== this.staticSessionSyncSignature;
        if (staticSessionChanged) {
            this.staticSessionSyncSignature = staticSignature;
            this.lastSearchQuery = session.definition.query;
            this.featureSearchScope = session.definition.scope;
            this.syncMapLayerTreeSelection(session);
            this.syncSelectedFeatureTypesFromSession(session);
            this.syncSelectedTileLevelsFromSession(session);
            this.syncSelectedViewIndicesFromSession(session);
            this.refreshFeatureSearchScopeSummary(session);
            this.syncStyleRulesFromSession(session.definition.searchStyleRules ?? []);
            const hasStyleRules = (session.definition.searchStyleRules?.length ?? 0) > 0;
            const styleFieldsRefreshScheduled = this.refreshStyleAttributeOptionsIfNeeded(session, hasStyleRules);
            if (!styleFieldsRefreshScheduled && hasStyleRules && this.applyDefaultStyleFieldIfMissing()) {
                this.onStyleRulesChanged();
            } else if (!styleFieldsRefreshScheduled && !hasStyleRules) {
                this.tryCreateAutoStyleRule(session);
            }
        }
        if (this.activeSearchGroupId !== session.runId) {
            this.activeSearchGroupId = session.runId;
            this.completedSearchGroupId = "";
            this.lastErrorAlertSignature = "";
            if (!wasQueryDirty) {
                this.featureSearchQuery = session.definition.query;
            }
            this.results = [];
            this.resultCount = 0;
            this.resultsTree = [];
            if (previousQuery !== session.definition.query
                || previousScope !== session.definition.scope
                || this.resultPanelIndex !== 'style') {
                this.resultPanelIndex = 'results';
            }
        } else if (!wasQueryDirty && this.featureSearchQuery !== session.definition.query) {
            this.featureSearchQuery = session.definition.query;
        }
        this.updateFeatureSearchQueryDirty();
        this.scheduleProgressDisplayRefresh(session);
        this.diagnostics = session.diagnostics;
        this.valueSummaries = session.valueSummaries;
        if (this.resultPanelIndex === "diagnostics" && session.complete) {
            this.requestDiagnosticsValueSummaries();
        }
        this.syncStreamingResults(session);
        if (this.isDocked() && this.stateService.isDockOpen && this.surfacedDockedSearchId !== session.id) {
            this.stateService.dockActiveTab = SEARCH_DOCK_TAB_ID;
            this.surfacedDockedSearchId = session.id;
        }
        if (session.complete) {
            this.searchResultReady(this.completedSearchGroupId !== session.runId);
            this.completedSearchGroupId = session.runId;
            this.canStopSearch = false;
        } else {
            this.resultsStatus = "Loading...";
            this.canStopSearch = true;
            this.completedSearchGroupId = "";
        }
    }

    /** Captures session fields that affect static controls, excluding high-frequency result/progress counters. */
    private staticSessionSyncSignatureFor(session: FeatureSearchSession): string {
        const analysis = session.schemaAnalysis;
        return [
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

    /** Stops feature search subscriptions when the component is destroyed. */
    ngOnDestroy() {
        this.destroyed = true;
        this.pendingProgressDisplaySession = undefined;
        this.subscriptions.unsubscribe();
        this.cancelResultTreeAppend();
        if (this.sessionSyncTimer !== null) {
            clearTimeout(this.sessionSyncTimer);
            this.sessionSyncTimer = null;
        }
        this.resizeObserver?.disconnect();
        this.resizeObserver = undefined;
        if (this.treeScrollHeightRaf !== undefined) {
            window.cancelAnimationFrame(this.treeScrollHeightRaf);
            this.treeScrollHeightRaf = undefined;
        }
        if (this.styleAttributeOptionsRefreshTimer) {
            clearTimeout(this.styleAttributeOptionsRefreshTimer);
            this.styleAttributeOptionsRefreshTimer = null;
        }
        this.styleAttributeOptionsRefreshPatchMissing = false;
    }

    protected isDocked(): boolean {
        return !!this.session && this.searchService.isSessionDocked(this.session.id);
    }

    protected searchEnabled(): boolean {
        return this.session?.definition.enabled ?? true;
    }

    protected featureSearchTitle(): string {
        return this.session?.definition.query.trim() || "Search Loaded Features";
    }

    /**
     * Recomputes the virtual tree height once the dialog becomes measurable.
     */
    onDialogShow(event: any) {
        this.refreshTreeResizeObserver();
        this.syncTreeScrollHeight(event);
        this.dialogStack.bringToFront(this.featureSearchDialog);
        this.refreshCompletionZIndex();
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
        this.refreshTreeResizeObserver();
        this.syncTreeScrollHeight();
        this.refreshCompletionZIndex();
    }

    protected onDockedPanelBodySizeChange(): void {
        this.syncTreeScrollHeight();
    }

    private measurePreferredBodyHeightEm(): number | undefined {
        const content = this.featureSearchContentContainer?.nativeElement;
        if (!content || !this.stateService.baseFontSize) {
            return undefined;
        }
        const height = content.scrollHeight / this.stateService.baseFontSize;
        return Number.isFinite(height) && height > 0 ? height : undefined;
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
        this.featureSearchCompletionZIndex = this.isDocked() ? 32070 : surfaceZIndex + 2000;
    }

    private shouldDockDialog(): boolean {
        return this.featureSearchDialog?.overlapsDockDropTarget() ?? false;
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
        this.featureSearchPanel?.toggleExpanded();
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

    protected onHeaderPointerDown(event: PointerEvent) {
        const session = this.session;
        if (!session || event.button !== 0) {
            return;
        }
        if (this.isDocked()) {
            this.panelDragRequest.emit({session, event});
        } else {
            this.featureSearchDialog?.startDrag(event);
        }
    }

    protected expandFeatureSearchQueryInput() {
        this.featureSearchQueryExpanded = true;
        this.refreshCompletionZIndex();
    }

    protected shrinkFeatureSearchQueryInput() {
        this.featureSearchQueryExpanded = false;
    }

    protected onFeatureSearchQueryChange(value: string): void {
        this.featureSearchQuery = value ?? "";
        this.updateFeatureSearchQueryDirty();
        if (this.featureSearchQueryDirty) {
            this.updateDraftFeatureSearchScopeSummary(this.featureSearchScope);
        } else if (this.session) {
            this.refreshFeatureSearchScopeSummary(this.session);
        }
    }

    /** Seeds map-layer selection from a schema completion accepted in the main search-query input. */
    protected onFeatureSearchQueryCompletionAccepted(candidate: CompletionCandidate): void {
        const session = this.session;
        if (!session || !this.searchEnabled()) {
            return;
        }
        const originLayers = featureSearchSelectedMapLayersFromPayload(
            featureSearchActionPayloadFromCompletion(candidate)
        ) ?? [];
        if (!originLayers.length) {
            return;
        }

        if (this.searchService.applySearchMapLayersForDetectedContext(session.id, originLayers)) {
            this.infoMessageService.showInfo("Auto-detected map layers for search.");
        }
    }

    protected rerunSearch() {
        const query = this.searchQueryForRerun();
        if (!query || !this.session || !this.searchEnabled()) {
            return;
        }
        this.featureSearchQuery = query;
        this.lastSearchQuery = query;
        this.featureSearchQueryDirty = false;
        this.searchService.rerunSearch(this.session.id, query);
    }

    protected searchQueryForRerun(): string {
        return this.featureSearchQuery.trim() || this.session?.definition.query || this.lastSearchQuery;
    }

    protected searchQueryEdited(): boolean {
        const query = this.featureSearchQuery.trim();
        const sessionQuery = this.session?.definition.query.trim() ?? "";
        return query.length > 0 && query !== sessionQuery;
    }

    protected refreshSearchAreaOrQuery(): void {
        if (this.searchQueryEdited()) {
            this.rerunSearch();
            return;
        }
        this.updateSearchInArea();
    }

    private updateFeatureSearchQueryDirty(): void {
        const persistedQuery = this.session?.definition.query ?? this.lastSearchQuery;
        this.featureSearchQueryDirty = this.featureSearchQuery.trim() !== (persistedQuery ?? "").trim();
    }

    protected onFeatureSearchScopeChange(scope: FeatureSearchScope): void {
        this.featureSearchScope = scope;
        this.refreshSearchStyleOptions();
        if (this.session) {
            this.updateDraftFeatureSearchScopeSummary(scope);
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
        if (this.resultPanelIndex === "diagnostics" && this.session) {
            if (this.session.complete) {
                this.requestDiagnosticsValueSummaries();
            }
        }
        if (this.resultPanelIndex === "results") {
            this.scheduleTreeScrollHeightSync();
        }
    }

    protected onFeatureSearchAutoUpdateChange(autoUpdate: boolean): void {
        if (this.session && this.searchEnabled()) {
            this.searchService.setSearchAutoUpdate(this.session.id, autoUpdate);
        }
    }

    protected onSearchEnabledChange(enabled: boolean): void {
        if (this.session) {
            this.searchService.setSearchEnabled(this.session.id, enabled);
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
        const autoUpdate = !!this.session?.definition.autoUpdate;
        const refreshLabel = this.searchQueryEdited() ? 'Rerun search' : 'Update area';
        const rerunQuery = this.searchQueryForRerun();
        const signature = JSON.stringify([
            this.session?.id ?? "",
            bookmarked,
            enabled,
            autoUpdate,
            refreshLabel,
            !!rerunQuery,
            this.canStopSearch
        ]);
        if (signature === this.featureSearchHeaderActionsSignature) {
            return this.featureSearchHeaderActionsCache;
        }
        this.featureSearchHeaderActionsSignature = signature;
        this.featureSearchHeaderActionsCache = [
            {
                label: bookmarked ? 'Remove bookmark' : 'Bookmark search',
                tooltip: bookmarked ? 'Remove bookmark' : 'Bookmark search',
                icon: bookmarked ? 'pi pi-bookmark-fill' : 'pi pi-bookmark',
                command: () => this.toggleSearchBookmarked()
            },
            {
                label: 'Clone search',
                tooltip: 'Clone search',
                materialIcon: 'copy_all',
                menuIcon: 'pi pi-copy',
                disabled: !this.session,
                command: () => this.cloneSearch()
            },
            {
                label: 'Auto update area',
                tooltip: autoUpdate ? 'Disable automatic area updates' : 'Enable automatic area updates',
                materialIcon: 'autorenew',
                menuIcon: 'pi pi-refresh',
                severity: autoUpdate ? 'success' : 'primary',
                disabled: !enabled || !this.session,
                command: () => this.onFeatureSearchAutoUpdateChange(!autoUpdate)
            },
            {
                label: 'Export as JSON',
                tooltip: 'Export as JSON',
                icon: 'pi pi-download',
                disabled: !this.session,
                command: () => this.exportSearchAsJson()
            },
            {
                label: refreshLabel,
                tooltip: refreshLabel,
                icon: 'pi pi-refresh',
                disabled: !enabled || !rerunQuery,
                command: () => this.refreshSearchAreaOrQuery()
            },
            {
                label: 'Stop search',
                tooltip: 'Stop search',
                icon: 'pi pi-stop-circle',
                disabled: !enabled || !this.canStopSearch,
                command: () => this.stopSearch()
            }
        ];
        return this.featureSearchHeaderActionsCache;
    }

    protected toggleSearchBookmarked(): void {
        if (this.session) {
            this.searchService.setSearchBookmarked(this.session.id, !this.session.definition.bookmarked);
        }
    }

    protected exportSearchAsJson(): void {
        const session = this.session;
        if (!session) {
            return;
        }
        this.openSearchExportDialog(session.id);
    }

    protected cloneSearch(): void {
        if (this.session) {
            this.searchService.cloneSearch(this.session.id);
        }
    }

    private openSearchExportDialog(sessionId: string, closeAfterExport = false): void {
        this.searchService.openExportDialog(sessionId, {
            closeAfterExport,
            grouping: this.currentExportGrouping(),
            filterValue: this.resultTreeFilterValue
        });
    }

    private currentExportGrouping(): FeatureSearchExportGroupingOption[] {
        return this.groupingValuesFromOptions(this.selectedGroupingOptions).map(id => ({
            id,
            name: this.grouping.find(option => option.value === id)?.name ?? String(id)
        }));
    }

    protected get bookmarkedCloseConfirmKey(): string {
        return `feature-search-bookmarked-close:${this.searchId}`;
    }

    protected closeSearch(event?: MouseEvent): void {
        const session = this.session;
        if (!session) {
            return;
        }
        if (this.closingSearchId === session.id) {
            return;
        }
        if (session.definition.bookmarked) {
            this.showBookmarkedClosePopup(session.id, event);
            return;
        }
        this.closingSearchId = session.id;
        this.clearResultTreeBeforeClose();
        this.featureSearchDialogVisible = false;
        setTimeout(() => {
            this.searchService.closeSearch(session.id);
            if (this.closingSearchId === session.id) {
                this.closingSearchId = null;
            }
        }, 0);
    }

    /** Drops the heavy PrimeNG tree input before the session is removed from the service. */
    private clearResultTreeBeforeClose(): void {
        this.cancelResultTreeAppend();
        this.results = [];
        this.resultCount = 0;
        this.searchTimeElapsed = "0ms";
        this.searchTotalFeatureCount = 0;
        this.resultsTree = [];
        this.resultTreeGroupNodesByKey.clear();
        this.resultTreeInputLength = 0;
        this.resultTreeAutoExpandedSignature = "";
        this.showFilter = false;
        this.resultsStatus = "Loading...";
    }

    private showBookmarkedClosePopup(sessionId: string, event?: MouseEvent): void {
        const target = this.bookmarkedClosePopupTarget(event);
        this.featureSearchDialogVisible = true;
        this.pendingBookmarkedCloseSessionId = sessionId;
        this.confirmPopupService.confirm({
            key: this.bookmarkedCloseConfirmKey,
            target,
            header: "Close bookmarked search?",
            message: "It will be permanently deleted. You can export the search before deleting.",
            severity: "error",
            accept: () => this.confirmBookmarkedCloseSearch(),
            reject: () => this.cancelBookmarkedCloseSearch()
        });
    }

    private bookmarkedClosePopupTarget(event?: MouseEvent): EventTarget {
        return (event?.currentTarget ?? event?.target)
            || this.featureSearchDialog?.container()
            || this.featureSearchPanel?.container()
            || document.body;
    }

    protected confirmBookmarkedCloseSearch(): void {
        const sessionId = this.pendingBookmarkedCloseSessionId;
        this.pendingBookmarkedCloseSessionId = null;
        if (sessionId) {
            this.searchService.closeSearch(sessionId);
        }
    }

    protected cancelBookmarkedCloseSearch(): void {
        this.pendingBookmarkedCloseSessionId = null;
        this.featureSearchDialogVisible = true;
    }

    protected exportBookmarkedCloseSearch(): void {
        const sessionId = this.pendingBookmarkedCloseSessionId;
        this.pendingBookmarkedCloseSessionId = null;
        this.confirmPopupService.close();
        if (sessionId) {
            this.openSearchExportDialog(sessionId, true);
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
        const errors = session.errors;
        this.diagnostics = session.diagnostics;
        this.valueSummaries = session.valueSummaries;

        this.canStopSearch = false;
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
            if (this.diagnosticsBadgeCount() > 0)
                this.resultPanelIndex = 'diagnostics';
        }

        this.results = results;
    }

    /**
     * Selects the concrete streamed result when possible so attribute/validity suffixes survive the click.
     */
    selectResult(event: any) {
        // Support both listbox change and tree node select events
        const selected = event?.value || event?.node?.data || event;
        const mapTileKey = typeof selected?.mapTileKey === "string" ? selected.mapTileKey : "";
        const selectedFeatureId = typeof selected?.hoverFeatureId === "string" && selected.hoverFeatureId
            ? selected.hoverFeatureId
            : typeof selected?.featureId === "string"
                ? selected.featureId
                : "";
        if (mapTileKey && selectedFeatureId) {
            const keepDockedSearchVisible = this.isDocked();
            const lockSelection = !!event?.originalEvent?.ctrlKey;
            const panelId = this.stateService.setSelection(
                [{mapTileKey, featureId: selectedFeatureId}],
                undefined,
                lockSelection,
                keepDockedSearchVisible);
            if (lockSelection && panelId !== undefined) {
                this.stateService.setInspectionPanelLockedState(panelId, true);
            }
            this.inspectionSelection.focusOnFeature(undefined, {
                mapTileKey,
                featureId: selectedFeatureId
            }).then();
            return;
        }
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
     * Stops the active search, freezes the partial result set, and surfaces any accumulated errors.
     */
    stopSearch() {
        const session = this.session;
        if (this.canStopSearch && session) {
            this.searchService.stopSearch(session.id);
            this.canStopSearch = false;
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
        const session = this.session;
        if (session?.definition.bookmarked) {
            this.featureSearchDialogVisible = true;
            return;
        }
        if (session) {
            this.searchService.closeSearch(session.id);
        }
        this.resetLocalState();
        this.featureSearchDialogVisible = false;
    }

    /** Clears local rendering state after the owning session disappears. */
    private resetLocalState(): void {
        this.pendingProgressDisplaySession = undefined;
        this.diagnostics = [];
        this.valueSummaries = this.emptyValueSummariesState();
        this.canStopSearch = false;
        this.percentDone = 0;
        this.resultTileIngressPercent = 0;
        this.resultTreeIngressPercent = 0;
        this.progressMeterItems = [];
        this.totalTiles = 0;
        this.doneTiles = 0;
        this.resultTileIngressDone = 0;
        this.resultTileIngressTotal = 0;
        this.resultTreeIngressDone = 0;
        this.resultTreeIngressTotal = 0;
        this.progressDisplayPercent = 0;
        this.progressLabel = "Preparing search...";
        this.progressTooltip = "";
        this.results = [];
        this.resultCount = 0;
        this.searchTimeElapsed = "0ms";
        this.searchTotalFeatureCount = 0;
        this.resultsTree = [];
        this.showFilter = false;
        this.resultsStatus = "Loading...";
        this.featureSearchExpanded = false;
        this.featureSearchQueryExpanded = false;
        this.featureSearchQuery = "";
        this.featureSearchQueryDirty = false;
        this.featureSearchCompletionOwnerId = "";
        this.featureSearchCompletionZIndex = 30050;
        this.featureSearchScope = "auto";
        this.styleAttributeOptions = [];
        this.styleScalarAttributeOptions = [];
        this.styleAttributeOptionsLoading = false;
        this.styleAttributeOptionsSessionSignature = "";
        if (this.styleAttributeOptionsRefreshTimer) {
            clearTimeout(this.styleAttributeOptionsRefreshTimer);
            this.styleAttributeOptionsRefreshTimer = null;
        }
        this.styleAttributeOptionsRefreshPatchMissing = false;
        this.styleRulesStateSignature = "";
        this.staticSessionSyncSignature = "";
        this.nextStyleRuleId = 1;
        this.nextStyleConditionId = 1;
        this.nextStyleColorStopId = 1;
        this.styleRuleDrafts = [];
        this.styleRuleAccordionValue = [];
        this.selectedSearchStyleId = null;
        this.searchStyleApplicationMessage = "";
        this.searchStyleApplicationWarning = false;
        this.activeSearchGroupId = "";
        this.completedSearchGroupId = "";
        this.resultTreeInputLength = 0;
        this.resultTreeGroupingSignature = "";
        this.resultTreeRunId = "";
        this.resultTreeAutoExpandedSignature = "";
        this.resultTreeFilterValue = "";
        this.resultTreeGroupNodesByKey.clear();
        this.cancelResultTreeAppend();
        this.lastErrorAlertSignature = "";
        this.surfacedDockedSearchId = "";
        this.mapLayerTreeOptions = [];
        this.selectedMapLayerTreeNodes = [];
        this.mapLayerTreeSelectionState.clear();
        this.mapLayerTreeExpandedKeys.clear();
        this.mapLayerTreeExpansionInitialized = false;
        this.featureSearchFeatureTypeOptions = [];
        this.selectedFeatureTypes = [];
        this.featureSearchTileLevelOptions = [];
        this.selectedTileLevels = [...DEFAULT_FEATURE_SEARCH_TILE_LEVELS];
        this.featureSearchViewOptions = [];
        this.selectedViewIndices = [];
        this.mapLayerTreeOptionsSignature = "";
        this.selectedMapLayersSignature = "";
        this.selectedSearchMapLayersCacheSignature = "";
        this.selectedSearchMapLayersCache = [];
        this.initializedMapLayerSelectionSessionId = "";
        this.featureSearchFeatureTypeOptionsSignature = "";
        this.selectedFeatureTypesSignature = "";
        this.searchTileLevelOptionsSignature = "";
        this.selectedTileLevelsSignature = "";
        this.searchViewOptionsSignature = "";
        this.selectedViewIndicesSignature = "";
        this.pendingBookmarkedCloseSessionId = null;
        this.featureSearchHeaderActionsSignature = "";
        this.featureSearchHeaderActionsCache = [];
        this.closingSearchId = null;
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
                // Expanding every group forces PrimeNG to flatten very large result trees
                // while streamed ingress is still active; keep the leaf-heavy level closed.
                expanded: this.resultTreeGroupExpandedByDefault(depth, selectedOrder),
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

    /** Expands shallow grouping context only; broad searches should not render all leaves immediately. */
    private resultTreeGroupExpandedByDefault(depth: number, selectedOrder: number[]): boolean {
        return selectedOrder.length > 1 && depth < selectedOrder.length - 1;
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
        this.resultTreeAutoExpandedSignature = "";
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
        const groupingSignature = this.groupingValuesFromOptions(this.selectedGroupingOptions).join(',');
        this.resetStreamingResultTree(session.runId, groupingSignature);
        this.scheduleResultTreeAppend();
    }

    /** Schedules another frame-budgeted streamed result-tree append pass. */
    private scheduleResultTreeAppend(): void {
        if (this.resultTreeAppendRaf !== null) {
            return;
        }
        this.resultTreeAppendRaf = this.ngZone.runOutsideAngular(() =>
            requestAnimationFrame(() => {
                this.resultTreeAppendRaf = null;
                this.appendStreamingResultsChunk();
                this.ngZone.run(() => this.changeDetector.markForCheck());
            })
        );
    }

    /** Updates the empty-message and filter state after streamed result-tree changes. */
    private updateResultTreeStatus(searchComplete: boolean): void {
        const previousShowFilter = this.showFilter;
        if (this.resultsTree.length) {
            this.showFilter = true;
            this.resultsStatus = "No entries found.";
        } else if (searchComplete) {
            this.showFilter = false;
            this.resultsStatus = "No matches found.";
        }
        if (previousShowFilter !== this.showFilter) {
            this.scheduleTreeScrollHeightSync();
        }
    }

    /** Expands every populated result group once, after the completed session is fully rendered. */
    private expandCompletedResultTreeIfReady(session: FeatureSearchSession): void {
        if (!session.complete || this.resultTreeInputLength < session.searchResults.length) {
            return;
        }
        const signature = `${session.runId}\n${this.resultTreeGroupingSignature}`;
        if (this.resultTreeAutoExpandedSignature === signature) {
            return;
        }

        const expandGroups = (nodes: TreeNode[]): void => {
            for (const node of nodes) {
                if (!node.children?.length) {
                    continue;
                }
                node.expanded = true;
                expandGroups(node.children);
            }
        };
        expandGroups(this.resultsTree);
        this.resultTreeAutoExpandedSignature = signature;
        this.resultsTree = [...this.resultsTree];
        this.scheduleTreeScrollHeightSync();
    }

    /** Appends pending streamed results for a bounded amount of work to keep the UI responsive. */
    private appendStreamingResultsChunk(): void {
        const session = this.session;
        if (!session) {
            return;
        }
        const results = session.searchResults;
        if (results.length <= this.resultTreeInputLength) {
            this.resultCount = results.length;
            this.scheduleProgressDisplayRefresh(session);
            this.updateResultTreeStatus(session.complete);
            this.expandCompletedResultTreeIfReady(session);
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
        this.resultCount = results.length;
        this.scheduleProgressDisplayRefresh(session);
        if (this.resultTreeInputLength < results.length) {
            this.scheduleResultTreeAppend();
        }
        this.updateResultTreeStatus(session.complete);
        this.expandCompletedResultTreeIfReady(session);
    }

    /**
     * Synchronizes streamed result entries into the tree incrementally.
     *
     * Run, grouping, and eviction changes reset the destination tree, but the
     * expensive node creation still happens through frame-budgeted append chunks.
     */
    private syncStreamingResults(session: FeatureSearchSession): void {
        const results = session.searchResults;
        const groupingSignature = this.groupingValuesFromOptions(this.selectedGroupingOptions).join(',');
        const needsFullRebuild = this.resultTreeRunId !== session.runId
            || this.resultTreeGroupingSignature !== groupingSignature
            || results.length < this.resultTreeInputLength;

        this.results = results;
        if (needsFullRebuild) {
            this.resetStreamingResultTree(session.runId, groupingSignature);
        }
        if (results.length > this.resultTreeInputLength) {
            // Session streams may emit synchronously from another component's
            // Angular turn. Keep tree/progress mutations behind the existing
            // RAF boundary so template bindings cannot change between the
            // development-mode check and check-no-changes passes.
            this.scheduleResultTreeAppend();
        }
        this.scheduleProgressDisplayRefresh(session);
        this.updateResultTreeStatus(session.complete);
        this.expandCompletedResultTreeIfReady(session);
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
                    expanded: this.resultTreeGroupExpandedByDefault(depth, selectedOrder),
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
        this.scheduleTreeScrollHeightSync();
        this.resultTreeInputLength = this.results.length;
        this.resultTreeGroupingSignature = selectedOrder.join(',');
    }

    /**
     * Derives the tree scroller height from the dialog size so virtual scrolling stays usable while resizing.
     */
    syncTreeScrollHeight(_event?: MouseEvent) {
        const host = this.featureSearchTreeHost?.nativeElement;
        const hostHeight = host?.getBoundingClientRect().height ?? 0;
        if (!host || hostHeight <= 0 || !this.stateService.baseFontSize) {
            return;
        }

        const treeElement = ((this.tree as any)?.el?.nativeElement ?? null) as HTMLElement | null;
        const filterElement = treeElement?.querySelector<HTMLElement>('.p-tree-filter-container');
        const treeStyles = treeElement ? window.getComputedStyle(treeElement) : undefined;
        const treeVerticalPadding = treeStyles
            ? (Number.parseFloat(treeStyles.paddingTop) || 0) + (Number.parseFloat(treeStyles.paddingBottom) || 0)
            : 0;
        const filterHeight = filterElement?.getBoundingClientRect().height ?? 0;
        const nextHeight = Math.max(
            this.stateService.baseFontSize * 6,
            Math.floor(hostHeight - filterHeight - treeVerticalPadding)
        );
        this.scrollHeight = `${nextHeight}px`;

        window.requestAnimationFrame(() => {
            const scroller = (this.tree as any)?.scroller as Scroller | undefined;
            if (scroller) {
                scroller.scrollHeight = this.scrollHeight;
                scroller.calculateAutoSize?.();
            }
        });
    }

    /** Keeps PrimeNG's virtual scroller synchronized with actual panel layout changes. */
    private scheduleTreeScrollHeightSync(): void {
        if (this.treeScrollHeightRaf !== undefined) {
            return;
        }
        this.treeScrollHeightRaf = window.requestAnimationFrame(() => {
            this.treeScrollHeightRaf = undefined;
            this.syncTreeScrollHeight();
        });
    }

    /** Observes the elements whose size changes affect the tree viewport. */
    private refreshTreeResizeObserver(): void {
        if (typeof ResizeObserver === "undefined") {
            return;
        }
        this.resizeObserver?.disconnect();
        this.resizeObserver = new ResizeObserver(() => this.scheduleTreeScrollHeightSync());
        const contentElement = this.featureSearchContentContainer?.nativeElement;
        const treeHostElement = this.featureSearchTreeHost?.nativeElement;
        if (contentElement) {
            this.resizeObserver.observe(contentElement);
        }
        if (treeHostElement) {
            this.resizeObserver.observe(treeHostElement);
        }
    }
}
