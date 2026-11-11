import {
    ChangeDetectionStrategy,
    AfterViewInit,
    ChangeDetectorRef,
    Component,
    ElementRef,
    EventEmitter,
    Input,
    NgZone,
    OnChanges,
    OnDestroy,
    Output,
    ViewChild
} from "@angular/core";
import { TreeNode } from "primeng/api";
import { Scroller } from "primeng/scroller";
import { Tree } from "primeng/tree";
import { Subscription } from "rxjs";
import { AppStateService } from "../appstate/appstate.service";
import { InfoMessageService } from "../diagnostics/info.service";
import { InspectionPanelService } from "../inspection/inspection-panel.service";
import { InspectionSelectionService } from "../inspection/inspection-selection.service";
import { coreLib } from "../integrations/wasm.adapter";
import { LayoutService } from "../layout/layout.service";
import { MapViewState } from "../mapview/mapview.state";
import { JumpTargetService } from "../navigation/jump.service";
import type { FeatureSearchExportGroupingOption, FeatureSearchSession } from "./search-session.model";
import { FeatureSearchResultEntry } from "./search.model";
import { SearchService } from "./search.service";

interface FeatureSearchGroupingOption {
    name: string;
    value: number;
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
/** A bounded result tree owns its append cursor, grouping, hover and resize lifetime. */
@Component({selector: "search-results", changeDetection: ChangeDetectionStrategy.OnPush, standalone: false,
    host: {style: "display:flex; flex:1; flex-direction:column; min-height:0; min-width:0"},
    template: `                        <div class="feature-search-results-panel">
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
                                        [virtualScrollItemSize]="layout.baseFontSize * 2"
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
`})
export class SearchResultsComponent implements OnChanges, AfterViewInit, OnDestroy {
    @Input({required: true}) searchId!: string;
    @Input() session?: Readonly<FeatureSearchSession>;
    @Input() revision = 0;
    @Input() docked = false;
    @Output() ingressChange = new EventEmitter<{done: number; total: number}>();
    private readonly subscriptions = new Subscription();
    private destroyed = false;
    private resultTreeInput?: readonly FeatureSearchResultEntry[];
    private scrollerResizeRaf?: number;

    /** Grouping is shared persisted data; expansion, filtering, and incremental work stay local. */
    constructor(public searchService: SearchService, public jumpService: JumpTargetService,
        private readonly inspectionSelection: InspectionSelectionService, public stateService: AppStateService,
        private readonly infoMessageService: InfoMessageService, private readonly changeDetector: ChangeDetectorRef,
        private readonly ngZone: NgZone, public readonly layout: LayoutService,
        public readonly viewSettings: MapViewState, public readonly inspectionState: InspectionPanelService) {
        this.selectedGroupingOptions = this.groupingOptionsFromValues(this.searchService.state.featureSearchGrouping);
        this.subscriptions.add(this.searchService.state.featureSearchGroupingState.subscribe(values => {
            const options = this.groupingOptionsFromValues(values);
            if (this.sameGroupingOptions(this.selectedGroupingOptions, options)) return;
            this.selectedGroupingOptions = options;
            this.rebuildResultsTreeIncrementally();
        }));
    }

    /** Session revisions carry streamed mutations without passing the parent component as an API. */
    ngOnChanges(): void {
        if (this.session?.id === this.searchId) this.syncStreamingResults(this.session);
        else this.clear();
    }

    /** Observe this component's actual rendered host, including dialog/dock replacements. */
    ngAfterViewInit(): void {
        this.refreshTreeResizeObserver();
        this.scheduleTreeScrollHeightSync();
    }

    /** Cancels every scheduled append/resize before Angular removes this tree. */
    ngOnDestroy(): void {
        this.destroyed = true;
        this.subscriptions.unsubscribe();
        this.clear();
        this.resizeObserver?.disconnect();
        if (this.treeScrollHeightRaf !== undefined) cancelAnimationFrame(this.treeScrollHeightRaf);
        if (this.scrollerResizeRaf !== undefined) cancelAnimationFrame(this.scrollerResizeRaf);
    }

