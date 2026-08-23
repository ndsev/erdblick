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
    TileSubsetLayerRenderService
} from "./deck/tile-subset-layer-render.service";
import {
    TileSubsetLayerVisualization,
    type TileSubsetInteractionOverlay
} from "./deck/tile-subset-layer.visualization";
import {
    resolveDeckInteractionEffect,
    type DeckInteractionEffect
} from
    "./deck/deck-interaction-effect";
import {tileCoordinateOrigin} from "./deck/tile-coordinate-origin";
import type {FeatureSearchService} from "../search/feature.search.service";
import type {
    InspectionSelectionService
} from "../inspection/inspection-selection.service";
import type {
    InspectionPanelModel,
    TileFeatureId
} from "../shared/appstate.service";
import {sipHash64Hex} from "../styledata/hash";
import {
    tileFeatureInteractionTargetsEqual
} from "../shared/tile-feature-id";
import {
    hasAuthoredInteractionHighlight,
    interactionTargetKey,
    planRemoteInteractionHighlight
} from "./interaction-highlight-plan";
import type {
    ViewLayerDiagnosticsService
} from "./view-layer-diagnostics.service";
import type {
    StyleValidationReportService
} from "../styledata/style-validation-report.service";
import type {RuleFidelity} from "../../build/libs/core/erdblick-core";
import type {HoverDetailService} from "../mapdata/hover-detail.service";
import {NgZone} from "@angular/core";
import type {GpuSceneSnapshot} from "./deck/gpu-scene";
import {INTERACTION_STYLE_ORDER_BASE} from
    "./deck/tile-subset-interaction.model";

export type ViewTileOccupancy = "unknown" | "empty" | "non-empty" | "error";

interface OwnedStyledLayer {
    layer: StyledMapgetLayer;
    subscription: Subscription;
    visualizations: Map<string, TileSubsetLayerVisualization>;
    visualizationKeyByTileId: Map<number, string>;
    pendingTiles: Map<number, {
        state: FilterTileState;
        fidelity: number;
        lineSimplificationToleranceMeters: number;
        preservedContributionIdentity: string | null;
    }>;
    disposeLayer: boolean;
    replacementSlot: string | null;
    replacementTileIds: Set<number>;
}

interface RetiringRegularLayer {
    key: string;
    owned: OwnedStyledLayer;
}

/**
 * View-local owner which reconciles catalog, style, and viewport state.
 *
 * Renderer/device recreation only replaces `sceneHandle`; filter refs, subsets,
 * and logical visualizations remain alive for the logical view lifetime.
 */
export class ViewLayerController {
    readonly occupancyChanged = new Subject<void>();
    private readonly subscriptions: Subscription[] = [];
    private readonly styledLayers = new Map<string, OwnedStyledLayer>();
    private readonly retiringRegularLayers =
        new Map<string, RetiringRegularLayer>();
    private sceneHandle: IRenderSceneHandle | null = null;
    private disposed = false;
    private reconcileQueued = false;
    private fullReconcileRequired = true;
    private interactionReconcileRequired = true;
    private lastViewportPresentationSignature = "";
    private lastInteractionViewportSignature = "";
    private localInteractionOverlaysByLayer =
        new Map<string, readonly TileSubsetInteractionOverlay[]>();
    private readonly localInteractionVisualizationsWithOverlays =
        new Set<TileSubsetLayerVisualization>();
    private readonly regularCoverageByLayer = new WeakMap<
        StyledMapgetLayer,
        {tileIds: readonly number[]; priorityTileIds: readonly number[]}
    >();
    private interactionLayerAffinityCache =
        new WeakMap<ErdblickStyle, Map<string, boolean>>();
    private interactionFilterPlanCache =
        new WeakMap<ErdblickStyle, Map<string, StyleFilterPlan | null>>();
    private interactionEffectCache =
        new WeakMap<ErdblickStyle, Map<string, DeckInteractionEffect | null>>();
    private pendingDispatchQueued = false;
    private nextStyledLayerDispatchIndex = 0;
    private readonly pendingVisualizationRenders =
        new Set<TileSubsetLayerVisualization>();
    private readonly unregisterDiagnostics: () => void;

