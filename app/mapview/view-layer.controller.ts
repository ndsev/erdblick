import {Subject, Subscription} from "rxjs";
import type {FilterTileState} from "../mapdata/filter-tile-state.model";
import type {MapInfoService} from "../mapdata/map-info.service";
import type {MapTileStreamService} from "../mapdata/map-tile-stream.service";
import {
    StyledMapgetLayer,
    type StyleFilterPlan,
    type StyledMapgetLayerEvent
} from "../mapdata/styled-mapget-layer.model";
import type {MapgetLayer} from "../mapdata/mapget-layer.model";
import type {StyleService, ErdblickStyle} from "../styledata/style.service";
import {coreLib} from "../integrations/wasm";
import type {IRenderSceneHandle} from "./render-view.model";
import {
    MapViewStateService,
    ViewRecalculationReason
} from "./map-view-state.service";
import {
    TileSubsetLayerRenderService,
    type TileSubsetLayerRenderPolicyChange
} from "./deck/tile-subset-layer-render.service";
import {
    TileSubsetLayerVisualization
} from "./deck/tile-subset-layer.visualization";
import {
    fitsMortonPresentationVertexBudget,
    MORTON_AGGREGATE_BLOCK_BIT_COUNTS,
    mortonBlockBatch,
    type MortonBlockBatch
} from "./deck/morton-presentation-block";
import type {FeatureSearchService} from "../search/feature.search.service";
import type {
    InspectionSelectionService
} from "../inspection/inspection-selection.service";
import type {
    InspectionPanelModel,
    TileFeatureId
} from "../shared/appstate.service";
import {sipHash64Hex} from "../styledata/hash";
import {stripFeatureInspectionTarget} from "../shared/tile-feature-id";
import type {
    ViewLayerDiagnosticsService
} from "./view-layer-diagnostics.service";
import type {
    StyleValidationReportService
} from "../styledata/style-validation-report.service";
import type {RuleFidelity} from "../../build/libs/core/erdblick-core";

export type ViewTileOccupancy = "unknown" | "empty" | "non-empty" | "error";

interface OwnedStyledLayer {
    layer: StyledMapgetLayer;
    subscription: Subscription;
    visualizations: Map<string, TileSubsetLayerVisualization>;
    visualizationKeyByTileId: Map<number, string>;
    pendingBlockTiles: Map<number, {
        state: FilterTileState;
        fidelity: number;
        queuedAt: number;
    }>;
    disposeLayer: boolean;
    replacementSlot: string | null;
    replacementTileIds: Set<number>;
}

interface RetiringRegularLayer {
    key: string;
    owned: OwnedStyledLayer;
}

const BLOCK_ASSEMBLY_CADENCE_MS = 16;
const BLOCK_ASSEMBLY_MAX_WAIT_MS = 3 * BLOCK_ASSEMBLY_CADENCE_MS;

/**
 * View-local owner which reconciles catalog, style, and viewport state.
 *
 * Renderer/device recreation only replaces `sceneHandle`; filter refs, subsets,
 * and logical visualizations remain alive for the logical view lifetime.
 */
export class ViewLayerController {
    readonly changed = new Subject<void>();
    readonly occupancyChanged = new Subject<void>();
    private readonly subscriptions: Subscription[] = [];
    private readonly styledLayers = new Map<string, OwnedStyledLayer>();
    private readonly retiringRegularLayers =
        new Map<string, RetiringRegularLayer>();
    private sceneHandle: IRenderSceneHandle | null = null;
    private disposed = false;
    private reconcileQueued = false;
    private fullReconcileRequired = true;
    private lastViewportPresentationSignature = "";
    private blockAssemblyTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly unregisterDiagnostics: () => void;

    constructor(
        readonly viewIndex: number,
        private readonly mapInfo: MapInfoService,
        private readonly viewState: MapViewStateService,
        private readonly tileStream: MapTileStreamService,
        private readonly styleService: StyleService,
        private readonly renderService: TileSubsetLayerRenderService,
        private readonly featureSearch: FeatureSearchService,
        private readonly inspection: InspectionSelectionService,
        private readonly diagnostics: ViewLayerDiagnosticsService,
        private readonly styleValidationReports: StyleValidationReportService
    ) {
        this.unregisterDiagnostics = diagnostics.register(
            viewIndex,
            () => this.diagnosticStyledLayers(),
            (layer, state) => this.presentationStillDemanded(layer, state)
        );
        this.subscriptions.push(
            this.mapInfo.maps$.subscribe(() => this.scheduleReconcile()),
            this.mapInfo.layerStateChanged.subscribe(() => this.scheduleReconcile()),
            this.mapInfo.styleOptionChanged.subscribe(([_, changedView]) => {
                if (changedView === this.viewIndex) {
                    this.scheduleReconcile();
                }
            }),
            this.viewState.viewStateChanged.subscribe(reason =>
                this.scheduleReconcile(
                    reason !== ViewRecalculationReason.Viewport
                )
            ),
            this.styleService.styleAddedForId.subscribe(() => this.scheduleReconcile()),
            this.styleService.styleRemovedForId.subscribe(() => this.scheduleReconcile()),
            this.styleService.styleGroups.subscribe(() => this.scheduleReconcile()),
            this.featureSearch.searchPresentationsChanged.subscribe(() =>
                this.scheduleReconcile()
            ),
            this.inspection.selectionIdsTopic.subscribe(() =>
                this.scheduleReconcile()
            ),
            this.inspection.hoverIdsTopic.subscribe(() =>
                this.scheduleReconcile()
            ),
            this.renderService.capacityChanged.subscribe(() =>
                this.scheduleBlockAssembly()
            ),
            this.renderService.policyChanged.subscribe(change =>
                this.handleRenderPolicyChange(change)
            )
        );
        this.scheduleReconcile();
    }

