import {
    ChangeDetectorRef,
    Component,
    effect,
    input,
    NgZone,
    OnDestroy,
    output,
    ViewChild
} from "@angular/core";
import { TreeTableNode } from "primeng/api";
import { Subscription } from "rxjs";
import { Feature } from '../../build/libs/core/erdblick-core';
import { coreLib } from "../integrations/wasm.adapter";
import { FeatureWrapper, IncomingInspectionResult, readFeatureInspectionModel } from "../mapdata/feature-inspection.adapter";
import { MapDataService } from "../mapdata/mapdata.service";
import {
    formatFeatureInspectionTarget,
    hasFeatureInspectionValidity,
    isFeatureInspectionSubTarget,
    parseFeatureInspectionTarget,
    stripFeatureInspectionTarget,
    stripFeatureInspectionValidity
} from "./feature-identity.model";
import { InspectionPanelModel } from "./inspection.model";
import { Column, FeatureFilterOptions, InspectionTreeComponent } from "./inspection-tree.component";

/** Click target metadata emitted by C++ for propagated scalar value pills. */
interface InspectionValueBubble {
    label: string;
    targetNodeId?: string;
    hoverTargetNodeId?: string;
    kind?: string;
    colorKey?: string;
    children?: InspectionValueBubble[];
}

/** Non-interactive key-column badge emitted by C++ for node metadata. */
interface InspectionKeyBubble {
    label: string;
    kind?: string;
}

/** Shape emitted by the WASM inspection converter for one inspection subtree. */
interface InspectionModelData {
    key: string;
    type: number;
    value: any;
    displayValue?: string;
    scalarType?: unknown;
    info?: string;
    hoverId?: string;
    referenceHoverId?: string;
    geometryOrdinal?: number;
    pointIndex?: number;
    pointGeometryOrdinal?: number;
    originalPointCount?: number;
    reopenFeature?: boolean;
    sourceNodeId?: string;
    geoJsonPath?: string;
    mapId?: string;
    mapTileKey?: string;
    incomingLoading?: boolean;
    retryIncoming?: () => void;
    nodeId?: string;
    valueCount?: string;
    keyBubbles?: InspectionKeyBubble[];
    valueBubbles?: InspectionValueBubble[];
    sourceDataReferences?: Array<object>;
    children: Array<InspectionModelData>;
}

/** Lifetime of one deferred section, independent of the ordinary feature load. */
interface IncomingSectionState {
    controller: AbortController;
    loading: boolean;
    result?: IncomingInspectionResult;
    error?: string;
    timer?: ReturnType<typeof setTimeout>;
}

@Component({
    selector: 'feature-panel',
    template: `
        <div style="position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; min-height: 0;">
            @if (loading) {
                <div style="position: absolute; inset: 0; z-index: 1; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--p-content-background) 55%, transparent);">
                    <p-progressSpinner ariaLabel="loading"/>
                </div>
            }
            @for (warning of selectionWarnings; track warning) {
                <div role="status" data-testid="feature-representation-warning" style="padding: .5rem;">{{ warning }}</div>
            }
            <inspection-tree [treeData]="treeData" [columns]="columns" [panelId]="panel().id"
                             [geoJson]="geoJson"
                             [featureIds]="featureIds"
                             [filterText]="filterText()" (filterTextChange)="filterTextChange.emit($event)"
                             [showFilter]="showFilter()"
                             [enableSourceDataNavigation]="enableSourceDataNavigation()"
                             style="flex: 1 1 auto; min-height: 0;">
            </inspection-tree>
        </div>
    `,
    standalone: false
})
/** Renders feature-restricted inspection data. */
export class FeaturePanelComponent implements OnDestroy {

    panel = input.required<InspectionPanelModel<FeatureWrapper>>();
    enableSourceDataNavigation = input<boolean>(true);
    filterText = input<string | undefined>();
    filterTextChange = output<string>();
    showFilter = input<boolean>(true);

    treeData: TreeTableNode[] = [];
    columns: Column[] = [
        { key: "key", header: "Key", width: '0*', transform: this.formatData.bind(this) },
        { key: "value", header: "Value", width: '0*', transform: this.formatData.bind(this) }
    ];
    filterOptions = new FeatureFilterOptions();