    /** Bind one logical view to catalog, style, search, inspection, and worker state. */
    constructor(
        readonly viewIndex: number,
        private readonly mapInfo: MapInfoService,
        private readonly viewState: MapViewStateService,
        private readonly tileStream: MapTileStreamService,
        private readonly styleService: StyleService,
        private readonly renderService: TileSubsetLayerRenderService,
        private readonly featureSearch: FeatureSearchService,
        private readonly inspection: InspectionSelectionService,
        private readonly hoverDetails: HoverDetailService,
        private readonly diagnostics: ViewLayerDiagnosticsService,
        private readonly styleValidationReports: StyleValidationReportService,
        private readonly ngZone: NgZone
    ) {
        this.unregisterDiagnostics = diagnostics.register(
            viewIndex,
            () => this.diagnosticStyledLayers(),
            (layer, state) => this.presentationStillDemanded(layer, state)
        );
        this.subscriptions.push(
            this.mapInfo.maps$.subscribe(() => this.scheduleReconcile()),
            this.mapInfo.dataSourceInfoChanged.subscribe(() =>
                this.resetInteractionStyleCaches()),
            this.mapInfo.layerStateChanged.subscribe(() => this.scheduleReconcile()),
            this.mapInfo.styleOptionsChanged.subscribe(changes => {
                if (changes.some(change => change.viewIndex === this.viewIndex)) {
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
                this.scheduleInteractionReconcile()
            ),
            this.inspection.hoverIdsTopic.subscribe(() =>
                this.scheduleInteractionReconcile()
            ),
            this.renderService.capacityChanged.subscribe(() =>
                this.schedulePendingTiles()
            )
        );
        this.scheduleReconcile();
    }

    /** Attach a fresh renderer generation and replay every retained contribution. */
    attachScene(sceneHandle: IRenderSceneHandle): void {
        this.ngZone.runOutsideAngular(() => {
            this.sceneHandle = sceneHandle;
            for (const owned of this.styledLayers.values()) {
                for (const visualization of owned.visualizations.values()) {
                    visualization.reattach(sceneHandle);
                    this.queueVisualizationRender(visualization);
                }
            }
            for (const {owned} of this.retiringRegularLayers.values()) {
                for (const visualization of owned.visualizations.values()) {
                    visualization.reattach(sceneHandle);
                    this.queueVisualizationRender(visualization);
                }
            }
            this.schedulePendingTiles();
        });
    }

    /** Stop publishing into a renderer generation that is being destroyed. */
    detachScene(): void {
        this.sceneHandle = null;
    }

    /**
     * Tear down one map's active presentation and request a fresh transport
     * generation without changing coverage, styles, visibility, or view state.
     */
    refreshMap(mapId: string): void {
        if (this.disposed || !mapId) {
            return;
        }

        for (const [slot, fallback] of
             [...this.retiringRegularLayers])
        {
            if (fallback.owned.layer.identity.mapId !== mapId) {
                continue;
            }
            this.retiringRegularLayers.delete(slot);
            this.destroyOwnedLayer(fallback.owned);
        }

        let refreshed = false;
        for (const owned of this.styledLayers.values()) {
            if (owned.layer.identity.mapId !== mapId ||
                owned.layer.identity.presentationKind === "search")
            {
                continue;
            }
            this.clearOwnedVisualizations(owned);
            owned.layer.refresh();
            refreshed = true;
        }

        if (refreshed) {
            this.occupancyChanged.next();
            this.diagnostics.notifyChanged();
        }
    }

    /** Bridges view-local Deck screen-pass timing into global diagnostics. */
    recordDeckFrameTime(milliseconds: number): void {
        this.renderService.recordDeckFrameTime(
            this.viewIndex,
            milliseconds
        );
    }

    /** Let diagnostics defer Angular publications while this view's camera moves. */
    setCameraInteracting(active: boolean): void {
        this.diagnostics.setViewInteracting(this.viewIndex, active);
    }

    /** Exposes view-owned Deck counters to diagnostics without sampling every frame. */
    setDeckPresentationDiagnosticsProvider(
        provider: () => {layers: number; scene: GpuSceneSnapshot}
    ): void {
        this.renderService.setDeckPresentationDiagnosticsProvider(
            this.viewIndex,
            provider
        );
    }

    /** Removes a Deck diagnostics provider when its renderer generation ends. */
    clearDeckPresentationDiagnostics(): void {
        this.renderService.clearDeckPresentationDiagnostics(this.viewIndex);
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

    /** Release every logical layer, worker request, diagnostic hook, and subscription. */
    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.subscriptions.splice(0).forEach(subscription => subscription.unsubscribe());
        for (const owned of this.styledLayers.values()) {
            this.destroyOwnedLayer(owned);
        }
        this.styledLayers.clear();
        for (const {owned} of this.retiringRegularLayers.values()) {
            this.destroyOwnedLayer(owned);
        }
        this.retiringRegularLayers.clear();
        this.pendingVisualizationRenders.clear();
        this.localInteractionOverlaysByLayer.clear();
        this.hoverDetails.clearView(this.viewIndex);
        this.renderService.clearDeckFrameTime(this.viewIndex);
        this.renderService.clearDeckPresentationDiagnostics(this.viewIndex);
        this.unregisterDiagnostics();
        this.sceneHandle = null;
        this.occupancyChanged.complete();
    }

    /** Coalesce demand changes outside Angular into one microtask reconciliation. */
    private scheduleReconcile(fullReconcile = true): void {
        this.ngZone.runOutsideAngular(() => {
            if (this.disposed) {
                return;
            }
            this.fullReconcileRequired ||= fullReconcile;
            this.interactionReconcileRequired ||= fullReconcile;
            this.queueReconcile();
        });
    }

    /** Queue only exact hover/selection mask work, without revisiting regular coverage. */
    private scheduleInteractionReconcile(): void {
        this.ngZone.runOutsideAngular(() => {
            if (this.disposed) {
                return;
            }
            this.interactionReconcileRequired = true;
            this.queueReconcile();
        });
    }

    /** Coalesce full, viewport-only, and interaction-only work into one microtask. */
    private queueReconcile(): void {
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
            const viewportSignature = this.viewportPresentationSignature();
            const viewportChanged = viewportSignature !==
                this.lastViewportPresentationSignature;
            if (!full && !viewportChanged) {
                if (this.interactionReconcileRequired) {
                    this.reconcileInteractions();
                }
                return;
            }
            this.reconcile();
            this.lastViewportPresentationSignature =
                this.viewportPresentationSignature();
        });
    }