    attachScene(sceneHandle: IRenderSceneHandle): void {
        this.sceneHandle = sceneHandle;
        for (const owned of this.styledLayers.values()) {
            for (const visualization of owned.visualizations.values()) {
                visualization.reattach(sceneHandle).catch(error =>
                    console.error("Failed to reattach a subset visualization.", error)
                );
            }
        }
        for (const {owned} of this.retiringRegularLayers.values()) {
            for (const visualization of owned.visualizations.values()) {
                visualization.reattach(sceneHandle).catch(error =>
                    console.error("Failed to reattach a retiring subset visualization.", error)
                );
            }
        }
        this.scheduleBlockAssembly();
    }

    detachScene(): void {
        this.sceneHandle = null;
    }

    /** Bridges view-local Deck screen-pass timing into global diagnostics. */
    recordDeckFrameTime(milliseconds: number): void {
        this.renderService.recordDeckFrameTime(
            this.viewIndex,
            milliseconds
        );
    }

    /** Current regular-presentation styled layers, for diagnostics and grid aggregation. */
    regularStyledLayers(): Iterable<StyledMapgetLayer> {
        return [...this.styledLayers.values()]
            .map(owned => owned.layer)
            .filter(layer => layer.identity.presentationKind === "regular");
    }

    /** Current presentation state exposed read-only to diagnostics. */
    diagnosticStyledLayers(): Iterable<StyledMapgetLayer> {
        return [...this.styledLayers.values()].map(owned => owned.layer);
    }

