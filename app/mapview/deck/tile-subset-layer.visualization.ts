import {COORDINATE_SYSTEM} from "@deck.gl/core";
import {PathStyleExtension} from "@deck.gl/extensions";
import {
    IconLayer,
    PathLayer,
    ScatterplotLayer,
    SolidPolygonLayer,
    TextLayer
} from "@deck.gl/layers";
import {Matrix4} from "@math.gl/core";
import type {Device} from "@luma.gl/core";
import {PackedTileId} from "@ndsev/ndslive-math";
import type {FilterTileState} from "../../mapdata/filter-tile-state.model";
import type {StyledMapgetLayer} from "../../mapdata/styled-mapget-layer.model";
import type {TileFeatureId} from "../../shared/appstate.service";
import {sipHash64Hex} from "../../styledata/hash";
import {SceneMode} from "../../integrations/geo";
import {coreLib} from "../../integrations/wasm";
import type {IRenderSceneHandle} from "../render-view.model";
import {
    isValidSurfaceRingTopology,
    triangulateSurfaceIndices
} from "./surface-triangulation";
import {
    DeckLayerRegistry,
    makeDeckLayerKey
} from "./deck-layer-registry";
import {
    StaleSubsetRenderError,
    TileSubsetLayerRenderService
} from "./tile-subset-layer-render.service";
import type {
    TileSubsetLabelDatum,
    TileSubsetLayerRenderBuffers,
    TileSubsetPickResult,
    TileSubsetPathBuffers,
    TileSubsetPointBuffers,
    TileSubsetSurfaceBuffers
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
import type {
    StyleValidationReportService
} from "../../styledata/style-validation-report.service";

interface DeckScene {
    layerRegistry?: DeckLayerRegistry;
    sceneMode?: SceneMode;
    device?: Device | null;
}

interface DeckBinaryAttribute<T extends ArrayLike<number>> {
    value: T;
    size: number;
}

type PickResolver = (pickIndex: number) => TileFeatureId[];

interface DeckPickProps {
    tileKey: string;
    subsetPickResolver: PickResolver;
    featureAddresses?: Uint32Array;
    featureAddressesByPath?: Uint32Array;
}

interface DeckPathData {
    length: number;
    billboard: boolean;
    depthTest: boolean;
    coordinateOrigin: [number, number, number];
    startIndices: Uint32Array;
    featureAddressesByPath: Uint32Array;
    attributes: {
        getPath: DeckBinaryAttribute<Float32Array>;
        instanceColors: DeckBinaryAttribute<Uint8Array>;
        instanceStrokeWidths: DeckBinaryAttribute<Float32Array>;
        instanceDashArrays?: DeckBinaryAttribute<Float32Array>;
    };
}

interface DeckPointData {
    length: number;
    billboard: boolean;
    depthTest: boolean;
    coordinateOrigin: [number, number, number];
    featureAddresses: Uint32Array;
    attributes: {
        getPosition: DeckBinaryAttribute<Float32Array>;
        getFillColor: DeckBinaryAttribute<Uint8Array>;
        getRadius: DeckBinaryAttribute<Float32Array>;
    };
}

interface DeckSurfaceData {
    length: number;
    depthTest: boolean;
    coordinateOrigin: [number, number, number];
    startIndices: Uint32Array;
    featureAddresses: Uint32Array;
    attributes: {
        getPolygon: DeckBinaryAttribute<Float32Array>;
        indices: DeckBinaryAttribute<Uint32Array>;
        fillColors: DeckBinaryAttribute<Uint8Array>;
    };
}

type DeckLabelData = Omit<TileSubsetLabelDatum, "position"> & {
    position: [number, number, number];
};

interface DeckArrowMarker {
    featureAddress: number;
    position: [number, number, number];
    color: [number, number, number, number];
    sizePx: number;
    angleDeg: number;
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
}

const MAX_PATHS = 1_000_000;
const MAX_SURFACES = 1_000_000;
const MAX_VERTICES = 20_000_000;
const MAX_POINTS = 10_000_000;
const UNSELECTABLE = 0xffffffff;
const FLAT_2D_MODEL_MATRIX = new Matrix4().scale([1, 1, 0]);
const NO_DEPTH_PARAMETERS = {
    depthTest: false,
    depthMask: false
} as any;
const ARROW_ICON_SIZE = 64;
const ARROW_ICON_ATLAS =
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${ARROW_ICON_SIZE}" height="${ARROW_ICON_SIZE}" viewBox="0 0 ${ARROW_ICON_SIZE} ${ARROW_ICON_SIZE}"><polygon points="32,0 60,60 4,60" fill="white"/></svg>`
    );
