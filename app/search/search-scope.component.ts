import { ChangeDetectorRef, Component, Input, OnChanges, OnDestroy } from "@angular/core";
import { TreeNode } from "primeng/api";
import { Subscription } from "rxjs";
import { GroupTreeNode, LayerTreeNode, MapTreeNode, removeGroupPrefix } from "../mapdata/map-tree.controller";
import { MapDataService } from "../mapdata/mapdata.service";
import { MapViewState } from "../mapview/mapview.state";
import type { FeatureSearchMapLayerRef, FeatureSearchScope, FeatureSearchStateEntry } from "./search-definition.model";
import {
    DEFAULT_FEATURE_SEARCH_TILE_LEVELS,
    MAX_FEATURE_SEARCH_TILE_LEVEL,
    MIN_FEATURE_SEARCH_TILE_LEVEL,
    normalizeFeatureSearchFeatureTypes
} from "./search-definition.model";
import type { FeatureSearchSession, FeatureSearchSessionSchemaAnalysis } from "./search-session.model";
import { SearchService } from "./search.service";

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
/** Owns source/scope selector drafts and their catalog subscriptions for one search dialog. */
@Component({selector: "search-scope", standalone: false, host: {style: "display:contents"}, template: `            <div class="feature-search-layer-control"
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
                                   data-testid="feature-search-levels"
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
                              data-testid="feature-search-scope"
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
`})
export class SearchScopeComponent implements OnChanges, OnDestroy {
    @Input({required: true}) searchId!: string;
    @Input() session?: Readonly<FeatureSearchSession>;
    @Input() definition?: FeatureSearchStateEntry;
    @Input() analysis?: FeatureSearchSessionSchemaAnalysis;
    private readonly subscriptions = new Subscription();

    /** Catalog and view changes update this selector without involving the dialog shell. */
    constructor(public searchService: SearchService, public mapService: MapDataService,
        public readonly viewSettings: MapViewState,
        private readonly changeDetector: ChangeDetectorRef) {
        const refreshSelectors = () => {
            this.refresh();
            // The shell is OnPush: idle or disabled searches have no progress
            // updates to reveal new catalog entries or a second view selector.
            this.changeDetector.markForCheck();
        };
        this.subscriptions.add(this.mapService.maps$.subscribe(refreshSelectors));
        this.subscriptions.add(this.viewSettings.numViewsState.subscribe(refreshSelectors));
    }

    /** Synchronizes read-only current values, retaining local tree expansion. */
    ngOnChanges(): void { this.refresh(); }

    /** Releases the per-dialog catalog observers. */
    ngOnDestroy(): void { this.subscriptions.unsubscribe(); }

    /** Resolves current catalog options and applies this session's selector values. */
    private refresh(): void {
        this.refreshMapLayerTreeOptions();
        this.refreshSearchFeatureTypeOptions(this.session);
        this.refreshSearchTileLevelOptions(this.session);
        this.refreshSearchViewOptions();
        const session = this.session;
        if (!session || session.id !== this.searchId) return;
        this.featureSearchScope = session.definition.scope;
        this.syncMapLayerTreeSelection(session);
        this.syncSelectedFeatureTypesFromSession(session);
        this.syncSelectedTileLevelsFromSession(session);
        this.syncSelectedViewIndicesFromSession(session);
    }

    /** Prevents selector edits while the search is disabled. */
    protected searchEnabled(): boolean { return this.session?.definition.enabled ?? true; }

    /** Commits a semantic scope selection, leaving the runtime session controller-owned. */
    protected onFeatureSearchScopeChange(scope: FeatureSearchScope): void {
        this.featureSearchScope = scope;
        if (this.session && this.searchEnabled() && this.session.definition.scope !== scope) {
            this.searchService.state.patchFeatureSearch(this.searchId, {scope});
        }
    }

    mapLayerTreeOptions: TreeNode<FeatureSearchLayerTreeNodeData>[] = [];

    selectedMapLayerTreeNodes: TreeNode<FeatureSearchLayerTreeNodeData>[] = [];

    featureSearchFeatureTypeOptions: FeatureSearchFeatureTypeOption[] = [];