    /** Resolves source occupancy without interpreting filtered entry counts. */
    occupancyForTile(
        tileId: number,
        visibleLayers: ReadonlyArray<{mapId: string; layerId: string}>
    ): ViewTileOccupancy {
        let sawPending = false;
        let sawObservation = false;
        let sawEmpty = false;
        let sawNonEmpty = false;
        for (const source of visibleLayers) {
            const observations: number[] = [];
            for (const owned of this.styledLayers.values()) {
                const styled = owned.layer;
                if (styled.identity.presentationKind !== "regular" ||
                    styled.mapgetLayer.mapId !== source.mapId ||
                    styled.mapgetLayer.layerId !== source.layerId) {
                    continue;
                }
                const state = styled.tileStates.get(tileId);
                if (!state) {
                    continue;
                }
                if (state.status === "error") {
                    return "error";
                }
                if (state.status !== "ready" || state.sourceFeatureCount === null) {
                    sawPending = true;
                    continue;
                }
                observations.push(state.sourceFeatureCount);
            }
            if (!observations.length) {
                continue;
            }
            sawObservation = true;
            const first = observations[0];
            if (observations.some(value => value !== first)) {
                return "unknown";
            }
            if (first > 0) {
                sawNonEmpty = true;
            } else {
                sawEmpty = true;
            }
        }
        if (sawNonEmpty) {
            return "non-empty";
        }
        if (sawObservation && sawEmpty && !sawPending) {
            return "empty";
        }
        return "unknown";
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.blockAssemblyTimer !== null) {
            clearTimeout(this.blockAssemblyTimer);
            this.blockAssemblyTimer = null;
        }
        this.subscriptions.splice(0).forEach(subscription => subscription.unsubscribe());
        for (const owned of this.styledLayers.values()) {
            this.destroyOwnedLayer(owned);
        }
        this.styledLayers.clear();
        for (const {owned} of this.retiringRegularLayers.values()) {
            this.destroyOwnedLayer(owned);
        }
        this.retiringRegularLayers.clear();
        this.renderService.clearDeckFrameTime(this.viewIndex);
        this.unregisterDiagnostics();
        this.sceneHandle = null;
        this.changed.complete();
        this.occupancyChanged.complete();
    }

    private scheduleReconcile(fullReconcile = true): void {
        if (this.disposed) {
            return;
        }
        this.fullReconcileRequired ||= fullReconcile;
        if (this.reconcileQueued) {
            return;
        }
        this.reconcileQueued = true;
        queueMicrotask(() => {
            this.reconcileQueued = false;
            if (this.disposed) {
                return;
            }
            const full = this.fullReconcileRequired;
            this.fullReconcileRequired = false;
            const viewportSignature =
                this.viewportPresentationSignature();
            if (!full &&
                viewportSignature ===
                    this.lastViewportPresentationSignature) {
                return;
            }
            this.reconcile();
            this.lastViewportPresentationSignature =
                this.viewportPresentationSignature();
        });
    }

    /**
     * Exact cheap signature for presentation demand affected by viewport
     * motion. Regular coverage/fidelity is versioned by ViewVisualizationState;
     * search coverage is versioned by its StyledMapgetLayer and its density
     * decision is represented once per occupied source level.
     */
    private viewportPresentationSignature(): string {
        const viewState = this.viewState.viewStateFor(this.viewIndex);
        const parts = [
            String(viewState?.coverageVersion ?? -1)
        ];
        for (const layer of this.featureSearch
            .searchStyledLayersForView(this.viewIndex)) {
            parts.push(layer.ownerId, String(layer.coverageVersion));
            const levelSamples = new Map<number, number>();
            for (const tileId of layer.tileStates.keys()) {
                const level = Number(coreLib.getTileLevel(tileId));
                if (!levelSamples.has(level)) {
                    levelSamples.set(level, tileId);
                }
            }
            for (const [level, tileId] of [...levelSamples]
                .sort(([left], [right]) => left - right)) {
                parts.push(
                    `${level}:` +
                    `${this.featureSearch.shouldRenderSearchStyledLayer(
                        this.viewIndex,
                        layer,
                        tileId
                    ) ? 1 : 0}`
                );
            }
        }
        return parts.join("|");
    }

    private reconcile(): void {
        const desired = new Map<string, {
            mapgetLayer: MapgetLayer;
            style: ErdblickStyle;
            styleOrder: number;
            tileIds: number[];
            priorityTileIds: number[];
            options: Record<string, boolean | number | string>;
            plannedFidelity: RuleFidelity;
            replacementSlot: string;
        }>();
        const orderedStyles = [...this.styleService.styles.values()]
            .filter(style => style.visible);
        for (const mapgetLayer of this.mapInfo.mapgetLayers()) {
            if (!this.mapInfo.maps.getMapLayerVisibility(
                this.viewIndex,
                mapgetLayer.mapId,
                mapgetLayer.layerId
            )) {
                continue;
            }
            const level = this.viewState.getEffectiveMapLayerLevel(
                this.viewIndex,
                mapgetLayer.mapId,
                mapgetLayer.layerId
            );
            const visibleTileIds = this.viewState.visibleTileIdsForLevel(this.viewIndex, level);
            const plannedFidelity =
                visibleTileIds.length > 0 &&
                this.fidelityFor(visibleTileIds[0]) ===
                    coreLib.RuleFidelity.HIGH.value
                    ? coreLib.RuleFidelity.HIGH
                    : coreLib.RuleFidelity.LOW;
            for (let styleOrder = 0; styleOrder < orderedStyles.length; ++styleOrder) {
                const style = orderedStyles[styleOrder];
                if (!style.featureLayerStyle.hasLayerAffinity(mapgetLayer.layerId)) {
                    continue;
                }
                const key = this.regularKey(
                    mapgetLayer,
                    style,
                    plannedFidelity
                );
                const options = this.mapInfo.maps.getLayerStyleOptions(
                    this.viewIndex,
                    mapgetLayer.mapId,
                    mapgetLayer.layerId,
                    style.id
                ) ?? {};
                const tileIds = this.expandGroupCoverage(visibleTileIds, style, mapgetLayer);
                desired.set(key, {
                    mapgetLayer,
                    style,
                    styleOrder,
                    tileIds,
                    priorityTileIds: [...visibleTileIds],
                    options,
                    plannedFidelity,
                    replacementSlot: this.regularReplacementSlot(
                        mapgetLayer,
                        style
                    )
                });
            }
        }

        // A fast fidelity reversal can reuse the still-present retiring owner
        // before the current successor is retired in the pass below.
        for (const [key, next] of desired) {
            if (this.styledLayers.has(key)) {
                continue;
            }
            const fallback =
                this.retiringRegularLayers.get(next.replacementSlot);
            if (!fallback || fallback.key !== key ||
                fallback.owned.layer.style !== next.style ||
                fallback.owned.layer.mapgetLayer !== next.mapgetLayer) {
                continue;
            }
            this.retiringRegularLayers.delete(next.replacementSlot);
            fallback.owned.layer.setSuspended(false);
            this.styledLayers.set(key, fallback.owned);
        }

        for (const [key, owned] of [...this.styledLayers]) {
            if (owned.layer.identity.presentationKind !== "regular") {
                continue;
            }
            const next = desired.get(key);
            if (next && owned.layer.style === next.style &&
                owned.layer.mapgetLayer === next.mapgetLayer) {
                continue;
            }
            this.styledLayers.delete(key);
            const replacementSlot = owned.replacementSlot;
            const replacement = replacementSlot
                ? [...desired.entries()].find(
                    ([, candidate]) =>
                        candidate.replacementSlot === replacementSlot
                )
                : undefined;
            if (replacementSlot && replacement &&
                replacement[0] !== key) {
                this.retainAsRegularFallback(
                    replacementSlot,
                    key,
                    owned
                );
            } else {
                this.destroyOwnedLayer(owned);
            }
        }

        for (const [key, next] of desired) {
            let owned = this.styledLayers.get(key);
            if (!owned) {
                try {
                    const layer = new StyledMapgetLayer(
                        {
                            viewIndex: this.viewIndex,
                            mapId: next.mapgetLayer.mapId,
                            layerId: next.mapgetLayer.layerId,
                            presentationKind: "regular",
                            presentationInstanceId:
                                `${next.style.id}:${this.styleVersion(next.style)}` +
                                `/f${next.plannedFidelity.value}`
                        },
                        next.mapgetLayer,
                        next.style,
                        next.options,
                        this.mapInfo,
                        this.tileStream,
                        coreLib.HighlightMode.NO_HIGHLIGHT,
                        next.plannedFidelity
                    );
                    if (!layer.filterPlan.channels.length) {
                        layer.dispose();
                        continue;
                    }
                    owned = {
                        layer,
                        subscription: layer.events.subscribe(event =>
                            this.handleStyledLayerEvent(layer, event)
                        ),
                        visualizations: new Map(),
                        visualizationKeyByTileId: new Map(),
                        pendingBlockTiles: new Map(),
                        disposeLayer: true,
                        replacementSlot: next.replacementSlot,
                        replacementTileIds:
                            new Set(next.priorityTileIds)
                    };
                    this.styledLayers.set(key, owned);
                } catch (error) {
                    console.error("Failed to create StyledMapgetLayer.", error);
                    continue;
                }
            }
            owned.layer.styleOrder = next.styleOrder;
            owned.replacementTileIds =
                new Set(next.priorityTileIds);
            owned.layer.setOptions(next.options);
            owned.layer.setCoverage(next.tileIds, next.priorityTileIds);
            this.reconcileOwnedVisualizations(owned);
            this.releaseRegularFallbackWhenReady(owned);
        }
        const desiredReplacementSlots = new Set(
            [...desired.values()].map(next => next.replacementSlot)
        );
        for (const [slot, fallback] of
            [...this.retiringRegularLayers]) {
            if (desiredReplacementSlots.has(slot)) {
                continue;
            }
            this.retiringRegularLayers.delete(slot);
            this.destroyOwnedLayer(fallback.owned);
        }
        this.reconcileSearchLayers(orderedStyles.length);
        this.reconcileHighlightLayers(orderedStyles);
        this.changed.next();
        this.occupancyChanged.next();
        this.diagnostics.notifyChanged();
    }

    private handleStyledLayerEvent(
        layer: StyledMapgetLayer,
        event: StyledMapgetLayerEvent
    ): void {
        const owned = [...this.styledLayers.values()].find(candidate => candidate.layer === layer);
        if (!owned) {
            return;
        }
        if (event.type === "tile-ready") {
            this.reconcileReadyBlockTile(owned, event.state);
            this.occupancyChanged.next();
            this.changed.next();
            this.diagnostics.notifyChanged();
            return;
        }
        if (event.type === "tile-removed") {
            this.removeBlockTile(owned, event.state.tileId);
            this.occupancyChanged.next();
            this.changed.next();
            this.diagnostics.notifyChanged();
            return;
        }
        if (event.type === "status" &&
            ["Success", "Failed", "Aborted"].includes(event.status.state)) {
            this.reconcileOwnedVisualizations(owned);
        }
        if (event.type === "error") {
            this.occupancyChanged.next();
            this.changed.next();
            this.diagnostics.notifyLayerErrors(this.viewIndex, layer);
            return;
        }
        if (event.type === "status") {
            this.occupancyChanged.next();
            this.changed.next();
            this.diagnostics.notifyChanged();
        }
    }

    private destroyOwnedLayer(owned: OwnedStyledLayer): void {
        owned.subscription.unsubscribe();
        for (const visualization of owned.visualizations.values()) {
            visualization.destroy(this.sceneHandle);
        }
        owned.visualizations.clear();
        owned.visualizationKeyByTileId.clear();
        owned.pendingBlockTiles.clear();
        if (owned.disposeLayer) {
            owned.layer.dispose();
        }
    }

    /** Keeps one fully rendered regular owner as the visual replacement fallback. */
    private retainAsRegularFallback(
        slot: string,
        key: string,
        owned: OwnedStyledLayer
    ): void {
        const previous = this.retiringRegularLayers.get(slot);
        if (previous && previous.owned !== owned) {
            this.destroyOwnedLayer(previous.owned);
        }
        owned.layer.setSuspended(true);
        this.retiringRegularLayers.set(slot, {key, owned});
    }

    /**
     * Retires the old owner only after every visible successor tile has its
     * current immutable value installed in a Deck contribution.
     */
    private releaseRegularFallbackWhenReady(
        owned: OwnedStyledLayer
    ): void {
        const slot = owned.replacementSlot;
        if (!slot) {
            return;
        }
        const fallback = this.retiringRegularLayers.get(slot);
        if (!fallback || fallback.owned === owned) {
            return;
        }
        if (!this.regularReplacementIsReady(owned)) {
            return;
        }
        this.retiringRegularLayers.delete(slot);
        this.destroyOwnedLayer(fallback.owned);
    }

    private regularReplacementIsReady(
        owned: OwnedStyledLayer
    ): boolean {
        if (!owned.replacementTileIds.size) {
            return true;
        }
        if (!this.sceneHandle) {
            return false;
        }
        for (const tileId of owned.replacementTileIds) {
            const state = owned.layer.tileStates.get(tileId);
            const visualizationKey =
                owned.visualizationKeyByTileId.get(tileId);
            const visualization = visualizationKey
                ? owned.visualizations.get(visualizationKey)
                : undefined;
            if (!state || state.status !== "ready" ||
                !visualization?.isCurrentPresentationInstalled()) {
                return false;
            }
        }
        return true;
    }

    /** Applies live worker, block-budget, and block-overlay preferences. */
    private handleRenderPolicyChange(
        change: TileSubsetLayerRenderPolicyChange
    ): void {
        if (change === "debug-blocks") {
            const enabled =
                this.renderService.debugRenderBlocksEnabled();
            for (const owned of this.allOwnedStyledLayers()) {
                for (const visualization of owned.visualizations.values()) {
                    visualization.setDebugBlockVisualization(
                        enabled,
                        this.sceneHandle
                    );
                }
            }
            return;
        }
        if (change === "block-vertex-limit") {
            for (const owned of this.styledLayers.values()) {
                for (const key of [...owned.visualizations.keys()]) {
                    this.dissolveBlockVisualization(owned, key, true);
                }
            }
        }
        this.scheduleBlockAssembly();
    }

    private *allOwnedStyledLayers(): Iterable<OwnedStyledLayer> {
        yield* this.styledLayers.values();
        for (const {owned} of this.retiringRegularLayers.values()) {
            yield owned;
        }
    }

    private fidelityFor(tileId: number): number {
        return this.viewState.prefersHighFidelityForTile(this.viewIndex, tileId)
            ? coreLib.RuleFidelity.HIGH.value
            : coreLib.RuleFidelity.LOW.value;
    }

    private regularKey(
        mapgetLayer: MapgetLayer,
        style: ErdblickStyle,
        fidelity: RuleFidelity
    ): string {
        return [
            mapgetLayer.key,
            "regular",
            `${style.id}:${this.styleVersion(style)}`,
            `f${fidelity.value}`
        ].join("/");
    }

    private regularReplacementSlot(
        mapgetLayer: MapgetLayer,
        style: ErdblickStyle
    ): string {
        return `${mapgetLayer.key}/regular/${style.id}`;
    }

    /**
     * Identifies one parsed stylesheet incarnation.
     *
     * The stable style id intentionally remains the replacement slot, while
     * transport owners must change whenever presentation semantics change.
     * Otherwise a style edit can recreate a layer under a still-retiring
     * filter subscription and wait forever for generation one.
     */
    private styleVersion(style: ErdblickStyle): string {
        return style.sourceRef?.sourceHash ?? sipHash64Hex(style.source);
    }

    /** Reconciles service-owned search presentations into this view. */
    private reconcileSearchLayers(styleOrderBase: number): void {
        const layers = this.featureSearch.searchStyledLayersForView(this.viewIndex);
        const desired = new Map(
            layers.map(layer => [this.searchKey(layer), layer])
        );

        for (const [key, owned] of [...this.styledLayers]) {
            if (owned.disposeLayer) {
                continue;
            }
            if (desired.get(key) === owned.layer) {
                continue;
            }
            this.styledLayers.delete(key);
            this.destroyOwnedLayer(owned);
        }

        layers.forEach((layer, index) => {
            const key = this.searchKey(layer);
            let owned = this.styledLayers.get(key);
            if (!owned) {
                owned = {
                    layer,
                    subscription: layer.events.subscribe(event =>
                        this.handleStyledLayerEvent(layer, event)
                    ),
                    visualizations: new Map(),
                    visualizationKeyByTileId: new Map(),
                    pendingBlockTiles: new Map(),
                    disposeLayer: false,
                    replacementSlot: null,
                    replacementTileIds: new Set()
                };
                this.styledLayers.set(key, owned);
            }
            layer.styleOrder = styleOrderBase + index;
            this.reconcileOwnedVisualizations(owned);
        });
    }

    private searchKey(layer: StyledMapgetLayer): string {
        return `search/${layer.ownerId}`;
    }

    /** Reconciles exact-ID hover and selection bundles through the normal filter path. */
    private reconcileHighlightLayers(orderedStyles: readonly ErdblickStyle[]): void {
        const groups: Array<{
            kind: "selection" | "hover";
            id: string;
            color?: string;
            features: TileFeatureId[];
            mode: typeof coreLib.HighlightMode.SELECTION_HIGHLIGHT;
        }> = [
            ...this.inspection.selectionIdsTopic.getValue().map(
                (panel: InspectionPanelModel<TileFeatureId>) => ({
                    kind: "selection" as const,
                    id: String(panel.id),
                    color: panel.color,
                    features: panel.features,
                    mode: coreLib.HighlightMode.SELECTION_HIGHLIGHT
                })
            ),
            {
                kind: "hover",
                id: "current",
                features: this.inspection.hoverIdsTopic.getValue(),
                mode: coreLib.HighlightMode.HOVER_HIGHLIGHT
            }
        ];
        const desired = new Map<string, {
            mapgetLayer: MapgetLayer;
            style: ErdblickStyle;
            mode: typeof coreLib.HighlightMode.SELECTION_HIGHLIGHT;
            presentationKind: "selection" | "hover";
            presentationId: string;
            options: Record<string, boolean | number | string>;
            plan: StyleFilterPlan;
            tileIds: number[];
            roots: Array<{tileId: number; featureId: string}>;
            styleOrder: number;
        }>();

        for (const group of groups) {
            const byLayer = new Map<string, {
                mapgetLayer: MapgetLayer;
                features: Array<TileFeatureId & {tileId: number}>;
            }>();
            for (const feature of group.features) {
                const parsed = this.parseFeatureTileId(feature);
                if (!parsed) {
                    continue;
                }
                const {mapId, layerId, tileId} = parsed;
                const mapgetLayer = this.mapInfo.mapgetLayer(mapId, layerId);
                if (!mapgetLayer ||
                    !this.mapInfo.maps.getMapLayerVisibility(
                        this.viewIndex,
                        mapId,
                        layerId
                    ) ||
                    Number(coreLib.getTileLevel(tileId)) !==
                        this.viewState.getEffectiveMapLayerLevel(
                            this.viewIndex,
                            mapId,
                            layerId
                        )) {
                    continue;
                }
                let entry = byLayer.get(mapgetLayer.key);
                if (!entry) {
                    entry = {mapgetLayer, features: []};
                    byLayer.set(mapgetLayer.key, entry);
                }
                if (!entry.features.some(candidate =>
                    candidate.mapTileKey === feature.mapTileKey &&
                    candidate.featureId === feature.featureId
                )) {
                    entry.features.push({...feature, tileId});
                }
            }

            for (const {mapgetLayer, features} of byLayer.values()) {
                const resolvedFeatures = features.map(feature => ({
                    ...feature,
                    backendFeatureId:
                        stripFeatureInspectionTarget(feature.featureId)
                }));
                const roots = resolvedFeatures.map(feature => ({
                    tileId: feature.tileId,
                    featureId: feature.backendFeatureId
                }));
                const tileIds = [...new Set(
                    resolvedFeatures.map(feature => feature.tileId)
                )];
                for (let styleIndex = 0;
                     styleIndex < orderedStyles.length;
                     ++styleIndex) {
                    const style = orderedStyles[styleIndex];
                    if (!style.featureLayerStyle.hasLayerAffinity(
                        mapgetLayer.layerId
                    ) ||
                        !style.featureLayerStyle.supportsHighlightMode(
                            group.mode
                        )) {
                        continue;
                    }
                    const rawPlan = this.mapInfo.planStyleFilter(
                        style.featureLayerStyle,
                        mapgetLayer.mapId,
                        mapgetLayer.layerId,
                        group.mode.value,
                        coreLib.RuleFidelity.ANY.value
                    ) as StyleFilterPlan;
                    if (!rawPlan.valid || !rawPlan.channels.length) {
                        continue;
                    }
                    const plan = structuredClone(rawPlan);
                    plan.channels = plan.channels.filter(channel => {
                        const scopedFeatures = channel.scope === "attribute"
                            ? resolvedFeatures.filter(feature =>
                                /:attribute#\d+/.test(feature.featureId))
                            : resolvedFeatures;
                        // A bare feature selection must not expand every
                        // attribute/validity merely because the highlight
                        // stylesheet also contains attribute rules.
                        if (scopedFeatures.length === 0) {
                            return false;
                        }
                        const scopedRestriction = scopedFeatures
                            .map(feature =>
                                `id == ${JSON.stringify(feature.backendFeatureId)}`)
                            .join(" or ");
                        channel.featureFilter = channel.featureFilter
                            ? `(${channel.featureFilter}) and (${scopedRestriction})`
                            : scopedRestriction;
                        const entryRestrictions = scopedFeatures.flatMap(
                            feature => {
                                if (channel.scope === "attribute") {
                                    const match = feature.featureId.match(
                                        /:attribute#(\d+)(?:[:,]validity#(\d+))?/
                                    );
                                    const conditions = [
                                        `$feature.id == ${JSON.stringify(feature.backendFeatureId)}`
                                    ];
                                    if (match) {
                                        conditions.push(
                                            `$attributeIndex == ${Number(match[1])}`
                                        );
                                        if (match[2] !== undefined) {
                                            conditions.push(
                                                "$hasValidity",
                                                `$validityIndex == ${Number(match[2])}`
                                            );
                                        }
                                    }
                                    return [`(${conditions.join(" and ")})`];
                                }
                                if (channel.scope === "relation") {
                                    const match = feature.featureId.match(
                                        /:relation#(\d+)/
                                    );
                                    if (match) {
                                        return [
                                            `($source.id == ${JSON.stringify(feature.backendFeatureId)} and ` +
                                            `$relationIndex == ${Number(match[1])})`
                                        ];
                                    }
                                    // Exact roots already restrict traversal
                                    // to this selected feature. Restricting
                                    // every terminal relation to the root as
                                    // its source would discard recursively
                                    // discovered local edges.
                                    return [];
                                }
                                return [];
                            }
                        );
                        if (entryRestrictions.length) {
                            const entryRestriction =
                                entryRestrictions.join(" or ");
                            channel.entryFilter = channel.entryFilter
                                ? `(${channel.entryFilter}) and (${entryRestriction})`
                                : entryRestriction;
                        }
                        return true;
                    });
                    if (!plan.channels.length) {
                        continue;
                    }
                    const needsRoots = plan.channels.some(channel =>
                        channel.scope === "relation"
                    );
                    const options = {
                        ...(this.mapInfo.maps.getLayerStyleOptions(
                            this.viewIndex,
                            mapgetLayer.mapId,
                            mapgetLayer.layerId,
                            style.id
                        ) ?? {})
                    };
                    if (group.color) {
                        options["selectableFeatureHighlightColor"] = group.color;
                    }
                    const identitySignature = sipHash64Hex(JSON.stringify({
                        features: features.map(feature => [
                            feature.mapTileKey,
                            feature.featureId
                        ]),
                        options
                    }));
                    const presentationId = [
                        group.id,
                        style.id,
                        this.styleVersion(style),
                        identitySignature
                    ].join(":");
                    const key = [
                        mapgetLayer.key,
                        group.kind,
                        presentationId
                    ].join("/");
                    desired.set(key, {
                        mapgetLayer,
                        style,
                        mode: group.mode,
                        presentationKind: group.kind,
                        presentationId,
                        options,
                        plan,
                        tileIds,
                        roots: needsRoots ? roots : [],
                        styleOrder: styleIndex +
                            (group.kind === "hover" ? 3000 : 2000)
                    });
                }
            }
        }

        for (const [key, owned] of [...this.styledLayers]) {
            const kind = owned.layer.identity.presentationKind;
            if (kind !== "selection" && kind !== "hover") {
                continue;
            }
            const next = desired.get(key);
            if (next &&
                owned.layer.style === next.style &&
                owned.layer.mapgetLayer === next.mapgetLayer) {
                continue;
            }
            this.styledLayers.delete(key);
            this.destroyOwnedLayer(owned);
        }

        for (const [key, next] of desired) {
            let owned = this.styledLayers.get(key);
            if (!owned) {
                try {
                    const layer = new StyledMapgetLayer(
                        {
                            viewIndex: this.viewIndex,
                            mapId: next.mapgetLayer.mapId,
                            layerId: next.mapgetLayer.layerId,
                            presentationKind: next.presentationKind,
                            presentationInstanceId: next.presentationId
                        },
                        next.mapgetLayer,
                        next.style,
                        next.options,
                        this.mapInfo,
                        this.tileStream,
                        next.mode,
                        coreLib.RuleFidelity.ANY,
                        next.plan
                    );
                    owned = {
                        layer,
                        subscription: layer.events.subscribe(event =>
                            this.handleStyledLayerEvent(layer, event)
                        ),
                        visualizations: new Map(),
                        visualizationKeyByTileId: new Map(),
                        pendingBlockTiles: new Map(),
                        disposeLayer: true,
                        replacementSlot: null,
                        replacementTileIds: new Set()
                    };
                    this.styledLayers.set(key, owned);
                } catch (error) {
                    console.error("Failed to create highlight presentation.", error);
                    continue;
                }
            }
            owned.layer.styleOrder = next.styleOrder;
            owned.layer.setCoverage(
                next.tileIds,
                next.tileIds,
                next.roots
            );
            this.reconcileOwnedVisualizations(owned);
        }
    }

    private parseFeatureTileId(feature: TileFeatureId): {
        mapId: string;
        layerId: string;
        tileId: number;
    } | null {
        try {
            const [mapId, layerId, tileId] =
                coreLib.parseMapTileKey(feature.mapTileKey);
            const numericTileId = Number(tileId);
            return Number.isInteger(numericTileId)
                ? {mapId, layerId, tileId: numericTileId}
                : null;
        } catch (_error) {
            return null;
        }
    }

    /** Reconciles values which may have arrived before this view subscribed. */
    private reconcileOwnedVisualizations(owned: OwnedStyledLayer): void {
        for (const [key, visualization] of [...owned.visualizations]) {
            const retained = visualization.states.some(state =>
                owned.layer.tileStates.get(state.tileId) === state &&
                this.presentationStillDemanded(owned.layer, state)
            );
            const fidelities = visualization.states.map(state =>
                this.presentationFidelity(owned.layer, state)
            );
            const sameFidelity = fidelities.every(
                fidelity => fidelity === fidelities[0]
            ) && visualization.hasSameStates(
                visualization.states,
                fidelities[0]
            );
            const terminalIncomplete =
                visualization.states.some(state => state.status === "error") &&
                visualization.states.every(state => state.status !== "pending");
            if (!retained ||
                !sameFidelity ||
                terminalIncomplete ||
                !this.fitsBlockVertexBudget(visualization.states)) {
                this.dissolveBlockVisualization(owned, key, true);
                continue;
            }
            if (visualization.states.every(
                state => state.status === "ready" && !!state.subsetBlob
            )) {
                this.renderBlockVisualization(visualization);
            }
        }

        for (const state of owned.layer.tileStates.values()) {
            if (this.shouldVisualize(owned.layer, state) &&
                !owned.visualizationKeyByTileId.has(state.tileId)) {
                this.enqueueBlockTile(owned, state);
            }
        }

        for (const [tileId, pending] of [...owned.pendingBlockTiles]) {
            if (owned.layer.tileStates.get(tileId) !== pending.state ||
                !this.shouldVisualize(owned.layer, pending.state)) {
                owned.pendingBlockTiles.delete(tileId);
            }
        }
        this.scheduleBlockAssembly();
    }

    private reconcileReadyBlockTile(
        owned: OwnedStyledLayer,
        state: FilterTileState
    ): void {
        if (!this.shouldVisualize(owned.layer, state)) {
            return;
        }
        const existingKey =
            owned.visualizationKeyByTileId.get(state.tileId);
        if (existingKey) {
            const visualization = owned.visualizations.get(existingKey);
            if (visualization &&
                !this.fitsBlockVertexBudget(visualization.states)) {
                this.dissolveBlockVisualization(
                    owned,
                    existingKey,
                    true
                );
                return;
            }
            if (visualization?.states.every(
                member => member.status === "ready" && !!member.subsetBlob
            )) {
                this.renderBlockVisualization(visualization);
            }
            return;
        }
        this.enqueueBlockTile(owned, state);
    }

    private enqueueBlockTile(
        owned: OwnedStyledLayer,
        state: FilterTileState
    ): void {
        const existing = owned.pendingBlockTiles.get(state.tileId);
        owned.pendingBlockTiles.set(state.tileId, {
            state,
            fidelity: this.presentationFidelity(owned.layer, state),
            queuedAt: existing?.queuedAt ?? performance.now()
        });
        this.scheduleBlockAssembly();
    }

    private scheduleBlockAssembly(): void {
        if (this.disposed || this.blockAssemblyTimer !== null) {
            return;
        }
        const hasPending = [...this.styledLayers.values()].some(
            owned => owned.pendingBlockTiles.size > 0
        );
        if (!hasPending) {
            return;
        }
        this.blockAssemblyTimer = setTimeout(() => {
            this.blockAssemblyTimer = null;
            let madeProgress = true;
            while (madeProgress &&
                this.renderService.availableWorkerSlots() > 0) {
                madeProgress = false;
                for (const owned of this.styledLayers.values()) {
                    if (this.renderService.availableWorkerSlots() <= 0) {
                        break;
                    }
                    madeProgress =
                        this.assembleOnePendingBlock(owned) || madeProgress;
                }
            }
            if (this.sceneHandle &&
                this.renderService.availableWorkerSlots() > 0 &&
                [...this.styledLayers.values()].some(
                    owned => owned.pendingBlockTiles.size > 0
                )) {
                this.scheduleBlockAssembly();
            }
        }, BLOCK_ASSEMBLY_CADENCE_MS);
    }

    private assembleOnePendingBlock(owned: OwnedStyledLayer): boolean {
        if (!this.sceneHandle ||
            !owned.pendingBlockTiles.size ||
            this.renderService.availableWorkerSlots() <= 0) {
            return false;
        }
        let selection: {
            block: MortonBlockBatch;
            members: Array<{
                state: FilterTileState;
                fidelity: number;
                queuedAt: number;
            }>;
        } | null = null;
        for (const anchor of owned.pendingBlockTiles.values()) {
            selection = this.largestAvailableBlock(owned, anchor);
            if (selection) {
                break;
            }
        }
        if (!selection) {
            return false;
        }
        const fidelity = selection.members[0].fidelity;
        for (const member of selection.members) {
            owned.pendingBlockTiles.delete(member.state.tileId);
        }
        const visualizationKey =
            `${selection.block.key}/f${fidelity}`;
        const states = selection.members.map(member => member.state);
        const visualization = new TileSubsetLayerVisualization(
            owned.layer,
            states,
            visualizationKey,
            selection.block.origin,
            this.renderService,
            this.styleValidationReports,
            fidelity,
            this.viewIndex
        );
        visualization.setDebugBlockVisualization(
            this.renderService.debugRenderBlocksEnabled(),
            this.sceneHandle
        );
        owned.visualizations.set(visualizationKey, visualization);
        for (const state of states) {
            owned.visualizationKeyByTileId.set(
                state.tileId,
                visualizationKey
            );
        }
        this.renderBlockVisualization(visualization);
        return true;
    }

    private largestAvailableBlock(
        owned: OwnedStyledLayer,
        anchor: {
            state: FilterTileState;
            fidelity: number;
            queuedAt: number;
        }
    ): {
        block: MortonBlockBatch;
        members: Array<{
            state: FilterTileState;
            fidelity: number;
            queuedAt: number;
        }>;
    } | null {
        if (owned.layer.identity.presentationKind === "regular" &&
            !anchor.state.glbAttachmentName) {
            for (const suffixBitCount of
                MORTON_AGGREGATE_BLOCK_BIT_COUNTS) {
                const block = mortonBlockBatch(
                    anchor.state.tileId,
                    suffixBitCount
                );
                const states = block.tileIds.map(
                    tileId => owned.layer.tileStates.get(tileId)
                );
                const isCompleteCoverageBlock = states.every(
                    (state): state is FilterTileState =>
                        !!state &&
                        state.status !== "error" &&
                        this.presentationStillDemanded(owned.layer, state) &&
                        this.presentationFidelity(owned.layer, state) ===
                            anchor.fidelity
                );
                if (!isCompleteCoverageBlock) {
                    continue;
                }
                if (!fitsMortonPresentationVertexBudget(
                    states.map(state => state.status === "ready"
                        ? state.geometryVertexCount
                        : 0),
                    this.renderService.blockVertexLimit()
                )) {
                    continue;
                }
                if (states.some(
                    state => state.status !== "ready" || !state.subsetBlob
                )) {
                    // Give adjacent completions a short batching window, then
                    // prefer visible progress over an indefinitely perfect
                    // coverage block.
                    if (performance.now() - anchor.queuedAt <
                        BLOCK_ASSEMBLY_MAX_WAIT_MS) {
                        return null;
                    }
                    break;
                }
                if (states.some(state => state.glbAttachmentName)) {
                    continue;
                }
                const members = states.map(
                    state => owned.pendingBlockTiles.get(state.tileId)
                );
                if (members.every(
                    (member): member is typeof anchor =>
                        !!member &&
                        member.fidelity === anchor.fidelity &&
                        member.state.stringPoolId ===
                            anchor.state.stringPoolId
                )) {
                    return {block, members};
                }
            }
        }
        if (!anchor.state.glbAttachmentName) {
            for (const suffixBitCount of
                MORTON_AGGREGATE_BLOCK_BIT_COUNTS) {
                const block = mortonBlockBatch(
                    anchor.state.tileId,
                    suffixBitCount
                );
                const members = block.tileIds.map(
                    tileId => owned.pendingBlockTiles.get(tileId)
                );
                if (members.every(
                    (member): member is typeof anchor =>
                        !!member &&
                        member.fidelity === anchor.fidelity &&
                        member.state.stringPoolId ===
                            anchor.state.stringPoolId &&
                        !member.state.glbAttachmentName
                ) && fitsMortonPresentationVertexBudget(
                    members.map(member =>
                        member?.state.geometryVertexCount ?? 0
                    ),
                    this.renderService.blockVertexLimit()
                )) {
                    return {block, members};
                }
            }
        }
        return {
            block: mortonBlockBatch(anchor.state.tileId, 0),
            members: [anchor]
        };
    }

    private fitsBlockVertexBudget(
        states: readonly FilterTileState[]
    ): boolean {
        return fitsMortonPresentationVertexBudget(
            states.map(state => state.geometryVertexCount),
            this.renderService.blockVertexLimit()
        );
    }

    private removeBlockTile(
        owned: OwnedStyledLayer,
        tileId: number
    ): void {
        owned.pendingBlockTiles.delete(tileId);
        const key = owned.visualizationKeyByTileId.get(tileId);
        if (!key) {
            return;
        }
        const visualization = owned.visualizations.get(key);
        if (visualization?.states.some(state =>
            owned.layer.tileStates.get(state.tileId) === state &&
            this.presentationStillDemanded(owned.layer, state)
        )) {
            return;
        }
        this.dissolveBlockVisualization(owned, key, true);
    }

    private dissolveBlockVisualization(
        owned: OwnedStyledLayer,
        key: string,
        requeueRemaining: boolean
    ): void {
        const visualization = owned.visualizations.get(key);
        if (!visualization) {
            return;
        }
        owned.visualizations.delete(key);
        for (const state of visualization.states) {
            if (owned.visualizationKeyByTileId.get(state.tileId) === key) {
                owned.visualizationKeyByTileId.delete(state.tileId);
            }
        }
        visualization.destroy(this.sceneHandle);
        if (!requeueRemaining) {
            return;
        }
        for (const state of visualization.states) {
            if (owned.layer.tileStates.get(state.tileId) === state &&
                this.shouldVisualize(owned.layer, state)) {
                this.enqueueBlockTile(owned, state);
            }
        }
    }

    private renderBlockVisualization(
        visualization: TileSubsetLayerVisualization
    ): void {
        if (!this.sceneHandle) {
            return;
        }
        visualization.render(this.sceneHandle)
            .then(rendered => {
                if (rendered) {
                    const owned = [...this.styledLayers.values()].find(
                        candidate =>
                            candidate.layer === visualization.owner
                    );
                    if (owned) {
                        this.releaseRegularFallbackWhenReady(owned);
                    }
                    this.diagnostics.notifyChanged();
                }
            })
            .catch(error =>
                console.error("TileSubsetLayer block visualization failed.", error)
            );
    }

    private presentationFidelity(
        layer: StyledMapgetLayer,
        state: FilterTileState
    ): number {
        if (layer.identity.presentationKind === "search") {
            return coreLib.RuleFidelity.HIGH.value;
        }
        if (layer.identity.presentationKind === "regular" &&
            layer.plannedFidelity.value !==
                coreLib.RuleFidelity.ANY.value) {
            return layer.plannedFidelity.value;
        }
        return this.fidelityFor(state.tileId);
    }

    private presentationStillDemanded(
        layer: StyledMapgetLayer,
        state: FilterTileState
    ): boolean {
        if (layer.tileStates.get(state.tileId) !== state) {
            return false;
        }
        if (layer.identity.presentationKind !== "search" ||
            state.status !== "ready") {
            return true;
        }
        return this.featureSearch.shouldRenderSearchStyledLayer(
            this.viewIndex,
            layer,
            state.tileId
        );
    }

    private shouldVisualize(
        layer: StyledMapgetLayer,
        state: FilterTileState
    ): boolean {
        if (state.status !== "ready" || !state.subsetBlob) {
            return false;
        }
        if (layer.identity.presentationKind !== "search") {
            return true;
        }
        return this.featureSearch.shouldRenderSearchStyledLayer(
            this.viewIndex,
            layer,
            state.tileId
        );
    }

    /**
     * Point-grid output owners can sit just outside the viewport. The initial
     * point-grid contract has a one-tile halo, so request one deterministic
     * neighbor ring only when the planned stylesheet contains grouping.
     */
    private expandGroupCoverage(
        visibleTileIds: readonly number[],
        style: ErdblickStyle,
        mapgetLayer: MapgetLayer
    ): number[] {
        const plan = this.mapInfo.planStyleFilter(
            style.featureLayerStyle,
            mapgetLayer.mapId,
            mapgetLayer.layerId,
            coreLib.HighlightMode.NO_HIGHLIGHT.value,
            coreLib.RuleFidelity.ANY.value
        ) as {channels?: Array<{group?: unknown}>};
        if (!plan.channels?.some(channel => channel.group)) {
            return [...visibleTileIds];
        }
        const result = [...visibleTileIds];
        const seen = new Set(result);
        for (const tileId of visibleTileIds) {
            for (let y = -1; y <= 1; ++y) {
                for (let x = -1; x <= 1; ++x) {
                    if (x === 0 && y === 0) {
                        continue;
                    }
                    const neighbor = Number(coreLib.getTileNeighbor(tileId, x, y));
                    if (!seen.has(neighbor)) {
                        seen.add(neighbor);
                        result.push(neighbor);
                    }
                }
            }
        }
        return result;
    }
}
