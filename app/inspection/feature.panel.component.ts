import {ChangeDetectorRef, Component, effect, input, NgZone, OnDestroy, output, ViewChild} from "@angular/core";
import {TreeTableNode} from "primeng/api";
import {MapTileStreamService} from "../mapdata/map-tile-stream.service";
import {coreLib} from "../integrations/wasm";
import {InspectionPanelModel} from "../shared/appstate.service";
import {FeatureWrapper} from "../mapdata/features.model";
import {Column, FeatureFilterOptions, InspectionTreeComponent} from "./inspection.tree.component";
import {Feature} from '../../build/libs/core/erdblick-core';
import {Subscription} from "rxjs";
import {stripFeatureInspectionTarget} from "../shared/tile-feature-id";

/** Click target metadata emitted by C++ for propagated scalar value pills. */
interface InspectionValueBubble {
    label: string;
    targetNodeId?: string;
    hoverTargetNodeId?: string;
    kind?: string;
    colorKey?: string;
    children?: InspectionValueBubble[];
}

/** Shape emitted by the WASM inspection converter for one inspection subtree. */
interface InspectionModelData {
    key: string;
    type: number;
    value: any;
    info?: string;
    hoverId?: string;
    geoJsonPath?: string;
    mapId?: string;
    nodeId?: string;
    valueCount?: string;
    valueBubbles?: InspectionValueBubble[];
    sourceDataReferences?: Array<object>;
    children: Array<InspectionModelData>;
}

@Component({
    selector: 'feature-panel',
    template: `
        <div style="position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; min-height: 0;">
            @if (loading) {
                <div style="position: absolute; inset: 0; z-index: 1; display: flex; align-items: center; justify-content: center; background: rgba(255, 255, 255, 0.55);">
                    <p-progressSpinner ariaLabel="loading"/>
                </div>
            }
            <inspection-tree [treeData]="treeData" [columns]="columns" [panelId]="panel().id"
                             [geoJson]="geoJson"
                             [featureIds]="featureIds"
                             [firstHighlightedItemIndex]="firstHighlightedItemIndex"
                             [filterText]="filterText()" (filterTextChange)="filterTextChange.emit($event)"
                             [showFilter]="showFilter()"
                             [enableSourceDataNavigation]="enableSourceDataNavigation()"
                             style="flex: 1 1 auto; min-height: 0;">
            </inspection-tree>
        </div>
    `,
    standalone: false
})
/** Renders feature inspection data and keeps it in sync while staged tiles continue loading. */
export class FeaturePanelComponent implements OnDestroy {

    panel = input.required<InspectionPanelModel<FeatureWrapper>>();
    enableSourceDataNavigation = input<boolean>(true);
    filterText = input<string | undefined>();
    filterTextChange = output<string>();
    showFilter = input<boolean>(true);

    treeData: TreeTableNode[] = [];
    columns: Column[] = [
        { key: "key",   header: "Key",   width: '0*', transform: this.formatData.bind(this) },
        { key: "value", header: "Value", width: '0*', transform: this.formatData.bind(this) }
    ];
    filterOptions = new FeatureFilterOptions();
    geoJson: string = "";
    featureIds: string[] = [];
    selectedFeatures?: FeatureWrapper[];
    loading: boolean = false;
    firstHighlightedItemIndex?: number;
    private readonly tileUpdateSubscription: Subscription;
    private rebuildQueued = false;
    private destroyed = false;

    @ViewChild(InspectionTreeComponent) inspectionTree?: InspectionTreeComponent;

    constructor(private mapService: MapTileStreamService,
                private cdr: ChangeDetectorRef,
                private ngZone: NgZone) {
        effect(() => {
            this.panel();
            this.scheduleInspectionTreeRebuild();
        });
        this.tileUpdateSubscription = this.mapService.selectionTileUpdated.subscribe(tileKey => {
            const selectedFeatures = this.panel().features ?? [];
            const hasUpdatedSelectionTile = selectedFeatures.some(feature => feature.mapTileKey === tileKey);
            if (!hasUpdatedSelectionTile) {
                return;
            }
            this.scheduleInspectionTreeRebuild();
        });
    }

