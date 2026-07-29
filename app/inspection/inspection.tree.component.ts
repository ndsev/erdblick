import {
    AfterViewInit,
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    ViewChild,
    input,
    OnDestroy,
    effect,
    output
} from "@angular/core";
import {MenuItem, TreeNode, TreeTableNode} from "primeng/api";
import {TreeTable} from "primeng/treetable";
import {toObservable} from "@angular/core/rxjs-interop";
import {Subscription} from "rxjs";
import {coreLib} from "../integrations/wasm";
import {InfoMessageService} from "../shared/info.service";
import {InspectionSelectionService} from "./inspection-selection.service";
import {Menu} from "primeng/menu";
import {ClipboardService} from "../shared/clipboard.service";
import {AppStateService, SelectedSourceData, type InspectionTreeExpansionState} from "../shared/appstate.service";
import {Popover} from "primeng/popover";
import {JumpTargetService} from "../search/jump.service";
import {stripFeatureInspectionTarget} from "../shared/tile-feature-id";
import {FeatureSearchService} from "../search/feature.search.service";
import type {FeatureSearchMapLayerRef} from "../shared/feature-search-state";
import {inspectionSearchNumberLiteral} from "./inspection-search.util";

/** Column definition used by the inspection tree's generic table renderer. */
export interface Column {
    key: string,
    header: string,
    width: string,
    transform: (colKey: string, rowData: any) => any,
    toggleable?: boolean,
    toggleIcon?: string
}

/** User-facing switches that control which inspection fields participate in tree filtering. */
export class FeatureFilterOptions {
    filterByKeys: boolean = true;
    filterByValues: boolean = true;
    filterOnlyFeatureIds: boolean = false;
    filterGeometryEntries: boolean = false;
}