    /** Releases the heavy tree immediately when the owning search is closing. */
    clear(): void {
        this.cancelResultTreeAppend();
        this.results = [];
        this.resultsTree = [];
        this.resultCount = 0;
        this.resultTreeInputLength = 0;
        this.resultTreeGroupNodesByKey.clear();
        this.resultTreeRunId = "";
        this.resultTreeAutoExpandedSignature = "";
        this.resultTreeInput = undefined;
        this.showFilter = false;
        this.resultsStatus = "Loading...";
    }

    /** Captures local grouping/filter choices for an export initiated by the dialog shell. */
    exportOptions(): {grouping: FeatureSearchExportGroupingOption[]; filterValue: string} {
        return {
            grouping: this.groupingValuesFromOptions(this.selectedGroupingOptions).map(id => ({
                id, name: this.grouping.find(option => option.value === id)?.name ?? String(id)
            })),
            filterValue: this.resultTreeFilterValue
        };
    }

    /** Reports completed tree work as one semantic progress value per append chunk. */
    private publishIngress(session: FeatureSearchSession): void {
        this.ingressChange.emit({done: this.resultTreeInputLength, total: session.results.searchResults.length});
    }

    results: FeatureSearchResultEntry[] = [];

    resultCount = 0;

    resultsTree: TreeNode[] = [];

    grouping: FeatureSearchGroupingOption[] = [
        { name: 'Maps', value: 1 },
        { name: 'Layers', value: 2 },
        { name: 'Features', value: 3 },
        { name: 'Tiles', value: 4 }
    ];

    selectedGroupingOptions: FeatureSearchGroupingOption[] = [];

    showFilter: boolean = false;

    resultsStatus: string = "Loading...";

    scrollHeight: string = "28.5em";

    private resultTreeInputLength = 0;

    private resultTreeGroupingSignature = "";

    private resultTreeRunId = "";

    private resultTreeAutoExpandedSignature = "";

    private resultTreeFilterValue = "";

    private resultTreeGroupNodesByKey = new Map<string, TreeNode>();

    private resultTreeAppendRaf: number | null = null;

    private readonly resultTreeAppendBatchSize = 1000;

    private readonly resultTreeAppendFrameBudgetMs = 8;

    private resizeObserver?: ResizeObserver;

    private treeScrollHeightRaf?: number;

    @ViewChild('tree') tree!: Tree;