    /** Tears down staged-selection listeners so closed panels stop rebuilding. */
    ngOnDestroy() {
        this.destroyed = true;
        this.tileUpdateSubscription.unsubscribe();
    }

    /** Rebuilds the tree immediately and refreshes the virtual scroller geometry. */
    refresh() {
        this.rebuildInspectionTree();
        this.inspectionTree?.refreshLayout();
    }

    /** Forwards layout refreshes to the shared inspection tree component. */
    refreshLayout() {
        this.inspectionTree?.refreshLayout();
    }

    /** Returns the current content height so docked panels can auto-expand to fit. */
    measurePreferredHeightEm(): number | undefined {
        return this.inspectionTree?.measurePreferredContentHeightEm();
    }

    /** Coalesces multiple tile updates into one rebuild to avoid thrashing Angular change detection. */
    private scheduleInspectionTreeRebuild(): void {
        if (this.rebuildQueued || this.destroyed) {
            return;
        }
        this.rebuildQueued = true;
        queueMicrotask(() => {
            this.rebuildQueued = false;
            if (this.destroyed) {
                return;
            }
            this.ngZone.run(() => {
                this.rebuildInspectionTree();
                this.cdr.markForCheck();
            });
        });
    }

    /** Re-reads GeoJSON and inspection trees from the selected features when staged data changes. */
    private rebuildInspectionTree() {
        const previousExpansionState = this.captureTreeExpansionState(this.treeData);
        this.selectedFeatures = this.panel().features ?? [];
        if (!this.selectedFeatures.length) {
            this.loading = false;
            this.geoJson = `{"type":"FeatureCollection","features":[]}`;
            this.featureIds = [];
            this.treeData = [];
            this.firstHighlightedItemIndex = undefined;
            return;
        }

        this.featureIds = Array.from(new Set(
            this.selectedFeatures.map(feature => stripFeatureInspectionTarget(feature.featureId))
        ));
        this.loading = this.selectedFeatures.some(feature =>
            !this.mapService.isTileInspectionDataComplete(feature.featureTile));

        const selectedFeatureInspectionModels: InspectionModelData[][] = [];
        const selectedFeatureGeoJsonTexts: string[] = [];
        this.selectedFeatures.forEach(featureWrapper => {
            if (!this.mapService.isTileInspectionDataComplete(featureWrapper.featureTile)) {
                return;
            }
            try {
                featureWrapper.peek((feature: Feature) => {
                    selectedFeatureInspectionModels.push(feature.inspectionModel() as InspectionModelData[]);
                    selectedFeatureGeoJsonTexts.push(feature.geojson() as string);
                });
            } catch (error) {
                console.error("Failed to read inspection model for selected feature.", {
                    panelId: this.panel().id,
                    mapTileKey: featureWrapper.mapTileKey,
                    featureId: featureWrapper.featureId,
                    error
                });
            }
        });
        const nextGeoJson = `{"type": "FeatureCollection", "features": [${selectedFeatureGeoJsonTexts.join(", ")}]}`;
        let nextTreeData: TreeTableNode[] = [];
        try {
            nextTreeData = this.getFeatureTreeDataFromModel(selectedFeatureInspectionModels);
        } catch (error) {
            console.error("getFeatureTreeDataFromModel failed.", {
                panelId: this.panel().id,
                selectedFeatureCount: this.selectedFeatures.length,
                error
            });
        }

        // During staged loading, keep the existing tree until inspection data is available.
        if (!nextTreeData.length && this.loading && this.treeData.length) {
            return;
        }

        this.restoreTreeExpansionState(nextTreeData, previousExpansionState);
        this.firstHighlightedItemIndex = this.highlightSelectedInspectionTarget(nextTreeData);
        this.geoJson = nextGeoJson;
        this.treeData = nextTreeData;
        this.inspectionTree?.refreshLayout();
    }