    /** Serialize complete geometry only when the user requests an export. */
    geoJson = (): string => this.exportGeoJson();
    featureIds: string[] = [];
    selectedFeatures?: FeatureWrapper[];
    loading: boolean = false;
    private rebuildQueued = false;
    private destroyed = false;
    private catalogSubscription?: Subscription;
    private readonly incoming = new Map<FeatureWrapper, IncomingSectionState>();

    /** Keep source fidelity and incomplete-data notices visible beside inspection/export controls. */
    get selectionWarnings(): string[] {
        return [...new Set([...(this.panel().unavailablePoints ?? []),
            ...(this.selectedFeatures ?? []).flatMap(feature => feature.featureTile.warnings)])];
    }

    /** A point selection exports its current host from the selected datasource. */
    private exportGeoJson(): string {
        const features = (this.selectedFeatures ?? []).flatMap(wrapper => {
            const target = parseFeatureInspectionTarget(wrapper.featureId);
            if (target.scope === "shapepoint" &&
                wrapper.featureTile.sourceId !== target.sourceId) {
                return [];
            }
            const snapshot = target.scope === "shapepoint" ? wrapper : this.inspectionFeature(wrapper);
            const json = snapshot.peek(feature => {
                if (target.scope === "shapepoint" &&
                    !feature.shapePointPosition(target.geometryOrdinal, target.pointIndex, target.sourceId)) return null;
                return feature.geojson() as string;
            });
            return json === null ? [] : [json];
        });
        return `{"type":"FeatureCollection","features":[${features.join(",")}]}`;
    }

    @ViewChild(InspectionTreeComponent) inspectionTree?: InspectionTreeComponent;

    /**
     * Invalidate incoming-relation requests on catalog changes and queue a tree
     * rebuild for catalog or panel changes; old snapshots must not survive new metadata.
     */
    constructor(private cdr: ChangeDetectorRef,
        private ngZone: NgZone,
        mapInfo: MapDataService) {
        this.catalogSubscription = mapInfo.dataSourceInfoChanged.subscribe(() => {
            for (const state of this.incoming.values()) {
                state.controller.abort();
                clearTimeout(state.timer);
            }
            this.incoming.clear();
            this.scheduleInspectionTreeRebuild();
        });
        effect(() => {
            this.panel();
            this.scheduleInspectionTreeRebuild();
        });
    }