    selectedFeatureTypes: string[] = [];

    featureSearchTileLevelOptions: FeatureSearchTileLevelOption[] = [];

    selectedTileLevels: number[] = [...DEFAULT_FEATURE_SEARCH_TILE_LEVELS];

    featureSearchViewOptions: FeatureSearchViewOption[] = [];

    selectedViewIndices: number[] = [];

    private mapLayerTreeOptionsSignature = "";

    // PrimeNG supports null at runtime to disable tree selection, but its TreeSelect type excludes it.
    protected readonly mapLayerTreeSelectionMode = null as unknown as "single";

    private mapLayerTreeSelectionState = new Map<string, FeatureSearchLayerTreeNodeSelectionState>();

    private mapLayerTreeExpandedKeys = new Set<string>();

    private mapLayerTreeExpansionInitialized = false;

    private selectedMapLayersSignature = "";

    private selectedSearchMapLayersCacheSignature = "";

    private selectedSearchMapLayersCache: FeatureSearchMapLayerRef[] = [];

    private featureSearchFeatureTypeOptionsSignature = "";

    private selectedFeatureTypesSignature = "";

    private searchTileLevelOptionsSignature = "";

    private selectedTileLevelsSignature = "";

    private searchViewOptionsSignature = "";

    private selectedViewIndicesSignature = "";

    featureSearchScope: FeatureSearchScope = 'auto';

    featureSearchScopeOptions: FeatureSearchScopeOption[] = [
        { label: 'Auto', value: 'auto' },
        { label: 'Attribute', value: 'attribute' },
        { label: 'Feature', value: 'feature' }
    ];

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
                const featureTypeSignature = this.mapService.featureTypesForLayer(mapId, layer.id)
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
                data: { kind: "group" },
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
            data: { kind: "map", mapId: node.id },
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
        const visit = (node: TreeNode<FeatureSearchLayerTreeNodeData>): { selected: number; total: number } => {
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
                return { selected: selected ? 1 : 0, total: 1 };
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
            return { selected, total };
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

    /** Reflect confirmed scope edits, including MCP edits, without losing tree expansion. */
    private syncMapLayerTreeSelection(session: FeatureSearchSession): void {
        this.refreshMapLayerTreeOptions();
        const selectedKeys = new Set(session.definition.selectedMapLayers
            .map(ref => this.searchLayerKey(ref.mapId, ref.layerId)));
        this.selectedMapLayersSignature = this.mapLayerKeySignature(selectedKeys);
        this.setSelectedMapLayerTreeLeafKeys(selectedKeys, new Set(this.mapLayerTreeExpandedKeys));
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
        this.searchService.setSearchMapLayers(
            session.id,
            this.selectedMapLayerRefsFromTreeNodes(this.selectedMapLayerTreeNodes)
        );
    }

    protected onSearchMapLayerTreeNodeExpansionChange(
        event?: { node?: TreeNode<FeatureSearchLayerTreeNodeData> },
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
            this.selectedSearchMapLayersCache = refs.map(ref => ({ ...ref }));
        }
        return this.selectedSearchMapLayersCache;
    }

    /** Rebuilds the feature-type selector from the currently selected map/layer scope. */
    private refreshSearchFeatureTypeOptions(session?: FeatureSearchSession): void {
        const options = this.availableSearchFeatureTypes(session)
            .map(featureType => ({ label: featureType, value: featureType }));
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
            for (const type of this.mapService.featureTypesForLayer(layer.mapId, layer.id)) {
                featureTypes.add(type);
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
        const nextTypes = this.mapService.canPruneStateForCurrentCatalog()
            ? persistedTypes.filter(type => availableTypes.has(type))
            : persistedTypes;
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
        return this.viewSettings.numViews === 2 && this.featureSearchViewOptions.length === 2;
    }

    private refreshSearchViewOptions(): void {
        const viewLabels = ["Left", "Right"];
        const options = Array.from(
            { length: Math.min(this.viewSettings.numViews, viewLabels.length) },
            (_, index) => ({ label: viewLabels[index], value: index })
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
            this.viewSettings.numViews === 1 ? [0] : session.definition.selectedViewIndices
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
}