    @ViewChild('featureSearchTreeHost') featureSearchTreeHost?: ElementRef<HTMLElement>;

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
            const keepDockedSearchVisible = this.docked;
            const lockSelection = !!event?.originalEvent?.ctrlKey;
            this.stateService.transaction(() => {
                const panelId = this.inspectionState.setSelection(
                    [{ mapTileKey, featureId: selectedFeatureId }],
                    undefined,
                    lockSelection,
                    keepDockedSearchVisible);
                if (lockSelection && panelId !== undefined) {
                    this.inspectionState.setInspectionPanelLockedState(panelId, true);
                }
            });
            this.inspectionSelection.focusOnFeature(undefined, {
                mapTileKey,
                featureId: selectedFeatureId
            }).catch(error => this.infoMessageService.showError(error instanceof Error ? error.message : String(error)));
            return;
        }
        if (selected && selected.mapId && selected.featureId) {
            this.jumpService.highlightByJumpTargetFilter(selected.mapId, selected.featureId,
                coreLib.HighlightMode.SELECTION_HIGHLIGHT, this.viewSettings.focusedView)
                .catch(error => this.infoMessageService.showError(error instanceof Error ? error.message : String(error)));
        }
    }

    /** Mirrors result-tree hover into the map hover highlighter, including attribute-validity suffixes. */
    protected hoverResultNode(node: TreeNode): void {
        const data = node.data as { mapTileKey?: string; hoverFeatureId?: string } | undefined;
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

    protected onResultTreeFilter(event: { filter?: string | null | undefined }): void {
        this.resultTreeFilterValue = String(event?.filter ?? "");
    }

    /** Applies user changes to feature search grouping options. */
    onGroupingOptionsChange(options: FeatureSearchGroupingOption[]) {
        const groupingValues = this.groupingValuesFromOptions(options);
        this.selectedGroupingOptions = groupingValues
            .map(value => this.grouping.find(option => option.value === value))
            .filter((option): option is FeatureSearchGroupingOption => !!option);
        this.searchService.state.featureSearchGrouping = groupingValues;
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
        const data = node.data as { count?: number } | undefined;
        return typeof data?.count === "number" ? data.count : 0;
    }

    /** Updates the displayed label and cached count for one grouping node. */
    private setGroupNodeCount(node: TreeNode, label: string, value: string | number, count: number): void {
        node.data = { ...(node.data ?? {}), count };
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
                data: { count: 0 }
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
        this.results = session.results.searchResults;
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
                if (this.destroyed) return;
                this.appendStreamingResultsChunk();
                this.changeDetector.detectChanges();
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
        if (!session.results.complete || this.resultTreeInputLength < session.results.searchResults.length) {
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
        const results = session.results.searchResults;
        if (results.length <= this.resultTreeInputLength) {
            this.resultCount = results.length;
            this.publishIngress(session);
            this.updateResultTreeStatus(session.results.complete);
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
        this.publishIngress(session);
        if (this.resultTreeInputLength < results.length) {
            this.scheduleResultTreeAppend();
        }
        this.updateResultTreeStatus(session.results.complete);
        this.expandCompletedResultTreeIfReady(session);
    }

    /**
     * Synchronizes streamed result entries into the tree incrementally.
     *
     * Run, grouping, and eviction changes reset the destination tree, but the
     * expensive node creation still happens through frame-budgeted append chunks.
     */
    private syncStreamingResults(session: FeatureSearchSession): void {
        const results = session.results.searchResults;
        const groupingSignature = this.groupingValuesFromOptions(this.selectedGroupingOptions).join(',');
        const needsFullRebuild = this.resultTreeRunId !== session.runId
            || (this.resultTreeInput !== results && this.resultTreeInputLength > 0)
            || this.resultTreeGroupingSignature !== groupingSignature
            || results.length < this.resultTreeInputLength;

        this.results = results;
        this.resultTreeInput = results;
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
        this.publishIngress(session);
        this.updateResultTreeStatus(session.results.complete);
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
                    data: { count: childCount },
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
        if (!host || hostHeight <= 0 || !this.layout.baseFontSize) {
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
            this.layout.baseFontSize * 6,
            Math.floor(hostHeight - filterHeight - treeVerticalPadding)
        );
        const scrollHeight = `${nextHeight}px`;
        if (this.scrollHeight !== scrollHeight) {
            this.scrollHeight = scrollHeight;
            this.changeDetector.markForCheck();
        }

        if (this.scrollerResizeRaf !== undefined) return;
        this.scrollerResizeRaf = this.ngZone.runOutsideAngular(() => requestAnimationFrame(() => {
            this.scrollerResizeRaf = undefined;
            if (this.destroyed) return;
            const scroller = (this.tree as any)?.scroller as Scroller | undefined;
            if (scroller) {
                scroller.scrollHeight = this.scrollHeight;
                scroller.calculateAutoSize?.();
            }
        }));
    }

    /** Keeps PrimeNG's virtual scroller synchronized with actual panel layout changes. */
    private scheduleTreeScrollHeightSync(): void {
        if (this.treeScrollHeightRaf !== undefined) {
            return;
        }
        this.treeScrollHeightRaf = this.ngZone.runOutsideAngular(() => requestAnimationFrame(() => {
            this.treeScrollHeightRaf = undefined;
            if (!this.destroyed) this.syncTreeScrollHeight();
        }));
    }

    /** Observes the elements whose size changes affect the tree viewport. */
    private refreshTreeResizeObserver(): void {
        if (typeof ResizeObserver === "undefined") {
            return;
        }
        this.resizeObserver?.disconnect();
        this.resizeObserver = new ResizeObserver(() => this.scheduleTreeScrollHeightSync());
        const treeHostElement = this.featureSearchTreeHost?.nativeElement;
        if (treeHostElement) {
            this.resizeObserver.observe(treeHostElement);
        }
    }
}
