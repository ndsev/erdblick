import {COORDINATE_SYSTEM} from "@deck.gl/core";
import {
    PathLayer,
    TextLayer
} from "@deck.gl/layers";
import {Matrix4} from "@math.gl/core";
import type {Device} from "@luma.gl/core";
import {PackedTileId} from "@ndsev/ndslive-math";
import type {FilterTileState} from "../../mapdata/filter-tile-state.model";
import type {StyledMapgetLayer} from "../../mapdata/styled-mapget-layer.model";
import type {TileFeatureId} from "../../shared/appstate.service";
import {formatFeatureInspectionTarget} from "../../shared/tile-feature-id";
import {sipHash64Hex} from "../../styledata/hash";
import {SceneMode} from "../../integrations/geo";
import {coreLib} from "../../integrations/wasm";
import type {IRenderSceneHandle} from "../render-view.model";
import {
    DeckLayerRegistry,
    makeDeckLayerKey
} from "./deck-layer-registry";
import {DeckRenderBufferArena} from "./deck-render-buffer-arena";
import {StaleSubsetRenderError, TileSubsetLayerRenderService} from
    "./tile-subset-layer-render.service";
import type {
    TileSubsetLayerRenderBuffers,
    TileSubsetPickResult
} from "./tile-subset-layer-render.worker.protocol";
import {
    DeckGltfNodeLayer,
    DeckGltfPickProxyLayer,
    type DeckGltfNodeStyleContribution,
    type DeckGltfPickProxyDatum,
    type DeckGltfPickProxyStyleContribution,
    type DeckTileGltfAsset,
    type DeckTileGltfAttachmentSource,
    releaseDeckTileGltfAsset,
    retainDeckTileGltfAsset
} from "./deck-gltf-node.layer";
import type {StyleValidationReportService} from "../../styledata/style-validation-report.service";
import {
    deckSubsetGltfPickProxyKey,
    deckSubsetInteractionProps,
    remapGltfPickContributions,
    type DeckSubsetInteractionProps as DeckInteractionProps,
    type SubsetPickResolver as PickResolver
} from "./deck-subset-picking";
import {
    interactionColor,
    type DeckInteractionEffect,
    type DeckRgba
} from "./deck-interaction-effect";
import {DeckInteractionOutlineService} from
    "./deck-interaction-outline.service";
import {packVariablePathOffsetVectors} from
    "./deck-variable-path-offset.extension";
import {
    compileTileSubsetArrowMarkers,
    MAX_TILE_SUBSET_RENDER_VERTICES,
    type DeckArrowMarker,
    type DeckPathData,
    type DeckPointData,
    type DeckSurfaceData
} from "./tile-subset-render-data";
import {
    createTileSubsetArrowLayer,
    createTileSubsetPathLayer,
    createTileSubsetPointLayer,
    createTileSubsetSurfaceLayer,
    TileSubsetVectorPresentation,
    type DeckLabelData,
    type TileSubsetVectorSource
} from "./tile-subset-vector-presentation";

interface DeckScene {
    layerRegistry?: DeckLayerRegistry;
    renderBufferArena?: DeckRenderBufferArena;
    interactionOutlineService?: DeckInteractionOutlineService;
    sceneMode?: SceneMode;
    device?: Device | null;
}

interface DeckGlowMaterial {
    key: string;
    color: DeckRgba;
    radius: number;
}

interface DebugBlockPath {
    path: Array<[number, number, number]>;
}

interface DebugBlockLabel {
    position: [number, number, number];
    text: string;
}

interface PreparedGltf {
    source: DeckTileGltfAttachmentSource;
    asset: DeckTileGltfAsset;
    device: Device;
}

interface SharedGltfContribution {
    asset: DeckTileGltfAsset;
    order: number;
    priority: number;
    styleOrder: number;
    data: DeckGltfNodeStyleContribution["data"];
}

interface SharedGltfPickContribution {
    order: number;
    coordinateOrigin: [number, number, number];
    data: DeckGltfPickProxyStyleContribution["data"];
    pickResolver: PickResolver;
}

/** One style-owned interaction material applied to exact locally retained picks. */
export interface TileSubsetInteractionOverlay {
    id: string;
    targets: readonly TileFeatureId[];
    effect: DeckInteractionEffect;
    order: number;
}

interface InteractionSource extends TileSubsetVectorSource {
    gltf: InteractionGltfSource | null;
}

interface InteractionGltfSource {
    key: string;
    asset: DeckTileGltfAsset;
    data: DeckGltfNodeStyleContribution["data"];
}

const UNSELECTABLE = 0xffffffff;
const FLAT_2D_MODEL_MATRIX = new Matrix4().scale([1, 1, 0]);
const NO_DEPTH_PARAMETERS = {
    depthTest: false,
    depthMask: false
} as any;
const MASK_NO_DEPTH_PARAMETERS = {
    ...NO_DEPTH_PARAMETERS,
    blend: false
} as any;
/**
 * One logical Deck visualization for one pre-render Morton block of directly
 * owned TileSubsetLayers.
 *
 * Workers resolve compact pick identities while they own the exact parsed
 * subset. The main thread retains only raw immutable bytes and render output.
 */
export class TileSubsetLayerVisualization {
    readonly visualizationId: string;
    private readonly layerKeys = new Set<string>();
    private readonly vectorPresentation: TileSubsetVectorPresentation;
    private readonly interactionLayerKeys = new Set<string>();
    private readonly interactionGltfSources = new Map<
        string,
        {key: string; sourceId: string}
    >();
    private readonly interactionOutlineSources = new Map<
        string,
        {groupId: string; sourceId: string}
    >();
    private readonly styleGlowOutlineSources = new Map<
        string,
        {groupId: string; sourceId: string}
    >();
    private readonly styleCacheKey: string;
    private pickResults: TileSubsetPickResult[] = [];
    private readonly interactionTargetKeys = new Set<string>();
    private readonly interactionScopesByTarget = new Map<string, Set<string>>();
    private interactionSource: InteractionSource | null = null;
    private interactionOverlays: readonly TileSubsetInteractionOverlay[] = [];
    private renderedSignature = "";
    private requestedSignature = "";
    private disposed = false;
    private sceneHandle: IRenderSceneHandle | null = null;
    private sceneRevision = 0;
    private fidelityValue: number;
    private activeGltfSource: DeckTileGltfAttachmentSource | null = null;
    private activeGltfAsset: DeckTileGltfAsset | null = null;
    private activeGltfDevice: Device | null = null;
    private gltfSharedSourceActive = false;
    private gltfPickSharedSourceActive = false;
    private debugBlockVisualization = false;
    private readonly reportedRuntimeIssueIds = new Set<string>();

    constructor(
        readonly owner: StyledMapgetLayer,
        readonly states: readonly FilterTileState[],
        readonly blockKey: string,
        private readonly blockOrigin: [number, number, number],
        private readonly renderService: TileSubsetLayerRenderService,
        private readonly styleValidationReports: StyleValidationReportService,
        fidelityValue: number,
        readonly viewIndex: number = owner.identity.viewIndex
    ) {
        if (!states.length) {
            throw new Error("A subset block visualization needs at least one tile.");
        }
        this.visualizationId = [
            owner.ownerId,
            `view-${viewIndex}`,
            encodeURIComponent(blockKey)
        ].join("/");
        this.styleCacheKey = [
            sipHash64Hex(owner.style.source),
            owner.style.source.length
        ].join(":");
        this.vectorPresentation = new TileSubsetVectorPresentation({
            visualizationId: this.visualizationId,
            ownerId: owner.ownerId,
            presentationKind: owner.identity.presentationKind,
            styleOrder: owner.styleOrder,
            viewIndex,
            blockKey
        });
        this.fidelityValue = fidelityValue;
        for (const state of states) {
            owner.retainTileState(state);
        }
    }

    setFidelity(fidelityValue: number): void {
        if (this.fidelityValue === fidelityValue) {
            return;
        }
        this.fidelityValue = fidelityValue;
        this.requestedSignature = "";
        if (this.sceneHandle) {
            this.render(this.sceneHandle).catch(error =>
                console.error("Failed to switch subset visualization fidelity.", error)
            );
        }
    }

    containsTile(tileId: number): boolean {
        return this.states.some(state => state.tileId === tileId);
    }

    /** Reports whether an exact feature/validity/relation/group pick is retained locally. */
    hasLocalInteractionTarget(
        target: TileFeatureId,
        scope?: "feature" | "attribute" | "relation" | "group"
    ): boolean {
        if (!this.interactionSource) {
            return false;
        }
        const key = this.interactionTargetKey(target);
        return scope
            ? this.interactionScopesByTarget.get(key)?.has(scope) ?? false
            : this.interactionTargetKeys.has(key);
    }