    /** Captures user-expanded and user-collapsed tree rows before rebuilding equivalent inspection nodes. */
    private captureTreeExpansionState(nodes: TreeTableNode[]): Map<string, boolean> {
        const expansionState = new Map<string, boolean>();
        const visit = (nodeList: TreeTableNode[]) => {
            for (const node of nodeList) {
                const nodeId = node.data?.["nodeId"];
                if (typeof nodeId === "string" && typeof node.expanded === "boolean") {
                    expansionState.set(nodeId, node.expanded);
                }
                visit(node.children ?? []);
            }
        };
        visit(nodes);
        return expansionState;
    }

    /** Restores expansion state for stable inspection row ids without blocking target-highlight auto-expansion. */
    private restoreTreeExpansionState(nodes: TreeTableNode[], expansionState: Map<string, boolean>): void {
        if (!expansionState.size) {
            return;
        }
        const visit = (nodeList: TreeTableNode[]) => {
            for (const node of nodeList) {
                const nodeId = node.data?.["nodeId"];
                if (typeof nodeId === "string" && expansionState.has(nodeId)) {
                    node.expanded = expansionState.get(nodeId);
                }
                visit(node.children ?? []);
            }
        };
        visit(nodes);
    }

    /** Marks and expands the inspection row or subtree addressed by a suffixed selected feature id. */
    private highlightSelectedInspectionTarget(nodes: TreeTableNode[]): number | undefined {
        const selectedTargetIds = (this.selectedFeatures ?? [])
            .map(feature => feature.featureId)
            .filter(featureId => featureId.includes(":attribute#") || featureId.includes(":relation#"));
        const exactTargetIds = new Set(selectedTargetIds);
        const parentTargetIds = new Set(selectedTargetIds
            .map(featureId => featureId.replace(/:validity#\d+$/, ""))
            .filter(featureId => featureId.includes(":attribute#") || featureId.includes(":relation#")));
        if (!exactTargetIds.size) {
            return undefined;
        }

        let highlightedNode: TreeTableNode | undefined;
        let highlightedParents: TreeTableNode[] = [];
        let selectedHighlightTarget: string | undefined;
        let selectedHighlightMode: "soft" | "strong" = "soft";
        const rowTargetsForNode = (node: TreeTableNode): string[] => {
            const data = node.data as Record<string, unknown> | undefined;
            return [
                data?.["hoverId"],
                data?.["strongHoverGroupId"],
                data?.["softHoverGroupId"]
            ].filter((value): value is string => typeof value === "string");
        };
        const findTarget = (
            node: TreeTableNode,
            parents: TreeTableNode[],
            targetIds: ReadonlySet<string>
        ): boolean => {
            const rowTargets = rowTargetsForNode(node);
            const matchedTarget = rowTargets.find(target => targetIds.has(target));
            const rowMatches = matchedTarget !== undefined;
            if (rowMatches && !highlightedNode) {
                highlightedNode = node;
                highlightedParents = parents;
                selectedHighlightTarget = matchedTarget;
                selectedHighlightMode = matchedTarget?.includes(":validity#") ? "strong" : "soft";
                for (const parent of parents) {
                    parent.expanded = true;
                }
                node.expanded = true;
                return true;
            }

            let childMatches = false;
            for (const child of node.children ?? []) {
                childMatches = findTarget(child, [...parents, node], targetIds) || childMatches;
            }
            if (childMatches) {
                node.expanded = true;
            }
            return rowMatches || childMatches;
        };

        const findInTree = (targetIds: ReadonlySet<string>) => {
            for (const node of nodes) {
                findTarget(node, [], targetIds);
            }
        };
        findInTree(exactTargetIds);
        if (!highlightedNode) {
            findInTree(parentTargetIds);
        }
        if (!highlightedNode || !selectedHighlightTarget) {
            return undefined;
        }
        for (const parent of highlightedParents) {
            parent.expanded = true;
        }
        highlightedNode.expanded = true;

        const applySelectionHighlight = (nodeList: TreeTableNode[]) => {
            for (const node of nodeList) {
                const data = node.data as Record<string, unknown> | undefined;
                const rowTargetMatches = selectedHighlightMode === "strong"
                    ? data?.["hoverId"] === selectedHighlightTarget ||
                        data?.["strongHoverGroupId"] === selectedHighlightTarget
                    : data?.["hoverId"] === selectedHighlightTarget ||
                        data?.["softHoverGroupId"] === selectedHighlightTarget;
                if (rowTargetMatches) {
                    node.data = {
                        ...(node.data ?? {}),
                        selectionHighlight: selectedHighlightMode
                    };
                }
                applySelectionHighlight(node.children ?? []);
            }
        };
        applySelectionHighlight(nodes);

        let visibleIndex = 0;
        const visibleIndexOf = (nodeList: TreeTableNode[]): number | undefined => {
            for (const node of nodeList) {
                if (node === highlightedNode) {
                    return visibleIndex;
                }
                visibleIndex += 1;
                if (node.expanded && node.children?.length) {
                    const childIndex = visibleIndexOf(node.children);
                    if (childIndex !== undefined) {
                        return childIndex;
                    }
                }
            }
            return undefined;
        };
        return visibleIndexOf(nodes);
    }

    /** Converts the WASM inspection model into PrimeNG tree nodes and annotates hover/highlight groups. */
    getFeatureTreeDataFromModel(inspectionModelsByFeature: InspectionModelData[][]) {
        interface HoverAnnotationContext {
            mapTileKey: string;
            mapId?: string;
            softHoverGroupId?: string;
            strongHoverGroupId?: string;
            nodePath: string;
            nodeIdPrefix: string;
        }

        /** Checks whether an inspection value identifies a geometry type. */
        const isGeometryTypeValue = (value: unknown): boolean => {
            if (typeof value !== "string") {
                return false;
            }
            return value === "Points" || value === "Polyline" || value === "Polygon" || value === "Mesh";
        };

        /** Extracts the geometry name bubble from an inspection tree node. */
        const extractGeometryNameBubble = (children: TreeTableNode[]): string | null => {
            const nameNode = children.find(child => child.data?.["key"] === "name");
            const name = nameNode?.data?.["value"];
            if (typeof name !== "string") {
                return null;
            }
            const trimmed = name.trim();
            if (!trimmed.length) {
                return null;
            }
            return trimmed;
        };

        /** Removes validity suffixes from displayed inspection names. */
        const stripValiditySuffix = (hoverId: string): string => {
            const validityIndex = hoverId.indexOf(":validity#");
            if (validityIndex >= 0) {
                return hoverId.slice(0, validityIndex);
            }
            return hoverId;
        };

        /** Builds a stable tree node id from the current traversal path. */
        const makeNodeId = (context: HoverAnnotationContext, key: string, ordinal: number): string =>
            `${context.nodePath}/${ordinal}:${key}`;

        /** Prefixes WASM-local bubble targets with the feature namespace used by the merged tree. */
        const prefixValueBubbleTargets = (
            bubbles: InspectionValueBubble[] | undefined,
            nodeIdPrefix: string
        ): InspectionValueBubble[] | undefined => {
            if (!Array.isArray(bubbles) || !bubbles.length) {
                return undefined;
            }
            return bubbles.map(bubble => ({
                ...bubble,
                targetNodeId: typeof bubble.targetNodeId === "string"
                    ? `${nodeIdPrefix}${bubble.targetNodeId}`
                    : bubble.targetNodeId,
                hoverTargetNodeId: typeof bubble.hoverTargetNodeId === "string"
                    ? `${nodeIdPrefix}${bubble.hoverTargetNodeId}`
                    : bubble.hoverTargetNodeId,
                children: prefixValueBubbleTargets(bubble.children, nodeIdPrefix)
            }));
        };

        /** Converts inspection model sections into PrimeNG tree table nodes. */
        const convertToTreeTableNodes = (
            dataNodes: Array<InspectionModelData> | undefined,
            context: HoverAnnotationContext
        ): TreeTableNode[] => {
            if (!Array.isArray(dataNodes) || !dataNodes.length) {
                return [];
            }
            const treeNodes: TreeTableNode[] = [];
            for (let nodeIndex = 0; nodeIndex < dataNodes.length; nodeIndex++) {
                const data = dataNodes[nodeIndex];
                const node: TreeTableNode = {};
                const valueType = Number(data?.type ?? coreLib.ValueType.NULL.value);
                let value = data?.value;
                if (valueType === coreLib.ValueType.NULL.value && data?.children === undefined) {
                    value = "NULL";
                } else if ((valueType & coreLib.ValueType.ARRAY.value)
                    && (valueType & coreLib.ValueType.NUMBER.value)
                    && Array.isArray(value)) {
                    for (let i = 0; i < value.length; i++) {
                        if (!Number.isInteger(value[i])) {
                            const strValue = String(value[i]);
                            const index = strValue.indexOf(".");
                            if (index !== -1 && strValue.length - index - 1 > 8) {
                                value[i] = Number(value[i]).toFixed(8);
                            }
                        }
                    }
                }

                if (valueType & coreLib.ValueType.ARRAY.value) {
                    if (Array.isArray(value)) {
                        value = value.join(", ");
                    } else if (value === null || value === undefined) {
                        value = "";
                    } else {
                        value = String(value);
                    }
                }

                const nodeId = typeof data?.nodeId === "string"
                    ? `${context.nodeIdPrefix}${data.nodeId}`
                    : makeNodeId(context, data?.key ?? "", nodeIndex);
                node.data = {
                    key: data?.key ?? "",
                    value: value ?? "",
                    type: valueType,
                    mapTileKey: context.mapTileKey,
                    nodeId,
                    mapId: context.mapId ?? ""
                };
                if (data?.hasOwnProperty("info")) {
                    node.data["info"] = data.info;
                }
                if (data?.hasOwnProperty("hoverId")) {
                    node.data["hoverId"] = data.hoverId;
                }
                if (data?.hasOwnProperty("mapId")) {
                    node.data["mapId"] = data.mapId;
                }
                if (data?.hasOwnProperty("geoJsonPath")) {
                    node.data["geoJsonPath"] = data.geoJsonPath;
                }
                if (data?.hasOwnProperty("sourceDataReferences")) {
                    node.data["sourceDataReferences"] = data.sourceDataReferences;
                }
                if (data?.hasOwnProperty("valueCount")) {
                    node.data["valueCount"] = data.valueCount;
                }
                const valueBubbles = prefixValueBubbleTargets(data?.valueBubbles, context.nodeIdPrefix);
                if (valueBubbles) {
                    node.data["valueBubbles"] = valueBubbles;
                }

                let nextSoftHoverGroupId = context.softHoverGroupId;
                let nextStrongHoverGroupId = context.strongHoverGroupId;
                if (typeof data?.hoverId === "string") {
                    if (data.hoverId.includes(":validity#")) {
                        nextSoftHoverGroupId = stripValiditySuffix(data.hoverId);
                        nextStrongHoverGroupId = data.hoverId;
                    } else {
                        nextSoftHoverGroupId = data.hoverId;
                        nextStrongHoverGroupId = undefined;
                    }
                }
                if (nextSoftHoverGroupId) {
                    node.data["softHoverGroupId"] = nextSoftHoverGroupId;
                }
                if (nextStrongHoverGroupId) {
                    node.data["strongHoverGroupId"] = nextStrongHoverGroupId;
                }

                const children = convertToTreeTableNodes(
                    Array.isArray(data?.children) ? data.children : [],
                    {
                        mapTileKey: context.mapTileKey,
                        mapId: typeof node.data["mapId"] === "string" ? node.data["mapId"] : context.mapId,
                        softHoverGroupId: nextSoftHoverGroupId,
                        strongHoverGroupId: nextStrongHoverGroupId,
                        nodePath: node.data["nodeId"],
                        nodeIdPrefix: context.nodeIdPrefix
                    }
                );
                if (isGeometryTypeValue(node.data["value"])) {
                    const nameBubble = extractGeometryNameBubble(children);
                    if (nameBubble) {
                        node.data["stageLabelBubble"] = nameBubble;
                    }
                }
                node.children = children;
                treeNodes.push(node);
            }
            return treeNodes;
        };

        const treeNodes: Array<TreeTableNode> = [];
        if (!Array.isArray(inspectionModelsByFeature)) {
            return treeNodes;
        }
        for (let featureIndex = 0; featureIndex < inspectionModelsByFeature.length; featureIndex++) {
            const inspectionModels = inspectionModelsByFeature[featureIndex];
            if (!Array.isArray(inspectionModels)) {
                continue;
            }
            const mapTileKey = this.selectedFeatures?.[featureIndex]?.mapTileKey ?? "";
            const mapId = this.selectedFeatures?.[featureIndex]?.featureTile.mapName ?? "";
            const nodeIdPrefix = `feature-${featureIndex}:`;
            for (const section of inspectionModels) {
                const node: TreeTableNode = {};
                const sectionNodeId = typeof section?.nodeId === "string"
                    ? `${nodeIdPrefix}${section.nodeId}`
                    : `${nodeIdPrefix}${section?.key ?? ""}`;
                node.data = {
                    key: section?.key ?? "",
                    value: section?.value ?? "",
                    type: section?.type ?? coreLib.ValueType.NULL.value,
                    nodeId: sectionNodeId,
                    mapId
                };
                if (section?.hasOwnProperty("info")) {
                    node.data["info"] = section.info;
                }
                if (section?.hasOwnProperty("sourceDataReferences")) {
                    node.data["sourceDataReferences"] = section.sourceDataReferences;
                }
                const valueBubbles = prefixValueBubbleTargets(section?.valueBubbles, nodeIdPrefix);
                if (valueBubbles) {
                    node.data["valueBubbles"] = valueBubbles;
                }
                node.children = convertToTreeTableNodes(
                    Array.isArray(section?.children) ? section.children : [],
                    {
                        mapTileKey,
                        mapId,
                        nodePath: sectionNodeId,
                        nodeIdPrefix
                    }
                );
                treeNodes.push(node);
            }
        }
        return treeNodes;
    }

    /** Column adapter used by the tree table to render the preformatted inspection fields. */
    formatData(colKey: string, rowData: any) {
        if (!colKey || !rowData.hasOwnProperty(colKey)) {
            return "";
        }

        return rowData[colKey];
    }

    /** Opens the delegated GeoJSON actions menu for the current feature selection. */
    showGeoJsonMenu(event: MouseEvent) {
        this.inspectionTree?.showGeoJsonMenu(event);
    }

    /** Delegates GeoJSON viewing to the shared inspection tree implementation. */
    openGeoJsonInNewTab() {
        this.inspectionTree?.openGeoJsonInNewTab();
    }

    /** Delegates GeoJSON download to the shared inspection tree implementation. */
    downloadGeoJson() {
        this.inspectionTree?.downloadGeoJson();
    }

    /** Delegates GeoJSON clipboard export to the shared inspection tree implementation. */
    copyGeoJson() {
        this.inspectionTree?.copyGeoJson();
    }

    /** Freezes the tree while outer drag gestures are active so PrimeNG does not relayout mid-drag. */
    freezeTree() {
        this.inspectionTree?.freeze();
    }

    /** Re-enables the tree after a temporary drag freeze. */
    unfreezeTree() {
        this.inspectionTree?.unfreeze();
    }
}
