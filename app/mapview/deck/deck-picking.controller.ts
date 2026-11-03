/**
 * Picking and hover state belong to the canvas that initiated each readback.
 * The renderer supplies live resources and handles application-level actions.
 */
import {
    FirstPersonView as DeckFirstPersonView,
    Deck as DeckGlDeck,
    MapView as DeckMercatorView,
    type InteractionTargetContext,
    type PickingInfo,
    type WebMercatorViewport
} from "@deck.gl/core";
import { BehaviorSubject } from "rxjs";
import { TileFeatureId } from "../../inspection/inspection.model";
import { featureSetsEqual } from "../../mapdata/feature-inspection.adapter";
import { RenderedFeaturePickResult, RenderNavigationTarget } from "../render-view.model";
import { ErdblickVectorLayer } from "./erdblick-vector.layer";
import { GpuScene } from "./gpu-scene.visualization";
import { GpuTextLayerHost } from "./gpu-text-layer.host";
import {
    type DeckFeaturePickLayerProps,
    markerAnchorFromPickingInfo,
    navigationTargetFromPickingInfo,
    pickNavigationAnchor
} from "./navigation/erdblick-navigation-anchor.util";
import type { NavigationAnchor, NavigationVisualTarget } from "./navigation/feature-navigation.model";
import { isNavigationAnchorUsable } from "./navigation/web-mercator-feature-navigation.adapter";

/** Only the Deck operations used for readbacks and cursor updates. */
export type DeckPickingSurface = Pick<DeckGlDeck<DeckMercatorView | DeckFirstPersonView>,
    "pickObject" | "pickObjectAsync" | "pickObjectsAsync" |
    "pickMultipleObjects" | "getCanvas" | "setProps"> & {readonly props: {readonly layers?: unknown}};

/** Live renderer resources are read lazily so replacement invalidates pending samples. */
export interface DeckPickingContext {
    deck(): DeckPickingSurface | null;
    scene(): Pick<GpuScene, "resolvePick" | "pickOrder"> | null;
    viewport(): WebMercatorViewport | null;
}

/** Application preferences projected onto picking, without an inspection controller dependency. */
export interface DeckPickingOptions {
    radius: number;
    maxObjects: number;
    navigationAnchors: boolean;
}

/** Leaving for an inspection panel must not clear the panel's own hover selection. */
export interface DeckHoverResult {
    featureIds: TileFeatureId[];
    updateInspection: boolean;
}

/** Primary-click identity and its physical marker anchor. */
export interface DeckClickResult {
    featureIds: TileFeatureId[];
    markerPosition: NavigationAnchor | null;
}

/** Owns one canvas's pick decoding, bounded hover queue, and stale-readback cancellation. */
export class DeckPicking {
    readonly hoveredFeatureIds = new BehaviorSubject<TileFeatureId[]>([]);
    private isCameraInteracting = false;
    private destroyed = false;

    /** The renderer supplies only readback resources and receives typed interaction results. */
    constructor(
        private readonly surface: DeckPickingContext,
        private readonly options: () => DeckPickingOptions,
        private readonly onHover: (result: DeckHoverResult) => void,
        private readonly publishNavigationTarget: (target: NavigationVisualTarget | null) => void
    ) {}

    private get deck(): DeckPickingSurface | null {
        return this.destroyed ? null : this.surface.deck();
    }
    private get gpuScene() { return this.surface.scene(); }
    private get allowPitchAndBearing(): boolean { return this.options().navigationAnchors; }
    get cursor() { return this.deckCursor; }

    /** Cancels deferred work before the owning renderer finalizes its Deck instance. */
    destroy(): void {
        this.clearHoverPickingState(false);
        this.destroyed = true;
        this.deckCanvasPointerInside = false;
        this.hoveredFeatureIds.complete();
    }

    /** Starts accepting samples only while the pointer belongs to this canvas. */
    pointerEnter(): void { this.deckCanvasPointerInside = true; }