    /** Reconcile semantic masks and authored interaction styles against retained tiles. */
    private reconcileInteractions(): void {
        this.interactionReconcileRequired = false;
        const orderedStyles = [...this.styleService.styles.values()]
            .filter(style => style.visible);
        this.reconcileHighlightLayers(orderedStyles);
        this.lastInteractionViewportSignature =
            this.interactionViewportSignature();
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

    /** Reconcile desired regular/search/interaction owners without rebuilding the view. */
    private reconcile(): void {
        const desired = new Map<string, {
            mapgetLayer: MapgetLayer;
            style: ErdblickStyle;
            styleOrder: number;
            tileIds: readonly number[];
            priorityTileIds: readonly number[];
            options: Record<string, boolean | number | string>;
            plannedFidelity: RuleFidelity;
            replacementSlot: string;
        }>();
        const hoverDetailCoverage: Array<{
            mapgetLayer: MapgetLayer;
            tileIds: readonly number[];
            priorityTileIds: readonly number[];
        }> = [];
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
                desired.set(key, {
                    mapgetLayer,
                    style,
                    styleOrder,
                    tileIds: visibleTileIds,
                    priorityTileIds: visibleTileIds,
                    options,
                    plannedFidelity,
                    replacementSlot: this.regularReplacementSlot(
                        mapgetLayer,
                        style
                    )
                });
            }
            hoverDetailCoverage.push({
                mapgetLayer,
                tileIds: visibleTileIds,
                priorityTileIds: visibleTileIds
            });
        }
        this.hoverDetails.reconcileView(this.viewIndex, hoverDetailCoverage);
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
                        subscription: this.subscribeToStyledLayer(layer),
                        visualizations: new Map(),
                        visualizationKeyByTileId: new Map(),
                        pendingTiles: new Map(),
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
            this.setRegularCoverage(
                owned.layer,
                next.tileIds,
                next.priorityTileIds
            );
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
        const interactionViewportSignature =
            this.interactionViewportSignature();
        if (this.interactionReconcileRequired ||
            interactionViewportSignature !==
                this.lastInteractionViewportSignature) {
            this.interactionReconcileRequired = false;
            this.reconcileHighlightLayers(orderedStyles);
            this.lastInteractionViewportSignature =
                interactionViewportSignature;
        }
        this.occupancyChanged.next();
        this.diagnostics.notifyChanged();
    }

    /** Routes high-volume tile events through the non-Angular render pipeline. */
    private subscribeToStyledLayer(layer: StyledMapgetLayer): Subscription {
        return layer.events.subscribe(event =>
            this.ngZone.runOutsideAngular(() =>
                this.handleStyledLayerEvent(layer, event))
        );
    }

    /** Turn immutable filter events into singleton visualization lifecycle changes. */
    private handleStyledLayerEvent(
        layer: StyledMapgetLayer,
        event: StyledMapgetLayerEvent
    ): void {
        const owned = [...this.styledLayers.values()].find(candidate => candidate.layer === layer);
        if (!owned) {
            return;
        }
        if (event.type === "tile-ready") {
            this.reconcileReadyTile(owned, event.state);
            this.occupancyChanged.next();
            this.diagnostics.notifyChanged();
            return;
        }
        if (event.type === "tiles-removed") {
            this.removeTileVisualizations(owned, event.states);
            this.occupancyChanged.next();
            this.diagnostics.notifyChanged();
            return;
        }
        if (event.type === "tiles-pending") {
            this.occupancyChanged.next();
            this.diagnostics.notifyChanged();
            return;
        }
        if (event.type === "status" &&
            ["Success", "Failed", "Aborted"].includes(event.status.state)) {
            this.reconcileOwnedVisualizations(owned);
        }
        if (event.type === "error") {
            this.occupancyChanged.next();
            this.diagnostics.notifyLayerErrors(this.viewIndex, layer);
            return;
        }
        if (event.type === "status") {
            this.occupancyChanged.next();
            this.diagnostics.notifyChanged();
        }
    }

    /** Retire one filter owner and every GPU/GLTF contribution it controls. */
    private destroyOwnedLayer(owned: OwnedStyledLayer): void {
        owned.subscription.unsubscribe();
        this.clearOwnedVisualizations(owned);
        if (owned.disposeLayer) {
            owned.layer.dispose();
        }
    }

    /** Releases every render and attachment resource while retaining the transport owner. */
    private clearOwnedVisualizations(owned: OwnedStyledLayer): void {
        const hadInstalledVisualizations = owned.visualizations.size > 0;
        for (const tileId of [...owned.pendingTiles.keys()]) {
            this.discardPendingTile(owned, tileId);
        }
        for (const visualization of owned.visualizations.values()) {
            this.pendingVisualizationRenders.delete(visualization);
            this.localInteractionVisualizationsWithOverlays.delete(
                visualization
            );
            visualization.destroy(this.sceneHandle);
        }
        owned.visualizations.clear();
        owned.visualizationKeyByTileId.clear();
        if (hadInstalledVisualizations) {
            this.scheduleInteractionPresenceReconcile(owned.layer);
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

    /** Require every demanded successor tile to be visibly installed before handover. */
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

    /** Resolve the view's contextual fidelity preference for one tile. */
    private fidelityFor(tileId: number): number {
        return this.viewState.prefersHighFidelityForTile(this.viewIndex, tileId)
            ? coreLib.RuleFidelity.HIGH.value
            : coreLib.RuleFidelity.LOW.value;
    }

    /** Build the immutable transport-owner key for one regular style incarnation. */
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

    /** Build the stable handover slot shared by successive style incarnations. */
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
                    subscription: this.subscribeToStyledLayer(layer),
                    visualizations: new Map(),
                    visualizationKeyByTileId: new Map(),
                    pendingTiles: new Map(),
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

    /** Keep each service-owned search presentation independently addressable. */
    private searchKey(layer: StyledMapgetLayer): string {
        return `search/${layer.ownerId}`;
    }

    /** Reconciles exact-ID hover and selection bundles through the normal filter path. */
    private reconcileHighlightLayers(orderedStyles: readonly ErdblickStyle[]): void {
        const selectedTargets = this.inspection.selectionIdsTopic.getValue()
            .flatMap(panel => panel.features);
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
                // Selection dominates hover only for the exact same semantic
                // target. Nested attribute/validity rows remain hoverable so
                // their authored inspection visualizations can still run.
                features: this.inspection.hoverIdsTopic.getValue().filter(
                    hovered => !selectedTargets.some(selected =>
                        tileFeatureInteractionTargetsEqual(
                            hovered,
                            selected))),
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
        const localOverlaysByLayer = new Map<
            string,
            Map<string, TileSubsetInteractionOverlay>
        >();

        for (const group of groups) {
            const byLayer = new Map<string, {
                mapgetLayer: MapgetLayer;
                features: Array<TileFeatureId & {tileId: number}>;
            }>();
            for (const feature of group.features) {
                const resolved = this.resolveInteractionTargetLayer(feature);
                if (!resolved) {
                    continue;
                }
                const {mapgetLayer, tileId} = resolved;
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
                for (let styleIndex = 0;
                     styleIndex < orderedStyles.length;
                     ++styleIndex) {
                    const style = orderedStyles[styleIndex];
                    if (!this.hasInteractionLayerAffinity(
                        style,
                        mapgetLayer.layerId
                    )) {
                        continue;
                    }
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
                    const remoteAllowed = group.kind !== "hover" ||
                        this.inspection.remoteHoverHighlightAllowed;
                    const optionsSignature = sipHash64Hex(
                        JSON.stringify(options)
                    );
                    const effect = this.interactionEffect(
                        style,
                        group.mode,
                        options,
                        optionsSignature
                    );
                    const localTargetKeys = new Set(
                        effect
                            ? features
                                .filter(feature =>
                                    this.hasLocalInteractionTarget(
                                        mapgetLayer,
                                        feature
                                    ))
                                .map(interactionTargetKey)
                            : []
                    );
                    let rawPlan: StyleFilterPlan | null = null;
                    let remotePlan: ReturnType<
                        typeof planRemoteInteractionHighlight
                    > = null;
                    if (remoteAllowed) {
                        rawPlan = this.interactionFilterPlan(
                            style,
                            mapgetLayer,
                            group.mode
                        );
                        if (rawPlan) {
                            remotePlan = planRemoteInteractionHighlight(
                                rawPlan,
                                features,
                                {localTargetKeys}
                            );
                        }
                    }
                    if (effect) {
                        const overlayId = [
                            group.kind,
                            group.id,
                            style.id,
                            this.styleVersion(style),
                            optionsSignature
                        ].join(":");
                        let byId = localOverlaysByLayer.get(mapgetLayer.key);
                        if (!byId) {
                            byId = new Map();
                            localOverlaysByLayer.set(mapgetLayer.key, byId);
                        }
                        for (const feature of features) {
                            // An exact target already materialized by a regular
                            // or search presentation uses the local compositor.
                            // Authored geometry is the fallback only while that
                            // target is absent from the retained scene.
                            if (rawPlan &&
                                hasAuthoredInteractionHighlight(
                                    rawPlan,
                                    feature
                                ) &&
                                !localTargetKeys.has(
                                    interactionTargetKey(feature)
                                )) {
                                continue;
                            }
                            const existing = byId.get(overlayId);
                            if (existing) {
                                if (!existing.targets.some(target =>
                                    interactionTargetKey(target) ===
                                        interactionTargetKey(feature))) {
                                    byId.set(overlayId, {
                                        ...existing,
                                        targets: [...existing.targets, feature]
                                    });
                                }
                            }
                            else {
                                byId.set(overlayId, {
                                    id: overlayId,
                                    targets: [feature],
                                    effect,
                                    order: styleIndex +
                                        (group.kind === "hover"
                                            ? INTERACTION_STYLE_ORDER_BASE + 1_000
                                            : INTERACTION_STYLE_ORDER_BASE)
                                });
                            }
                        }
                    }
                    if (!remotePlan) {
                        continue;
                    }
                    // StyledMapgetLayer plans are immutable. Presence changes
                    // must therefore replace the remote owner even when the
                    // interaction targets and style options did not change.
                    const identitySignature = sipHash64Hex(JSON.stringify({
                        filterPlan: remotePlan.plan,
                        tileIds: remotePlan.tileIds,
                        roots: remotePlan.roots,
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
                        plan: remotePlan.plan,
                        tileIds: remotePlan.tileIds,
                        roots: remotePlan.roots,
                        styleOrder: styleIndex +
                            (group.kind === "hover"
                                ? INTERACTION_STYLE_ORDER_BASE + 1_000
                                : INTERACTION_STYLE_ORDER_BASE)
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
                        subscription: this.subscribeToStyledLayer(layer),
                        visualizations: new Map(),
                        visualizationKeyByTileId: new Map(),
                        pendingTiles: new Map(),
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

        this.localInteractionOverlaysByLayer = new Map(
            [...localOverlaysByLayer].map(([layerKey, overlays]) => [
                layerKey,
                [...overlays.values()]
            ])
        );
        const nextVisualizations = this.localInteractionVisualizations(
            localOverlaysByLayer
        );
        for (const visualization of
            this.localInteractionVisualizationsWithOverlays) {
            if (!nextVisualizations.has(visualization)) {
                visualization.setInteractionOverlays([]);
            }
        }
        this.localInteractionVisualizationsWithOverlays.clear();
        for (const visualization of nextVisualizations) {
            this.applyLocalInteractionOverlays(visualization);
        }
    }

    /** Memoizes the immutable layer-affinity query across hover targets. */
    private hasInteractionLayerAffinity(
        style: ErdblickStyle,
        layerId: string
    ): boolean {
        let byLayer = this.interactionLayerAffinityCache.get(style);
        if (!byLayer) {
            byLayer = new Map();
            this.interactionLayerAffinityCache.set(style, byLayer);
        }
        const cached = byLayer.get(layerId);
        if (cached !== undefined) {
            return cached;
        }
        const affinity = style.featureLayerStyle.hasLayerAffinity(layerId);
        byLayer.set(layerId, affinity);
        return affinity;
    }

    /** Memoizes schema-dependent interaction plans until datasource metadata changes. */
    private interactionFilterPlan(
        style: ErdblickStyle,
        mapgetLayer: MapgetLayer,
        mode: typeof coreLib.HighlightMode.SELECTION_HIGHLIGHT
    ): StyleFilterPlan | null {
        let byContext = this.interactionFilterPlanCache.get(style);
        if (!byContext) {
            byContext = new Map();
            this.interactionFilterPlanCache.set(style, byContext);
        }
        const key = [
            mapgetLayer.key,
            mode.value,
            coreLib.RuleFidelity.ANY.value
        ].join("\n");
        if (byContext.has(key)) {
            return byContext.get(key) ?? null;
        }
        let plan: StyleFilterPlan | null = null;
        if (style.featureLayerStyle.supportsHighlightMode(mode)) {
            const candidate = this.mapInfo.planStyleFilter(
                style.featureLayerStyle,
                mapgetLayer.mapId,
                mapgetLayer.layerId,
                mode.value,
                coreLib.RuleFidelity.ANY.value
            ) as StyleFilterPlan;
            if (candidate.valid && candidate.channels.length) {
                plan = candidate;
            }
        }
        byContext.set(key, plan);
        return plan;
    }

    /** Memoizes one expression-free interaction material per style option state. */
    private interactionEffect(
        style: ErdblickStyle,
        mode: typeof coreLib.HighlightMode.SELECTION_HIGHLIGHT,
        options: Readonly<Record<string, boolean | number | string>>,
        optionsSignature: string
    ): DeckInteractionEffect | null {
        let byContext = this.interactionEffectCache.get(style);
        if (!byContext) {
            byContext = new Map();
            this.interactionEffectCache.set(style, byContext);
        }
        const key = `${mode.value}\n${optionsSignature}`;
        if (byContext.has(key)) {
            return byContext.get(key) ?? null;
        }
        const effect = resolveDeckInteractionEffect(
            style.featureLayerStyle,
            mode,
            options
        );
        byContext.set(key, effect);
        return effect;
    }

    /** Drops schema-derived interaction caches after a datasource catalog replacement. */
    private resetInteractionStyleCaches(): void {
        this.interactionLayerAffinityCache = new WeakMap();
        this.interactionFilterPlanCache = new WeakMap();
        this.interactionEffectCache = new WeakMap();
    }

    /** Apply retained semantic overlays only to targets present in one rendered contribution. */
    private applyLocalInteractionOverlays(
        visualization: TileSubsetLayerVisualization
    ): void {
        const kind = visualization.owner.identity.presentationKind;
        if (kind !== "regular" && kind !== "search") {
            return;
        }
        const overlays = this.localInteractionOverlaysByLayer.get(
            visualization.owner.mapgetLayer.key
        ) ?? [];
        const applicable = overlays.flatMap(overlay => {
            const targets = overlay.targets.filter(target =>
                visualization.hasLocalInteractionTarget(target));
            return targets.length ? [{...overlay, targets}] : [];
        });
        visualization.setInteractionOverlays(applicable);
        if (applicable.length) {
            this.localInteractionVisualizationsWithOverlays.add(visualization);
        } else {
            this.localInteractionVisualizationsWithOverlays.delete(visualization);
        }
    }

    /** Resolve only tile visualizations named by the next request-free local masks. */
    private localInteractionVisualizations(
        overlaysByLayer: ReadonlyMap<
            string,
            ReadonlyMap<string, TileSubsetInteractionOverlay>
        >
    ): Set<TileSubsetLayerVisualization> {
        const result = new Set<TileSubsetLayerVisualization>();
        const tileIdsByLayer = new Map<string, Set<number>>();
        for (const [layerKey, overlays] of overlaysByLayer) {
            const tileIds = new Set<number>();
            for (const overlay of overlays.values()) {
                for (const target of overlay.targets) {
                    const parsed = this.parseFeatureTileId(target);
                    if (parsed) {
                        tileIds.add(parsed.tileId);
                    }
                }
            }
            if (tileIds.size) {
                tileIdsByLayer.set(layerKey, tileIds);
            }
        }
        const collect = (owned: OwnedStyledLayer) => {
            const kind = owned.layer.identity.presentationKind;
            const tileIds = tileIdsByLayer.get(owned.layer.mapgetLayer.key);
            if ((kind !== "regular" && kind !== "search") || !tileIds) {
                return;
            }
            for (const tileId of tileIds) {
                const visualizationKey =
                    owned.visualizationKeyByTileId.get(tileId);
                const visualization = visualizationKey
                    ? owned.visualizations.get(visualizationKey)
                    : undefined;
                if (visualization) {
                    result.add(visualization);
                }
            }
        };
        for (const owned of this.styledLayers.values()) {
            collect(owned);
        }
        for (const {owned} of this.retiringRegularLayers.values()) {
            collect(owned);
        }
        return result;
    }

    /** Resolve one exact interaction target independently of base-layer visibility. */
    private resolveInteractionTargetLayer(feature: TileFeatureId): {
        mapgetLayer: MapgetLayer;
        tileId: number;
    } | null {
        const parsed = this.parseFeatureTileId(feature);
        if (!parsed) {
            return null;
        }
        const {mapId, layerId, tileId} = parsed;
        const mapgetLayer = this.mapInfo.mapgetLayer(mapId, layerId);
        if (!mapgetLayer) {
            return null;
        }
        // A hidden ordinary layer has no local contribution by definition;
        // its exact selected/hovered tile is therefore authored-fallback
        // demand, not ineligible interaction demand.
        return {mapgetLayer, tileId};
    }

    /** Test exact entity presence in any regular/search contribution for this map layer. */
    private hasLocalInteractionTarget(
        mapgetLayer: MapgetLayer,
        target: TileFeatureId
    ): boolean {
        const parsed = this.parseFeatureTileId(target);
        if (!parsed || parsed.mapId !== mapgetLayer.mapId ||
            parsed.layerId !== mapgetLayer.layerId) {
            return false;
        }
        const matches = (owned: OwnedStyledLayer): boolean => {
            const kind = owned.layer.identity.presentationKind;
            if ((kind !== "regular" && kind !== "search") ||
                owned.layer.mapgetLayer.key !== mapgetLayer.key) {
                return false;
            }
            const visualizationKey =
                owned.visualizationKeyByTileId.get(parsed.tileId);
            const visualization = visualizationKey
                ? owned.visualizations.get(visualizationKey)
                : undefined;
            return visualization?.hasLocalInteractionTarget(target) ?? false;
        };
        for (const owned of this.styledLayers.values()) {
            if (matches(owned)) {
                return true;
            }
        }
        return [...this.retiringRegularLayers.values()]
            .some(({owned}) => matches(owned));
    }

    /** Re-evaluate local-versus-authored highlighting after scene geometry changes. */
    private scheduleInteractionPresenceReconcile(
        layer: StyledMapgetLayer,
        tileId?: number
    ): void {
        const kind = layer.identity.presentationKind;
        if (kind !== "regular" && kind !== "search") {
            return;
        }
        const matchesChangedPresentation = (target: TileFeatureId) => {
            const parsed = this.parseFeatureTileId(target);
            return parsed?.mapId === layer.mapgetLayer.mapId &&
                parsed.layerId === layer.mapgetLayer.layerId &&
                (tileId === undefined || parsed.tileId === tileId);
        };
        const relevantTargetExists =
            this.inspection.selectionIdsTopic.getValue().some(panel =>
                panel.features.some(matchesChangedPresentation)) ||
            this.inspection.hoverIdsTopic.getValue()
                .some(matchesChangedPresentation);
        if (relevantTargetExists) {
            this.scheduleInteractionReconcile();
        }
    }

    /** Decode a semantic target through the authoritative WASM MapTileKey parser. */
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

    /** Track viewport-derived state that can switch targets between local and authored rendering. */
    private interactionViewportSignature(): string {
        const layers = new Map<string, {mapId: string; layerId: string}>();
        const features = [
            ...this.inspection.selectionIdsTopic.getValue()
                .flatMap(panel => panel.features),
            ...this.inspection.hoverIdsTopic.getValue()
        ];
        for (const feature of features) {
            const parsed = this.parseFeatureTileId(feature);
            if (!parsed) {
                continue;
            }
            layers.set(`${parsed.mapId}\n${parsed.layerId}`, parsed);
        }
        return [...layers.values()]
            .sort((left, right) =>
                left.mapId.localeCompare(right.mapId) ||
                left.layerId.localeCompare(right.layerId))
            .map(({mapId, layerId}) => {
                const visible = this.mapInfo.maps.getMapLayerVisibility(
                    this.viewIndex,
                    mapId,
                    layerId
                );
                return [
                    mapId,
                    layerId,
                    visible ? 1 : 0,
                    visible
                        ? this.viewState.getEffectiveMapLayerLevel(
                            this.viewIndex,
                            mapId,
                            layerId
                        )
                        : -1
                ].join(":");
            })
            .join("|");
    }

    /** Reconcile one independently owned visualization for every demanded tile. */
    private reconcileOwnedVisualizations(owned: OwnedStyledLayer): void {
        for (const [key, visualization] of [...owned.visualizations]) {
            const state = visualization.state;
            const retained =
                owned.layer.tileStates.get(state.tileId) === state &&
                this.presentationStillDemanded(owned.layer, state);
            const fidelity = this.presentationFidelity(owned.layer, state);
            const lineSimplificationToleranceMeters =
                this.lineSimplificationToleranceMeters();
            const terminalIncomplete = state.status === "error";
            if (!retained || terminalIncomplete ||
                !visualization.hasSameState(
                    state,
                    fidelity,
                    lineSimplificationToleranceMeters
                )) {
                this.replaceVisualization(owned, key, true);
                continue;
            }
            if (state.status === "ready" && state.subsetBlob &&
                !visualization.isCurrentPresentationInstalled()) {
                this.queueVisualizationRender(visualization);
            }
        }

        for (const state of owned.layer.tileStates.values()) {
            if (this.shouldVisualize(owned.layer, state) &&
                !owned.visualizationKeyByTileId.has(state.tileId)) {
                this.enqueueTile(owned, state);
            }
        }

        for (const [tileId, pending] of [...owned.pendingTiles]) {
            if (owned.layer.tileStates.get(tileId) !== pending.state ||
                !this.shouldVisualize(owned.layer, pending.state)) {
                this.discardPendingTile(owned, tileId);
            }
        }
        this.schedulePendingTiles();
    }

    /** Re-render a changed ready tile or reserve its first worker credit. */
    private reconcileReadyTile(
        owned: OwnedStyledLayer,
        state: FilterTileState
    ): void {
        if (!this.shouldVisualize(owned.layer, state)) {
            return;
        }
        const existingKey = owned.visualizationKeyByTileId.get(state.tileId);
        if (!existingKey) {
            this.enqueueTile(owned, state);
            return;
        }
        const visualization = owned.visualizations.get(existingKey);
        if (!visualization) {
            owned.visualizationKeyByTileId.delete(state.tileId);
            this.enqueueTile(owned, state);
            return;
        }
        const fidelity = this.presentationFidelity(owned.layer, state);
        if (!visualization.hasSameState(
            state,
            fidelity,
            this.lineSimplificationToleranceMeters()
        )) {
            this.replaceVisualization(owned, existingKey, true);
            return;
        }
        this.queueVisualizationRender(visualization);
    }

    /** Add or replace one pending tile without constructing a render batch. */
    private enqueueTile(
        owned: OwnedStyledLayer,
        state: FilterTileState,
        preservedContributionIdentity: string | null = null
    ): void {
        const previous = owned.pendingTiles.get(state.tileId);
        owned.pendingTiles.set(state.tileId, {
            state,
            fidelity: this.presentationFidelity(owned.layer, state),
            lineSimplificationToleranceMeters:
                this.lineSimplificationToleranceMeters(),
            preservedContributionIdentity:
                preservedContributionIdentity ??
                previous?.preservedContributionIdentity ??
                null
        });
        this.schedulePendingTiles();
    }

    /** Drop one pending successor and retire any installed contribution it inherited. */
    private discardPendingTile(
        owned: OwnedStyledLayer,
        tileId: number
    ): void {
        const pending = owned.pendingTiles.get(tileId);
        if (!pending) {
            return;
        }
        owned.pendingTiles.delete(tileId);
        if (pending.preservedContributionIdentity) {
            TileSubsetLayerVisualization.retireContribution(
                this.sceneHandle,
                pending.preservedContributionIdentity
            );
            this.scheduleInteractionPresenceReconcile(owned.layer, tileId);
        }
    }

    /** Coalesce dispatch notifications while preserving worker-credit backpressure. */
    private schedulePendingTiles(): void {
        this.ngZone.runOutsideAngular(() => {
            if (this.disposed || this.pendingDispatchQueued) {
                return;
            }
            this.pendingDispatchQueued = true;
            queueMicrotask(() => {
                this.pendingDispatchQueued = false;
                if (!this.disposed) {
                    this.drainPendingTiles();
                }
            });
        });
    }

    /** Dispatch changed and newly visible singleton tiles under one worker budget. */
    private drainPendingTiles(): void {
        if (!this.sceneHandle) {
            return;
        }
        while (this.renderService.availableWorkerSlots() > 0) {
            const rerender = this.pendingVisualizationRenders.values()
                .next().value as TileSubsetLayerVisualization | undefined;
            if (rerender) {
                this.pendingVisualizationRenders.delete(rerender);
                this.startVisualizationRender(rerender);
                continue;
            }
            if (!this.dispatchOnePendingStyledLayerTile()) {
                return;
            }
        }
    }

    /** Dispatches one tile while rotating fairly across all active styled layers. */
    private dispatchOnePendingStyledLayerTile(): boolean {
        const layers = [...this.styledLayers.values()];
        if (!layers.length) {
            this.nextStyledLayerDispatchIndex = 0;
            return false;
        }
        const start = this.nextStyledLayerDispatchIndex % layers.length;
        for (let offset = 0; offset < layers.length; ++offset) {
            const index = (start + offset) % layers.length;
            if (!this.dispatchOnePendingTile(layers[index])) {
                continue;
            }
            this.nextStyledLayerDispatchIndex = (index + 1) % layers.length;
            return true;
        }
        return false;
    }

    /** Turn one current pending tile into an independently replaceable scene owner. */
    private dispatchOnePendingTile(owned: OwnedStyledLayer): boolean {
        if (!this.sceneHandle) {
            return false;
        }
        for (const [tileId, pending] of owned.pendingTiles) {
            if (owned.layer.tileStates.get(tileId) !== pending.state ||
                !this.shouldVisualize(owned.layer, pending.state) ||
                owned.visualizationKeyByTileId.has(tileId)) {
                this.discardPendingTile(owned, tileId);
                continue;
            }
            // The new visualization takes responsibility for the stable
            // contribution identity retained by its predecessor.
            owned.pendingTiles.delete(tileId);
            const visualizationKey = [
                `tile-${tileId}`,
                `f${pending.fidelity}`,
                `s${pending.lineSimplificationToleranceMeters}`
            ].join("/");
            const visualization = new TileSubsetLayerVisualization(
                owned.layer,
                pending.state,
                visualizationKey,
                tileCoordinateOrigin(tileId),
                this.renderService,
                this.styleValidationReports,
                pending.fidelity,
                pending.lineSimplificationToleranceMeters,
                this.viewIndex,
                item => this.queueVisualizationRender(item)
            );
            owned.visualizations.set(visualizationKey, visualization);
            owned.visualizationKeyByTileId.set(tileId, visualizationKey);
            this.startVisualizationRender(visualization);
            return true;
        }
        return false;
    }

    /** Remove one tile and its exact GPU contribution without touching siblings. */
    private removeTileVisualization(
        owned: OwnedStyledLayer,
        tileId: number
    ): void {
        this.discardPendingTile(owned, tileId);
        const key = owned.visualizationKeyByTileId.get(tileId);
        if (!key) {
            return;
        }
        owned.visualizationKeyByTileId.delete(tileId);
        const visualization = owned.visualizations.get(key);
        if (!visualization) {
            return;
        }
        owned.visualizations.delete(key);
        this.pendingVisualizationRenders.delete(visualization);
        this.localInteractionVisualizationsWithOverlays.delete(visualization);
        visualization.destroy(this.sceneHandle);
        this.scheduleInteractionPresenceReconcile(owned.layer, tileId);
    }

    /** Remove one coverage delta as a single scene and diagnostics transaction. */
    private removeTileVisualizations(
        owned: OwnedStyledLayer,
        states: readonly FilterTileState[]
    ): void {
        const visualizations: TileSubsetLayerVisualization[] = [];
        for (const state of states) {
            this.discardPendingTile(owned, state.tileId);
            const key = owned.visualizationKeyByTileId.get(state.tileId);
            if (!key) {
                continue;
            }
            owned.visualizationKeyByTileId.delete(state.tileId);
            const visualization = owned.visualizations.get(key);
            if (!visualization) {
                continue;
            }
            owned.visualizations.delete(key);
            this.pendingVisualizationRenders.delete(visualization);
            this.localInteractionVisualizationsWithOverlays.delete(
                visualization
            );
            visualizations.push(visualization);
        }
        TileSubsetLayerVisualization.destroyMany(
            visualizations,
            this.sceneHandle
        );
        if (visualizations.length) {
            this.scheduleInteractionPresenceReconcile(owned.layer);
        }
    }

    /** Replace one tile owner while retaining its installed contribution until admission. */
    private replaceVisualization(
        owned: OwnedStyledLayer,
        key: string,
        requeue: boolean
    ): void {
        const visualization = owned.visualizations.get(key);
        if (!visualization) {
            return;
        }
        owned.visualizations.delete(key);
        this.pendingVisualizationRenders.delete(visualization);
        this.localInteractionVisualizationsWithOverlays.delete(visualization);
        const state = visualization.state;
        if (state && owned.visualizationKeyByTileId.get(state.tileId) === key) {
            owned.visualizationKeyByTileId.delete(state.tileId);
        }
        const preserve = requeue && !!state &&
            owned.layer.tileStates.get(state.tileId) === state &&
            this.shouldVisualize(owned.layer, state);
        const preservedContributionIdentity = visualization.destroy(
            this.sceneHandle,
            preserve
        );
        if (!preservedContributionIdentity) {
            this.scheduleInteractionPresenceReconcile(
                owned.layer,
                state?.tileId
            );
        }
        if (preserve && state) {
            this.enqueueTile(
                owned,
                state,
                preservedContributionIdentity
            );
        }
    }

    /** Coalesce one visualization's desired revision behind global worker credit. */
    private queueVisualizationRender(
        visualization: TileSubsetLayerVisualization
    ): void {
        this.pendingVisualizationRenders.add(visualization);
        this.schedulePendingTiles();
    }

    /** Start one credited immutable worker render and publish state on admission. */
    private startVisualizationRender(
        visualization: TileSubsetLayerVisualization
    ): void {
        if (!this.sceneHandle) {
            return;
        }
        visualization.render(this.sceneHandle)
            .then(rendered => {
                if (!rendered) {
                    return;
                }
                const owned = [...this.styledLayers.values()].find(
                    candidate => candidate.layer === visualization.owner
                );
                if (owned) {
                    this.releaseRegularFallbackWhenReady(owned);
                }
                this.applyLocalInteractionOverlays(visualization);
                this.scheduleInteractionPresenceReconcile(
                    visualization.owner,
                    visualization.state.tileId
                );
                this.diagnostics.notifyChanged();
            })
            .catch(error =>
                console.error("TileSubsetLayer visualization failed.", error)
            );
    }

    /** Resolve the fixed worker fidelity used by one presentation owner. */
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

    /** Return the view's quantized line LOD without coupling it to tile state. */
    private lineSimplificationToleranceMeters(): number {
        return this.viewState.viewStateFor(this.viewIndex)
            ?.lineSimplificationToleranceMeters ?? 0;
    }

    /** Test whether diagnostics may retain a tile after asynchronous state changes. */
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

    /** Gate scene ownership on ready data and search-density policy. */
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

    /** Avoid rescanning unchanged large coverage arrays on non-viewport reconciliations. */
    private setRegularCoverage(
        layer: StyledMapgetLayer,
        tileIds: readonly number[],
        priorityTileIds: readonly number[]
    ): void {
        const previous = this.regularCoverageByLayer.get(layer);
        if (previous?.tileIds === tileIds &&
            previous.priorityTileIds === priorityTileIds) {
            return;
        }
        layer.setCoverage(tileIds, priorityTileIds);
        this.regularCoverageByLayer.set(layer, {tileIds, priorityTileIds});
    }
}