const ARROW_ICON_MAPPING = {
    arrowhead: {
        x: 0,
        y: 0,
        width: ARROW_ICON_SIZE,
        height: ARROW_ICON_SIZE,
        anchorX: ARROW_ICON_SIZE / 2,
        anchorY: 0,
        mask: true
    }
};

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
    private readonly styleCacheKey: string;
    private pickResults: TileSubsetPickResult[] = [];
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
        const signature = [
            ...this.states.map(state =>
                `${state.mapTileKey}:${state.valueVersion}`
            ),
            this.fidelityValue,
            this.owner.style.id,
            this.styleCacheKey,
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
                coordinateOrigin: this.blockOrigin,
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
        this.removeSharedGltfContributions(registry);
        this.releaseGltfAsset();
        for (const state of this.states) {
            this.owner.releaseAttachment(state.tileId);
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
        const pickResolver: PickResolver = pickIndex => this.resolvePick(pickIndex);

        for (const surface of this.surfaceData(result.surface, origin)) {
            const key = this.key("surface", surface.depthTest);
            registry.upsert(key, new SolidPolygonLayer<DeckSurfaceData, DeckPickProps>({
                id: key,
                data: surface,
                coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                coordinateOrigin: surface.coordinateOrigin,
                filled: true,
                extruded: false,
                wireframe: false,
                _normalize: false,
                _full3d: true,
                modelMatrix,
                parameters: this.parameters(surface.depthTest),
                pickable: true,
                tileKey: this.blockKey,
                subsetPickResolver: pickResolver,
                featureAddresses: surface.featureAddresses
            }), 350 + this.owner.styleOrder);
            desired.add(key);
        }

        const pathBuckets = [
            ...this.pathData(result.pathWorld, origin, false),
            ...this.pathData(result.pathBillboard, origin, true)
        ];
        for (const path of pathBuckets) {
            const key = this.key("path", path.depthTest, path.billboard);
            registry.upsert(key, new PathLayer<DeckPathData, DeckPickProps>({
                id: key,
                data: path,
                coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                coordinateOrigin: path.coordinateOrigin,
                _pathType: "open",
                widthUnits: "pixels",
                billboard: path.billboard,
                modelMatrix,
                parameters: this.parameters(path.depthTest),
                capRounded: true,
                jointRounded: true,
                pickable: true,
                extensions: [new PathStyleExtension({dash: true})],
                tileKey: this.blockKey,
                subsetPickResolver: pickResolver,
                featureAddressesByPath: path.featureAddressesByPath
            }), 400 + this.owner.styleOrder);
            desired.add(key);
        }

        const pointBuckets = [
            ...this.pointData(result.pointWorld, origin, false),
            ...this.pointData(result.pointBillboard, origin, true)
        ];
        for (const point of pointBuckets) {
            const key = this.key("point", point.depthTest, point.billboard);
            registry.upsert(key, new ScatterplotLayer<DeckPointData, DeckPickProps>({
                id: key,
                data: point,
                coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                coordinateOrigin: point.coordinateOrigin,
                filled: true,
                stroked: false,
                radiusUnits: "pixels",
                billboard: point.billboard,
                modelMatrix,
                parameters: this.parameters(point.depthTest),
                pickable: true,
                tileKey: this.blockKey,
                subsetPickResolver: pickResolver,
                featureAddresses: point.featureAddresses
            }), 425 + this.owner.styleOrder);
            desired.add(key);
        }

        const labels = [...result.labelWorld, ...result.labelBillboard];
        for (const billboard of [false, true]) {
            for (const depthTest of [true, false]) {
                const data = labels
                    .filter(label => Boolean(label.billboard) === billboard &&
                        (label.depthTest !== false) === depthTest)
                    .map(label => ({
                        ...label,
                        position: [
                            label.position.x,
                            label.position.y,
                            label.position.z
                        ] as [number, number, number]
                    }));
                if (!data.length) {
                    continue;
                }
                const key = this.key("label", depthTest, billboard);
                registry.upsert(key, new TextLayer({
                    id: key,
                    data,
                    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                    coordinateOrigin: origin,
                    getPosition: (datum: DeckLabelData) => datum.position,
                    getText: (datum: DeckLabelData) => datum.text,
                    getColor: (datum: DeckLabelData) => datum.fillColor,
                    getOutlineColor: (datum: DeckLabelData) => datum.outlineColor,
                    getOutlineWidth: (datum: DeckLabelData) => datum.outlineWidth,
                    getSize: (datum: DeckLabelData) => 14 * datum.scale,
                    sizeUnits: "pixels",
                    getPixelOffset: (datum: DeckLabelData) => datum.pixelOffset ?? [0, 0],
                    billboard,
                    modelMatrix,
                    parameters: this.parameters(depthTest),
                    pickable: true,
                    tileKey: this.blockKey,
                    subsetPickResolver: pickResolver
                } as any), 475 + this.owner.styleOrder);
                desired.add(key);
            }
        }

        const arrowBuckets = [
            ...this.pathData(result.arrowWorld, origin, false),
            ...this.pathData(result.arrowBillboard, origin, true)
        ];
        for (const arrow of arrowBuckets) {
            const markers = this.arrowMarkers(arrow);
            if (!markers.length) {
                continue;
            }
            const key = this.key("arrow", arrow.depthTest, arrow.billboard);
            registry.upsert(key, new IconLayer<DeckArrowMarker, DeckPickProps>({
                id: key,
                data: markers,
                coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                coordinateOrigin: origin,
                iconAtlas: ARROW_ICON_ATLAS,
                iconMapping: ARROW_ICON_MAPPING,
                getIcon: () => "arrowhead",
                getPosition: marker => marker.position,
                getSize: marker => marker.sizePx,
                sizeUnits: "pixels",
                getAngle: marker => marker.angleDeg,
                getColor: marker => marker.color,
                billboard: arrow.billboard,
                modelMatrix,
                parameters: this.parameters(arrow.depthTest),
                pickable: true,
                tileKey: this.blockKey,
                subsetPickResolver: pickResolver,
                alphaCutoff: 0.05
            }), 450 + this.owner.styleOrder);
            desired.add(key);
        }

        this.applyGltf(
            registry,
            result,
            origin,
            modelMatrix,
            pickResolver,
            preparedGltf
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
        prepared: PreparedGltf | null
    ): void {
        const sourceId = this.owner.ownerId;
        const state = this.primaryState;
        const gltfKey = `${state.mapTileKey}/gltf`;
        const pickKey = `${state.mapTileKey}/gltf-pick-proxy`;
        const raw = result.gltfNodes;
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
            const contribution: SharedGltfContribution = {
                asset: prepared.asset,
                order: 375 + this.owner.styleOrder,
                priority,
                styleOrder: this.owner.styleOrder,
                data
            };
            registry.upsertShared(
                gltfKey,
                sourceId,
                contribution,
                (key, rawContributions) => {
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
                            id: key,
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
                }
            );
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
                data: proxyData
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
                    return {
                        order: Math.max(...contributions.map(
                            item => item.contribution.order
                        )),
                        layer: new DeckGltfPickProxyLayer({
                            id: key,
                            contributions: contributions.map(item => ({
                                sourceId: item.sourceId,
                                data: item.contribution.data
                            })),
                            coordinateOrigin: first.coordinateOrigin,
                            pickable: true,
                            tileKey: state.mapTileKey,
                            subsetPickResolver: pickResolver
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
        if (vertexCount < 3 || vertexCount > MAX_VERTICES ||
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
                `${this.primaryState.mapTileKey}/gltf-pick-proxy`,
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
        if (Number.isInteger(result.attributeIndex)) {
            featureId += `:attribute#${result.attributeIndex}`;
            if (result.hasValidity && Number.isInteger(result.validityIndex)) {
                featureId += `:validity#${result.validityIndex}`;
            }
        } else if (result.relationSourceFeatureId &&
                   Number.isInteger(result.relationIndex)) {
            featureId =
                `${result.relationSourceFeatureId}:relation#${result.relationIndex}`;
        }
        return [{mapTileKey: state.mapTileKey, featureId}];
    }

    private pathData(
        raw: TileSubsetPathBuffers,
        origin: [number, number, number],
        billboard: boolean
    ): DeckPathData[] {
        if (raw.startIndices.length < 2 || raw.startIndices[0] !== 0) {
            return [];
        }
        const pathCount = raw.startIndices.length - 1;
        const vertexCount = raw.startIndices[pathCount];
        if (!pathCount || pathCount > MAX_PATHS ||
            vertexCount <= 1 || vertexCount > MAX_VERTICES ||
            raw.positions.length < vertexCount * 3 ||
            raw.colors.length < vertexCount * 4 ||
            raw.widths.length < vertexCount ||
            raw.featureAddresses.length < pathCount) {
            return [];
        }
        const groups = new Map<boolean, {
            positions: number[];
            starts: number[];
            colors: number[];
            widths: number[];
            addresses: number[];
            dashes?: number[];
        }>();
        const hasDashes = !!raw.dashArrays && raw.dashArrays.length >= vertexCount * 2;
        for (let pathIndex = 0; pathIndex < pathCount; ++pathIndex) {
            const start = raw.startIndices[pathIndex];
            const end = raw.startIndices[pathIndex + 1];
            if (end <= start || end > vertexCount) {
                return [];
            }
            const depthTest = !raw.depthTests?.length || raw.depthTests[pathIndex] !== 0;
            const group = groups.get(depthTest) ?? {
                positions: [],
                starts: [0],
                colors: [],
                widths: [],
                addresses: [],
                dashes: hasDashes ? [] : undefined
            };
            for (let vertex = start; vertex < end; ++vertex) {
                group.positions.push(...raw.positions.subarray(vertex * 3, vertex * 3 + 3));
                group.colors.push(...raw.colors.subarray(vertex * 4, vertex * 4 + 4));
                group.widths.push(raw.widths[vertex]);
                if (group.dashes && raw.dashArrays) {
                    group.dashes.push(...raw.dashArrays.subarray(vertex * 2, vertex * 2 + 2));
                }
            }
            group.addresses.push(raw.featureAddresses[pathIndex]);
            group.starts.push(group.positions.length / 3);
            groups.set(depthTest, group);
        }
        return [...groups].map(([depthTest, group]) => ({
            length: group.addresses.length,
            billboard,
            depthTest,
            coordinateOrigin: origin,
            startIndices: new Uint32Array(group.starts),
            featureAddressesByPath: new Uint32Array(group.addresses),
            attributes: {
                getPath: {value: new Float32Array(group.positions), size: 3},
                instanceColors: {value: new Uint8Array(group.colors), size: 4},
                instanceStrokeWidths: {value: new Float32Array(group.widths), size: 1},
                ...(group.dashes
                    ? {instanceDashArrays: {
                        value: new Float32Array(group.dashes),
                        size: 2
                    }}
                    : {})
            }
        }));
    }

    private pointData(
        raw: TileSubsetPointBuffers,
        origin: [number, number, number],
        billboard: boolean
    ): DeckPointData[] {
        if (!raw.positions.length || raw.positions.length % 3 !== 0) {
            return [];
        }
        const pointCount = raw.positions.length / 3;
        if (pointCount > MAX_POINTS ||
            raw.colors.length < pointCount * 4 ||
            raw.radii.length < pointCount ||
            raw.featureAddresses.length < pointCount) {
            return [];
        }
        const groups = new Map<boolean, {
            positions: number[];
            colors: number[];
            radii: number[];
            addresses: number[];
        }>();
        for (let index = 0; index < pointCount; ++index) {
            const depthTest = !raw.depthTests?.length || raw.depthTests[index] !== 0;
            const group = groups.get(depthTest) ?? {
                positions: [],
                colors: [],
                radii: [],
                addresses: []
            };
            group.positions.push(...raw.positions.subarray(index * 3, index * 3 + 3));
            group.colors.push(...raw.colors.subarray(index * 4, index * 4 + 4));
            group.radii.push(raw.radii[index]);
            group.addresses.push(raw.featureAddresses[index]);
            groups.set(depthTest, group);
        }
        return [...groups].map(([depthTest, group]) => ({
            length: group.addresses.length,
            billboard,
            depthTest,
            coordinateOrigin: origin,
            featureAddresses: new Uint32Array(group.addresses),
            attributes: {
                getPosition: {value: new Float32Array(group.positions), size: 3},
                getFillColor: {value: new Uint8Array(group.colors), size: 4},
                getRadius: {value: new Float32Array(group.radii), size: 1}
            }
        }));
    }

    private surfaceData(
        raw: TileSubsetSurfaceBuffers,
        origin: [number, number, number]
    ): DeckSurfaceData[] {
        if (raw.startIndices.length < 2 || raw.startIndices[0] !== 0) {
            return [];
        }
        const surfaceCount = raw.startIndices.length - 1;
        const vertexCount = raw.startIndices[surfaceCount];
        if (!surfaceCount || surfaceCount > MAX_SURFACES ||
            vertexCount < 3 || vertexCount > MAX_VERTICES ||
            raw.positions.length < vertexCount * 3 ||
            raw.colors.length < vertexCount * 4 ||
            raw.featureAddresses.length < surfaceCount ||
            !isValidSurfaceRingTopology(raw, vertexCount)) {
            return [];
        }
        const groups = new Map<boolean, {
            positions: number[];
            starts: number[];
            holes: number[];
            holeStarts: number[];
            colors: number[];
            addresses: number[];
        }>();
        for (let surface = 0; surface < surfaceCount; ++surface) {
            const start = raw.startIndices[surface];
            const end = raw.startIndices[surface + 1];
            if (end - start < 3 || end > vertexCount) {
                return [];
            }
            const depthTest = !raw.depthTests?.length || raw.depthTests[surface] !== 0;
            const group = groups.get(depthTest) ?? {
                positions: [],
                starts: [0],
                holes: [],
                holeStarts: [0],
                colors: [],
                addresses: []
            };
            const groupStart = group.positions.length / 3;
            for (let vertex = start; vertex < end; ++vertex) {
                group.positions.push(...raw.positions.subarray(vertex * 3, vertex * 3 + 3));
                group.colors.push(...raw.colors.subarray(vertex * 4, vertex * 4 + 4));
            }
            if (raw.holeIndexStarts.length >= surface + 2) {
                for (let index = raw.holeIndexStarts[surface];
                     index < raw.holeIndexStarts[surface + 1];
                     ++index) {
                    group.holes.push(groupStart + raw.holeIndices[index] - start);
                }
            }
            group.holeStarts.push(group.holes.length);
            group.addresses.push(raw.featureAddresses[surface]);
            group.starts.push(group.positions.length / 3);
            groups.set(depthTest, group);
        }
        return [...groups].map(([depthTest, group]) => ({
            length: group.addresses.length,
            depthTest,
            coordinateOrigin: origin,
            startIndices: new Uint32Array(group.starts),
            featureAddresses: new Uint32Array(group.addresses),
            attributes: {
                getPolygon: {value: new Float32Array(group.positions), size: 3},
                indices: {
                    value: triangulateSurfaceIndices({
                        positions: group.positions,
                        startIndices: group.starts,
                        holeIndices: group.holes,
                        holeIndexStarts: group.holeStarts
                    }),
                    size: 1
                },
                fillColors: {value: new Uint8Array(group.colors), size: 4}
            }
        }));
    }

    private arrowMarkers(path: DeckPathData): DeckArrowMarker[] {
        const result: DeckArrowMarker[] = [];
        const positions = path.attributes.getPath.value;
        const colors = path.attributes.instanceColors.value;
        const widths = path.attributes.instanceStrokeWidths.value;
        for (let index = 0; index < path.length; ++index) {
            const start = path.startIndices[index];
            const end = path.startIndices[index + 1];
            if (end - start < 3) {
                continue;
            }
            const tip = start + 1;
            const tipOffset = tip * 3;
            const leftOffset = start * 3;
            const rightOffset = (end - 1) * 3;
            const directionX = positions[tipOffset] -
                (positions[leftOffset] + positions[rightOffset]) * 0.5;
            const directionY = positions[tipOffset + 1] -
                (positions[leftOffset + 1] + positions[rightOffset + 1]) * 0.5;
            if (Math.hypot(directionX, directionY) <= 1e-6) {
                continue;
            }
            const colorOffset = tip * 4;
            result.push({
                featureAddress: path.featureAddressesByPath[index],
                position: [
                    positions[tipOffset],
                    positions[tipOffset + 1],
                    positions[tipOffset + 2]
                ],
                color: [
                    colors[colorOffset],
                    colors[colorOffset + 1],
                    colors[colorOffset + 2],
                    colors[colorOffset + 3]
                ],
                sizePx: Math.max(8, widths[tip] * 4),
                angleDeg: this.normalizeDegrees(
                    -((Math.atan2(directionX, directionY) * 180) / Math.PI)
                )
            });
        }
        return result;
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

    private normalizeDegrees(value: number): number {
        const normalized = value % 360;
        return normalized < 0 ? normalized + 360 : normalized;
    }
}