    /** Replaces this block's view-owned local interaction overlay definitions. */
    setInteractionOverlays(
        overlays: readonly TileSubsetInteractionOverlay[]
    ): void {
        const kind = this.owner.identity.presentationKind;
        // Hover/selection subsets are already authored interaction
        // visualizations. Feeding them back through the generic mask would
        // double their material and compound translucent geometry.
        this.interactionOverlays = kind === "hover" || kind === "selection"
            ? []
            : overlays;
        this.refreshInteractionOverlays();
    }

    hasSameStates(
        states: readonly FilterTileState[],
        fidelityValue: number
    ): boolean {
        return this.fidelityValue === fidelityValue &&
            states.length === this.states.length &&
            states.every((state, index) => state === this.states[index]);
    }

    private get primaryState(): FilterTileState {
        return this.states[0];
    }

    private isReadyForRender(): boolean {
        return this.states.every(
            state => state.status === "ready" && !!state.subsetBlob
        );
    }

    /** True once every current immutable input version is installed in Deck. */
    isCurrentPresentationInstalled(): boolean {
        return this.renderedSignature.length > 0 &&
            this.states.every(state =>
                state.status === "ready" &&
                state.renderedValueVersion === state.valueVersion
            );
    }

    /** Toggles the main-thread-only render-block boundary overlay. */
    setDebugBlockVisualization(
        enabled: boolean,
        sceneHandle: IRenderSceneHandle | null = this.sceneHandle
    ): void {
        this.debugBlockVisualization = enabled;
        if (!sceneHandle || this.disposed) {
            return;
        }
        const registry = this.registry(sceneHandle);
        if (!registry) {
            return;
        }
        const desired = new Set(this.layerKeys);
        this.applyDebugBlockVisualization(registry, desired);
        this.reconcile(registry, desired);
    }

    async render(sceneHandle: IRenderSceneHandle): Promise<boolean> {
        if (this.sceneHandle && this.sceneHandle !== sceneHandle) {
            this.sceneRevision += 1;
        }
        this.sceneHandle = sceneHandle;
        if (this.disposed || !this.isReadyForRender()) {
            return false;
        }
        const primaryState = this.primaryState;
        const dataSourceInfoBlob =
            this.owner.mapInfo.getRenderDataSourceInfoBlob(primaryState.mapId);
        if (!dataSourceInfoBlob) {
            return false;
        }
        // Add-on composition may give a delivered layer a combined string-pool
        // namespace which differs from the catalog datasource's namespace.
        // The worker must decode the subset against the namespace serialized in
        // that exact value, not the MapgetLayer catalog entry.
        const stringPoolId = primaryState.stringPoolId;
        if (this.states.some(state => state.stringPoolId !== stringPoolId)) {
            throw new Error(
                `Subset block '${this.blockKey}' spans multiple string-pool namespaces.`
            );
        }
        const fieldDictBlob = this.owner.mapInfo.getFieldDictBlob(
            stringPoolId
        );
        if (!fieldDictBlob) {
            return false;
        }
        const renderOrigin =
            this.arena(sceneHandle)?.coordinateOrigin(this.blockOrigin) ??
            this.blockOrigin;
        const signature = [
            ...this.states.map(state =>
                `${state.mapTileKey}:${state.valueVersion}`
            ),
            this.fidelityValue,
            this.owner.style.id,
            this.styleCacheKey,
            ...renderOrigin,
            this.sceneRevision
        ].join("|");
        if (signature === this.renderedSignature || signature === this.requestedSignature) {
            return true;
        }
        this.requestedSignature = signature;
        const valueVersions = this.states.map(
            state => state.valueVersion
        );
        const sceneRevision = this.sceneRevision;
        const startedAt = performance.now();
        try {
            const result = await this.renderService.render({
                visualizationId: this.visualizationId,
                renderSignature: signature,
                viewIndex: this.viewIndex,
                blockKey: this.blockKey,
                mapTileKeys: this.states.map(state => state.mapTileKey),
                tileIds: this.states.map(state => state.tileId),
                coordinateOrigin: renderOrigin,
                mapId: primaryState.mapId,
                catalogRevision: this.owner.mapInfo.sourceCatalogRevision ?? 0,
                dataSourceInfoBlob,
                stringPoolId,
                fieldDictBlob,
                subsetBlobs: this.states.map(
                    state => state.subsetBlob!
                ),
                inputGeometryVertexCount: this.states.reduce(
                    (sum, state) =>
                        sum + state.geometryVertexCount,
                    0
                ),
                styleKey: this.styleCacheKey,
                styleSource: this.owner.style.source,
                highlightModeValue: this.owner.highlightMode.value,
                fidelityValue: this.fidelityValue
            });
            if (this.disposed ||
                signature !== this.requestedSignature ||
                this.sceneHandle !== sceneHandle ||
                this.sceneRevision !== sceneRevision ||
                this.states.some(
                    (state, index) =>
                        state.valueVersion !== valueVersions[index]
                )) {
                return false;
            }
            if (!await this.applyResult(
                sceneHandle,
                result,
                signature,
                sceneRevision
            )) {
                return false;
            }
            this.pickResults = result.pickResults ?? [];
            this.rebuildInteractionTargetIndex();
            this.refreshInteractionOverlays();
            this.renderedSignature = signature;
            this.requestedSignature = "";
            this.installRenderStats(
                result,
                valueVersions,
                performance.now() - startedAt
            );
            this.recordRuntimeStyleIssues(result);
            return true;
        } catch (error) {
            if (error instanceof StaleSubsetRenderError) {
                return false;
            }
            this.requestedSignature = "";
            throw error;
        }
    }

    /** Expands compact worker diagnostics into the application's canonical style-issue stream. */
    private recordRuntimeStyleIssues(
        result: TileSubsetLayerRenderBuffers
    ): void {
        for (const issue of result.styleIssues) {
            const id = [
                "subset-runtime",
                sipHash64Hex(this.owner.style.source),
                this.blockKey,
                issue.ruleIndex,
                issue.property,
                sipHash64Hex(issue.expression),
                sipHash64Hex(issue.message)
            ].join(":");
            if (this.reportedRuntimeIssueIds.has(id)) {
                continue;
            }
            this.reportedRuntimeIssueIds.add(id);
            this.styleValidationReports.recordIssue({
                id,
                at: Date.now(),
                severity: "warning",
                phase: "runtime",
                impact: "runtime-sample-skipped",
                source: {...this.owner.style.sourceRef},
                message: issue.occurrenceCount > 1
                    ? `${issue.message} (${issue.occurrenceCount} occurrences)`
                    : issue.message,
                ruleIndex: issue.ruleIndex,
                rulePath: `rules[${issue.ruleIndex}]`,
                property: issue.property,
                expression: issue.expression,
                runtimeContext: {
                    mapName: this.primaryState.mapId,
                    layerName: this.owner.mapgetLayer.layerId,
                    tileKey: this.blockKey,
                    renderPath: "worker"
                }
            });
        }
    }

    private installRenderStats(
        result: TileSubsetLayerRenderBuffers,
        valueVersions: readonly number[],
        clientWallMs: number
    ): void {
        const counts = result.subsetVertexCounts;
        const totalVertices = [...counts].reduce(
            (sum, count) => sum + count,
            0
        );
        const count = Math.max(1, this.states.length);
        for (let index = 0; index < this.states.length; ++index) {
            const state = this.states[index];
            const vertexCount = Number(counts[index] ?? 0);
            const weight = totalVertices > 0
                ? vertexCount / totalVertices
                : 1 / count;
            const deserializeMs = Number(
                result.timings.deserializeMsBySubset[index] ??
                result.timings.deserializeMs / count
            );
            const renderMs = result.timings.renderMs * weight;
            state.renderedValueVersion = valueVersions[index];
            state.renderStats = {
                subsetBytes: state.subsetBlob?.byteLength ?? 0,
                deserializeMs,
                renderMs,
                totalMs: deserializeMs + renderMs,
                clientWallMs,
                vertexCount
            };
        }
    }

    reattach(sceneHandle: IRenderSceneHandle): Promise<boolean> {
        if (this.sceneHandle !== sceneHandle) {
            this.sceneRevision += 1;
        }
        this.sceneHandle = sceneHandle;
        this.renderedSignature = "";
        this.requestedSignature = "";
        return this.render(sceneHandle);
    }