@Component({
    selector: 'inspection-tree',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <p-treeTable #tt class="inspection-tree-table" scrollHeight="flex" filterMode="strict"
                     [value]="data"
                     [autoLayout]="true"
                     [scrollable]="true"
                     [resizableColumns]="true"
                     [rowHover]="true"
                     [virtualScroll]="true"
                     [virtualScrollItemSize]="'1.5em'"
                     [tableStyle]="{'min-height': '1px', 'padding': '0px'}"
                     [globalFilterFields]="filterFields">
            <ng-template pTemplate="caption">
                @if (showFilter() || toggleableColumns().length) {
                    <div class="filter-container">
                        @if (showFilter()) {
                            <p-iconfield class="input-container">
                                @if (filterOptions()) {
                                    <p-inputicon (click)="filterPanel.toggle($event)" styleClass="pi pi-filter"
                                                 style="cursor: pointer"/>
                                }
                                <input class="filter-input" type="text" pInputText placeholder="Filter inspection tree"
                                       [(ngModel)]="filterString"
                                       (ngModelChange)="onFilterInput($event)"
                                       (input)="onFilterInput($any($event.target).value)"/>
                                @if (filterString) {
                                    <i (click)="clearFilter()" class="pi pi-times clear-icon" style="cursor: pointer"></i>
                                }
                            </p-iconfield>
                        }
                        @if (toggleableColumns().length) {
                            <p-buttonGroup class="inspection-column-visibility-buttons">
                                @for (col of toggleableColumns(); track col.key) {
                                    <p-button class="inspection-column-visibility-button"
                                              [severity]="isColumnVisible(col) ? 'primary' : 'secondary'"
                                              [outlined]="!isColumnVisible(col)"
                                              (click)="toggleColumnVisibility($event, col)"
                                              [pTooltip]="(isColumnVisible(col) ? 'Hide ' : 'Show ') + col.header + ' column'"
                                              [tooltipOptions]="{appendTo: 'body'}"
                                              tooltipPosition="bottom"
                                              [attr.aria-pressed]="isColumnVisible(col)"
                                              [attr.aria-label]="(isColumnVisible(col) ? 'Hide ' : 'Show ') + col.header + ' column'">
                                        <span class="material-symbols-outlined">
                                            {{ col.toggleIcon || 'view_column' }}
                                        </span>
                                    </p-button>
                                }
                            </p-buttonGroup>
                        }
                    </div>
                }
            </ng-template>

            <ng-template pTemplate="colgroup">
                <colgroup>
                    @for (col of visibleColumns(); track col.key) {
                        <col [style.width]="col.width"/>
                    }
                </colgroup>
            </ng-template>

            <ng-template pTemplate="header">
                <tr>
                    @for (col of visibleColumns(); track col.key) {
                        <th ttResizableColumn>
                            <div class="inspection-header-content">
                                <span class="inspection-header-label">{{ col.header }}</span>
                                @if (col.key === "key") {
                                    <p-buttonGroup class="table-header-buttons"
                                                   (mousedown)="$event.stopPropagation()">
                                        <p-button class="table-header-button"
                                                  severity="secondary"
                                                  (click)="toggleFullExpansion($event)"
                                                  [disabled]="fullCollapseActive"
                                                  [pTooltip]="fullExpansionActive ? 'Restore expanded state' : 'Expand all nodes'"
                                                  [tooltipOptions]="{appendTo: 'body'}"
                                                  tooltipPosition="bottom"
                                                  [attr.aria-label]="fullExpansionActive ? 'Restore expanded state' : 'Expand all nodes'">
                                            <span class="material-symbols-outlined">
                                                {{ fullExpansionActive ? 'settings_backup_restore' : 'unfold_more' }}
                                            </span>
                                        </p-button>
                                        <p-button class="table-header-button"
                                                  severity="secondary"
                                                  (click)="toggleFullCollapse($event)"
                                                  [disabled]="fullExpansionActive"
                                                  [pTooltip]="fullCollapseActive ? 'Restore collapsed state' : 'Collapse all nodes'"
                                                  [tooltipOptions]="{appendTo: 'body'}"
                                                  tooltipPosition="bottom"
                                            [attr.aria-label]="fullCollapseActive ? 'Restore collapsed state' : 'Collapse all nodes'">
                                            <span class="material-symbols-outlined">
                                                {{ fullCollapseActive ? 'settings_backup_restore' : 'unfold_less' }}
                                            </span>
                                        </p-button>
                                    </p-buttonGroup>
                                }
                            </div>
                        </th>
                    }
                </tr>
            </ng-template>

            <ng-template pTemplate="body" let-rowNode let-rowData="rowData">
                @if (rowData) {
                    <tr [ttRow]="rowNode"
                        [attr.data-inspection-node-id]="rowData['nodeId']"
                        (click)="onRowClick($event, rowNode)"
                        (mouseenter)="onRowHover(rowData)"
                        (mouseleave)="onRowHoverExit(rowData)"
                        [ngClass]="getRowClasses(rowData)">
                        @for (col of visibleColumns(); track $index) {
                            <td [class]="getStyleClassByType(rowData) + ' inspection-tree-cell'"
                                [pTooltip]="valueCellUsesBubblePopover(rowNode, rowData, col.key) ? '' : cellTooltip(rowNode, rowData, col.key)"
                                tooltipPosition="left"
                                [tooltipOptions]="tooltipOptions"
                                (mouseenter)="onValueCellMouseEnter($event, rowNode, rowData, col.key)"
                                (mouseleave)="onValueCellMouseLeave(col.key)">
                                <div [class.inspection-first-cell-content]="$index === 0"
                                     [class.inspection-value-cell-content]="col.key === 'value'"
                                     class="inspection-cell-content">
                                    @if ($index === 0) {
                                        @if (shouldShowRowActions(rowNode, rowData)) {
                                            <button type="button"
                                                    class="inspection-row-actions"
                                                    (click)="onRowActionsClick($event, rowNode, rowData)"
                                                    pTooltip="Row actions"
                                                    tooltipPosition="top">...</button>
                                        }
                                        <span class="inspection-row-toggle" (click)="$event.stopPropagation()">
                                            <p-treeTableToggler [rowNode]="rowNode"/>
                                        </span>
                                    }
                                    @if (shouldShowValueCopyButton(rowNode, rowData, col.key)) {
                                        <p-button class="inspection-value-copy-button"
                                                  severity="secondary"
                                                  (click)="copyNodeValue($event, rowData)"
                                                  pTooltip="Copy"
                                                  [tooltipOptions]="{appendTo: 'body'}"
                                                  tooltipPosition="left">
                                            <span class="material-symbols-outlined">content_copy</span>
                                        </p-button>
                                    }
                                    @if (col.key === "value" && shouldShowValueBubbles(rowNode, rowData)) {
                                        <span class="inspection-value-bubbles">
                                            @for (bubble of rowData["valueBubbles"]; track bubble.targetNodeId + ':' + bubble.label + ':' + $index) {
                                                @if (hasBubbleChildren(bubble)) {
                                                    <span class="inspection-value-bubble-group">
                                                        @for (child of bubble.children; track child.targetNodeId + ':' + child.label + ':' + $index) {
                                                            <span class="inspection-value-bubble-frame"
                                                                  (mouseenter)="onValueBubbleHover(child)"
                                                                  (mouseleave)="onValueBubbleHoverExit(rowData)">
                                                                <button type="button"
                                                                        class="inspection-value-bubble"
                                                                        [ngClass]="valueBubbleClasses(child)"
                                                                        (click)="onValueBubbleClick($event, child)">
                                                                    {{ child.label }}
                                                                </button>
                                                                <button type="button"
                                                                        class="inspection-value-bubble-copy"
                                                                        (click)="copyValueBubble($event, child)">
                                                                    <span class="material-symbols-outlined">content_copy</span>
                                                                </button>
                                                            </span>
                                                        }
                                                    </span>
                                                } @else {
                                                    <span class="inspection-value-bubble-frame"
                                                          (mouseenter)="onValueBubbleHover(bubble)"
                                                          (mouseleave)="onValueBubbleHoverExit(rowData)">
                                                        <button type="button"
                                                                class="inspection-value-bubble"
                                                                [ngClass]="valueBubbleClasses(bubble)"
                                                                (click)="onValueBubbleClick($event, bubble)">
                                                            {{ bubble.label }}
                                                        </button>
                                                        <button type="button"
                                                                class="inspection-value-bubble-copy"
                                                                (click)="copyValueBubble($event, bubble)">
                                                            <span class="material-symbols-outlined">content_copy</span>
                                                        </button>
                                                    </span>
                                                }
                                            }
                                        </span>
                                    } @else if (col.key === "value" && isFeatureIdValueRow(rowData)) {
                                        <a href=""
                                           (click)="onFeatureIdLinkClick($event, rowData)"
                                           (mouseenter)="onNodeValueHover(rowData, col.key)"
                                           (mouseleave)="onNodeValueHoverExit(rowData, col.key)"
                                           style="cursor: pointer"
                                           [class.inspection-feature-id-pill]="isHoveredFeatureIdValue(rowData, col.key)"
                                           [style.overflow]="filterFields.indexOf(col.key) !== -1 ? 'hidden' : null"
                                           [style.white-space]="filterFields.indexOf(col.key) !== -1 ? 'nowrap' : null"
                                           [style.text-overflow]="filterFields.indexOf(col.key) !== -1 ? 'ellipsis' : null"
                                           [innerHTML]="filterFields.indexOf(col.key) !== -1 ? (col.transform(col.key, rowData) | highlight: filterString) : col.transform(col.key, rowData)">
                                        </a>
                                    } @else {
                                        <span (click)="onNodeClick($event, rowData, col.key)"
                                              (mouseenter)="onNodeValueHover(rowData, col.key)"
                                              (mouseleave)="onNodeValueHoverExit(rowData, col.key)"
                                              style="cursor: pointer"
                                              [class.inspection-feature-id-pill]="isHoveredFeatureIdValue(rowData, col.key)"
                                              [style.overflow]="filterFields.indexOf(col.key) !== -1 ? 'hidden' : null"
                                              [style.white-space]="filterFields.indexOf(col.key) !== -1 ? 'nowrap' : null"
                                              [style.text-overflow]="filterFields.indexOf(col.key) !== -1 ? 'ellipsis' : null"
                                              [innerHTML]="filterFields.indexOf(col.key) !== -1 ? (col.transform(col.key, rowData) | highlight: filterString) : col.transform(col.key, rowData)">
                                        </span>
                                    }
                                    @if (col.key === "key" && hasKeyBubbles(rowData)) {
                                        <span class="inspection-key-bubbles">
                                            @for (bubble of rowData["keyBubbles"]; track bubble.kind + ':' + bubble.label + ':' + $index) {
                                                <span class="inspection-key-bubble"
                                                      [ngClass]="keyBubbleClasses(bubble)"
                                                      [pTooltip]="keyBubbleTooltip(bubble)"
                                                      tooltipPosition="top">
                                                    {{ bubble.label }}
                                                </span>
                                            }
                                        </span>
                                    }
                                    @if (rowData.hasOwnProperty("geometryNameBubble") && $index === 0) {
                                        <span class="inspection-geometry-name-badge">{{rowData["geometryNameBubble"]}}</span>
                                    }
                                    @if (rowData.hasOwnProperty("valueCount") && $index === 0) {
                                        <p-tag class="inspection-node-count-tag"
                                               severity="info"
                                               [rounded]="true"
                                               [value]="rowData['valueCount']"
                                               [pTooltip]="'Value count: ' + rowData['valueCount']"
                                               tooltipPosition="top"/>
                                    }
                                    @if (rowData.hasOwnProperty("info") && $index !== 0) {
                                        <span>
                                            <i class="pi pi-info-circle" pTooltip="{{rowData['info']}}" tooltipPosition="top"></i>
                                        </span>
                                    }
                                    @if (enableSourceDataNavigation() &&
                                    rowData.hasOwnProperty("sourceDataReferences") &&
                                    rowData["sourceDataReferences"].length > 0 &&
                                    $index === 0) {
                                        <p-buttonGroup class="source-data-ref-container">
                                            @for (item of rowData["sourceDataReferences"]; track $index) {
                                                <p-button class="source-data-button"
                                                          (click)="showSourceData($event, item)"
                                                          severity="secondary"
                                                          label="{{ item.qualifier.substring(0, 1).toUpperCase() }}"
                                                          pTooltip="Go to {{item.qualifier?.trim()}} source data."
                                                          [tooltipOptions]="{appendTo: 'body'}"
                                                          tooltipPosition="bottom" />
                                            }
                                        </p-buttonGroup>
                                    }
                                </div>
                            </td>
                        }
                    </tr>
                }
            </ng-template>

            <ng-template pTemplate="emptymessage">
                <tr>
                    <td [attr.colspan]="visibleColumns().length">No entries found.</td>
                </tr>
            </ng-template>
        </p-treeTable>
        <p-menu #geoJsonMenu [popup]="true" [model]="geoJsonMenuItems" appendTo="body" [baseZIndex]="30000"></p-menu>
        <p-menu #inspectionMenu [model]="inspectionMenuItems" [popup]="true" [baseZIndex]="30000" appendTo="body"
                [style]="{'font-size': '0.9em'}"></p-menu>
        <p-popover *ngIf="filterOptions() !== undefined" #filterPanel class="filter-panel">
            <div class="font-bold white-space-nowrap"
                 style="display: flex; justify-items: flex-start; gap: 0.5em; flex-direction: column">
                <p-checkbox [(ngModel)]="filterOptions()!.filterByKeys" (ngModelChange)="filterTree(filterString)"
                            inputId="fbk" [binary]="true"/>
                <label for="fbk" style="margin-left: 0.5em; cursor: pointer">Filter by Keys</label>
                <p-checkbox [(ngModel)]="filterOptions()!.filterByValues" (ngModelChange)="filterTree(filterString)"
                            inputId="fbv" [binary]="true"/>
                <label for="fbv" style="margin-left: 0.5em; cursor: pointer">Filter by Values</label>
                <p-checkbox [(ngModel)]="filterOptions()!.filterOnlyFeatureIds"
                            (ngModelChange)="filterTree(filterString)"
                            inputId="fofids" [binary]="true"/>
                <label for="fofids" style="margin-left: 0.5em; cursor: pointer">Filter only FeatureIDs</label>
                <p-checkbox [(ngModel)]="filterOptions()!.filterGeometryEntries"
                            (ngModelChange)="filterTree(filterString)"
                            inputId="ige" [binary]="true"/>
                <label for="ige" style="margin-left: 0.5em; cursor: pointer">Include Geometry Entries</label>
            </div>
        </p-popover>
    `,
    standalone: false
})
/** Shared tree-table renderer for feature inspection and source-data inspection content. */
export class InspectionTreeComponent implements AfterViewInit, OnDestroy {
    private static readonly DOCK_RESIZE_PAUSE_START_EVENT = "erdblick-dock-resize-start";
    private static readonly DOCK_RESIZE_PAUSE_END_EVENT = "erdblick-dock-resize-end";
    private activeSoftHoverGroupId?: string;
    private activeStrongHoverGroupId?: string;
    private activeFeatureIdNodeId?: string;
    private activeValueBubbleTargetNodeId?: string;

    @ViewChild('tt') table!: TreeTable;
    @ViewChild('filterPanel') filterPanel!: Popover;

    data: TreeTableNode[] = [];
    treeData = input.required<TreeTableNode[]>();
    columns = input.required<Column[]>();
    panelId = input.required<number>();
    firstHighlightedItemIndex = input<number>();
    firstHighlightedItemIndex$ = toObservable(this.firstHighlightedItemIndex);
    subscriptions: Subscription[] = [];
    filterOptions = input<FeatureFilterOptions>();
    filterText = input<string | undefined>();
    filterTextChange = output<string>();
    showFilter = input<boolean>(true);
    geoJson = input<string>();
    enableSourceDataNavigation = input<boolean>(true);
    featureIds = input<string[]>([]);

    /** Returns columns currently participating in the table layout. */
    protected visibleColumns(): Column[] {
        return this.columns().filter(column => this.isColumnVisible(column));
    }

    /** Returns columns for which the caller requested a visibility control. */
    protected toggleableColumns(): Column[] {
        return this.columns().filter(column => column.toggleable);
    }

    /** Returns whether one column is currently shown. */
    protected isColumnVisible(column: Column): boolean {
        return !this.hiddenColumnKeys.has(column.key);
    }

    /** Toggles one optional column without mutating the caller-owned column definitions. */
    protected toggleColumnVisibility(event: MouseEvent, column: Column): void {
        event.stopPropagation();
        if (this.hiddenColumnKeys.has(column.key)) {
            this.hiddenColumnKeys.delete(column.key);
        } else {
            this.hiddenColumnKeys.add(column.key);
        }
        this.refreshLayout();
        this.cdr.markForCheck();
    }

    filterFields: string[] = [
        "key",
        "value"
    ];
    tooltipOptions = {
        showDelay: 1000,
        autoHide: false
    };
    filterString = "";
    private suppressFilterEmit = false;
    private lastEmittedFilterText = "";
    private readonly hiddenColumnKeys = new Set<string>();
    protected fullExpansionActive = false;
    private expansionSnapshotBeforeFullExpand?: Map<string, boolean | undefined>;
    protected fullCollapseActive = false;
    private expansionSnapshotBeforeFullCollapse?: Map<string, boolean | undefined>;
    private frozen = false;
    private manualFreezeRequested = false;
    private dockFreezeRequested = false;
    private pendingScrollerRecalcWhileFrozen = false;
    private destroyed = false;
    private resizeObserver?: ResizeObserver;
    private scrollerRecalcFrame?: number;
    private valueBubblePopoverHost?: HTMLElement;
    private valueBubblePopoverElement?: HTMLDivElement;
    private valueBubblePopoverFrame?: number;
    private readonly valueBubblePopoverGapPx = 8;
    private readonly valueBubblePopoverMarginPx = 4;
    private readonly valueBubblePopoverMaxWidthPx = 1024;
    private readonly valueBubblePopoverPreferredWidthPx = 720;
    private readonly onWindowResize = () => this.scheduleScrollerRecalc();
    private readonly onDockResizePauseStart = () => {
        this.dockFreezeRequested = true;
        this.applyFreezeState();
    };
    private readonly onDockResizePauseEnd = () => {
        this.dockFreezeRequested = false;
        this.applyFreezeState();
    };

    @ViewChild('inspectionMenu') inspectionMenu!: Menu;
    inspectionMenuItems: MenuItem[] | undefined;
    @ViewChild('geoJsonMenu') geoJsonMenu!: Menu;
    geoJsonMenuItems: MenuItem[] = [];

    constructor(private cdr: ChangeDetectorRef,
                private clipboardService: ClipboardService,
                public mapService: InspectionSelectionService,
                private jumpService: JumpTargetService,
                public stateService: AppStateService,
                private messageService: InfoMessageService,
                private featureSearchService: FeatureSearchService) {
        effect(() => {
            this.savePanelExpansionState();
            this.data = this.treeData();
            this.fullExpansionActive = false;
            this.expansionSnapshotBeforeFullExpand = undefined;
            this.fullCollapseActive = false;
            this.expansionSnapshotBeforeFullCollapse = undefined;
            this.applyInitialExpansion(this.data);
            this.restorePanelExpansionState(this.data);

            this.refreshLayout();
            this.scrollToHighlightedIndex(this.firstHighlightedItemIndex());
            this.cdr.markForCheck();
        });
        effect(() => {
            const sharedFilter = this.filterText();
            if (sharedFilter === undefined || sharedFilter === this.filterString) {
                return;
            }
            this.suppressFilterEmit = true;
            this.filterString = sharedFilter;
            this.filterTree(sharedFilter);
            this.lastEmittedFilterText = sharedFilter;
            this.suppressFilterEmit = false;
            this.cdr.markForCheck();
        });
        this.subscriptions.push(this.firstHighlightedItemIndex$.subscribe(index => {
            this.scrollToHighlightedIndex(index);
        }));
        this.subscriptions.push(this.stateService.inspectionTreeExpandByDefaultState.subscribe(expandByDefault => {
            if (!this.data.length) {
                return;
            }
            if (expandByDefault) {
                this.setTreeExpansion(this.data, true, true);
            } else if (this.isFeatureInspectionTree(this.data)) {
                this.expandTreeNodes(this.data);
            }
            this.fullExpansionActive = false;
            this.expansionSnapshotBeforeFullExpand = undefined;
            this.fullCollapseActive = false;
            this.expansionSnapshotBeforeFullCollapse = undefined;
            this.data = [...this.data];
            this.savePanelExpansionState();
            this.refreshLayout();
            this.cdr.markForCheck();
        }));
        this.subscriptions.push(this.stateService.inspectionValueVaryColorsState.subscribe(() => this.cdr.markForCheck()));
        this.subscriptions.push(this.stateService.inspectionValueVaryOutlinesState.subscribe(() => this.cdr.markForCheck()));
        this.subscriptions.push(this.stateService.inspectionValueVaryStripingState.subscribe(() => this.cdr.markForCheck()));
    }

    /** Attaches resize observers and window listeners once the PrimeNG tree has been rendered. */
    ngAfterViewInit() {
        this.scheduleScrollerRecalc();
        const hostElement = (this.table as any)?.el?.nativeElement as HTMLElement | undefined;
        if (hostElement) {
            this.resizeObserver = new ResizeObserver(() => this.scheduleScrollerRecalc());
            this.resizeObserver.observe(hostElement);
            const container = hostElement.closest(".resizable-container");
            if (container instanceof HTMLElement) {
                this.resizeObserver.observe(container);
            }
        }
        window.addEventListener("resize", this.onWindowResize);
        window.addEventListener(InspectionTreeComponent.DOCK_RESIZE_PAUSE_START_EVENT, this.onDockResizePauseStart);
        window.addEventListener(InspectionTreeComponent.DOCK_RESIZE_PAUSE_END_EVENT, this.onDockResizePauseEnd);
    }

    /** Releases resize listeners, pending frames, and reactive subscriptions. */
    ngOnDestroy() {
        this.savePanelExpansionState();
        this.unfreeze();
        this.destroyed = true;
        this.resizeObserver?.disconnect();
        this.resizeObserver = undefined;
        window.removeEventListener("resize", this.onWindowResize);
        window.removeEventListener(InspectionTreeComponent.DOCK_RESIZE_PAUSE_START_EVENT, this.onDockResizePauseStart);
        window.removeEventListener(InspectionTreeComponent.DOCK_RESIZE_PAUSE_END_EVENT, this.onDockResizePauseEnd);
        if (this.scrollerRecalcFrame !== undefined) {
            window.cancelAnimationFrame(this.scrollerRecalcFrame);
            this.scrollerRecalcFrame = undefined;
        }
        if (this.valueBubblePopoverFrame !== undefined) {
            window.cancelAnimationFrame(this.valueBubblePopoverFrame);
            this.valueBubblePopoverFrame = undefined;
        }
        this.valueBubblePopoverHost?.remove();
        this.valueBubblePopoverHost = undefined;
        this.valueBubblePopoverElement = undefined;
        this.subscriptions.forEach(s => s.unsubscribe());
    }

    /** Suspends change detection and scroller work while an outer drag operation is in progress. */
    freeze(): void {
        if (this.destroyed) {
            return;
        }
        this.manualFreezeRequested = true;
        this.applyFreezeState();
    }

    /** Reattaches change detection after a temporary freeze. */
    unfreeze(): void {
        if (this.destroyed) {
            return;
        }
        this.manualFreezeRequested = false;
        this.applyFreezeState();
    }

    /** Combines manual freezes with dock resize freezes into one effective state flag. */
    private shouldStayFrozen(): boolean {
        return this.manualFreezeRequested || this.dockFreezeRequested;
    }

    /** Applies the effective freeze state and replays any deferred scroller recalculation. */
    private applyFreezeState(): void {
        const shouldFreeze = this.shouldStayFrozen();
        if (shouldFreeze) {
            if (!this.frozen) {
                this.frozen = true;
                this.cdr.detach();
            }
            return;
        }

        if (!this.frozen) {
            return;
        }

        this.frozen = false;
        this.cdr.reattach();
        this.cdr.detectChanges();
        const hadPendingRecalc = this.pendingScrollerRecalcWhileFrozen;
        this.pendingScrollerRecalcWhileFrozen = false;
        if (hadPendingRecalc) {
            this.scheduleScrollerRecalc();
            return;
        }
        this.scheduleScrollerRecalc();
    }

    /** Coalesces scroller geometry recalculations onto the next animation frame. */
    private scheduleScrollerRecalc() {
        if (this.destroyed) {
            return;
        }
        if (this.frozen) {
            this.pendingScrollerRecalcWhileFrozen = true;
            return;
        }
        if (this.scrollerRecalcFrame !== undefined) {
            window.cancelAnimationFrame(this.scrollerRecalcFrame);
        }
        this.scrollerRecalcFrame = window.requestAnimationFrame(() => {
            this.scrollerRecalcFrame = undefined;
            this.recalculateScrollerGeometry();
        });
    }

    /** Public hook used by surrounding panels after size changes. */
    refreshLayout(): void {
        this.scheduleScrollerRecalc();
    }

    /** Forces PrimeNG's virtual scroller to recompute its cached geometry after layout changes. */
    private recalculateScrollerGeometry(): void {
        if (this.destroyed || this.frozen) {
            this.pendingScrollerRecalcWhileFrozen = true;
            return;
        }
        const scroller = (this.table as any)?.scrollableViewChild?.scroller;
        if (!scroller) {
            this.updateValueBubbleOverflowMarkers();
            return;
        }

        scroller.setSpacerSize?.();
        scroller.setSize?.();
        scroller.calculateOptions?.();
        scroller.setContentPosition?.();
        this.cdr.detectChanges();
        this.updateValueBubbleOverflowMarkers();
    }

    /** Marks value-bubble rows whose content is clipped so CSS can show one terminal ellipsis. */
    private updateValueBubbleOverflowMarkers(): void {
        const hostElement = (this.table as any)?.el?.nativeElement as HTMLElement | undefined;
        if (!hostElement) {
            return;
        }
        hostElement.querySelectorAll<HTMLElement>(".inspection-value-bubbles").forEach(element => {
            element.classList.toggle(
                "inspection-value-bubbles-overflowing",
                element.scrollWidth > element.clientWidth + 1
            );
        });
    }

    /** Measures the current rendered content height so parent panels can auto-size around it. */
    measurePreferredContentHeightEm(): number | undefined {
        const hostElement = (this.table as any)?.el?.nativeElement as HTMLElement | undefined;
        if (!hostElement) {
            return undefined;
        }

        const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
        if (!Number.isFinite(rootFontSize) || rootFontSize <= 0) {
            return undefined;
        }

        const filterHeightPx = hostElement.querySelector<HTMLElement>('.p-treetable-header')
            ?.getBoundingClientRect().height ?? 0;
        const headerHeightPx = hostElement.querySelector<HTMLElement>('.p-treetable-thead')
            ?.getBoundingClientRect().height ?? 0;

        let contentHeightPx = hostElement.querySelector<HTMLElement>('.p-virtualscroller-spacer')
            ?.getBoundingClientRect().height ?? 0;
        if (!contentHeightPx) {
            contentHeightPx = Array
                .from(hostElement.querySelectorAll<HTMLElement>('.p-treetable-tbody > tr'))
                .reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
        }
        if (!contentHeightPx) {
            return undefined;
        }

        const borderCompensationPx = 2;
        const totalHeightPx = filterHeightPx + headerHeightPx + contentHeightPx + borderCompensationPx;
        return totalHeightPx / rootFontSize;
    }

    /** Clears the filter input and restores the original tree. */
    clearFilter() {
        this.filterString = "";
        this.table.filterGlobal("" , 'contains');
        this.data = this.treeData();
        this.applyInitialExpansion(this.data);
        this.emitFilterChange("");
    }

    /** Handles escape-to-clear without leaking the key event to global shortcuts. */
    onKeydown(event: any) {
        event.stopPropagation();

        if (event.key === 'Escape') {
            this.clearFilter();
        }
    }

    /** Toggles row expansion unless the user clicked an explicit action control. */
    onRowClick(event: MouseEvent, rowNode: any) {
        const target = event.target as HTMLElement | null;
        if (target?.closest(".inspection-row-actions")
            || target?.closest(".inspection-value-bubble")
            || target?.closest(".p-treetable-toggler")
            || target?.closest("a")) {
            return;
        }
        const node: TreeNode = rowNode.node;
        node.expanded = !node.expanded;
        this.data = [...this.data];
        this.refreshLayout();
        this.cdr.markForCheck();
    }

    /** Opens feature-id navigation from the value column while preserving text-selection behavior. */
    onNodeClick(event: MouseEvent, rowData: any, colKey: string) {
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) {
            event.stopPropagation();
            return;
        }

        if (colKey === "value" && this.isFeatureIdValueRow(rowData)) {
            this.onValueClick(event, rowData);
        }
    }

    /** Returns whether C++ supplied propagated child-value pills for this row. */
    protected hasValueBubbles(rowData: any): boolean {
        return Array.isArray(rowData?.["valueBubbles"]) && rowData["valueBubbles"].length > 0;
    }

    /** Returns whether C++ supplied compact key-column metadata badges for this row. */
    protected hasKeyBubbles(rowData: any): boolean {
        return Array.isArray(rowData?.["keyBubbles"]) && rowData["keyBubbles"].length > 0;
    }

    /** Assigns stable kind classes for key-column metadata badges. */
    protected keyBubbleClasses(bubble: any): Record<string, boolean> {
        const kind = typeof bubble?.kind === "string" && bubble.kind.length ? bubble.kind : "metadata";
        return {
            [`inspection-key-bubble-${kind}`]: true
        };
    }

    /** Describes key-column metadata badges without forcing the label to include verbose context. */
    protected keyBubbleTooltip(bubble: any): string {
        if (bubble?.kind === "attribute-layer-id") {
            return `Attribute layer ID ${bubble?.label ?? ""}`.trim();
        }
        return "";
    }

    /** Provides one cell-level tooltip, using bubble labels only when bubbles are visibly replacing the value text. */
    protected cellTooltip(rowNode: any, rowData: any, colKey: string): string {
        if (colKey === "value" && this.shouldShowValueBubbles(rowNode, rowData)) {
            return this.valueBubbleTooltip(rowData["valueBubbles"]);
        }
        const value = rowData?.[colKey];
        return value === null || value === undefined ? "" : String(value);
    }

    /** Joins the visible bubble labels for the single value-cell tooltip. */
    private valueBubbleTooltip(bubbles: any[]): string {
        const labels: string[] = [];
        for (const bubble of bubbles) {
            const label = this.valueBubbleText(bubble);
            if (label) {
                labels.push(label);
            }
        }
        return labels.join(" ");
    }

    /** Returns the flattened visible text for one bubble. */
    private valueBubbleText(bubble: any): string {
        if (this.hasBubbleChildren(bubble)) {
            return bubble.children
                .map((child: any) => this.valueBubbleText(child))
                .filter((label: string) => label.length > 0)
                .join(" ");
        }
        return typeof bubble?.label === "string" ? bubble.label : "";
    }

    /** Returns whether a value cell should use the structured bubble popover instead of a plain tooltip. */
    protected valueCellUsesBubblePopover(rowNode: any, rowData: any, colKey: string): boolean {
        return colKey === "value" && this.shouldShowValueBubbles(rowNode, rowData);
    }

    /** Shows the structured bubble popover next to collapsed summary rows. */
    protected onValueCellMouseEnter(event: MouseEvent, rowNode: any, rowData: any, colKey: string): void {
        if (!this.valueCellUsesBubblePopover(rowNode, rowData, colKey)) {
            return;
        }
        const cell = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
        if (!cell) {
            return;
        }
        this.showValueBubblePopover(cell, rowData["valueBubbles"]);
    }

    /** Hides the structured bubble popover when the pointer leaves a value cell. */
    protected onValueCellMouseLeave(colKey: string): void {
        if (colKey !== "value") {
            return;
        }
        this.hideValueBubblePopover();
    }


    /** Builds the value-bubble popover in document.body so undocked dialogs cannot clip it. */
    private showValueBubblePopover(cell: HTMLElement, bubbles: any[]): void {
        const container = this.ensureValueBubblePopoverElement();
        const content = document.createElement("div");
        content.className = "inspection-value-bubble-popover-content";
        for (const bubble of bubbles) {
            content.appendChild(this.createValueBubblePopoverNode(bubble));
        }
        container.replaceChildren(content);
        container.style.visibility = "hidden";
        container.style.display = "block";
        container.style.width = "";
        container.style.maxWidth = `${this.valueBubblePopoverPreferredWidthPx}px`;
        this.alignValueBubblePopover(cell);
        if (this.valueBubblePopoverFrame !== undefined) {
            window.cancelAnimationFrame(this.valueBubblePopoverFrame);
        }
        this.valueBubblePopoverFrame = window.requestAnimationFrame(() => {
            this.valueBubblePopoverFrame = undefined;
            this.alignValueBubblePopover(cell);
        });
    }

    /** Returns the singleton body-level popover element used for structured value previews. */
    private ensureValueBubblePopoverElement(): HTMLDivElement {
        if (this.valueBubblePopoverElement) {
            return this.valueBubblePopoverElement;
        }
        const element = document.createElement("div");
        element.className = "inspection-value-bubble-popover";
        element.style.display = "none";
        const host = document.createElement("inspection-tree");
        host.className = "inspection-value-bubble-popover-host";
        host.appendChild(element);
        document.body.appendChild(host);
        this.valueBubblePopoverHost = host;
        this.valueBubblePopoverElement = element;
        return element;
    }

    /** Converts one bubble tree to non-interactive popover DOM while reusing normal bubble styling. */
    private createValueBubblePopoverNode(bubble: any): HTMLElement {
        if (this.hasBubbleChildren(bubble)) {
            const group = document.createElement("span");
            group.className = "inspection-value-bubble-group inspection-value-bubble-popover-group";
            for (const child of bubble.children) {
                group.appendChild(this.createValueBubblePopoverLeaf(child));
            }
            return group;
        }
        return this.createValueBubblePopoverLeaf(bubble);
    }

    /** Converts one leaf bubble to a styled non-interactive popover item. */
    private createValueBubblePopoverLeaf(bubble: any): HTMLElement {
        const item = document.createElement("span");
        item.classList.add("inspection-value-bubble", "inspection-value-bubble-popover-item");
        for (const [className, enabled] of Object.entries(this.valueBubbleClasses(bubble))) {
            if (enabled) {
                item.classList.add(className);
            }
        }
        item.textContent = this.valueBubbleText(bubble);
        return item;
    }

    /** Hides and detaches transient state for the body-level value-bubble popover. */
    private hideValueBubblePopover(): void {
        if (this.valueBubblePopoverFrame !== undefined) {
            window.cancelAnimationFrame(this.valueBubblePopoverFrame);
            this.valueBubblePopoverFrame = undefined;
        }
        if (this.valueBubblePopoverElement) {
            this.valueBubblePopoverElement.style.display = "none";
        }
    }

    /** Repositions the value popover to the left of the inspected value cell without covering it. */
    private alignValueBubblePopover(cell: HTMLElement): void {
        const container = this.valueBubblePopoverElement;
        if (!container || container.style.display === "none") {
            return;
        }
        const cellRect = cell.getBoundingClientRect();
        const desiredWidth = Math.min(
            container.scrollWidth || this.valueBubblePopoverPreferredWidthPx,
            this.valueBubblePopoverMaxWidthPx
        );
        const placement = this.calculateValueBubblePopoverPlacement(cellRect, desiredWidth);
        container.style.maxWidth = `${placement.maxWidth}px`;
        if (placement.width === undefined) {
            container.style.width = "";
        } else {
            container.style.width = `${placement.width}px`;
        }
        const top = Math.min(
            Math.max(this.valueBubblePopoverMarginPx, cellRect.top + cellRect.height / 2 - container.offsetHeight / 2),
            Math.max(this.valueBubblePopoverMarginPx, window.innerHeight - container.offsetHeight - this.valueBubblePopoverMarginPx)
        );
        container.style.left = `${placement.left}px`;
        container.style.top = `${top}px`;
        container.style.visibility = "visible";
    }

    /** Computes left-side placement and width for a value bubble popover without overlapping the source cell. */
    private calculateValueBubblePopoverPlacement(cellRect: DOMRect, desiredWidth: number): {
        left: number;
        maxWidth: number;
        width: number | undefined;
    } {
        const leftSpace = Math.max(1, cellRect.left - this.valueBubblePopoverGapPx - this.valueBubblePopoverMarginPx);
        const maxWidth = Math.max(1, Math.min(this.valueBubblePopoverMaxWidthPx, leftSpace));
        const width = desiredWidth > maxWidth ? maxWidth : undefined;
        const renderedWidth = width ?? Math.min(desiredWidth, maxWidth);
        const left = Math.max(
            this.valueBubblePopoverMarginPx,
            Math.min(
                cellRect.left - renderedWidth - this.valueBubblePopoverGapPx,
                window.innerWidth - renderedWidth - this.valueBubblePopoverMarginPx
            )
        );
        return {
            left,
            maxWidth,
            width
        };
    }

    /** Shows summary bubbles only while their source children are collapsed. */
    protected shouldShowValueBubbles(rowNode: any, rowData: any): boolean {
        if (!this.hasValueBubbles(rowData)) {
            return false;
        }
        const node = rowNode?.node as TreeNode | undefined;
        return !(this.hasChildNodes(node) && node?.expanded);
    }

    /** Returns whether a propagated bubble is a one-level visual group emitted by C++. */
    protected hasBubbleChildren(bubble: any): boolean {
        return Array.isArray(bubble?.children) && bubble.children.length > 0;
    }

    /** Assigns stable kind and color classes so grouped bubbles keep their leaf colors. */
    protected valueBubbleClasses(bubble: any): Record<string, boolean> {
        const kind = typeof bubble?.kind === "string" && bubble.kind.length ? bubble.kind : "scalar";
        const classes: Record<string, boolean> = {
            [`inspection-value-bubble-${kind}`]: true
        };
        if (this.stateService.inspectionValueVaryColors) {
            classes[`inspection-value-bubble-color-${this.valueBubbleColorIndex(bubble)}`] = true;
        }
        if (this.stateService.inspectionValueVaryOutlines) {
            classes[`inspection-value-bubble-outline-${this.valueBubbleOutlineIndex(bubble)}`] = true;
        }
        if (this.stateService.inspectionValueVaryStriping) {
            classes[`inspection-value-bubble-stripe-${this.valueBubbleStripeIndex(bubble)}`] = true;
        }
        return classes;
    }

    /** Hashes the source target/label so color and outline assignments survive regrouping. */
    private valueBubbleHash(bubble: any): number {
        const key = `${bubble?.colorKey ?? bubble?.label ?? ""}`;
        let hash = 0;
        for (let i = 0; i < key.length; ++i) {
            hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
        }
        return Math.abs(hash);
    }

    /** Maps a bubble's stable hash to the color palette. */
    private valueBubbleColorIndex(bubble: any): number {
        return this.valueBubbleHash(bubble) % 10;
    }

    /** Maps a bubble's stable hash to an additional non-color visual discriminator. */
    private valueBubbleOutlineIndex(bubble: any): number {
        if (this.isValidityBubble(bubble)) {
            return 6;
        }
        const nonValidityOutlines = [0, 1, 2, 3, 4, 5, 7];
        return nonValidityOutlines[Math.floor(this.valueBubbleHash(bubble) / 10) % nonValidityOutlines.length];
    }

    /** Maps a bubble's stable hash to a subtle background stripe discriminator. */
    private valueBubbleStripeIndex(bubble: any): number {
        return Math.floor(this.valueBubbleHash(bubble) / 80) % 5;
    }

    /** Returns whether a bubble should use the dedicated validity outline family. */
    private isValidityBubble(bubble: any): boolean {
        return typeof bubble?.kind === "string" && bubble.kind.startsWith("validity");
    }

    /** Expands and highlights the inspection row represented by one propagated value bubble. */
    protected onValueBubbleClick(event: MouseEvent, bubble: any): void {
        event.preventDefault();
        event.stopPropagation();
        const targetNodeId = bubble?.targetNodeId;
        if (typeof targetNodeId !== "string" || !targetNodeId.length) {
            return;
        }
        const targetRow = this.rowDataForNodeId(this.data, targetNodeId);
        if (bubble?.kind === "feature-id" && targetRow) {
            this.onValueClick(event, targetRow);
            return;
        }
        if (!this.expandPathToNodeId(this.data, targetNodeId)) {
            return;
        }
        this.activeValueBubbleTargetNodeId = targetNodeId;
        this.data = [...this.data];
        this.cdr.detectChanges();
        if (!this.isNodeIdVisible(targetNodeId)) {
            this.scrollToHighlightedIndex(this.visibleIndexForNodeId(this.data, targetNodeId));
        }
        this.cdr.markForCheck();
    }

    /** Copies a bubble label without also expanding/highlighting its source row. */
    protected copyValueBubble(event: MouseEvent, bubble: any): void {
        event.preventDefault();
        event.stopPropagation();
        const value = this.valueBubbleText(bubble);
        if (value) {
            this.copyToClipboard(value);
        }
    }

    /** Activates the same map hover behavior as the row represented by a bubble. */
    protected onValueBubbleHover(bubble: any): void {
        const hoverTargetNodeId = typeof bubble?.hoverTargetNodeId === "string" && bubble.hoverTargetNodeId.length
            ? bubble.hoverTargetNodeId
            : bubble?.targetNodeId;
        const targetRow = this.rowDataForNodeId(this.data, hoverTargetNodeId);
        if (!targetRow) {
            return;
        }
        if (this.isFeatureIdValueRow(targetRow)) {
            this.activeFeatureIdNodeId = typeof targetRow?.["nodeId"] === "string"
                ? targetRow["nodeId"]
                : undefined;
            this.jumpService.highlightByJumpTargetFilter(
                targetRow["mapId"],
                targetRow["value"],
                coreLib.HighlightMode.HOVER_HIGHLIGHT).then();
            return;
        }
        this.highlightRowHoverTarget(targetRow);
    }

    /** Restores the owning row hover state after leaving a bubble. */
    protected onValueBubbleHoverExit(rowData: any): void {
        this.activeFeatureIdNodeId = undefined;
        this.highlightRowHoverTarget(rowData);
    }

    /** Shows the inline copy button only for leaf rows with a non-empty value cell. */
    protected shouldShowValueCopyButton(rowNode: any, rowData: any, colKey: string): boolean {
        if (colKey !== "value"
            || this.hasValueBubbles(rowData)
            || this.hasChildNodes(rowNode?.node)
            || !rowData?.hasOwnProperty?.("value")) {
            return false;
        }
        const value = rowData["value"];
        return value !== null && value !== undefined && String(value).length > 0;
    }

    /** Copies the exact value-cell text without also toggling the row or following FeatureId links. */
    protected copyNodeValue(event: MouseEvent, rowData: any): void {
        event.preventDefault();
        event.stopPropagation();
        const value = rowData?.["value"];
        if (value === null || value === undefined || String(value).length === 0) {
            return;
        }
        this.copyToClipboard(String(value));
    }

    /** Opens the row action menu for copy/docs/search-path helpers. */
    onRowActionsClick(event: MouseEvent, rowNode: any, rowData: any) {
        this.inspectionMenu.toggle(event);
        event.stopPropagation();
        const key = rowData["key"];
        const value = this.copyableValueForRow(rowData);
        const node = rowNode?.node as TreeNode | undefined;
        const hasChildren = this.hasChildNodes(node);
        const showScalarActions = this.shouldShowScalarRowActions(rowNode, rowData);
        this.inspectionMenuItems = [];
        if (showScalarActions) {
            this.inspectionMenuItems.push(
                {
                    label: 'Copy Key/Value',
                    command: () => {
                        this.copyToClipboard(`{${key}: ${value}}`);
                    }
                },
                {
                    label: 'Open NDS.Live Docs',
                    command: () => {
                        window.open(`https://doc.nds.live/search?q=${key}`, "_blank");
                    }
                }
            );
        }
        if (showScalarActions && rowData.hasOwnProperty("geoJsonPath")) {
            const path = rowData["geoJsonPath"];
            this.inspectionMenuItems.push({
                label: 'Copy Search Path',
                command: () => {
                    if (path) {
                        this.copyToClipboard(path);
                    }
                }
            });
            const keyValueSearch = this.keyValueSearchRequestForRow(rowData);
            if (keyValueSearch) {
                this.inspectionMenuItems.push({
                    label: 'Search for key/value',
                    icon: 'pi pi-search',
                    command: () => {
                        this.featureSearchService.run(keyValueSearch.query, {
                            scope: 'auto',
                            selectedMapLayers: keyValueSearch.selectedMapLayers
                        });
                    }
                });
            }
        }
        if (hasChildren && node) {
            if (this.inspectionMenuItems.length) {
                this.inspectionMenuItems.push({separator: true});
            }
            this.inspectionMenuItems.push(
                {
                    label: 'Expand child nodes',
                    command: () => this.expandChildNodes(node)
                },
                {
                    label: 'Collapse child nodes',
                    command: () => this.collapseChildNodes(node)
                }
            );
        }
        const inspectionTarget = this.inspectionTargetForRow(rowData);
        const mapTileKey = typeof rowData?.["mapTileKey"] === "string" ? rowData["mapTileKey"] : "";
        if (inspectionTarget && mapTileKey) {
            if (this.inspectionMenuItems.length) {
                this.inspectionMenuItems.push({separator: true});
            }
            const targetLabel = inspectionTarget.includes(":relation#") ? "Relation/Validity" : "Attr/Validity";
            this.inspectionMenuItems.push({
                label: this.isInspectionTargetHighlighted(mapTileKey, inspectionTarget)
                    ? `Unhighlight ${targetLabel}`
                    : `Highlight ${targetLabel}`,
                icon: 'pi pi-bullseye',
                command: () => {
                    this.stateService.toggleInspectionFeatureHighlight(this.panelId(), mapTileKey, inspectionTarget);
                }
            });
        }
    }

    /** Returns the display value used by row-level copy actions, including collapsed bubble summaries. */
    private copyableValueForRow(rowData: any): string {
        if (this.hasValueBubbles(rowData)) {
            return this.valueBubbleTooltip(rowData["valueBubbles"]);
        }
        const value = rowData?.["value"];
        return value === null || value === undefined ? "" : String(value);
    }

    /** Returns the attribute or validity pseudo-feature id represented by a row, preferring exact validities. */
    private inspectionTargetForRow(rowData: any): string | undefined {
        const candidates = [
            rowData?.["strongHoverGroupId"],
            rowData?.["hoverId"],
            rowData?.["softHoverGroupId"]
        ];
        return candidates.find((value): value is string =>
            typeof value === "string" && (value.includes(":attribute#") || value.includes(":relation#")));
    }

    /** Checks whether this panel already highlights the requested attribute/validity target. */
    private isInspectionTargetHighlighted(mapTileKey: string, targetFeatureId: string): boolean {
        const targetBaseFeatureId = stripFeatureInspectionTarget(targetFeatureId);
        const panel = this.stateService.selection.find(item => item.id === this.panelId());
        return panel?.features.some(feature =>
            feature.mapTileKey === mapTileKey &&
            stripFeatureInspectionTarget(feature.featureId) === targetBaseFeatureId &&
            feature.featureId === targetFeatureId
        ) ?? false;
    }

    /** Builds a feature-root equality search from one scalar inspection row. */
    private keyValueSearchRequestForRow(
        rowData: any
    ): {query: string; selectedMapLayers: FeatureSearchMapLayerRef[]} | undefined {
        const path = typeof rowData?.["geoJsonPath"] === "string" ? rowData["geoJsonPath"].trim() : "";
        if (!path) {
            return undefined;
        }
        const literal = this.searchLiteralForInspectionValue(rowData);
        if (literal === undefined) {
            return undefined;
        }
        const selectedMapLayer = this.searchMapLayerForInspectionRow(rowData);
        if (!selectedMapLayer) {
            return undefined;
        }
        return {
            query: `(${path}) == (${literal})`,
            selectedMapLayers: [selectedMapLayer]
        };
    }

    /** Converts the typed inspection cell value into a Simfil literal for equality searches. */
    private searchLiteralForInspectionValue(rowData: any): string | undefined {
        const type = Number(rowData?.["type"] ?? coreLib.ValueType.NULL.value);
        if ((type & coreLib.ValueType.ARRAY.value) === coreLib.ValueType.ARRAY.value ||
            type === coreLib.ValueType.SECTION.value) {
            return undefined;
        }

        const value = rowData?.["value"];
        switch (type) {
            case coreLib.ValueType.NULL.value:
                return value === "NULL" ? "null" : this.searchLiteralForUntypedInspectionValue(value);
            case coreLib.ValueType.NUMBER.value:
                return this.searchNumberLiteral(value);
            case coreLib.ValueType.BOOLEAN.value:
                return this.searchBooleanLiteral(value);
            case coreLib.ValueType.STRING.value:
            case coreLib.ValueType.FEATUREID.value:
                return JSON.stringify(String(value ?? ""));
            default:
                return this.searchLiteralForUntypedInspectionValue(value);
        }
    }

    /** Falls back to the primitive JS value when nested inspection rows lack precise type metadata. */
    private searchLiteralForUntypedInspectionValue(value: unknown): string | undefined {
        if (typeof value === "number" || typeof value === "bigint") {
            return this.searchNumberLiteral(value);
        }
        if (typeof value === "boolean") {
            return this.searchBooleanLiteral(value);
        }
        if (typeof value !== "string") {
            return undefined;
        }
        return value.length > 0 ? JSON.stringify(value) : undefined;
    }

    /** Converts a rendered numeric inspection value without accepting malformed partial numbers. */
    private searchNumberLiteral(value: unknown): string | undefined {
        return inspectionSearchNumberLiteral(value);
    }

    /** Converts boolean inspection values regardless of whether Angular received a boolean or rendered string. */
    private searchBooleanLiteral(value: unknown): string | undefined {
        if (typeof value === "boolean") {
            return value ? "true" : "false";
        }
        if (typeof value !== "string") {
            return undefined;
        }
        const normalized = value.trim().toLowerCase();
        return normalized === "true" || normalized === "false" ? normalized : undefined;
    }

    /** Extracts the feature-search map/layer scope from the inspected feature tile key. */
    private searchMapLayerForInspectionRow(rowData: any): FeatureSearchMapLayerRef | undefined {
        const mapTileKey = typeof rowData?.["mapTileKey"] === "string" ? rowData["mapTileKey"] : "";
        if (!mapTileKey) {
            return undefined;
        }
        try {
            const [mapId, layerId] = coreLib.parseMapTileKey(mapTileKey);
            if (mapId && layerId) {
                return {mapId, layerId};
            }
        } catch (_error) {
            return undefined;
        }
        return undefined;
    }

    /** Jumps or highlights the feature referenced by a FeatureId cell. */
    onValueClick(event: any, rowData: any) {
        event.stopPropagation();
        this.jumpService.highlightByJumpTargetFilter(
            rowData["mapId"],
            rowData["value"]).then();
    }

    /** Converts the rendered feature-id anchor back into the same value-click behavior. */
    onFeatureIdLinkClick(event: MouseEvent, rowData: any) {
        event.preventDefault();
        this.onValueClick(event, rowData);
    }

    /** Activates row-based soft or strong hover highlighting while the pointer is over a row. */
    onRowHover(rowData: any) {
        this.activeSoftHoverGroupId = typeof rowData?.["softHoverGroupId"] === "string"
            ? rowData["softHoverGroupId"]
            : undefined;
        this.activeStrongHoverGroupId = typeof rowData?.["strongHoverGroupId"] === "string"
            ? rowData["strongHoverGroupId"]
            : undefined;
        this.activeFeatureIdNodeId = undefined;
        this.highlightRowHoverTarget(rowData);
    }

    /** Clears any hover highlight emitted from row-level annotations. */
    onRowHoverExit(rowData: any) {
        this.activeSoftHoverGroupId = undefined;
        this.activeStrongHoverGroupId = undefined;
        this.activeFeatureIdNodeId = undefined;
        if (!rowData.hasOwnProperty("type") &&
            !rowData.hasOwnProperty("hoverId") &&
            !rowData.hasOwnProperty("softHoverGroupId")) {
            return;
        }
        if (rowData["type"] === this.InspectionValueType.FEATUREID.value ||
            rowData["hoverId"] ||
            rowData["softHoverGroupId"]) {
            this.mapService.setHoveredFeatures([]).then();
        }
    }

    /** Highlights feature-id values independently from the row hover group. */
    onNodeValueHover(rowData: any, colKey: string) {
        if (colKey !== "value" || !this.isFeatureIdValueRow(rowData)) {
            return;
        }
        this.activeFeatureIdNodeId = typeof rowData?.["nodeId"] === "string"
            ? rowData["nodeId"]
            : undefined;
        this.jumpService.highlightByJumpTargetFilter(
            rowData["mapId"],
            rowData["value"],
            coreLib.HighlightMode.HOVER_HIGHLIGHT).then();
    }

    /** Restores row-level hover once the pointer leaves a feature-id cell. */
    onNodeValueHoverExit(rowData: any, colKey: string) {
        if (colKey !== "value" || !this.isFeatureIdValueRow(rowData)) {
            return;
        }
        this.activeFeatureIdNodeId = undefined;
        this.highlightRowHoverTarget(rowData);
    }

    /** Chooses the strongest available hover target annotation for a tree row and forwards it to the map. */
    private highlightRowHoverTarget(rowData: any) {
        const hoverId = typeof rowData["strongHoverGroupId"] === "string"
            ? String(rowData["strongHoverGroupId"])
            : typeof rowData["softHoverGroupId"] === "string"
                ? String(rowData["softHoverGroupId"])
                : typeof rowData["hoverId"] === "string"
                    ? String(rowData["hoverId"])
                    : "";
        const mapTileKey = typeof rowData["mapTileKey"] === "string"
            ? rowData["mapTileKey"]
            : undefined;
        if (!mapTileKey || !hoverId) {
            this.mapService.setHoveredFeatures([]).then();
            return;
        }
        this.mapService.setHoveredFeatures([{
            mapTileKey,
            featureId: hoverId
        }]).then();
    }

    /** Returns whether a row's value column stores a FeatureId rather than a plain scalar. */
    protected isFeatureIdValueRow(rowData: any): boolean {
        return rowData?.["type"] === this.InspectionValueType.FEATUREID.value;
    }

    /** Tracks whether a FeatureId cell currently owns the dedicated hover highlight styling. */
    isHoveredFeatureIdValue(rowData: any, colKey: string): boolean {
        return colKey === "value" &&
            this.isFeatureIdValueRow(rowData) &&
            typeof rowData?.["nodeId"] === "string" &&
            rowData["nodeId"] === this.activeFeatureIdNodeId;
    }

    /** Extracts the row depth from PrimeNG's row wrapper regardless of the current template shape. */
    private rowLevel(rowNode: any): number {
        if (typeof rowNode?.level === "number") {
            return rowNode.level;
        }
        if (typeof rowNode?.node?.level === "number") {
            return rowNode.node.level;
        }
        return 0;
    }

    /** Shows row actions when a row has useful scalar actions or subtree controls. */
    shouldShowRowActions(rowNode: any, rowData: any): boolean {
        if (this.rowLevel(rowNode) <= 0) {
            return false;
        }
        return this.shouldShowScalarRowActions(rowNode, rowData) || this.hasChildNodes(rowNode?.node);
    }

    /** Keeps copy/search/doc actions off root sections where only subtree controls are useful. */
    private shouldShowScalarRowActions(rowNode: any, rowData: any): boolean {
        return this.rowLevel(rowNode) > 0 && rowData?.["type"] !== this.InspectionValueType.SECTION.value;
    }

    /** Returns whether a PrimeNG tree wrapper has expandable children. */
    private hasChildNodes(node: TreeNode | undefined): boolean {
        return Array.isArray(node?.children) && node.children.length > 0;
    }

    /** Builds the CSS class map for geometry badges, hover groups, and special inspection rows. */
    getRowClasses(rowData: any): Record<string, boolean> {
        const strongHoverGroupId = typeof rowData?.["strongHoverGroupId"] === "string"
            ? rowData["strongHoverGroupId"]
            : undefined;
        const softHoverGroupId = typeof rowData?.["softHoverGroupId"] === "string"
            ? rowData["softHoverGroupId"]
            : undefined;
        return {
            [rowData?.styleClass ?? ""]: !!rowData?.styleClass,
            "inspection-value-bubble-target": typeof rowData?.["nodeId"] === "string" &&
                rowData["nodeId"] === this.activeValueBubbleTargetNodeId,
            "inspection-selection-soft": rowData?.["selectionHighlight"] === "soft",
            "inspection-selection-strong": rowData?.["selectionHighlight"] === "strong",
            "inspection-hover-soft": !!this.activeSoftHoverGroupId &&
                softHoverGroupId === this.activeSoftHoverGroupId,
            "inspection-hover-strong": !!this.activeStrongHoverGroupId &&
                strongHoverGroupId === this.activeStrongHoverGroupId
        };
    }

    /** Navigates from an inspection row to the referenced source-data address. */
    showSourceData(event: Event, sourceDataRef: any) {
        event.stopPropagation();
        if (!this.enableSourceDataNavigation()) {
            return;
        }
        try {
            this.stateService.setSelection({
                mapTileKey: sourceDataRef.mapTileKey,
                address: sourceDataRef.address
            } as SelectedSourceData);
        } catch (e) {
            this.messageService.showError(`Encountered error: ${e}`);
        }
    }

    /** Maps inspection value types to the CSS classes used by the table template. */
    getStyleClassByType(rowData: any): string {
        if (!rowData || !rowData.hasOwnProperty("type")) {
            return "standard-style";
        }
        switch (rowData["type"]) {
            case this.InspectionValueType.SECTION.value:
                return "section-style";
            case this.InspectionValueType.FEATUREID.value:
                return "feature-id-style";
            default:
                return "standard-style";
        }
    }

    /** Thin wrapper so menus and template actions share one clipboard helper. */
    copyToClipboard(text: string) {
        this.clipboardService.copyToClipboard(text);
    }

    /** Toggles between all nodes expanded and the expansion snapshot captured before that action. */
    protected toggleFullExpansion(event: MouseEvent) {
        event.stopPropagation();
        if (this.fullExpansionActive) {
            if (this.expansionSnapshotBeforeFullExpand) {
                this.restoreExpansionState(this.data, this.expansionSnapshotBeforeFullExpand);
            }
            this.fullExpansionActive = false;
            this.expansionSnapshotBeforeFullExpand = undefined;
        } else {
            this.expansionSnapshotBeforeFullExpand = this.captureExpansionState(this.data);
            this.setTreeExpansion(this.data, true);
            this.fullExpansionActive = true;
            this.fullCollapseActive = false;
            this.expansionSnapshotBeforeFullCollapse = undefined;
        }
        this.data = [...this.data];
        this.savePanelExpansionState();
        this.refreshLayout();
        this.cdr.markForCheck();
    }

    /** Toggles between all nodes collapsed and the expansion snapshot captured before that action. */
    protected toggleFullCollapse(event: MouseEvent) {
        event.stopPropagation();
        if (this.fullCollapseActive) {
            if (this.expansionSnapshotBeforeFullCollapse) {
                this.restoreExpansionState(this.data, this.expansionSnapshotBeforeFullCollapse);
            }
            this.fullCollapseActive = false;
            this.expansionSnapshotBeforeFullCollapse = undefined;
        } else {
            this.expansionSnapshotBeforeFullCollapse = this.captureExpansionState(this.data);
            this.collapseTreeBelowRootSections(this.data);
            this.fullCollapseActive = true;
            this.fullExpansionActive = false;
            this.expansionSnapshotBeforeFullExpand = undefined;
        }
        this.data = [...this.data];
        this.savePanelExpansionState();
        this.refreshLayout();
        this.cdr.markForCheck();
    }

    /** Expands the selected row and every descendant below it. */
    private expandChildNodes(node: TreeNode) {
        node.expanded = true;
        this.setDescendantExpansion(node, true);
        this.data = [...this.data];
        this.refreshLayout();
        this.cdr.markForCheck();
    }

    /** Collapses the selected parent and every descendant below it. */
    private collapseChildNodes(node: TreeNode) {
        node.expanded = false;
        this.setDescendantExpansion(node, false);
        this.data = [...this.data];
        this.refreshLayout();
        this.cdr.markForCheck();
    }

    /** Recursively applies expansion to descendants, excluding the supplied node itself. */
    private setDescendantExpansion(node: TreeNode, expanded: boolean) {
        for (const child of node.children ?? []) {
            if (this.hasChildNodes(child)) {
                child.expanded = expanded;
                this.setDescendantExpansion(child, expanded);
            }
        }
    }

    /** Opens the GeoJSON actions menu for the current inspection payload. */
    showGeoJsonMenu(event: MouseEvent) {
        event.stopPropagation();
        if (!this.geoJson()) {
            return;
        }
        this.geoJsonMenuItems = [
            {
                label: 'Open in new tab',
                icon: 'pi pi-external-link',
                command: () => this.openGeoJsonInNewTab()
            },
            {
                label: 'Download (.geojson)',
                icon: 'pi pi-download',
                command: () => this.downloadGeoJson()
            },
            {
                label: 'Copy to clipboard',
                icon: 'pi pi-copy',
                command: () => this.copyGeoJson()
            }
        ];
        this.geoJsonMenu.toggle(event);
    }

    /** Copies the panel GeoJSON payload to the clipboard when available. */
    copyGeoJson() {
        const data = this.geoJson();
        if (!data) {
            return;
        }
        this.copyToClipboard(data);
    }

    /** Downloads the current inspection GeoJSON as a `.geojson` file. */
    downloadGeoJson() {
        const data = this.geoJson();
        if (!data) {
            return;
        }
        const blob = new Blob([data], {type: 'application/geo+json'});
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = this.geoJsonFilename();
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        this.messageService.showSuccess('GeoJSON download started');
    }

    /** Opens the current inspection GeoJSON in a separate tab via a blob URL. */
    openGeoJsonInNewTab() {
        const data = this.geoJson();
        if (!data) {
            return;
        }
        const blob = new Blob([data], {type: 'application/geo+json'});
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        this.messageService.showSuccess('Opened GeoJSON in new tab');
    }

    private geoJsonFilename(): string {
        return `inspection-${this.panelId()}.geojson`;
    }

    /** Applies the global filter and restores default expansion when the filter is cleared. */
    filterTree(filterString: string) {
        if (!filterString) {
            this.savePanelExpansionState();
            this.data = this.treeData();
            this.applyInitialExpansion(this.data);
            this.restorePanelExpansionState(this.data);
        }

        const query = filterString.toLowerCase();
        this.table.filterGlobal(query, "contains");
    }

    /** Applies either the global expand-by-default preference or the legacy feature-tree heuristic. */
    private applyInitialExpansion(nodes: TreeTableNode[]): void {
        if (this.stateService.inspectionTreeExpandByDefault) {
            this.setTreeExpansion(nodes, true, true);
            return;
        }
        if (this.isFeatureInspectionTree(nodes)) {
            this.expandTreeNodes(nodes);
        }
    }

    /** Sets expansion state throughout a tree, optionally preserving explicit user/restored states. */
    private setTreeExpansion(nodes: TreeNode[], expanded: boolean, onlyUndefined = false): void {
        nodes.forEach(node => {
            if (this.hasChildNodes(node) && (!onlyUndefined || node.expanded === undefined)) {
                node.expanded = expanded;
            }
            if (node.children) {
                this.setTreeExpansion(node.children, expanded, onlyUndefined);
            }
        });
    }

    /** Collapses all expandable rows while keeping top-level inspection section rows open. */
    private collapseTreeBelowRootSections(nodes: TreeNode[], depth = 0): void {
        nodes.forEach(node => {
            const isRootSection = depth === 0 && node.data?.["type"] === this.InspectionValueType.SECTION.value;
            if (this.hasChildNodes(node)) {
                node.expanded = isRootSection ? true : false;
            }
            if (node.children) {
                this.collapseTreeBelowRootSections(node.children, depth + 1);
            }
        });
    }

    /** Captures current expansion values using stable node ids when available. */
    private captureExpansionState(
        nodes: TreeNode[],
        result = new Map<string, boolean | undefined>(),
        path: number[] = []
    ): Map<string, boolean | undefined> {
        nodes.forEach((node, index) => {
            const nodePath = [...path, index];
            result.set(this.expansionStateKey(node, nodePath), node.expanded);
            if (node.children) {
                this.captureExpansionState(node.children, result, nodePath);
            }
        });
        return result;
    }

    /** Saves expansion state so dock/undock remounts keep the user's current tree shape. */
    private savePanelExpansionState(): void {
        if (!this.data.length) {
            return;
        }
        const state: InspectionTreeExpansionState = {
            expandedNodes: this.captureExpansionState(this.data),
            fullExpansionActive: this.fullExpansionActive,
            fullCollapseActive: this.fullCollapseActive
        };
        if (this.expansionSnapshotBeforeFullExpand) {
            state.expansionSnapshotBeforeFullExpand = this.expansionSnapshotBeforeFullExpand;
        }
        if (this.expansionSnapshotBeforeFullCollapse) {
            state.expansionSnapshotBeforeFullCollapse = this.expansionSnapshotBeforeFullCollapse;
        }
        this.stateService.setInspectionTreeExpansionState(this.panelId(), state);
    }

    /** Restores expansion state captured by a previous component instance for the same panel. */
    private restorePanelExpansionState(nodes: TreeNode[]): void {
        const state = this.stateService.getInspectionTreeExpansionState(this.panelId());
        if (!state) {
            return;
        }
        this.restoreExpansionState(nodes, state.expandedNodes, [], false);
        this.fullExpansionActive = state.fullExpansionActive;
        this.expansionSnapshotBeforeFullExpand = state.expansionSnapshotBeforeFullExpand;
        this.fullCollapseActive = state.fullCollapseActive;
        this.expansionSnapshotBeforeFullCollapse = state.expansionSnapshotBeforeFullCollapse;
    }

    /** Restores a previously captured expansion map, collapsing new expandable nodes by default. */
    private restoreExpansionState(
        nodes: TreeNode[],
        snapshot: Map<string, boolean | undefined>,
        path: number[] = [],
        collapseMissing = true
    ): void {
        nodes.forEach((node, index) => {
            const nodePath = [...path, index];
            const key = this.expansionStateKey(node, nodePath);
            if (snapshot.has(key)) {
                node.expanded = snapshot.get(key);
            } else if (collapseMissing) {
                node.expanded = false;
            }
            if (node.children) {
                this.restoreExpansionState(node.children, snapshot, nodePath, collapseMissing);
            }
        });
    }

    /** Returns the most stable available key for expansion snapshots. */
    private expansionStateKey(node: TreeNode, path: number[]): string {
        const nodeId = node.data?.["nodeId"];
        if (typeof nodeId === "string" && nodeId.length > 0) {
            return `node:${nodeId}`;
        }
        return `path:${path.join(".")}`;
    }

    /** Synchronizes the input field, tree filter state, and shared filter text binding. */
    onFilterInput(filterString: string) {
        const nextValue = filterString ?? "";
        this.filterString = nextValue;
        this.filterTree(nextValue);
        this.emitFilterChange(nextValue);
    }

    /** Expands the inspection branches that are usually most useful on first render, preserving explicit row state. */
    expandTreeNodes(nodes: TreeTableNode[], parent: TreeTableNode | null = null): void {
        nodes.forEach(node => {
            const isTopLevelNode = parent === null;
            const isRelationTypeNode = parent && parent.data["key"] === "Relations";
            const isSection = node.data && node.data["type"] === this.InspectionValueType.SECTION.value;
            const hasSingleChild = node.children && node.children.length === 1;
            const isAttributeLayerNode = parent?.data?.["key"] === "Attribute Layers";
            const attributeCount = node.children?.length ?? 0;
            if (node.expanded === undefined) {
                node.expanded = isTopLevelNode
                    || isRelationTypeNode
                    || isSection
                    || hasSingleChild
                    || (isAttributeLayerNode && attributeCount <= 10);
            }

            if (node.children) {
                this.expandTreeNodes(node.children, node);
            }
        });
    }

    /** Opens the ancestor chain for a node id emitted by the C++ inspection converter. */
    private expandPathToNodeId(nodes: TreeNode[], targetNodeId: string): boolean {
        for (const node of nodes) {
            if (node.data?.["nodeId"] === targetNodeId) {
                node.expanded = true;
                return true;
            }
            if (node.children && this.expandPathToNodeId(node.children, targetNodeId)) {
                node.expanded = true;
                return true;
            }
        }
        return false;
    }

    /** Computes the virtual-scroll row index for an already-expanded node id. */
    private visibleIndexForNodeId(nodes: TreeNode[], targetNodeId: string): number | undefined {
        let index = 0;
        const visit = (nodeList: TreeNode[]): number | undefined => {
            for (const node of nodeList) {
                if (node.data?.["nodeId"] === targetNodeId) {
                    return index;
                }
                index += 1;
                if (node.expanded && node.children?.length) {
                    const childIndex = visit(node.children);
                    if (childIndex !== undefined) {
                        return childIndex;
                    }
                }
            }
            return undefined;
        };
        return visit(nodes);
    }

    /** Finds the rendered row data for a C++ node id. */
    private rowDataForNodeId(nodes: TreeNode[], targetNodeId: unknown): any | undefined {
        if (typeof targetNodeId !== "string" || !targetNodeId.length) {
            return undefined;
        }
        for (const node of nodes) {
            if (node.data?.["nodeId"] === targetNodeId) {
                return node.data;
            }
            const childResult = this.rowDataForNodeId(node.children ?? [], targetNodeId);
            if (childResult) {
                return childResult;
            }
        }
        return undefined;
    }

    /** Checks whether the highlighted row is already rendered inside the scroll viewport. */
    private isNodeIdVisible(targetNodeId: string): boolean {
        const hostElement = (this.table as any)?.el?.nativeElement as HTMLElement | undefined;
        if (!hostElement) {
            return false;
        }
        const targetRow = Array.from(hostElement.querySelectorAll<HTMLElement>("[data-inspection-node-id]"))
            .find(element => element.dataset["inspectionNodeId"] === targetNodeId);
        const viewport = hostElement.querySelector<HTMLElement>(".p-scroller-viewport, .p-treetable-scrollable-body");
        if (!targetRow || !viewport) {
            return false;
        }
        const rowBounds = targetRow.getBoundingClientRect();
        const viewportBounds = viewport.getBoundingClientRect();
        return rowBounds.top >= viewportBounds.top && rowBounds.bottom <= viewportBounds.bottom;
    }

    /** Scrolls virtual inspection trees to selected attr/validity rows after PrimeNG has applied data changes. */
    private scrollToHighlightedIndex(index: number | undefined): void {
        if (index === undefined) {
            return;
        }
        const scroll = () => this.table?.scrollToVirtualIndex(index);
        setTimeout(scroll, 5);
        window.requestAnimationFrame(() => {
            scroll();
            window.requestAnimationFrame(scroll);
        });
    }

    protected readonly InspectionValueType = coreLib.ValueType;

    /** Distinguishes feature trees from source-data trees so only feature trees get default expansion. */
    private isFeatureInspectionTree(nodes: TreeTableNode[]): boolean {
        const firstKey = nodes[0]?.data?.["key"];
        return firstKey === "Feature" || firstKey === "Identifiers";
    }

    /** Avoids emitting redundant filter changes back to the shared panel state. */
    private emitFilterChange(filterString: string) {
        if (this.suppressFilterEmit || this.lastEmittedFilterText === filterString) {
            return;
        }
        this.lastEmittedFilterText = filterString;
        this.filterTextChange.emit(filterString);
    }
}
