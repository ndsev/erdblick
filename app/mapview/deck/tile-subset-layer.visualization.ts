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
import type {StyleValidationReportService} from "../../styledata/style-validation-report.service";
import {
    deckSubsetInteractionProps,
    type SubsetPickResolver as PickResolver
} from "./deck-subset-picking";
import {DeckInteractionOutlineService} from
    "./deck-interaction-outline.service";
import {
    TileSubsetVectorPresentation,
    type DeckLabelData
} from "./tile-subset-vector-presentation";
import {TileSubsetGltfPresentation} from "./tile-subset-gltf-presentation";
import {
    TileSubsetInteractionPresentation,
    type TileSubsetInteractionOverlay,
    type TileSubsetInteractionScope
} from "./tile-subset-interaction-presentation";

export type {TileSubsetInteractionOverlay} from
    "./tile-subset-interaction-presentation";

interface DeckScene {
    layerRegistry?: DeckLayerRegistry;
    renderBufferArena?: DeckRenderBufferArena;
    interactionOutlineService?: DeckInteractionOutlineService;
    sceneMode?: SceneMode;
    device?: Device | null;
}

interface DebugBlockPath {
    path: Array<[number, number, number]>;
}

interface DebugBlockLabel {
    position: [number, number, number];
    text: string;
}

const UNSELECTABLE = 0xffffffff;
const FLAT_2D_MODEL_MATRIX = new Matrix4().scale([1, 1, 0]);
const NO_DEPTH_PARAMETERS = {
    depthTest: false,
    depthMask: false
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
    private readonly gltfPresentation: TileSubsetGltfPresentation;
    private readonly interactionPresentation:
        TileSubsetInteractionPresentation;
    private readonly styleCacheKey: string;
    private pickResults: TileSubsetPickResult[] = [];
    private renderedSignature = "";
    private requestedSignature = "";
    private disposed = false;
    private sceneHandle: IRenderSceneHandle | null = null;
    private sceneRevision = 0;
    private fidelityValue: number;
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
        this.gltfPresentation = new TileSubsetGltfPresentation(
            owner,
            states[0],
            blockKey,
            states.length
        );
        this.interactionPresentation =
            new TileSubsetInteractionPresentation(
                {
                    visualizationId: this.visualizationId,
                    ownerId: owner.ownerId,
                    presentationKind: owner.identity.presentationKind,
                    styleOrder: owner.styleOrder,
                    viewIndex
                },
                this.gltfPresentation,
                address => this.resolvePick(address),
                address => this.interactionScope(address)
            );
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
        scope?: TileSubsetInteractionScope
    ): boolean {
        return this.interactionPresentation.hasLocalTarget(target, scope);
    }

    /** Replaces this block's view-owned local interaction overlay definitions. */
    setInteractionOverlays(
        overlays: readonly TileSubsetInteractionOverlay[]
    ): void {
        this.interactionPresentation.setOverlays(overlays);
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
            this.interactionPresentation.refreshPickTargets();
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
        if (registry) {
            for (const key of this.layerKeys) {
                registry.remove(key);
            }
        }
        this.layerKeys.clear();
        this.interactionPresentation.destroy();
        this.vectorPresentation.destroy();
        this.gltfPresentation.destroy(registry);
        for (const state of this.states) {
            this.owner.releaseTileState(state);
        }
        this.pickResults = [];
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
            this.interactionPresentation.clear(
                registry,
                this.outlineService(sceneHandle)
            );
            this.vectorPresentation.clear();
            this.gltfPresentation.clear(registry);
            this.reconcile(registry, desired);
            return true;
        }
        const preparedGltf = await this.gltfPresentation.prepare(
            result,
            (sceneHandle.scene as DeckScene | undefined)?.device ?? null
        );
        if (this.disposed ||
            signature !== this.requestedSignature ||
            this.sceneHandle !== sceneHandle ||
            this.sceneRevision !== sceneRevision) {
            this.gltfPresentation.discard(preparedGltf);
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
        const interactionGltf = this.gltfPresentation.install(
            registry,
            result,
            origin,
            modelMatrix,
            pickResolver,
            interaction,
            preparedGltf
        );
        this.interactionPresentation.installSource(
            {...vectorSource, gltf: interactionGltf},
            registry,
            this.outlineService(sceneHandle)
        );
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

    private interactionScope(
        address: number
    ): TileSubsetInteractionScope {
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