    destroy(sceneHandle: IRenderSceneHandle | null = this.sceneHandle): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.renderService.cancel(this.visualizationId);
        const registry = sceneHandle ? this.registry(sceneHandle) : null;
        const outlineService = sceneHandle
            ? this.outlineService(sceneHandle)
            : null;
        if (registry) {
            for (const key of this.layerKeys) {
                registry.remove(key);
            }
            for (const key of this.interactionLayerKeys) {
                registry.remove(key);
            }
            for (const source of this.interactionGltfSources.values()) {
                registry.removeShared(source.key, source.sourceId);
            }
        }
        this.layerKeys.clear();
        this.interactionLayerKeys.clear();
        this.interactionGltfSources.clear();
        if (outlineService) {
            for (const source of this.interactionOutlineSources.values()) {
                outlineService.removeMask(source.groupId, source.sourceId);
            }
            for (const source of this.styleGlowOutlineSources.values()) {
                outlineService.removeMask(source.groupId, source.sourceId);
            }
        }
        this.interactionOutlineSources.clear();
        this.styleGlowOutlineSources.clear();
        this.vectorPresentation.destroy();
        this.removeSharedGltfContributions(registry);
        this.releaseGltfAsset();
        for (const state of this.states) {
            this.owner.releaseAttachment(state.tileId);
            this.owner.releaseTileState(state);
        }
        this.pickResults = [];
        this.interactionTargetKeys.clear();
        this.interactionScopesByTarget.clear();
        this.interactionSource = null;
        this.interactionOverlays = [];
        this.sceneHandle = null;
    }

    private async applyResult(
        sceneHandle: IRenderSceneHandle,
        result: TileSubsetLayerRenderBuffers,
        signature: string,
        sceneRevision: number
    ): Promise<boolean> {
        const registry = this.registry(sceneHandle);
        if (!registry) {
            return false;
        }
        const desired = new Set<string>();
        this.applyDebugBlockVisualization(registry, desired);
        const origin = this.coordinateOrigin(result.coordinateOrigin);
        if (!origin) {
            this.vectorPresentation.clear();
            this.interactionSource = null;
            this.reconcileStyleGlowOutlines(
                this.outlineService(sceneHandle),
                new Set());
            this.refreshInteractionOverlays();
            this.reconcile(registry, desired);
            return true;
        }
        const preparedGltf = await this.prepareGltf(sceneHandle, result);
        if (this.disposed ||
            signature !== this.requestedSignature ||
            this.sceneHandle !== sceneHandle ||
            this.sceneRevision !== sceneRevision) {
            if (preparedGltf) {
                releaseDeckTileGltfAsset(preparedGltf.source, preparedGltf.device);
            }
            return false;
        }
        const modelMatrix = this.modelMatrix(sceneHandle);
        const interaction = deckSubsetInteractionProps(
            this.owner.identity.presentationKind,
            this.owner.highlightMode.value,
            coreLib.HighlightMode.NO_HIGHLIGHT.value,
            (sceneHandle.scene as DeckScene | undefined)?.sceneMode
        );
        const pickResolver: PickResolver = pickIndex => this.resolvePick(pickIndex);
        const vectorSource = this.vectorPresentation.install({
            registry,
            arena: this.arena(sceneHandle),
            result,
            origin,
            modelMatrix,
            interaction,
            pickResolver
        });
        const interactionGltf = this.applyGltf(
            registry,
            result,
            origin,
            modelMatrix,
            pickResolver,
            interaction,
            preparedGltf
        );
        this.interactionSource = {
            ...vectorSource,
            gltf: interactionGltf
        };
        this.refreshStyleGlows(sceneHandle);
        this.reconcile(registry, desired);
        return true;
    }

    /** Adds one labeled WGS84 rectangle for the actual rendered block. */
    private applyDebugBlockVisualization(
        registry: DeckLayerRegistry,
        desired: Set<string>
    ): void {
        const pathKey = this.key("debug-block", false, false);
        const labelKey = this.key("debug-block-label", false, true);
        desired.delete(pathKey);
        desired.delete(labelKey);
        if (!this.debugBlockVisualization) {
            return;
        }
        const bounds = this.debugBlockBounds();
        if (!bounds) {
            return;
        }
        const color = this.debugBlockColor(this.states.length);
        registry.upsert(pathKey, new PathLayer<DebugBlockPath>({
            id: pathKey,
            data: [{path: bounds.path}],
            coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
            getPath: datum => datum.path,
            getColor: color,
            getWidth: 3,
            widthUnits: "pixels",
            capRounded: false,
            jointRounded: false,
            pickable: false,
            parameters: NO_DEPTH_PARAMETERS
        }), 10_000 + this.owner.styleOrder);
        desired.add(pathKey);

        const geometryVertices = this.states.reduce(
            (sum, state) => sum + state.geometryVertexCount,
            0
        );
        const label: DebugBlockLabel = {
            position: bounds.center,
            text: `${this.states.length} tile${this.states.length === 1 ? "" : "s"} / ` +
                `${geometryVertices.toLocaleString()} v`
        };
        registry.upsert(labelKey, new TextLayer<DebugBlockLabel>({
            id: labelKey,
            data: [label],
            coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
            getPosition: datum => datum.position,
            getText: datum => datum.text,
            getColor: color,
            getSize: 13,
            getPixelOffset: () => [
                0,
                (this.debugLabelLane() - 2) * 14
            ],
            billboard: true,
            pickable: false,
            parameters: NO_DEPTH_PARAMETERS
        }), 10_001 + this.owner.styleOrder);
        desired.add(labelKey);
    }

    private debugBlockBounds(): {
        path: Array<[number, number, number]>;
        center: [number, number, number];
    } | null {
        let west = Number.POSITIVE_INFINITY;
        let south = Number.POSITIVE_INFINITY;
        let east = Number.NEGATIVE_INFINITY;
        let north = Number.NEGATIVE_INFINITY;
        for (const state of this.states) {
            const tile = new PackedTileId(state.tileId);
            const [x, y] = tile.southWestCorner();
            const size = tile.size();
            west = Math.min(west, x * 360 / 2 ** 32);
            south = Math.min(south, y * 180 / 2 ** 31);
            east = Math.max(east, (x + size) * 360 / 2 ** 32);
            north = Math.max(north, (y + size) * 180 / 2 ** 31);
        }
        if (![west, south, east, north].every(Number.isFinite)) {
            return null;
        }
        return {
            path: [
                [west, south, 0],
                [east, south, 0],
                [east, north, 0],
                [west, north, 0],
                [west, south, 0]
            ],
            center: [
                (west + east) / 2,
                (south + north) / 2,
                0
            ]
        };
    }

    private debugBlockColor(
        tileCount: number
    ): [number, number, number, number] {
        if (tileCount >= 16) {
            return [255, 60, 200, 255];
        }
        if (tileCount >= 8) {
            return [255, 150, 40, 255];
        }
        if (tileCount >= 4) {
            return [60, 230, 100, 255];
        }
        if (tileCount >= 2) {
            return [40, 180, 255, 255];
        }
        return [230, 230, 230, 255];
    }

    /** Spreads coincident labels from multiple styled layers into five lanes. */
    private debugLabelLane(): number {
        let hash = 0;
        const identity = [
            this.owner.mapgetLayer.layerId,
            this.owner.style.id
        ].join("/");
        for (let index = 0; index < identity.length; ++index) {
            hash = ((hash * 31) + identity.charCodeAt(index)) >>> 0;
        }
        return hash % 5;
    }

    private async prepareGltf(
        sceneHandle: IRenderSceneHandle,
        result: TileSubsetLayerRenderBuffers
    ): Promise<PreparedGltf | null> {
        const attachmentName = result.glbAttachmentName?.trim() ?? "";
        const device = (sceneHandle.scene as DeckScene | undefined)?.device ?? null;
        if (!attachmentName || !result.gltfNodes.nodeIndices.length || !device) {
            return null;
        }
        if (this.states.length !== 1) {
            throw new Error(
                `GLB-backed subset block '${this.blockKey}' must remain a singleton.`
            );
        }
        const state = this.primaryState;
        const attachmentRef = this.owner.retainAttachment(state, attachmentName);
        const tilePosition = coreLib.getTilePosition(state.tileId);
        const source: DeckTileGltfAttachmentSource = {
            cacheKey: `${state.mapTileKey}:${attachmentName}`,
            attachmentName,
            tilePosition: [
                Number(tilePosition.x),
                Number(tilePosition.y),
                Number(tilePosition.z)
            ],
            readBytes: async () => (await attachmentRef.ready)?.bytes ?? null
        };
        let asset: DeckTileGltfAsset | null = null;
        try {
            asset = await retainDeckTileGltfAsset(source, device);
        } catch (error) {
            console.warn(
                `Could not realize GLB attachment '${attachmentName}' for '${state.mapTileKey}'.`,
                error
            );
        }
        if (!asset) {
            releaseDeckTileGltfAsset(source, device);
            this.owner.releaseAttachment(state.tileId);
            return null;
        }
        return {source, asset, device};
    }

    private applyGltf(
        registry: DeckLayerRegistry,
        result: TileSubsetLayerRenderBuffers,
        origin: [number, number, number],
        modelMatrix: Matrix4 | null,
        pickResolver: PickResolver,
        interaction: DeckInteractionProps,
        prepared: PreparedGltf | null
    ): InteractionGltfSource | null {
        const sourceId = this.owner.ownerId;
        const state = this.primaryState;
        const gltfKey = `${state.mapTileKey}/gltf`;
        const pickKey = deckSubsetGltfPickProxyKey(state.mapTileKey, this.owner.ownerId);
        const raw = result.gltfNodes;
        let interactionData: DeckGltfNodeStyleContribution["data"] | null = null;
        const flatTint = this.owner.highlightMode.value !==
            coreLib.HighlightMode.NO_HIGHLIGHT.value;
        const priority = this.owner.highlightMode.value ===
            coreLib.HighlightMode.SELECTION_HIGHLIGHT.value
            ? 3
            : this.owner.highlightMode.value ===
                coreLib.HighlightMode.HOVER_HIGHLIGHT.value
                ? 2
                : 0;

        if (prepared && raw.nodeIndices.length &&
            raw.colors.length >= raw.nodeIndices.length * 4 &&
            raw.featureAddresses.length >= raw.nodeIndices.length) {
            const data: DeckGltfNodeStyleContribution["data"] = [];
            for (let index = 0; index < raw.nodeIndices.length; ++index) {
                const colorOffset = index * 4;
                data.push({
                    nodeIndex: raw.nodeIndices[index],
                    featureAddress: raw.featureAddresses[index],
                    color: [
                        raw.colors[colorOffset],
                        raw.colors[colorOffset + 1],
                        raw.colors[colorOffset + 2],
                        raw.colors[colorOffset + 3]
                    ],
                    depthTest: flatTint
                        ? false
                        : !raw.depthTests?.length || raw.depthTests[index] !== 0,
                    flatTint,
                    renderPriority: priority
                });
            }
            interactionData = data;
            const contribution: SharedGltfContribution = {
                asset: prepared.asset,
                order: 375 + this.owner.styleOrder,
                priority,
                styleOrder: this.owner.styleOrder,
                data
            };
            this.upsertSharedGltf(
                registry,
                gltfKey,
                sourceId,
                contribution,
                modelMatrix);
            this.gltfSharedSourceActive = true;
        } else if (this.gltfSharedSourceActive) {
            registry.removeShared(gltfKey, sourceId);
            this.gltfSharedSourceActive = false;
        }

        const proxyData = !flatTint
            ? this.gltfPickProxyData(result)
            : [];
        if (proxyData.length) {
            const contribution: SharedGltfPickContribution = {
                order: 374 + this.owner.styleOrder,
                coordinateOrigin: origin,
                data: proxyData,
                pickResolver
            };
            registry.upsertShared(
                pickKey,
                sourceId,
                contribution,
                (key, rawContributions) => {
                    const contributions = [...rawContributions.entries()].map(
                        ([id, value]) => ({
                            sourceId: id,
                            contribution: value as SharedGltfPickContribution
                        })
                    );
                    if (!contributions.length) {
                        return {layer: null, order: 0};
                    }
                    const first = contributions[0].contribution;
                    const remapped = remapGltfPickContributions(
                        contributions.map(item => ({
                            sourceId: item.sourceId,
                            data: item.contribution.data,
                            pickResolver: item.contribution.pickResolver
                        }))
                    );
                    return {
                        order: Math.max(...contributions.map(
                            item => item.contribution.order
                        )),
                        layer: new DeckGltfPickProxyLayer({
                            id: key,
                            contributions: remapped.contributions,
                            coordinateOrigin: first.coordinateOrigin,
                            pickable: interaction.pickable,
                            navigationAnchorEligible:
                                interaction.drillPickEligible,
                            markerAnchorEligible:
                                interaction.drillPickEligible,
                            drillPickEligible:
                                interaction.drillPickEligible,
                            tileKey: state.mapTileKey,
                            subsetPickResolver: remapped.pickResolver
                        })
                    };
                }
            );
            this.gltfPickSharedSourceActive = true;
        } else if (this.gltfPickSharedSourceActive) {
            registry.removeShared(pickKey, sourceId);
            this.gltfPickSharedSourceActive = false;
        }

        this.releaseGltfAsset();
        if (prepared) {
            this.activeGltfSource = prepared.source;
            this.activeGltfAsset = prepared.asset;
            this.activeGltfDevice = prepared.device;
        } else {
            this.owner.releaseAttachment(state.tileId);
        }
        return prepared && interactionData
            ? {
                key: gltfKey,
                asset: prepared.asset,
                data: interactionData
            }
            : null;
    }

    private upsertSharedGltf(
        registry: DeckLayerRegistry,
        key: string,
        sourceId: string,
        contribution: SharedGltfContribution,
        modelMatrix: Matrix4 | null
    ): void {
        registry.upsertShared(
            key,
            sourceId,
            contribution,
            (sharedKey, rawContributions) => {
                const contributions = [...rawContributions.entries()].map(
                    ([id, value]) => ({
                        sourceId: id,
                        contribution: value as SharedGltfContribution
                    })
                );
                if (!contributions.length) {
                    return {layer: null, order: 0};
                }
                const first = contributions[0].contribution;
                const maxPriority = Math.max(...contributions.map(
                    item => item.contribution.priority
                ));
                const order = Math.max(...contributions.map(
                    item => item.contribution.order
                )) + (maxPriority >= 2 ? 1000 : 0);
                return {
                    order,
                    layer: new DeckGltfNodeLayer({
                        id: sharedKey,
                        contributions: contributions.map(item => ({
                            sourceId: item.sourceId,
                            priority: item.contribution.priority,
                            styleOrder: item.contribution.styleOrder,
                            data: item.contribution.data
                        })),
                        asset: first.asset,
                        pickable: false,
                        modelMatrix
                    })
                };
            });
    }

    private gltfPickProxyData(
        result: TileSubsetLayerRenderBuffers
    ): DeckGltfPickProxyDatum[] {
        const raw = result.gltfPickProxies;
        if (raw.startIndices.length < 2 || raw.startIndices[0] !== 0) {
            return [];
        }
        const count = raw.startIndices.length - 1;
        const vertexCount = raw.startIndices[count];
        if (vertexCount < 3 ||
            vertexCount > MAX_TILE_SUBSET_RENDER_VERTICES ||
            raw.positions.length < vertexCount * 3 ||
            raw.nodeIndices.length < count ||
            raw.featureAddresses.length < count) {
            return [];
        }
        const resultData: DeckGltfPickProxyDatum[] = [];
        for (let index = 0; index < count; ++index) {
            const start = raw.startIndices[index];
            const end = raw.startIndices[index + 1];
            const featureAddress = raw.featureAddresses[index];
            if (end - start < 3 || end > vertexCount ||
                featureAddress === UNSELECTABLE) {
                continue;
            }
            resultData.push({
                nodeIndex: raw.nodeIndices[index],
                featureAddress,
                positions: raw.positions.slice(start * 3, end * 3)
            });
        }
        return resultData;
    }

    private removeSharedGltfContributions(
        registry: DeckLayerRegistry | null
    ): void {
        if (!registry) {
            this.gltfSharedSourceActive = false;
            this.gltfPickSharedSourceActive = false;
            return;
        }
        if (this.gltfSharedSourceActive) {
            registry.removeShared(
                `${this.primaryState.mapTileKey}/gltf`,
                this.owner.ownerId
            );
            this.gltfSharedSourceActive = false;
        }
        if (this.gltfPickSharedSourceActive) {
            registry.removeShared(
                deckSubsetGltfPickProxyKey(this.primaryState.mapTileKey, this.owner.ownerId),
                this.owner.ownerId
            );
            this.gltfPickSharedSourceActive = false;
        }
    }

    private releaseGltfAsset(): void {
        if (this.activeGltfSource && this.activeGltfDevice) {
            releaseDeckTileGltfAsset(
                this.activeGltfSource,
                this.activeGltfDevice
            );
        }
        this.activeGltfSource = null;
        this.activeGltfAsset = null;
        this.activeGltfDevice = null;
    }

    private resolvePick(pickIndex: number): TileFeatureId[] {
        if (!Number.isInteger(pickIndex) ||
            pickIndex < 0 ||
            pickIndex === UNSELECTABLE) {
            return [];
        }
        const result = this.pickResults[pickIndex];
        if (!result?.featureId) {
            return [];
        }
        const state = this.states[result.subsetOrdinal];
        if (!state) {
            return [];
        }
        if (result.memberFeatureIds?.length) {
            return [...new Set(result.memberFeatureIds)].map(featureId => ({
                mapTileKey: state.mapTileKey,
                featureId
            }));
        }
        let featureId = result.featureId;
        const attributeIndex = result.attributeIndex;
        const validityIndex = result.validityIndex;
        const relationIndex = result.relationIndex;
        if (typeof attributeIndex === "number" &&
            Number.isInteger(attributeIndex)) {
            featureId = formatFeatureInspectionTarget({
                scope: "attribute",
                baseFeatureId: result.featureId,
                attributeIndex,
                ...(result.hasValidity &&
                    typeof validityIndex === "number" &&
                    Number.isInteger(validityIndex)
                    ? {validityIndex}
                    : {})
            });
        } else if (result.relationSourceFeatureId &&
                   typeof relationIndex === "number" &&
                   Number.isInteger(relationIndex)) {
            featureId = formatFeatureInspectionTarget({
                scope: "relation",
                baseFeatureId: result.relationSourceFeatureId,
                relationIndex
            });
        }
        return [{mapTileKey: state.mapTileKey, featureId}];
    }

    /** Installs persistent style-owned glows through the shared vector mask compositor. */
    private refreshStyleGlows(sceneHandle: IRenderSceneHandle): void {
        const source = this.interactionSource;
        const service = this.outlineService(sceneHandle);
        if (!source || !service || this.disposed) {
            this.reconcileStyleGlowOutlines(service, new Set());
            return;
        }
        const desired = new Set<string>();
        const noPick: PickResolver = () => [];
        const maskInteraction: DeckInteractionProps = {
            pickable: true,
            drillPickEligible: false
        };
        const order = 300 + this.owner.styleOrder;
        const register = (
            kind: "path" | "arrow" | "point" | "surface",
            bucketIndex: number,
            material: DeckGlowMaterial,
            indices: ReadonlySet<number>,
            data: DeckPathData | DeckPointData | DeckSurfaceData
        ): void => {
            const effect = this.glowEffect(material);
            const groupId = this.styleGlowGroupId(material);
            const sourceId = [
                this.visualizationId,
                kind,
                bucketIndex,
                material.key
            ].join("/");
            const token = `${groupId}\n${sourceId}`;
            // A literal style glow is one union silhouette, not an
            // interaction boundary between individual features. Reusing one
            // identity removes dark seams where glowing paths overlap.
            const identity = (_address: number) =>
                service.identityColor(
                    groupId,
                    "style-glow-union",
                    effect,
                    order);
            let mask: DeckPathData | DeckPointData | DeckSurfaceData |
                DeckArrowMarker[] | null;
            if (kind === "arrow") {
                mask = compileTileSubsetArrowMarkers(
                    data as DeckPathData,
                    index => indices.has(index));
            } else if (kind === "path") {
                mask = this.interactionPathMaskData(
                    data as DeckPathData,
                    null,
                    identity,
                    index => indices.has(index),
                    true);
            } else if (kind === "point") {
                mask = this.interactionPointMaskData(
                    data as DeckPointData,
                    null,
                    identity,
                    index => indices.has(index),
                    true);
            } else {
                mask = this.interactionSurfaceMaskData(
                    data as DeckSurfaceData,
                    null,
                    identity,
                    index => indices.has(index),
                    true);
            }
            if (!mask) {
                return;
            }
            service.upsertMask(
                groupId,
                sourceId,
                effect,
                order,
                source.origin,
                layerId => kind === "path"
                    ? createTileSubsetPathLayer(
                        layerId,
                        mask as DeckPathData,
                        noPick,
                        source.modelMatrix,
                        maskInteraction)
                    : kind === "arrow"
                        ? createTileSubsetArrowLayer(
                            layerId,
                            data as DeckPathData,
                            mask as DeckArrowMarker[],
                            noPick,
                            source.modelMatrix,
                            maskInteraction,
                            {
                                parameters: MASK_NO_DEPTH_PARAMETERS,
                                getColor: () => [255, 255, 255, 255]
                            })
                    : kind === "point"
                        ? createTileSubsetPointLayer(
                            layerId,
                            mask as DeckPointData,
                            noPick,
                            source.modelMatrix,
                            maskInteraction)
                        : createTileSubsetSurfaceLayer(
                            layerId,
                            mask as DeckSurfaceData,
                            noPick,
                            source.modelMatrix,
                            maskInteraction,
                            MASK_NO_DEPTH_PARAMETERS));
            this.styleGlowOutlineSources.set(token, {groupId, sourceId});
            desired.add(token);
        };

        source.paths.forEach((data, bucketIndex) => {
            for (const {material, indices} of this.glowGroups(
                data.glowColors,
                data.glowRadii,
                data.length)) {
                register("path", bucketIndex, material, indices, data);
            }
        });
        source.arrows.forEach((data, bucketIndex) => {
            for (const {material, indices} of this.glowGroups(
                data.glowColors,
                data.glowRadii,
                data.length)) {
                register("arrow", bucketIndex, material, indices, data);
            }
        });
        source.points.forEach((data, bucketIndex) => {
            for (const {material, indices} of this.glowGroups(
                data.glowColors,
                data.glowRadii,
                data.length)) {
                register("point", bucketIndex, material, indices, data);
            }
        });
        source.surfaces.forEach((data, bucketIndex) => {
            for (const {material, indices} of this.glowGroups(
                data.glowColors,
                data.glowRadii,
                data.length)) {
                register("surface", bucketIndex, material, indices, data);
            }
        });
        this.reconcileStyleGlowOutlines(service, desired);
    }

    private glowGroups(
        colors: Uint8Array | undefined,
        radii: Float32Array | undefined,
        count: number
    ): Array<{material: DeckGlowMaterial; indices: Set<number>}> {
        if (!colors || !radii || colors.length < count * 4 ||
            radii.length < count) {
            return [];
        }
        const groups = new Map<
            string,
            {material: DeckGlowMaterial; indices: Set<number>}
        >();
        for (let index = 0; index < count; ++index) {
            const color = Array.from(colors.subarray(
                index * 4,
                index * 4 + 4)) as DeckRgba;
            const radius = Number(radii[index]);
            if (color[3] <= 0 || !Number.isFinite(radius) || radius <= 0) {
                continue;
            }
            const key = `${color.join(",")}:${radius.toPrecision(7)}`;
            const group = groups.get(key) ?? {
                material: {key, color, radius},
                indices: new Set<number>()
            };
            group.indices.add(index);
            groups.set(key, group);
        }
        return [...groups.values()];
    }

    private glowEffect(material: DeckGlowMaterial): DeckInteractionEffect {
        return {
            tintMix: 0,
            opacity: 1,
            edgeWidth: 0,
            haloColor: material.color,
            haloRadius: material.radius,
            haloOpacity: 1,
            // Style glow is always behind/outside authored geometry. The
            // interior semantic-halo branch exists only for nested selected
            // interaction objects and would otherwise muddy thin path fills.
            interiorHalo: false,
            stripeSpacing: 0,
            stripeWidth: 0,
            stripeOpacity: 0,
            stripeAngle: 45,
            stripeOffset: 0,
            stripeSoftness: 1
        };
    }

    private styleGlowGroupId(material: DeckGlowMaterial): string {
        return [
            this.owner.ownerId,
            `view-${this.viewIndex}`,
            "style-glow",
            encodeURIComponent(material.key)
        ].join("/");
    }

    private reconcileStyleGlowOutlines(
        service: DeckInteractionOutlineService | null,
        desired: ReadonlySet<string>
    ): void {
        if (!service) {
            this.styleGlowOutlineSources.clear();
            return;
        }
        for (const [token, source] of this.styleGlowOutlineSources) {
            if (!desired.has(token)) {
                service.removeMask(source.groupId, source.sourceId);
                this.styleGlowOutlineSources.delete(token);
            }
        }
    }

    /** Rebuilds only the tiny interaction layers whose exact pick rows are active. */
    private refreshInteractionOverlays(): void {
        const sceneHandle = this.sceneHandle;
        const source = this.interactionSource;
        if (!sceneHandle || this.disposed) {
            return;
        }
        const registry = this.registry(sceneHandle);
        if (!registry) {
            return;
        }
        if (!source) {
            for (const key of this.interactionLayerKeys) {
                registry.remove(key);
            }
            this.interactionLayerKeys.clear();
            this.reconcileInteractionGltf(registry, new Set());
            this.reconcileInteractionOutlines(
                this.outlineService(sceneHandle),
                new Set());
            return;
        }
        const desired = new Set<string>();
        const desiredGltf = new Set<string>();
        const desiredOutlines = new Set<string>();
        const outlineService = this.outlineService(sceneHandle);
        const overlays: Array<{
            id: string;
            targets: Set<string> | null;
            effect: DeckInteractionEffect;
            order: number;
        }> = this.interactionOverlays.map(overlay => ({
            id: overlay.id,
            targets: new Set(overlay.targets.map(target =>
                this.interactionTargetKey(target))),
            effect: overlay.effect,
            order: overlay.order
        }));

        const noInteraction: DeckInteractionProps = {
            pickable: false,
            drillPickEligible: false
        };
        const noPick: PickResolver = () => [];
        for (const overlay of overlays) {
            if (overlay.targets?.size === 0) {
                continue;
            }
            const groupId = outlineService
                ? this.interactionOutlineGroupId(overlay.id)
                : null;
            for (let pathIndex = 0;
                 pathIndex < source.paths.length;
                 ++pathIndex) {
                const path = source.paths[pathIndex];
                if (outlineService && groupId) {
                    const mask = this.interactionPathMaskData(
                        path,
                        overlay.targets,
                        address => outlineService.identityColor(
                            groupId,
                            this.interactionMaskIdentity(address),
                            overlay.effect,
                            overlay.order + 1));
                    if (!mask) {
                        continue;
                    }
                    const sourceId = [
                        this.visualizationId,
                        `path-${pathIndex}`,
                        path.billboard ? "billboard" : "world",
                        path.depthTest ? "depth" : "overlay"
                    ].join("/");
                    const token = `${groupId}\n${sourceId}`;
                    outlineService.upsertMask(
                        groupId,
                        sourceId,
                        overlay.effect,
                        overlay.order + 1,
                        source.origin,
                        layerId => createTileSubsetPathLayer(
                            layerId,
                            mask,
                            noPick,
                            source.modelMatrix,
                            {
                                pickable: true,
                                drillPickEligible: false
                            }));
                    this.interactionOutlineSources.set(token, {
                        groupId,
                        sourceId
                    });
                    desiredOutlines.add(token);
                    continue;
                }
                const main = this.interactionPathData(
                    path,
                    overlay.targets,
                    overlay.effect);
                if (!main) {
                    continue;
                }
                const key = this.interactionKey(
                    overlay.id,
                    `path-${pathIndex}`,
                    path.billboard,
                    path.depthTest);
                registry.upsert(
                    key,
                    createTileSubsetPathLayer(
                        key,
                        {...main, depthTest: false},
                        noPick,
                        source.modelMatrix,
                        noInteraction),
                    overlay.order + 11);
                desired.add(key);
            }

            for (let pointIndex = 0;
                 pointIndex < source.points.length;
                 ++pointIndex) {
                const point = source.points[pointIndex];
                if (outlineService && groupId) {
                    const mask = this.interactionPointMaskData(
                        point,
                        overlay.targets,
                        address => outlineService.identityColor(
                            groupId,
                            this.interactionMaskIdentity(address),
                            overlay.effect,
                            overlay.order + 1));
                    if (!mask) {
                        continue;
                    }
                    const sourceId = [
                        this.visualizationId,
                        `point-${pointIndex}`,
                        point.billboard ? "billboard" : "world",
                        point.depthTest ? "depth" : "overlay"
                    ].join("/");
                    const token = `${groupId}\n${sourceId}`;
                    outlineService.upsertMask(
                        groupId,
                        sourceId,
                        overlay.effect,
                        overlay.order + 1,
                        source.origin,
                        layerId => createTileSubsetPointLayer(
                            layerId,
                            mask,
                            noPick,
                            source.modelMatrix,
                            {
                                pickable: true,
                                drillPickEligible: false
                            }));
                    this.interactionOutlineSources.set(token, {
                        groupId,
                        sourceId
                    });
                    desiredOutlines.add(token);
                    continue;
                }
                const main = this.interactionPointData(
                    point,
                    overlay.targets,
                    overlay.effect);
                if (!main) {
                    continue;
                }
                const key = this.interactionKey(
                    overlay.id,
                    "point",
                    point.billboard,
                    point.depthTest);
                registry.upsert(
                    key,
                    createTileSubsetPointLayer(
                        key,
                        {...main, depthTest: false},
                        noPick,
                        source.modelMatrix,
                        noInteraction),
                    overlay.order + 21);
                desired.add(key);
            }

            if (outlineService) {
                if (!groupId) {
                    continue;
                }
                for (let surfaceIndex = 0;
                     surfaceIndex < source.surfaces.length;
                     ++surfaceIndex) {
                    const surface = source.surfaces[surfaceIndex];
                    const mask = this.interactionSurfaceMaskData(
                        surface,
                        overlay.targets,
                        address => outlineService.identityColor(
                            groupId,
                            this.interactionMaskIdentity(address),
                            overlay.effect,
                            overlay.order + 1));
                    if (!mask) {
                        continue;
                    }
                    const sourceId = [
                        this.visualizationId,
                        `surface-${surfaceIndex}`,
                        surface.depthTest ? "depth" : "overlay"
                    ].join("/");
                    const token = `${groupId}\n${sourceId}`;
                    outlineService.upsertMask(
                        groupId,
                        sourceId,
                        overlay.effect,
                        overlay.order + 1,
                        source.origin,
                        layerId => createTileSubsetSurfaceLayer(
                            layerId,
                            mask,
                            noPick,
                            source.modelMatrix,
                            {
                                pickable: true,
                                drillPickEligible: false
                            },
                            MASK_NO_DEPTH_PARAMETERS));
                    this.interactionOutlineSources.set(token, {
                        groupId,
                        sourceId
                    });
                    desiredOutlines.add(token);
                }
            }

            // Arrowheads and labels are semantic decorations of the retained
            // path/feature, not independent highlight geometry. Re-emitting
            // them here makes the base and interaction copies compete and,
            // for pixel-offset arrows, physically separates them when the
            // effect adds width. Keep their authored appearance and highlight
            // the owning path/point/surface instead.

            if (source.gltf) {
                const data = source.gltf.data
                    .filter(datum => this.matchesInteractionAddress(
                        datum.featureAddress,
                        overlay.targets))
                    .map(datum => ({
                        ...datum,
                        color: [
                            ...(overlay.effect.tint ?? datum.color).slice(0, 3),
                            Math.round(
                                datum.color[3] * overlay.effect.opacity *
                                (overlay.effect.tint?.[3] ?? 255) / 255)
                        ] as [number, number, number, number],
                        tintMix: overlay.effect.tint
                            ? overlay.effect.tintMix
                            : 0,
                        depthTest: false,
                        flatTint: true,
                        renderPriority: overlay.order
                    }));
                if (data.length) {
                    const sourceId = [
                        this.owner.ownerId,
                        "interaction",
                        overlay.id
                    ].join("/");
                    const token = `${source.gltf.key}\n${sourceId}`;
                    this.upsertSharedGltf(
                        registry,
                        source.gltf.key,
                        sourceId,
                        {
                            asset: source.gltf.asset,
                            order: overlay.order,
                            priority: overlay.order,
                            styleOrder: overlay.order,
                            data
                        },
                        source.modelMatrix);
                    this.interactionGltfSources.set(token, {
                        key: source.gltf.key,
                        sourceId
                    });
                    desiredGltf.add(token);
                }
            }
        }

        for (const key of this.interactionLayerKeys) {
            if (!desired.has(key)) {
                registry.remove(key);
            }
        }
        this.interactionLayerKeys.clear();
        for (const key of desired) {
            this.interactionLayerKeys.add(key);
        }
        this.reconcileInteractionGltf(registry, desiredGltf);
        this.reconcileInteractionOutlines(outlineService, desiredOutlines);
    }

    private reconcileInteractionGltf(
        registry: DeckLayerRegistry,
        desired: ReadonlySet<string>
    ): void {
        for (const [token, source] of this.interactionGltfSources) {
            if (!desired.has(token)) {
                registry.removeShared(source.key, source.sourceId);
                this.interactionGltfSources.delete(token);
            }
        }
    }

    private reconcileInteractionOutlines(
        service: DeckInteractionOutlineService | null,
        desired: ReadonlySet<string>
    ): void {
        if (!service) {
            this.interactionOutlineSources.clear();
            return;
        }
        for (const [token, source] of this.interactionOutlineSources) {
            if (!desired.has(token)) {
                service.removeMask(source.groupId, source.sourceId);
                this.interactionOutlineSources.delete(token);
            }
        }
    }

    private interactionPathData(
        source: DeckPathData,
        targets: ReadonlySet<string> | null,
        effect: DeckInteractionEffect
    ): DeckPathData | null {
        const positions: number[] = [];
        const colors: number[] = [];
        const widths: number[] = [];
        const offsets: number[] = [];
        const offsetVectors: number[] = [];
        const offsetScaleThresholds: number[] = [];
        const dashes: number[] = [];
        const starts = [0];
        const addresses: number[] = [];
        const sourceDashes = source.attributes.instanceDashArrays?.value;
        for (let pathIndex = 0; pathIndex < source.length; ++pathIndex) {
            const address = source.featureAddressesByPath[pathIndex];
            if (!this.matchesInteractionAddress(address, targets)) {
                continue;
            }
            const start = source.startIndices[pathIndex];
            const end = source.startIndices[pathIndex + 1];
            for (let vertex = start; vertex < end; ++vertex) {
                positions.push(...source.attributes.getPath.value.subarray(
                    vertex * 3,
                    vertex * 3 + 3));
                colors.push(...interactionColor(
                    source.attributes.instanceColors.value,
                    vertex * 4,
                    effect));
                const sourceWidth =
                    source.attributes.instanceStrokeWidths.value[vertex];
                const targetWidth = sourceWidth + effect.edgeWidth;
                widths.push(targetWidth);
                // The GPU path offset is a line-width factor. Preserve the
                // authored absolute pixel displacement when an interaction
                // effect changes the line width.
                offsets.push(targetWidth > 0
                    ? source.attributes.instanceOffsets.value[vertex] *
                        sourceWidth / targetWidth
                    : 0);
                if (source.offsetVectorsPx) {
                    offsetVectors.push(
                        source.offsetVectorsPx[vertex * 2],
                        source.offsetVectorsPx[vertex * 2 + 1]);
                }
                if (sourceDashes) {
                    dashes.push(...sourceDashes.subarray(
                        vertex * 2,
                        vertex * 2 + 2));
                }
            }
            addresses.push(address);
            offsetScaleThresholds.push(
                source.offsetScaleThresholds?.[pathIndex] ?? 0);
            starts.push(positions.length / 3);
        }
        if (!addresses.length) {
            return null;
        }
        const startIndices = new Uint32Array(starts);
        const offsetValues = new Float32Array(offsets);
        const variableOffset = Boolean(
            source.attributes.instanceVariableOffsets &&
            source.offsetVectorsPx);
        const offsetVectorValues = variableOffset
            ? new Float32Array(offsetVectors)
            : undefined;
        return {
            length: addresses.length,
            billboard: source.billboard,
            depthTest: false,
            coordinateOrigin: source.coordinateOrigin,
            startIndices,
            featureAddressesByPath: new Uint32Array(addresses),
            offsetVectorsPx: offsetVectorValues,
            offsetScaleThresholds: variableOffset
                ? new Float32Array(offsetScaleThresholds)
                : undefined,
            attributes: {
                getPath: {value: new Float32Array(positions), size: 3},
                instanceColors: {value: new Uint8Array(colors), size: 4},
                instanceStrokeWidths: {
                    value: new Float32Array(widths),
                    size: 1
                },
                instanceOffsets: {
                    value: offsetValues,
                    size: 1
                },
                ...(offsetVectorValues
                    ? {instanceVariableOffsets: {
                            value: packVariablePathOffsetVectors(
                                offsetVectorValues,
                                startIndices,
                                offsetScaleThresholds),
                            size: 4
                    }}
                    : {}),
                ...(sourceDashes
                    ? {instanceDashArrays: {
                        value: new Float32Array(dashes),
                        size: 2
                    }}
                    : {})
            }
        };
    }

    private interactionPointData(
        source: DeckPointData,
        targets: ReadonlySet<string> | null,
        effect: DeckInteractionEffect
    ): DeckPointData | null {
        const positions: number[] = [];
        const colors: number[] = [];
        const radii: number[] = [];
        const addresses: number[] = [];
        for (let index = 0; index < source.length; ++index) {
            const address = source.featureAddresses[index];
            if (!this.matchesInteractionAddress(address, targets)) {
                continue;
            }
            positions.push(...source.attributes.getPosition.value.subarray(
                index * 3,
                index * 3 + 3));
            colors.push(...interactionColor(
                source.attributes.getFillColor.value,
                index * 4,
                effect));
            radii.push(
                source.attributes.getRadius.value[index] +
                effect.edgeWidth * 0.5);
            addresses.push(address);
        }
        return addresses.length ? {
            length: addresses.length,
            billboard: source.billboard,
            depthTest: false,
            coordinateOrigin: source.coordinateOrigin,
            featureAddresses: new Uint32Array(addresses),
            attributes: {
                getPosition: {value: new Float32Array(positions), size: 3},
                getFillColor: {value: new Uint8Array(colors), size: 4},
                getRadius: {value: new Float32Array(radii), size: 1}
            }
        } : null;
    }

    /** Copies selected authored paths into the common object-identity mask input. */
    private interactionPathMaskData(
        source: DeckPathData,
        targets: ReadonlySet<string> | null,
        identityColor: (
            address: number
        ) => [number, number, number, number],
        includeIndex: ((index: number) => boolean) | null = null,
        allowUnselectable = false
    ): DeckPathData | null {
        const positions: number[] = [];
        const colors: number[] = [];
        const widths: number[] = [];
        const offsets: number[] = [];
        const offsetVectors: number[] = [];
        const offsetScaleThresholds: number[] = [];
        const dashes: number[] = [];
        const pickingColors: number[] = [];
        const starts = [0];
        const addresses: number[] = [];
        const sourceDashes = source.attributes.instanceDashArrays?.value;
        for (let pathIndex = 0; pathIndex < source.length; ++pathIndex) {
            const address = source.featureAddressesByPath[pathIndex];
            if ((!allowUnselectable &&
                 !this.matchesInteractionAddress(address, targets)) ||
                (includeIndex && !includeIndex(pathIndex))) {
                continue;
            }
            const objectColor = identityColor(address);
            const start = source.startIndices[pathIndex];
            const end = source.startIndices[pathIndex + 1];
            for (let vertex = start; vertex < end; ++vertex) {
                positions.push(...source.attributes.getPath.value.subarray(
                    vertex * 3,
                    vertex * 3 + 3));
                colors.push(...source.attributes.instanceColors.value.subarray(
                    vertex * 4,
                    vertex * 4 + 4));
                widths.push(
                    source.attributes.instanceStrokeWidths.value[vertex]);
                offsets.push(source.attributes.instanceOffsets.value[vertex]);
                if (source.offsetVectorsPx) {
                    offsetVectors.push(
                        source.offsetVectorsPx[vertex * 2],
                        source.offsetVectorsPx[vertex * 2 + 1]);
                }
                pickingColors.push(
                    objectColor[0], objectColor[1], objectColor[2]);
                if (sourceDashes) {
                    dashes.push(...sourceDashes.subarray(
                        vertex * 2,
                        vertex * 2 + 2));
                }
            }
            addresses.push(address);
            offsetScaleThresholds.push(
                source.offsetScaleThresholds?.[pathIndex] ?? 0);
            starts.push(positions.length / 3);
        }
        if (!addresses.length) {
            return null;
        }
        const startIndices = new Uint32Array(starts);
        const offsetValues = new Float32Array(offsets);
        const variableOffset = Boolean(
            source.attributes.instanceVariableOffsets &&
            source.offsetVectorsPx);
        const offsetVectorValues = variableOffset
            ? new Float32Array(offsetVectors)
            : undefined;
        return {
            length: addresses.length,
            billboard: source.billboard,
            depthTest: false,
            coordinateOrigin: source.coordinateOrigin,
            startIndices,
            featureAddressesByPath: new Uint32Array(addresses),
            offsetVectorsPx: offsetVectorValues,
            offsetScaleThresholds: variableOffset
                ? new Float32Array(offsetScaleThresholds)
                : undefined,
            attributes: {
                getPath: {value: new Float32Array(positions), size: 3},
                instanceColors: {value: new Uint8Array(colors), size: 4},
                instanceStrokeWidths: {
                    value: new Float32Array(widths),
                    size: 1
                },
                instanceOffsets: {
                    value: offsetValues,
                    size: 1
                },
                ...(offsetVectorValues
                    ? {instanceVariableOffsets: {
                            value: packVariablePathOffsetVectors(
                                offsetVectorValues,
                                startIndices,
                                offsetScaleThresholds),
                            size: 4
                    }}
                    : {}),
                instancePickingColors: {
                    value: new Uint8Array(pickingColors),
                    size: 3
                },
                ...(sourceDashes
                    ? {instanceDashArrays: {
                        value: new Float32Array(dashes),
                        size: 2
                    }}
                    : {})
            }
        };
    }

    /** Copies selected authored points into the same morphology mask as paths/surfaces. */
    private interactionPointMaskData(
        source: DeckPointData,
        targets: ReadonlySet<string> | null,
        identityColor: (
            address: number
        ) => [number, number, number, number],
        includeIndex: ((index: number) => boolean) | null = null,
        allowUnselectable = false
    ): DeckPointData | null {
        const positions: number[] = [];
        const colors: number[] = [];
        const radii: number[] = [];
        const pickingColors: number[] = [];
        const addresses: number[] = [];
        for (let index = 0; index < source.length; ++index) {
            const address = source.featureAddresses[index];
            if ((!allowUnselectable &&
                 !this.matchesInteractionAddress(address, targets)) ||
                (includeIndex && !includeIndex(index))) {
                continue;
            }
            positions.push(...source.attributes.getPosition.value.subarray(
                index * 3,
                index * 3 + 3));
            colors.push(...source.attributes.getFillColor.value.subarray(
                index * 4,
                index * 4 + 4));
            radii.push(source.attributes.getRadius.value[index]);
            const objectColor = identityColor(address);
            pickingColors.push(
                objectColor[0], objectColor[1], objectColor[2]);
            addresses.push(address);
        }
        return addresses.length ? {
            length: addresses.length,
            billboard: source.billboard,
            depthTest: false,
            coordinateOrigin: source.coordinateOrigin,
            featureAddresses: new Uint32Array(addresses),
            attributes: {
                getPosition: {value: new Float32Array(positions), size: 3},
                getFillColor: {value: new Uint8Array(colors), size: 4},
                getRadius: {value: new Float32Array(radii), size: 1},
                instancePickingColors: {
                    value: new Uint8Array(pickingColors),
                    size: 3
                }
            }
        } : null;
    }

    /**
     * Copies only selected triangles into the hidden GPU interaction-mask input.
     * Every vertex belonging to the same semantic feature receives the same
     * service-owned identity, so triangle and render-block seams disappear in
     * the subsequent screen-space boundary comparison.
     */
    private interactionSurfaceMaskData(
        source: DeckSurfaceData,
        targets: ReadonlySet<string> | null,
        identityColor: (
            address: number
        ) => [number, number, number, number],
        includeIndex: ((index: number) => boolean) | null = null,
        allowUnselectable = false
    ): DeckSurfaceData | null {
        const sourcePositions = source.attributes.getPolygon.value;
        const sourceColors = source.attributes.fillColors.value;
        const sourceIndices = source.attributes.indices.value;
        const positions: number[] = [];
        const colors: number[] = [];
        const pickingColors: number[] = [];
        const indices: number[] = [];
        const starts = [0];
        const addresses: number[] = [];
        const normals: number[] = [];
        let triangleOffset = 0;
        for (let surfaceIndex = 0;
             surfaceIndex < source.length;
             ++surfaceIndex) {
            const start = source.startIndices[surfaceIndex];
            const end = source.startIndices[surfaceIndex + 1];
            const address = source.featureAddresses[surfaceIndex];
            const selected = (allowUnselectable ||
                this.matchesInteractionAddress(address, targets)) &&
                (!includeIndex || includeIndex(surfaceIndex));
            const surfaceIndices: number[] = [];
            while (triangleOffset + 2 < sourceIndices.length &&
                   sourceIndices[triangleOffset] < end) {
                const first = sourceIndices[triangleOffset++];
                const second = sourceIndices[triangleOffset++];
                const third = sourceIndices[triangleOffset++];
                if (selected &&
                    first >= start && first < end &&
                    second >= start && second < end &&
                    third >= start && third < end) {
                    surfaceIndices.push(
                        first - start,
                        second - start,
                        third - start);
                }
            }
            if (!selected || surfaceIndices.length === 0) {
                continue;
            }
            const vertexBase = positions.length / 3;
            positions.push(...sourcePositions.subarray(start * 3, end * 3));
            colors.push(...sourceColors.subarray(start * 4, end * 4));
            const objectColor = identityColor(address);
            for (let vertex = start; vertex < end; ++vertex) {
                pickingColors.push(...objectColor);
            }
            indices.push(...surfaceIndices.map(index => vertexBase + index));
            addresses.push(address);
            normals.push(...source.surfaceNormals.subarray(
                surfaceIndex * 3,
                surfaceIndex * 3 + 3));
            starts.push(positions.length / 3);
        }
        return addresses.length ? {
            length: addresses.length,
            depthTest: false,
            coordinateOrigin: source.coordinateOrigin,
            startIndices: new Uint32Array(starts),
            featureAddresses: new Uint32Array(addresses),
            surfaceNormals: new Float32Array(normals),
            attributes: {
                getPolygon: {value: new Float32Array(positions), size: 3},
                indices: {value: new Uint32Array(indices), size: 1},
                fillColors: {value: new Uint8Array(colors), size: 4},
                pickingColors: {
                    value: new Uint8Array(pickingColors),
                    size: 4
                }
            }
        } : null;
    }

    private interactionFeatureAddresses(): number[] {
        const source = this.interactionSource;
        if (!source) {
            return [];
        }
        const result = new Set<number>();
        for (const data of source.paths) {
            data.featureAddressesByPath.forEach(value => result.add(value));
        }
        for (const data of source.arrows) {
            data.featureAddressesByPath.forEach(value => result.add(value));
        }
        for (const data of source.points) {
            data.featureAddresses.forEach(value => result.add(value));
        }
        for (const data of source.surfaces) {
            data.featureAddresses.forEach(value => result.add(value));
        }
        for (const label of source.labels) {
            result.add(label.featureAddress);
        }
        for (const datum of source.gltf?.data ?? []) {
            result.add(datum.featureAddress);
        }
        result.delete(UNSELECTABLE);
        return [...result];
    }

    private rebuildInteractionTargetIndex(): void {
        this.interactionTargetKeys.clear();
        this.interactionScopesByTarget.clear();
        for (const address of this.interactionFeatureAddresses()) {
            const scope = this.interactionScope(address);
            for (const target of this.resolvePick(address)) {
                const key = this.interactionTargetKey(target);
                this.interactionTargetKeys.add(key);
                let scopes = this.interactionScopesByTarget.get(key);
                if (!scopes) {
                    scopes = new Set();
                    this.interactionScopesByTarget.set(key, scopes);
                }
                scopes.add(scope);
            }
        }
    }

    private interactionScope(
        address: number
    ): "feature" | "attribute" | "relation" | "group" {
        const result = this.pickResults[address];
        if (result?.memberFeatureIds?.length) {
            return "group";
        }
        if (Number.isInteger(result?.attributeIndex)) {
            return "attribute";
        }
        if (result?.relationSourceFeatureId &&
            Number.isInteger(result.relationIndex)) {
            return "relation";
        }
        return "feature";
    }

    private matchesInteractionAddress(
        address: number,
        targets: ReadonlySet<string> | null
    ): boolean {
        return address !== UNSELECTABLE && (
            targets === null || this.resolvePick(address).some(feature =>
                targets.has(this.interactionTargetKey(feature)))
        );
    }

    private interactionTargetKey(target: TileFeatureId): string {
        return `${target.mapTileKey}\n${target.featureId}`;
    }

    private interactionMaskIdentity(address: number): string {
        const targets = this.resolvePick(address)
            .map(target => this.interactionTargetKey(target))
            .sort();
        return targets.length
            ? targets.join("\n")
            : `${this.visualizationId}\n${address}`;
    }

    private interactionOutlineGroupId(overlayId: string): string {
        return [
            this.owner.ownerId,
            `view-${this.viewIndex}`,
            "interaction-surface",
            encodeURIComponent(overlayId)
        ].join("/");
    }

    private interactionKey(
        overlayId: string,
        kind: string,
        billboard: boolean,
        depthTest: boolean
    ): string {
        return [
            this.visualizationId,
            "interaction",
            encodeURIComponent(overlayId),
            kind,
            billboard ? "billboard" : "world",
            depthTest ? "source-depth" : "source-overlay"
        ].join("/");
    }

    private key(kind: string, depthTest: boolean, billboard?: boolean): string {
        return makeDeckLayerKey({
            tileKey: this.blockKey,
            styleId: this.owner.ownerId,
            hoverMode: this.owner.identity.presentationKind,
            kind,
            variant: `${billboard ? "billboard" : "world"}-${depthTest ? "depth" : "overlay"}`
        });
    }

    private reconcile(registry: DeckLayerRegistry, desired: Set<string>): void {
        for (const key of this.layerKeys) {
            if (!desired.has(key)) {
                registry.remove(key);
            }
        }
        this.layerKeys.clear();
        for (const key of desired) {
            this.layerKeys.add(key);
        }
    }

    private registry(sceneHandle: IRenderSceneHandle): DeckLayerRegistry | null {
        return (sceneHandle.scene as DeckScene | undefined)?.layerRegistry ?? null;
    }

    private arena(sceneHandle: IRenderSceneHandle): DeckRenderBufferArena | null {
        return (sceneHandle.scene as DeckScene | undefined)?.renderBufferArena ?? null;
    }

    private outlineService(
        sceneHandle: IRenderSceneHandle
    ): DeckInteractionOutlineService | null {
        return (sceneHandle.scene as DeckScene | undefined)
            ?.interactionOutlineService ?? null;
    }

    private coordinateOrigin(raw: Float64Array): [number, number, number] | null {
        return raw.length >= 3 ? [raw[0], raw[1], raw[2]] : null;
    }

    private modelMatrix(sceneHandle: IRenderSceneHandle): Matrix4 | null {
        return (sceneHandle.scene as DeckScene | undefined)?.sceneMode === SceneMode.SCENE2D
            ? FLAT_2D_MODEL_MATRIX
            : null;
    }

    private parameters(depthTest: boolean): any {
        return depthTest ? {} : NO_DEPTH_PARAMETERS;
    }

}