    /** Invalidates samples before the gesture recognizer starts a camera interaction. */
    pointerDown(): void {
        this.hoverPickGeneration += 1;
        this.pendingHoverAnchorPosition = null;
        this.pendingHoverDetailPosition = null;
        this.cancelHoverPickScheduling();
    }

    /** Retires canvas hover without erasing a destination inspection panel's hover. */
    pointerLeave(preserveInspectionHover: boolean): void {
        this.deckCanvasPointerInside = false;
        this.latestHoverPosition = null;
        this.pointerDown();
        this.setFeatureHoverState(false);
        this.publishNavigationTarget(null);
        this.hoveredFeatureIds.next([]);
        this.onHover({featureIds: [], updateInspection: !preserveInspectionHover});
    }

    /** Keeps only the newest pointer position while suppressing picks during a drag. */
    pointerMove(position: {x: number; y: number}, buttons: number): void {
        if (this.destroyed || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
        this.latestHoverPosition = position;
        if (buttons !== 0 || this.isCameraInteracting) {
            this.pendingHoverAnchorPosition = null;
            this.pendingHoverDetailPosition = null;
            this.cancelHoverPickScheduling();
            return;
        }
        this.queueHoverPicks(position);
    }

    /** A camera change invalidates readbacks and resamples the latest stationary pointer. */
    cameraChanged(): void {
        this.pointerDown();
        this.publishNavigationTarget(null);
        if (this.deckCanvasPointerInside && !this.isCameraInteracting && this.latestHoverPosition) {
            this.queueHoverPicks(this.latestHoverPosition);
        }
    }

    /** Suspends expensive readbacks until camera motion ends. */
    setCameraInteracting(active: boolean): void {
        if (this.isCameraInteracting === active) return;
        this.isCameraInteracting = active;
        this.cameraChanged();
    }

    /** Resolves the top rendered object; touch performs one bounded pick only after a tap. */
    click(info: PickingInfo, pointerType?: string): DeckClickResult {
        const screenPosition = {x: info.x, y: info.y};
        const options = this.options();
        const useDesktopDrillPick = this.desktopDrillPickingEnabled
            && (!pointerType || pointerType === "mouse");
        let featureIds = useDesktopDrillPick
            ? this.drillPickFeatures(screenPosition, options.radius, options.maxObjects).topFeatureIds
            : this.featurePickResultFromPickingInfos([info]).topFeatureIds;
        if (!featureIds.length && !useDesktopDrillPick) {
            featureIds = this.drillPickFeatures(screenPosition, options.radius, 1).topFeatureIds;
        }
        // Grouped points retain every semantic member; lower objects are context-menu results.
        const markerPosition = featureIds.length
            ? this.markerPositionForFeature(info, screenPosition, featureIds[0], options.radius, options.maxObjects)
            : null;
        return {featureIds, markerPosition};
    }

    private static readonly UNSELECTABLE_FEATURE_INDEX = 0xffffffff;

    private static readonly HOVER_ANCHOR_PICK_THROTTLE_MS = 16;

    private static readonly HOVER_DETAIL_PICK_IDLE_MS = 80;

    private static readonly HOVER_PICK_MAX_OBJECTS = 10;

    private isHoveringFeature = false;

    private hoverAnchorPickTimer: ReturnType<typeof setTimeout> | null = null;

    private hoverDetailPickTimer: ReturnType<typeof setTimeout> | null = null;

    private pendingHoverAnchorPosition: { x: number; y: number } | null = null;

    private pendingHoverDetailPosition: { x: number; y: number } | null = null;

    private latestHoverPosition: { x: number; y: number } | null = null;

    private hoverDetailPickDueAtMs = 0;

    private hoverPickInFlight = false;

    private hoverPickGeneration = 0;

    private topHoverFeatureIds: TileFeatureId[] = [];

    private topHoverFeatureGeneration = -1;

    private deckCanvasPointerInside = false;

    private lastHoverAnchorPickAtMs = 0;

    private desktopDrillPickingEnabled = true;

    private readonly deckCursor = ({ isDragging }: { isDragging: boolean }) =>
        this.isHoveringFeature ? "pointer" : (isDragging ? "grabbing" : "grab");

    /** Enables desktop-only point drill-picking without broadening touch/narrow-view taps. */
    setDesktopDrillPickingEnabled(enabled: boolean): void {
        this.desktopDrillPickingEnabled = enabled;
    }

    /**
     * Resolves the first eligible physical surface beneath a screen position.
     * Multiple-object picking lets non-physical labels remain above the actual anchor;
     * surfaces without application identity intentionally return an empty feature list.
     */
    pickNavigationTarget(screenPos: { x: number; y: number }): RenderNavigationTarget | undefined {
        if (!this.deck) {
            return undefined;
        }
        const layerIds = this.navigationPickLayerIds();
        const picked = pickNavigationAnchor(
            this.deck,
            [screenPos.x, screenPos.y],
            pickingInfo => this.featureIdsFromPickingInfo(pickingInfo),
            (first, second) => first.length > 0 && second.length > 0 &&
                first.some(firstId => second.some(secondId =>
                    firstId.mapTileKey === secondId.mapTileKey
                    && firstId.featureId === secondId.featureId
                )),
            this.options().radius,
            layerIds.length ? layerIds : undefined
        );
        if (picked) {
            const { position, surfaceNormal, origin, value: featureIds } = picked;
            return surfaceNormal
                ? { position, surfaceNormal, origin, featureIds }
                : { position, origin, featureIds };
        }
        return undefined;
    }

    /** Resolves a finite visible point on the zero-height ground plane as the universal fallback pivot. */
    groundNavigationTarget(
        screenPos: { x: number; y: number },
        viewport: WebMercatorViewport | null | undefined = this.surface.viewport()
    ): NavigationVisualTarget | null {
        if (!viewport) {
            return null;
        }
        const ground = viewport.unproject(
            [screenPos.x, screenPos.y],
            { targetZ: 0 }
        );
        if (ground.length < 3 || !ground.every(Number.isFinite)) {
            return null;
        }
        const position: NavigationAnchor = [ground[0], ground[1], ground[2]];
        return isNavigationAnchorUsable(viewport, position, true)
            ? { position, origin: "ground" }
            : null;
    }

    /** Resolves one exact eligible physical surface for a controller acquisition. */
    pickControllerNavigationTarget(
        context: Readonly<InteractionTargetContext<WebMercatorViewport>>,
        screenPosition: [number, number]
    ): NavigationVisualTarget | null {
        const layerIds = this.navigationPickLayerIds();
        if (!this.deck || !layerIds.length) {
            return null;
        }
        const radius = Math.max(0, Math.trunc(this.options().radius));
        const canvasPosition = [
            context.viewport.x + screenPosition[0],
            context.viewport.y + screenPosition[1]
        ];
        try {
            const picked = this.deck.pickObject({
                x: canvasPosition[0],
                y: canvasPosition[1],
                radius,
                layerIds,
                unproject3D: true
            });
            return picked
                ? navigationTargetFromPickingInfo({
                    ...picked,
                    x: canvasPosition[0],
                    y: canvasPosition[1],
                    viewport: context.viewport
                }, radius, true)
                : null;
        } catch (error) {
            console.error("Navigation controller picking failed.", error);
            return null;
        }
    }

    /**
     * Resolves every eligible rendered feature returned by one bounded point drill-pick.
     * Layer filtering happens before the pick so excluded representations cannot consume depth.
     */
    drillPickFeatures(
        screenPos: { x: number; y: number },
        radius: number,
        maxObjects: number
    ): RenderedFeaturePickResult {
        if (!this.deck) {
            return { topFeatureIds: [], featureIds: [] };
        }
        const pickedObjects = this.deck.pickMultipleObjects({
            x: screenPos.x,
            y: screenPos.y,
            radius,
            depth: maxObjects,
            layerIds: this.drillPickLayerIds(),
            unproject3D: false
        });
        return this.featurePickResultFromPickingInfos(
            pickedObjects,
            maxObjects);
    }

    /** Returns the current top-level layer ids explicitly marked as ordinary feature representations. */
    private drillPickLayerIds(): string[] {
        return this.eligiblePickLayerIds("drillPickEligible");
    }

    /** Returns physical feature-representation layers that can supply navigation anchors. */
    private navigationPickLayerIds(): string[] {
        return this.eligiblePickLayerIds("navigationAnchorEligible");
    }

    /** Collects stable top-level layer ids carrying one explicit interaction capability. */
    private eligiblePickLayerIds(
        capability: "drillPickEligible" | "navigationAnchorEligible"
    ): string[] {
        if (!this.deck) {
            return [];
        }
        const result: string[] = [];
        const seen = new Set<string>();
        const visit = (entry: unknown): void => {
            if (Array.isArray(entry)) {
                entry.forEach(visit);
                return;
            }
            if (!entry || typeof entry !== "object") {
                return;
            }
            const layer = entry as { id?: unknown; props?: DeckFeaturePickLayerProps };
            if (layer.props?.[capability] !== true || typeof layer.id !== "string" || seen.has(layer.id)) {
                return;
            }
            seen.add(layer.id);
            result.push(layer.id);
        };
        visit(this.deck.props?.layers);
        return result;
    }

    /** Orders picks, preserving the first render object's atomic feature group while flattening all hits. */
    private featurePickResultFromPickingInfos(
        pickedObjects: PickingInfo[],
        maxFeatures = Number.POSITIVE_INFINITY
    ): RenderedFeaturePickResult {
        let topFeatureIds: TileFeatureId[] = [];
        const featureIds: TileFeatureId[] = [];
        const seen = new Set<string>();
        const candidates = pickedObjects.map((picked, index) => ({
            picked,
            index,
            order: this.renderedPickOrder(picked)
        }));
        const orderedVectorPicks = candidates
            .filter(candidate => candidate.order !== undefined)
            .sort((left, right) =>
                right.order!.zIndex - left.order!.zIndex ||
                right.order!.primitiveOrder - left.order!.primitiveOrder ||
                left.index - right.index);
        let vectorPickIndex = 0;
        for (const candidate of candidates) {
            const picked = candidate.order === undefined
                ? candidate.picked
                : orderedVectorPicks[vectorPickIndex++].picked;
            const groupFeatureIds: TileFeatureId[] = [];
            const groupSeen = new Set<string>();
            for (const featureId of this.featureIdsFromPickingInfo(picked)) {
                const identity = `${featureId.mapTileKey}\u0000${featureId.featureId}`;
                if (!groupSeen.has(identity)) {
                    groupSeen.add(identity);
                    groupFeatureIds.push(featureId);
                }
            }
            if (!groupFeatureIds.length) {
                continue;
            }
            if (!topFeatureIds.length) {
                // One rendered point can represent several server-grouped
                // features. Preserve that atomic membership independently of
                // the flat, bounded context-menu result.
                topFeatureIds = groupFeatureIds;
            }
            for (const featureId of groupFeatureIds) {
                const identity = `${featureId.mapTileKey}\u0000${featureId.featureId}`;
                if (seen.has(identity)) {
                    continue;
                }
                seen.add(identity);
                featureIds.push(featureId);
                if (featureIds.length >= maxFeatures) {
                    return { topFeatureIds, featureIds };
                }
            }
        }
        return { topFeatureIds, featureIds };
    }

    /** Resolve ordering metadata for one GPU vector picking result. */
    private renderedPickOrder(
        picked: PickingInfo
    ): { zIndex: number; primitiveOrder: number } | undefined {
        const globalPickIndex = Number(
            (picked.object as { globalPickIndex?: unknown } | undefined)
                ?.globalPickIndex ?? picked.index
        );
        if (!this.gpuScene || !Number.isInteger(globalPickIndex) ||
            globalPickIndex < 0 ||
            (!(picked.layer instanceof ErdblickVectorLayer) &&
                !(picked.sourceLayer instanceof ErdblickVectorLayer))) {
            return undefined;
        }
        return this.gpuScene.pickOrder(globalPickIndex);
    }

    /** Resolves feature ids from metadata already returned by a deck picking operation. */
    private featureIdsFromPickingInfo(picked: PickingInfo): TileFeatureId[] {
        const globalPickIndex = Number(
            (picked.object as { globalPickIndex?: unknown } | undefined)
                ?.globalPickIndex ?? picked.index
        );
        if ((picked.layer instanceof ErdblickVectorLayer ||
            picked.sourceLayer instanceof ErdblickVectorLayer ||
            picked.layer instanceof GpuTextLayerHost ||
            picked.sourceLayer instanceof GpuTextLayerHost) &&
            this.gpuScene && Number.isInteger(globalPickIndex) &&
            globalPickIndex >= 0) {
            return this.gpuScene.resolvePick(globalPickIndex);
        }
        const readFeatureAddress = (buffer: ArrayLike<number | null> | undefined, index: number): number | null => {
            if (!buffer || index < 0 || index >= buffer.length) {
                return null;
            }
            const value = buffer[index];
            if (!Number.isInteger(value) || value === DeckPicking.UNSELECTABLE_FEATURE_INDEX) {
                return null;
            }
            return value;
        };

        const layerProps = picked.layer?.props as DeckFeaturePickLayerProps | undefined;
        const pickedObject = picked.object;
        const objectFeatureAddresses = pickedObject?.featureAddresses ?? pickedObject?.featureAddress;
        const objectFeatureAddressesAreBinaryBuffer = typeof objectFeatureAddresses === "object"
            && objectFeatureAddresses !== null
            && ArrayBuffer.isView(objectFeatureAddresses as ArrayBufferView);
        if (objectFeatureAddresses !== undefined && objectFeatureAddresses !== null && !objectFeatureAddressesAreBinaryBuffer) {
            if (Array.isArray(objectFeatureAddresses)) {
                return objectFeatureAddresses
                    .map(value => Number.isInteger(value)
                        ? layerProps?.subsetPickResolver?.(Number(value)) ?? []
                        : [])
                    .flat();
            }
            if (Number.isInteger(objectFeatureAddresses)) {
                const subsetResult = layerProps?.subsetPickResolver?.(
                    objectFeatureAddresses as number
                );
                if (subsetResult?.length) {
                    return subsetResult;
                }
            }
            return [];
        }

        const pickedIndex = Number(picked.index);
        if (Number.isInteger(pickedIndex) && pickedIndex >= 0) {
            const featureAddress = readFeatureAddress(layerProps?.featureAddresses, pickedIndex);
            if (featureAddress !== null) {
                const subsetResult = layerProps?.subsetPickResolver?.(featureAddress);
                if (subsetResult?.length) {
                    return subsetResult;
                }
                return [];
            }
            const featureAddressByPath = readFeatureAddress(layerProps?.featureAddressesByPath, pickedIndex);
            if (featureAddressByPath !== null) {
                const subsetResult = layerProps?.subsetPickResolver?.(featureAddressByPath);
                if (subsetResult?.length) {
                    return subsetResult;
                }
                return [];
            }
        }
        return [];
    }

    /** Cancels any pending deferred hover-pick work. */
    private cancelHoverPickScheduling(): void {
        if (this.hoverAnchorPickTimer) {
            clearTimeout(this.hoverAnchorPickTimer);
            this.hoverAnchorPickTimer = null;
        }
        if (this.hoverDetailPickTimer) {
            clearTimeout(this.hoverDetailPickTimer);
            this.hoverDetailPickTimer = null;
        }
    }

    /** Clears hover work and highlights that belong to the previously installed deck view. */
    clearHoverPickingState(updateInspection = true): void {
        this.hoverPickGeneration += 1;
        this.pendingHoverAnchorPosition = null;
        this.pendingHoverDetailPosition = null;
        this.latestHoverPosition = null;
        this.topHoverFeatureIds = [];
        this.topHoverFeatureGeneration = -1;
        this.cancelHoverPickScheduling();
        this.setFeatureHoverState(false);
        this.publishNavigationTarget(null);
        this.hoveredFeatureIds.next([]);
        this.onHover({featureIds: [], updateInspection});
    }

    /** Queues a quick anchor sample and resets the deep hover query's pointer-idle deadline. */
    private queueHoverPicks(position: { x: number; y: number }): void {
        this.pendingHoverAnchorPosition = position;
        this.pendingHoverDetailPosition = position;
        this.hoverDetailPickDueAtMs = performance.now()
            + DeckPicking.HOVER_DETAIL_PICK_IDLE_MS;
        if (this.hoverDetailPickTimer) {
            clearTimeout(this.hoverDetailPickTimer);
            this.hoverDetailPickTimer = null;
        }
        this.scheduleHoverAnchorPick();
        this.scheduleHoverDetailPick();
    }

    /** Schedules the latest top-object sample at a bounded interactive rate. */
    private scheduleHoverAnchorPick(): void {
        if (this.hoverPickInFlight || this.hoverAnchorPickTimer ||
            !this.pendingHoverAnchorPosition) {
            return;
        }
        const now = performance.now();
        const nextEligibleAt = this.lastHoverAnchorPickAtMs
            + DeckPicking.HOVER_ANCHOR_PICK_THROTTLE_MS;
        const delayMs = Math.max(0, nextEligibleAt - now);
        this.hoverAnchorPickTimer = setTimeout(() => {
            this.hoverAnchorPickTimer = null;
            if (!this.deckCanvasPointerInside) {
                this.pendingHoverAnchorPosition = null;
                return;
            }
            if (this.isCameraInteracting || this.hoverPickInFlight) {
                return;
            }
            const pendingPosition = this.pendingHoverAnchorPosition;
            this.pendingHoverAnchorPosition = null;
            if (!pendingPosition) {
                return;
            }
            this.lastHoverAnchorPickAtMs = performance.now();
            void this.processHoverAnchorPick(pendingPosition);
        }, delayMs);
    }

    /** Resolves one top object without paying for a depth readback on every pointer move. */
    private async processHoverAnchorPick(position: { x: number; y: number }): Promise<void> {
        const deck = this.deck;
        if (!deck || !this.deckCanvasPointerInside) {
            return;
        }
        if (this.hoverPickInFlight) {
            this.pendingHoverAnchorPosition = position;
            return;
        }
        const generation = this.hoverPickGeneration;
        const radius = Math.max(0, Math.trunc(this.options().radius));
        const navigationLayerIds = this.navigationPickLayerIds();
        this.hoverPickInFlight = true;
        try {
            const topPick = navigationLayerIds.length
                ? await deck.pickObjectAsync({
                    x: position.x,
                    y: position.y,
                    radius,
                    layerIds: navigationLayerIds,
                    unproject3D: false
                })
                : null;
            if (deck !== this.deck || generation !== this.hoverPickGeneration ||
                !this.deckCanvasPointerInside || this.isCameraInteracting ||
                !this.isHoverSampleLocal(position, radius)) {
                return;
            }
            const topFeatureIds = topPick
                ? this.featureIdsFromPickingInfo(topPick)
                : [];
            this.topHoverFeatureIds = topFeatureIds;
            this.topHoverFeatureGeneration = generation;
            // Do not make the visible highlight wait for the more expensive drill pass.
            // A provisional top pick must not collapse an already settled
            // drill stack while the cursor still covers one of its objects.
            const settledFeatureIds = this.hoveredFeatureIds.getValue();
            const remainsInSettledStack = topFeatureIds.length > 0 &&
                topFeatureIds.every(topFeature =>
                    settledFeatureIds.some(settledFeature =>
                        settledFeature.mapTileKey === topFeature.mapTileKey &&
                        settledFeature.featureId === topFeature.featureId));
            this.publishHoveredFeatures(
                remainsInSettledStack ? settledFeatureIds : topFeatureIds
            );
            if (!this.allowPitchAndBearing) {
                return;
            }
            this.publishNavigationTarget(
                (topPick
                    ? navigationTargetFromPickingInfo({
                        ...topPick,
                        x: position.x,
                        y: position.y
                    }, radius)
                    : null) ?? this.groundNavigationTarget(position)
            );
        } catch (error) {
            if (deck === this.deck && generation === this.hoverPickGeneration) {
                console.error("Hover anchor picking failed.", error);
            }
        } finally {
            this.hoverPickInFlight = false;
            this.continueHoverPickQueue();
        }
    }

    /** Schedules the deep feature stack only after the pointer has settled briefly. */
    private scheduleHoverDetailPick(): void {
        if (this.hoverPickInFlight || this.hoverDetailPickTimer ||
            !this.pendingHoverDetailPosition) {
            return;
        }
        this.hoverDetailPickTimer = setTimeout(() => {
            this.hoverDetailPickTimer = null;
            if (!this.deckCanvasPointerInside) {
                this.pendingHoverDetailPosition = null;
                return;
            }
            if (this.isCameraInteracting || this.hoverPickInFlight) {
                return;
            }
            const pendingPosition = this.pendingHoverDetailPosition;
            this.pendingHoverDetailPosition = null;
            if (pendingPosition) {
                void this.processHoverDetailPick(pendingPosition);
            }
        }, Math.max(0, this.hoverDetailPickDueAtMs - performance.now()));
    }

    /** Resolves the bounded feature stack that drives hover highlights and the HUD label. */
    private async processHoverDetailPick(position: { x: number; y: number }): Promise<void> {
        const deck = this.deck;
        if (!deck || !this.deckCanvasPointerInside) {
            return;
        }
        if (this.hoverPickInFlight) {
            this.pendingHoverDetailPosition = position;
            return;
        }
        const generation = this.hoverPickGeneration;
        const radius = Math.max(0, Math.trunc(this.options().radius));
        const canvas = deck.getCanvas();
        const left = Math.max(0, position.x - radius);
        const top = Math.max(0, position.y - radius);
        const right = Math.min(canvas?.clientWidth ?? position.x + radius + 1,
            position.x + radius + 1);
        const bottom = Math.min(canvas?.clientHeight ?? position.y + radius + 1,
            position.y + radius + 1);
        const drillLayerIds = this.drillPickLayerIds();
        this.hoverPickInFlight = true;
        try {
            const picked = drillLayerIds.length && right > left && bottom > top
                ? await deck.pickObjectsAsync({
                    x: left,
                    y: top,
                    width: right - left,
                    height: bottom - top,
                    layerIds: drillLayerIds,
                    maxObjects: DeckPicking.HOVER_PICK_MAX_OBJECTS
                })
                : [];
            if (deck !== this.deck || generation !== this.hoverPickGeneration ||
                !this.deckCanvasPointerInside || this.isCameraInteracting ||
                !this.isHoverSampleLocal(position, radius)) {
                return;
            }
            const featureIds = this.featurePickResultFromPickingInfos(
                picked,
                DeckPicking.HOVER_PICK_MAX_OBJECTS
            ).featureIds;
            const topFeatureIds = generation === this.topHoverFeatureGeneration
                ? this.topHoverFeatureIds
                : [];
            if (this.allowPitchAndBearing && featureIds.length) {
                for (const item of picked) {
                    const target = navigationTargetFromPickingInfo(
                        { ...item, x: position.x, y: position.y },
                        radius
                    );
                    if (target) {
                        this.publishNavigationTarget(target);
                        break;
                    }
                }
            }
            this.publishHoveredFeatures(featureIds.length ? featureIds : topFeatureIds);
        } catch (error) {
            if (deck === this.deck && generation === this.hoverPickGeneration) {
                console.error("Hover detail picking failed.", error);
            }
        } finally {
            this.hoverPickInFlight = false;
            this.continueHoverPickQueue();
        }
    }

    /** Gives a pending anchor sample priority before resuming a settled deep query. */
    private continueHoverPickQueue(): void {
        if (this.pendingHoverAnchorPosition) {
            this.scheduleHoverAnchorPick();
        } else if (this.pendingHoverDetailPosition) {
            this.scheduleHoverDetailPick();
        }
    }

    /** Accepts an asynchronous readback while the cursor remains inside its sampled radius. */
    private isHoverSampleLocal(
        position: { x: number; y: number },
        radius: number
    ): boolean {
        const latest = this.latestHoverPosition;
        return !!latest && Math.hypot(
            latest.x - position.x,
            latest.y - position.y
        ) <= Math.max(1, radius);
    }

    /** Updates hover consumers only when the logical feature stack actually changed. */
    private publishHoveredFeatures(featureIds: TileFeatureId[]): void {
        const current = this.hoveredFeatureIds.getValue();
        const unchanged = featureSetsEqual(current, featureIds);
        this.setFeatureHoverState(featureIds.length > 0);
        if (unchanged) {
            return;
        }
        this.onHover({featureIds, updateInspection: true});
        this.hoveredFeatureIds.next(featureIds);
    }

    /** Tracks whether the cursor should show as a pointer over selectable geometry. */
    private setFeatureHoverState(isHoveringFeature: boolean): void {
        if (this.isHoveringFeature === isHoveringFeature) {
            return;
        }
        this.isHoveringFeature = isHoveringFeature;
        if (this.deck) {
            this.deck.setProps({ getCursor: this.deckCursor });
        }
    }

    /** Resolves the first drill hit's physical feature anchor for marker placement. */
    private markerPositionForFeature(
        clickInfo: PickingInfo,
        screenPosition: { x: number; y: number },
        targetFeature: TileFeatureId,
        radius: number,
        maxObjects: number
    ): NavigationAnchor | null {
        if (this.pickingInfoContainsFeature(clickInfo, targetFeature)) {
            const clickPosition = markerAnchorFromPickingInfo(clickInfo);
            if (clickPosition) {
                return clickPosition;
            }
        }
        if (!this.deck) {
            return null;
        }
        const pickedObjects = this.deck.pickMultipleObjects({
            x: screenPosition.x,
            y: screenPosition.y,
            radius,
            depth: maxObjects,
            layerIds: this.drillPickLayerIds(),
            unproject3D: true
        });
        for (const picked of pickedObjects) {
            if (!this.pickingInfoContainsFeature(picked, targetFeature)) {
                continue;
            }
            const position = markerAnchorFromPickingInfo(picked);
            if (position) {
                return position;
            }
        }
        return null;
    }

    /** Returns whether one Deck pick resolves to the exact supplied tile-feature identity. */
    private pickingInfoContainsFeature(picked: PickingInfo, target: TileFeatureId): boolean {
        return this.featureIdsFromPickingInfo(picked).some(featureId =>
            featureId.mapTileKey === target.mapTileKey
            && featureId.featureId === target.featureId
        );
    }
}