    /** Prevents queued inspection work from touching a destroyed component. */
    ngOnDestroy() {
        this.destroyed = true;
        this.catalogSubscription?.unsubscribe();
        for (const state of this.incoming.values()) {
            state.controller.abort();
            clearTimeout(state.timer);
        }
        this.incoming.clear();
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

    /** Re-reads bounded inspection trees from the selected feature values. */
    private rebuildInspectionTree() {
        const previousExpansionState = this.captureTreeExpansionState(this.treeData);
        const panel = this.panel();
        this.selectedFeatures = panel.features ?? [];
        for (const [feature, state] of this.incoming) {
            if (!this.selectedFeatures.includes(feature)) {
                state.controller.abort();
                clearTimeout(state.timer);
                this.incoming.delete(feature);
            }
        }
        this.loading = panel.loading === true;
        if (!this.selectedFeatures.length) {
            this.featureIds = [];
            this.treeData = [];
            return;
        }

        this.featureIds = Array.from(new Set(
            this.selectedFeatures.map(feature => stripFeatureInspectionTarget(feature.featureId))
        ));
        this.loading = false;

        const selectedFeatureInspectionModels: InspectionModelData[][] = [];
        this.selectedFeatures.forEach(featureWrapper => {
            const target = parseFeatureInspectionTarget(featureWrapper.featureId);
            let model: InspectionModelData[] = [];
            try {
                const point = target.scope === "shapepoint" ? target : undefined;
                const snapshot = point ? featureWrapper : this.inspectionFeature(featureWrapper);
                snapshot.peek((feature: Feature) => {
                    model = readFeatureInspectionModel(feature, target);
                    const incoming = point ? undefined : this.incomingSection(featureWrapper);
                    if (incoming) {
                        // Keep Geometry last, including while incoming relations are loading.
                        const geometryIndex = model.findIndex(section => section.geoJsonPath === "geometry");
                        model.splice(geometryIndex < 0 ? model.length : geometryIndex, 0, incoming);
                    }
                });
            } catch (error) {
                console.error("Failed to read inspection model for selected feature.", {
                    panelId: this.panel().id,
                    mapTileKey: featureWrapper.mapTileKey,
                    featureId: featureWrapper.featureId,
                    error
                });
            }
            selectedFeatureInspectionModels.push(model);
        });
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

        this.restoreTreeExpansionState(nextTreeData, previousExpansionState);
        this.highlightSelectedInspectionTarget(nextTreeData);
        this.treeData = nextTreeData;
        this.inspectionTree?.refreshLayout();
    }

    /** Use the bundle's canonical target without changing selection identity or restarting discovery. */
    private inspectionFeature(feature: FeatureWrapper): FeatureWrapper {
        const target = this.incoming?.get(feature)?.result?.target;
        return target ? new FeatureWrapper(feature.featureId, target) : feature;
    }

    /** Begin eligible incoming work only after the ordinary model is available. */
    private incomingSection(feature: FeatureWrapper): InspectionModelData | undefined {
        let state = this.incoming.get(feature);
        if (!state) {
            let eligibilityError: string | undefined;
            try {
                if (!feature.featureTile.hasIncomingRelations(feature.featureId)) return undefined;
            } catch (error) {
                eligibilityError = `Incoming discovery unavailable: ${error instanceof Error ? error.message : String(error)}`;
            }
            state = { controller: new AbortController(), loading: !eligibilityError, error: eligibilityError };
            this.incoming.set(feature, state);
            if (state.loading) void this.loadIncoming(feature, state);
        }
        const result = state.result;
        const section: InspectionModelData = result?.model[0] ?? {
            key: "Incoming Relations", type: coreLib.ValueType.SECTION.value, value: "", children: []
        };
        return {
            ...section, nodeId: "incoming-relations", incomingLoading: state.loading,
            value: state.loading ? "Loading…" : state.error ?? (
                result?.status === "no-possible-family" ? "No possible incoming family in the available sources"
                    : result?.status === "unsupported-scope" ? "Incoming search is unsupported for this scope"
                    : result?.complete ? (section.children?.length ? "" : "No matching relations in the searched scope")
                    : "Partial result in the searched scope"),
            info: state.error ?? (result
                ? [`Searched scope: ${result.scope.join(", ") || "no provider partitions"}`, ...result.issues].join("\n")
                : section.info),
            retryIncoming: !state.loading ? () => this.retryIncoming(feature) : undefined
        };
    }

    /** Publish only while the selected wrapper and request generation remain current. */
    private async loadIncoming(feature: FeatureWrapper, state: IncomingSectionState): Promise<void> {
        try {
            const result = await feature.featureTile.loadIncoming(feature.featureId, state.controller.signal);
            if (this.destroyed || this.incoming.get(feature) !== state) return;
            state.result = result;
            if (result.expiresAtMs !== undefined) {
                state.timer = setTimeout(() => this.retryIncoming(feature),
                    Math.min(2147483647, Math.max(1000, result.expiresAtMs - Date.now())));
            }
        } catch (error) {
            if (state.controller.signal.aborted) return;
            state.error = error instanceof Error ? error.message : String(error);
        } finally {
            if (!state.controller.signal.aborted && this.incoming.get(feature) === state) {
                state.loading = false;
                this.scheduleInspectionTreeRebuild();
            }
        }
    }

    /** Retry or renew only the incoming section, preserving the base inspection and its state. */
    private retryIncoming(feature: FeatureWrapper): void {
        const previous = this.incoming.get(feature);
        if (!previous || this.destroyed) return;
        previous.controller.abort();
        clearTimeout(previous.timer);
        const state: IncomingSectionState = {
            controller: new AbortController(), loading: true, result: previous?.result
        };
        this.incoming.set(feature, state);
        void this.loadIncoming(feature, state);
        this.scheduleInspectionTreeRebuild();
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
    private highlightSelectedInspectionTarget(nodes: TreeTableNode[]): void {
        const selectedTargetIds = (this.selectedFeatures ?? [])
            .map(feature => feature.featureId)
            .filter(isFeatureInspectionSubTarget);
        const exactTargetIds = new Set(selectedTargetIds);
        const parentTargetIds = new Set(selectedTargetIds
            .map(stripFeatureInspectionValidity)
            .filter(isFeatureInspectionSubTarget));
        if (!exactTargetIds.size) {
            return;
        }

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
            targetIds: ReadonlySet<string>
        ): boolean => {
            const rowTargets = rowTargetsForNode(node);
            const matchedTarget = rowTargets.find(target => targetIds.has(target));
            const rowMatches = matchedTarget !== undefined;
            if (rowMatches && selectedHighlightTarget === undefined) {
                selectedHighlightTarget = matchedTarget;
                selectedHighlightMode = hasFeatureInspectionValidity(matchedTarget)
                    ? "strong"
                    : "soft";
                // The table can restore a different set of expanded rows. Keep the
                // selected node itself so it can find its final scroll position.
                node.data.inspectionFocus = true;
                node.expanded = true;
                return true;
            }

            let childMatches = false;
            for (const child of node.children ?? []) {
                childMatches = findTarget(child, targetIds) || childMatches;
            }
            if (childMatches) {
                node.expanded = true;
            }
            return rowMatches || childMatches;
        };

        const findInTree = (targetIds: ReadonlySet<string>) => {
            for (const node of nodes) {
                findTarget(node, targetIds);
            }
        };
        findInTree(exactTargetIds);
        if (selectedHighlightTarget === undefined) {
            findInTree(parentTargetIds);
        }
        if (selectedHighlightTarget === undefined) {
            return;
        }

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
    }

    /**
     * A property container hovers the union of its references, not its whole attribute.
     * Raw fields of a record with one location describe that location too.
     * An unrelated list entry must never borrow a sibling's locations or the attribute fallback.
     */
    private groupPropertyReferences(node: TreeTableNode, model: InspectionModelData): void {
        let targets = model.referenceHoverId ? new Set([model.referenceHoverId]) : undefined;
        for (const child of node.children ?? []) {
            for (const id of child.data?.referenceHoverIds ?? []) {
                (targets ??= new Set()).add(id);
            }
        }
        if (!targets) return;
        const ids = [...targets];
        node.data.referenceHoverIds = ids;
        const isList = (model.type & coreLib.ValueType.ARRAY.value) !== 0;
        const peerIds = model.referenceHoverId || (!isList && ids.length === 1) ? ids : [];
        const bindRawFields = (child: TreeTableNode, inherited: string[]): void => {
            if (child.data.hoverId || child.data.referenceHoverIds) return;
            // A list without its own references cannot borrow other entries' slots.
            const childIds = child.data.type === coreLib.ValueType.ARRAY.value ? [] : inherited;
            child.data.referenceHoverIds = childIds;
            child.children?.forEach(grandchild => bindRawFields(grandchild, childIds));
        };
        node.children?.forEach(child => bindRawFields(child, peerIds));
    }

    /** Converts the WASM inspection model into PrimeNG tree nodes and annotates hover/highlight groups. */
    getFeatureTreeDataFromModel(inspectionModelsByFeature: InspectionModelData[][]) {
        interface HoverAnnotationContext {
            mapTileKey: string;
            mapId?: string;
            feature?: FeatureWrapper;
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
                    // Round the cell text, not the coordinates in the native inspection model.
                    value = value.map(coordinate => {
                        const text = String(coordinate);
                        const dot = text.indexOf(".");
                        return dot !== -1 && text.length - dot - 1 > 8
                            ? Number(coordinate).toFixed(8) : text;
                    }).join(", ");
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
                    displayValue: data?.displayValue,
                    scalarType: data?.scalarType,
                    type: valueType,
                    mapTileKey: data?.mapTileKey ?? context.mapTileKey,
                    incomingLoading: data?.incomingLoading,
                    retryIncoming: data?.retryIncoming,
                    nodeId,
                    mapId: context.mapId ?? ""
                };
                if (data?.hasOwnProperty("info")) {
                    node.data["info"] = data.info;
                }
                if (data?.hasOwnProperty("hoverId")) {
                    node.data["hoverId"] = data.hoverId;
                }
                if (data.sourceNodeId) node.data["sourceNodeId"] = context.nodeIdPrefix + data.sourceNodeId;
                const feature = context.feature;
                if (feature && data.pointGeometryOrdinal !== undefined && data.originalPointCount) {
                    node.data["inspectedFeatureId"] = feature.featureId;
                    node.data["pointRange"] = {
                        count: data.originalPointCount, geometryOrdinal: data.pointGeometryOrdinal,
                        baseFeatureId: stripFeatureInspectionTarget(feature.featureId),
                        sourceId: feature.featureTile.sourceId
                    };
                }
                if (data.geometryOrdinal !== undefined && data.pointIndex !== undefined && feature) {
                    const target = formatFeatureInspectionTarget({
                        scope: "shapepoint", baseFeatureId: stripFeatureInspectionTarget(feature.featureId),
                        geometryOrdinal: data.geometryOrdinal, pointIndex: data.pointIndex,
                        sourceId: feature.featureTile.sourceId
                    });
                    node.data["hoverId"] = target;
                    node.data["pointTarget"] = target;
                    node.data["inspectedFeatureId"] = feature.featureId;
                    node.data["pointSelected"] = target === feature.featureId;
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
                if (Array.isArray(data?.keyBubbles) && data.keyBubbles.length) {
                    node.data["keyBubbles"] = data.keyBubbles;
                }
                const valueBubbles = prefixValueBubbleTargets(data?.valueBubbles, context.nodeIdPrefix);
                if (valueBubbles) {
                    node.data["valueBubbles"] = valueBubbles;
                }

                let nextSoftHoverGroupId = context.softHoverGroupId;
                let nextStrongHoverGroupId = context.strongHoverGroupId;
                const hoverId = node.data["hoverId"];
                if (typeof hoverId === "string") {
                    if (hasFeatureInspectionValidity(hoverId)) {
                        nextSoftHoverGroupId =
                            stripFeatureInspectionValidity(hoverId);
                        nextStrongHoverGroupId = hoverId;
                    } else {
                        nextSoftHoverGroupId = hoverId;
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
                        mapTileKey: node.data["mapTileKey"],
                        feature: context.feature,
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
                        node.data["geometryNameBubble"] = nameBubble;
                    }
                }
                node.children = children;
                // Stop at the attribute itself: its normal hover includes assignment
                // geometry as well as tagged locations. Only raw property trees narrow it.
                if (!hoverId && nextSoftHoverGroupId) {
                    this.groupPropertyReferences(node, data);
                }
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
            const wrapper = this.selectedFeatures?.[featureIndex];
            const snapshot = wrapper && parseFeatureInspectionTarget(wrapper.featureId).scope !== "shapepoint"
                ? this.inspectionFeature(wrapper) : wrapper;
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
                    incomingLoading: section?.incomingLoading,
                    retryIncoming: section?.retryIncoming,
                    nodeId: sectionNodeId,
                    mapId
                };
                if (section.reopenFeature && wrapper) {
                    node.data["reopenPointTarget"] = {
                        mapTileKey, inspectedFeatureId: wrapper.featureId,
                        pointTarget: stripFeatureInspectionTarget(wrapper.featureId)
                    };
                }
                if (section?.hasOwnProperty("info")) {
                    node.data["info"] = section.info;
                }
                if (section?.hasOwnProperty("sourceDataReferences")) {
                    node.data["sourceDataReferences"] = section.sourceDataReferences;
                }
                if (Array.isArray(section?.keyBubbles) && section.keyBubbles.length) {
                    node.data["keyBubbles"] = section.keyBubbles;
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
                        feature: snapshot,
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
