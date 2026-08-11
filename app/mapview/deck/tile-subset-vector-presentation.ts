import {COORDINATE_SYSTEM} from "@deck.gl/core";
import {PathStyleExtension} from "@deck.gl/extensions";
import {
    IconLayer,
    PathLayer,
    ScatterplotLayer,
    SolidPolygonLayer,
    TextLayer
} from "@deck.gl/layers";
import type {Matrix4} from "@math.gl/core";

import {
    DeckLayerRegistry,
    makeDeckLayerKey
} from "./deck-layer-registry";
import {DeckRenderBufferArena} from "./deck-render-buffer-arena";
import type {
    DeckSubsetInteractionProps as DeckInteractionProps,
    DeckSubsetPickProps as DeckPickProps,
    SubsetPickResolver as PickResolver
} from "./deck-subset-picking";
import {
    DeckLocalPixelOffsetExtension,
    DeckVariableOffsetPathLayer,
    DeckVariablePathOffsetExtension,
    packVariablePathOffsetVectors
} from "./deck-variable-path-offset.extension";
import {
    buildZIndexOffsets,
    DeckZIndexExtension
} from "./deck-z-index.extension";
import type {
    TileSubsetLabelDatum,
    TileSubsetLayerRenderBuffers
} from "./tile-subset-layer-render.worker.protocol";
import {
    compileTileSubsetArrowMarkers,
    expandObjectValues,
    compileTileSubsetPathData,
    compileTileSubsetPointData,
    compileTileSubsetSurfaceData,
    type DeckArrowMarker,
    type DeckPathData,
    type DeckPointData,
    type DeckSurfaceData
} from "./tile-subset-render-data";

const UNSELECTABLE = 0xffffffff;
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

export type DeckLabelData = Omit<TileSubsetLabelDatum, "position"> & {
    position: [number, number, number];
    zIndexOffset: number;
};

interface SharedPrimitiveContribution<T> {
    data: T;
    pickResolver: PickResolver;
}

interface ArenaRegistration {
    arena: DeckRenderBufferArena;
    groupKey: string;
    sourceId: string;
}

export interface TileSubsetVectorSource {
    paths: DeckPathData[];
    arrows: DeckPathData[];
    points: DeckPointData[];
    surfaces: DeckSurfaceData[];
    labels: DeckLabelData[];
    origin: [number, number, number];
    modelMatrix: Matrix4 | null;
}

export interface TileSubsetVectorPresentationConfig {
    visualizationId: string;
    ownerId: string;
    presentationKind: string;
    styleOrder: number;
    viewIndex: number;
    blockKey: string;
}

export interface TileSubsetVectorInstall {
    registry: DeckLayerRegistry;
    arena: DeckRenderBufferArena | null;
    result: TileSubsetLayerRenderBuffers;
    origin: [number, number, number];
    modelMatrix: Matrix4 | null;
    interaction: DeckInteractionProps;
    pickResolver: PickResolver;
}

export interface TileSubsetArrowLayerOptions {
    parameters?: any;
    tileKey?: string;
    getColor?: (marker: DeckArrowMarker) => [number, number, number, number];
}

function renderParameters(depthTest: boolean): any {
    return depthTest ? {} : NO_DEPTH_PARAMETERS;
}

/** Builds the binary polygon layer shared by base and interaction presentations. */
export function createTileSubsetSurfaceLayer(
    key: string,
    surface: DeckSurfaceData,
    pickResolver: PickResolver,
    modelMatrix: Matrix4 | null,
    interaction: DeckInteractionProps,
    parameters: any = renderParameters(surface.depthTest)
): SolidPolygonLayer<DeckSurfaceData, DeckPickProps> {
    return new SolidPolygonLayer<DeckSurfaceData, DeckPickProps>({
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
        extensions: surface.attributes.zIndexOffsets
            ? [new DeckZIndexExtension()]
            : [],
        parameters,
        pickable: interaction.pickable,
        navigationAnchorEligible: interaction.drillPickEligible,
        markerAnchorEligible: interaction.drillPickEligible,
        drillPickEligible: interaction.drillPickEligible,
        tileKey: key,
        subsetPickResolver: pickResolver,
        featureAddresses: surface.featureAddresses,
        surfaceNormals: surface.surfaceNormals
    });
}

/** Builds the binary path layer shared by base and interaction presentations. */
export function createTileSubsetPathLayer(
    key: string,
    path: DeckPathData,
    pickResolver: PickResolver,
    modelMatrix: Matrix4 | null,
    interaction: DeckInteractionProps
): PathLayer<DeckPathData, DeckPickProps> {
    const variableOffset = Boolean(
        path.attributes.instanceVariableOffsets);
    const LayerType = variableOffset
        ? DeckVariableOffsetPathLayer
        : PathLayer;
    return new LayerType({
        id: key,
        data: path,
        coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
        coordinateOrigin: path.coordinateOrigin,
        _pathType: "open",
        widthUnits: "pixels",
        billboard: path.billboard,
        modelMatrix,
        parameters: renderParameters(path.depthTest),
        capRounded: true,
        jointRounded: true,
        pickable: interaction.pickable,
        navigationAnchorEligible: interaction.drillPickEligible,
        markerAnchorEligible: interaction.drillPickEligible,
        drillPickEligible: interaction.drillPickEligible,
        extensions: [
            ...(variableOffset
            ? [
                new PathStyleExtension({dash: true}),
                new DeckVariablePathOffsetExtension()
            ]
            : [new PathStyleExtension({dash: true, offset: true})]),
            ...(path.attributes.zIndexOffsets
                ? [new DeckZIndexExtension()]
                : [])
        ],
        tileKey: key,
        subsetPickResolver: pickResolver,
        featureAddressesByPath: path.featureAddressesByPath,
        pathCenterline: {
            positions: path.attributes.getPath.value,
            startIndices: path.startIndices,
            coordinateOrigin: path.coordinateOrigin
        }
    }) as PathLayer<DeckPathData, DeckPickProps>;
}

/** Builds the binary point layer shared by base and interaction presentations. */
export function createTileSubsetPointLayer(
    key: string,
    point: DeckPointData,
    pickResolver: PickResolver,
    modelMatrix: Matrix4 | null,
    interaction: DeckInteractionProps
): ScatterplotLayer<DeckPointData, DeckPickProps> {
    return new ScatterplotLayer<DeckPointData, DeckPickProps>({
        id: key,
        data: point,
        coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
        coordinateOrigin: point.coordinateOrigin,
        filled: true,
        stroked: false,
        radiusUnits: "pixels",
        billboard: point.billboard,
        modelMatrix,
        extensions: point.attributes.zIndexOffsets
            ? [new DeckZIndexExtension()]
            : [],
        parameters: renderParameters(point.depthTest),
        pickable: interaction.pickable,
        navigationAnchorEligible: interaction.drillPickEligible,
        markerAnchorEligible: interaction.drillPickEligible,
        drillPickEligible: interaction.drillPickEligible,
        tileKey: key,
        subsetPickResolver: pickResolver,
        featureAddresses: point.featureAddresses,
        anchorPositions: point.attributes.getPosition.value
    });
}

/** Builds one screen-space arrow layer from an authored path bucket. */
export function createTileSubsetArrowLayer(
    key: string,
    arrow: DeckPathData,
    markers: DeckArrowMarker[],
    pickResolver: PickResolver,
    modelMatrix: Matrix4 | null,
    interaction: DeckInteractionProps,
    options: TileSubsetArrowLayerOptions = {}
): IconLayer<DeckArrowMarker, DeckPickProps> {
    return new IconLayer<DeckArrowMarker, DeckPickProps>({
        id: key,
        data: markers,
        coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
        coordinateOrigin: arrow.coordinateOrigin,
        iconAtlas: ARROW_ICON_ATLAS,
        iconMapping: ARROW_ICON_MAPPING,
        getIcon: () => "arrowhead",
        getPosition: (marker: DeckArrowMarker) => marker.position,
        getSize: (marker: DeckArrowMarker) => marker.sizePx,
        sizeUnits: "pixels",
        getAngle: (marker: DeckArrowMarker) => marker.angleDeg,
        getPixelOffset: (marker: DeckArrowMarker) => marker.pixelOffset,
        getLocalPixelOffset: (marker: DeckArrowMarker) =>
            marker.localPixelOffset,
        getColor: options.getColor ??
            ((marker: DeckArrowMarker) => marker.color),
        extensions: [
            new DeckLocalPixelOffsetExtension(),
            ...(arrow.attributes.zIndexOffsets
                ? [new DeckZIndexExtension()]
                : [])
        ],
        getZIndexOffset: (marker: DeckArrowMarker) => marker.zIndexOffset,
        billboard: arrow.billboard,
        modelMatrix,
        parameters: options.parameters ?? renderParameters(arrow.depthTest),
        pickable: interaction.pickable,
        drillPickEligible: interaction.drillPickEligible,
        tileKey: options.tileKey ?? key,
        subsetPickResolver: pickResolver,
        alphaCutoff: 0.05
    } as any);
}

/**
 * Owns the installed vector representation of one immutable subset block.
 *
 * It reconciles direct registry layers and arena contributions as one unit.
 * Request freshness, GLTF attachments, and interaction overlays intentionally
 * remain with their respective presentation owners.
 */
export class TileSubsetVectorPresentation {
    private readonly layerKeys = new Set<string>();
    private readonly arenaRegistrations = new Map<string, ArenaRegistration>();
    private registry: DeckLayerRegistry | null = null;

    constructor(
        private readonly config: TileSubsetVectorPresentationConfig
    ) {}

    /** Compiles and atomically reconciles every vector primitive for one result. */
    install(request: TileSubsetVectorInstall): TileSubsetVectorSource {
        this.switchRegistry(request.registry);
        const desiredLayers = new Set<string>();
        const desiredArena = new Set<string>();
        const {
            result,
            origin,
            modelMatrix,
            interaction,
            pickResolver,
            registry,
            arena
        } = request;

        const surfaces = compileTileSubsetSurfaceData(result.surface, origin);
        for (const surface of surfaces) {
            const key = this.key("surface", surface.depthTest);
            if (!this.upsertArenaSurface(
                arena,
                surface,
                pickResolver,
                modelMatrix,
                interaction,
                desiredArena
            )) {
                registry.upsert(
                    key,
                    createTileSubsetSurfaceLayer(
                        key,
                        surface,
                        pickResolver,
                        modelMatrix,
                        interaction
                    ),
                    350 + this.config.styleOrder
                );
                desiredLayers.add(key);
            }
        }

        const paths = [
            ...compileTileSubsetPathData(result.pathWorld, origin, false),
            ...compileTileSubsetPathData(result.pathBillboard, origin, true),
            ...compileTileSubsetPathData(
                result.transitionPathWorld,
                origin,
                false
            ),
            ...compileTileSubsetPathData(
                result.transitionPathBillboard,
                origin,
                true
            )
        ];
        for (const path of paths) {
            const kind = path.attributes.instanceVariableOffsets
                ? "path-variable-offset"
                : "path";
            const key = this.key(kind, path.depthTest, path.billboard);
            if (!this.upsertArenaPath(
                arena,
                path,
                pickResolver,
                modelMatrix,
                interaction,
                desiredArena
            )) {
                registry.upsert(
                    key,
                    createTileSubsetPathLayer(
                        key,
                        path,
                        pickResolver,
                        modelMatrix,
                        interaction
                    ),
                    400 + this.config.styleOrder
                );
                desiredLayers.add(key);
            }
        }

        const points = [
            ...compileTileSubsetPointData(result.pointWorld, origin, false),
            ...compileTileSubsetPointData(result.pointBillboard, origin, true)
        ];
        for (const point of points) {
            const key = this.key("point", point.depthTest, point.billboard);
            if (!this.upsertArenaPoint(
                arena,
                point,
                pickResolver,
                modelMatrix,
                interaction,
                desiredArena
            )) {
                registry.upsert(
                    key,
                    createTileSubsetPointLayer(
                        key,
                        point,
                        pickResolver,
                        modelMatrix,
                        interaction
                    ),
                    425 + this.config.styleOrder
                );
                desiredLayers.add(key);
            }
        }

        const rawLabels = [...result.labelWorld, ...result.labelBillboard];
        const labelZIndexOffsets = buildZIndexOffsets(
            rawLabels.map(label => label.zIndex ?? Number.NaN),
            rawLabels.map(label => label.featureAddress)
        );
        const labels = rawLabels.map(
            (label, index) => ({
                ...label,
                position: [
                    label.position.x,
                    label.position.y,
                    label.position.z
                ] as [number, number, number],
                zIndexOffset: labelZIndexOffsets?.[index] ?? 0
            }));
        for (const billboard of [false, true]) {
            for (const depthTest of [true, false]) {
                const data = labels.filter(
                    label => Boolean(label.billboard) === billboard &&
                        (label.depthTest !== false) === depthTest
                );
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
                    getSize: (datum: DeckLabelData) => 14 * datum.scale,
                    sizeUnits: "pixels",
                    outlineColor: data[0].outlineColor,
                    outlineWidth: data[0].outlineWidth,
                    getPixelOffset: (datum: DeckLabelData) =>
                        datum.pixelOffset ?? [0, 0],
                    getZIndexOffset: (datum: DeckLabelData) =>
                        datum.zIndexOffset,
                    extensions: labelZIndexOffsets
                        ? [new DeckZIndexExtension()]
                        : [],
                    billboard,
                    modelMatrix,
                    parameters: renderParameters(depthTest),
                    pickable: interaction.pickable,
                    drillPickEligible: interaction.drillPickEligible,
                    tileKey: this.config.blockKey,
                    subsetPickResolver: pickResolver
                } as any), 475 + this.config.styleOrder);
                desiredLayers.add(key);
            }
        }

        const arrows = [
            ...compileTileSubsetPathData(result.arrowWorld, origin, false),
            ...compileTileSubsetPathData(result.arrowBillboard, origin, true)
        ];
        for (const arrow of arrows) {
            const markers = compileTileSubsetArrowMarkers(arrow);
            if (!markers.length) {
                continue;
            }
            const key = this.key("arrow", arrow.depthTest, arrow.billboard);
            registry.upsert(
                key,
                createTileSubsetArrowLayer(
                    key,
                    arrow,
                    markers,
                    pickResolver,
                    modelMatrix,
                    interaction,
                    {tileKey: this.config.blockKey}
                ),
                450 + this.config.styleOrder
            );
            desiredLayers.add(key);
        }

        this.reconcileLayers(desiredLayers);
        this.reconcileArena(desiredArena);
        return {
            paths,
            arrows,
            points,
            surfaces,
            labels,
            origin,
            modelMatrix
        };
    }

    /** Removes all direct and shared vector state while retaining the owner. */
    clear(): void {
        if (this.registry) {
            for (const key of this.layerKeys) {
                this.registry.remove(key);
            }
        }
        this.layerKeys.clear();
        this.removeArenaContributions();
    }

    /** Permanently releases the presentation's currently installed state. */
    destroy(): void {
        this.clear();
        this.registry = null;
    }

    private switchRegistry(registry: DeckLayerRegistry): void {
        if (this.registry === registry) {
            return;
        }
        if (this.registry) {
            for (const key of this.layerKeys) {
                this.registry.remove(key);
            }
        }
        this.layerKeys.clear();
        this.removeArenaContributions();
        this.registry = registry;
    }

    private key(
        kind: string,
        depthTest: boolean,
        billboard?: boolean
    ): string {
        return makeDeckLayerKey({
            tileKey: this.config.blockKey,
            styleId: this.config.ownerId,
            hoverMode: this.config.presentationKind,
            kind,
            variant: `${billboard ? "billboard" : "world"}-${
                depthTest ? "depth" : "overlay"}`
        });
    }

    private upsertArenaSurface(
        arena: DeckRenderBufferArena | null,
        surface: DeckSurfaceData,
        pickResolver: PickResolver,
        modelMatrix: Matrix4 | null,
        interaction: DeckInteractionProps,
        desired: Set<string>
    ): boolean {
        if (!arena) {
            return false;
        }
        const groupKey = this.arenaGroupKey(
            "surface",
            surface.depthTest,
            false,
            surface.coordinateOrigin
        );
        const sourceId = `${this.config.visualizationId}/surface/${
            surface.depthTest}`;
        arena.upsert({
            groupKey,
            sourceId,
            vertexCount: surface.attributes.getPolygon.value.length / 3,
            contribution: {data: surface, pickResolver} satisfies
                SharedPrimitiveContribution<DeckSurfaceData>,
            buildLayer: (key, contributions) => {
                const merged = this.mergeSurfaceContributions(contributions);
                return {
                    layer: merged
                        ? createTileSubsetSurfaceLayer(
                            key,
                            merged.data,
                            merged.pickResolver,
                            modelMatrix,
                            interaction
                        )
                        : null,
                    order: 350 + this.config.styleOrder
                };
            }
        });
        this.trackArenaRegistration(arena, groupKey, sourceId, desired);
        return true;
    }

    private upsertArenaPath(
        arena: DeckRenderBufferArena | null,
        path: DeckPathData,
        pickResolver: PickResolver,
        modelMatrix: Matrix4 | null,
        interaction: DeckInteractionProps,
        desired: Set<string>
    ): boolean {
        if (!arena) {
            return false;
        }
        const pathKind = path.attributes.instanceVariableOffsets
            ? "path-variable-offset"
            : "path";
        const groupKey = this.arenaGroupKey(
            pathKind,
            path.depthTest,
            path.billboard,
            path.coordinateOrigin
        );
        const sourceId = [
            this.config.visualizationId,
            pathKind,
            String(path.billboard),
            String(path.depthTest)
        ].join("/");
        arena.upsert({
            groupKey,
            sourceId,
            vertexCount: path.attributes.getPath.value.length / 3,
            contribution: {data: path, pickResolver} satisfies
                SharedPrimitiveContribution<DeckPathData>,
            buildLayer: (key, contributions) => {
                const merged = this.mergePathContributions(contributions);
                return {
                    layer: merged
                        ? createTileSubsetPathLayer(
                            key,
                            merged.data,
                            merged.pickResolver,
                            modelMatrix,
                            interaction
                        )
                        : null,
                    order: 400 + this.config.styleOrder
                };
            }
        });
        this.trackArenaRegistration(arena, groupKey, sourceId, desired);
        return true;
    }

    private upsertArenaPoint(
        arena: DeckRenderBufferArena | null,
        point: DeckPointData,
        pickResolver: PickResolver,
        modelMatrix: Matrix4 | null,
        interaction: DeckInteractionProps,
        desired: Set<string>
    ): boolean {
        if (!arena) {
            return false;
        }
        const groupKey = this.arenaGroupKey(
            "point",
            point.depthTest,
            point.billboard,
            point.coordinateOrigin
        );
        const sourceId = `${this.config.visualizationId}/point/${
            point.billboard}/${point.depthTest}`;
        arena.upsert({
            groupKey,
            sourceId,
            vertexCount: point.length,
            contribution: {data: point, pickResolver} satisfies
                SharedPrimitiveContribution<DeckPointData>,
            buildLayer: (key, contributions) => {
                const merged = this.mergePointContributions(contributions);
                return {
                    layer: merged
                        ? createTileSubsetPointLayer(
                            key,
                            merged.data,
                            merged.pickResolver,
                            modelMatrix,
                            interaction
                        )
                        : null,
                    order: 425 + this.config.styleOrder
                };
            }
        });
        this.trackArenaRegistration(arena, groupKey, sourceId, desired);
        return true;
    }

    private mergeSurfaceContributions(
        raw: ReadonlyMap<string, unknown>
    ): SharedPrimitiveContribution<DeckSurfaceData> | null {
        const contributions = [...raw.values()] as Array<
            SharedPrimitiveContribution<DeckSurfaceData>>;
        if (!contributions.length) {
            return null;
        }
        const picks = this.arenaPickTable(contributions);
        const hasZIndex = contributions.some(contribution =>
            Boolean(contribution.data.zIndices));
        let positionCount = 0;
        let colorCount = 0;
        let indexCount = 0;
        let surfaceCount = 0;
        for (const {data} of contributions) {
            positionCount += data.attributes.getPolygon.value.length;
            colorCount += data.attributes.fillColors.value.length;
            indexCount += data.attributes.indices.value.length;
            surfaceCount += data.length;
        }
        const positions = new Float32Array(positionCount);
        const colors = new Uint8Array(colorCount);
        const indices = new Uint32Array(indexCount);
        const startIndices = new Uint32Array(surfaceCount + 1);
        const addresses = new Uint32Array(surfaceCount);
        const normals = new Float32Array(surfaceCount * 3);
        const zIndices = hasZIndex
            ? new Float64Array(surfaceCount)
            : undefined;
        let positionOffset = 0;
        let colorOffset = 0;
        let indexOffset = 0;
        let surfaceOffset = 0;
        for (const contribution of contributions) {
            const data = contribution.data;
            const vertexBase = positionOffset / 3;
            positions.set(data.attributes.getPolygon.value, positionOffset);
            colors.set(data.attributes.fillColors.value, colorOffset);
            if (zIndices) {
                const values = data.zIndices;
                if (values) {
                    zIndices.set(values, surfaceOffset);
                } else {
                    zIndices.fill(
                        Number.NaN,
                        surfaceOffset,
                        surfaceOffset + data.length
                    );
                }
            }
            for (const index of data.attributes.indices.value) {
                indices[indexOffset++] = index + vertexBase;
            }
            for (let index = 1; index < data.startIndices.length; ++index) {
                startIndices[surfaceOffset + index] =
                    vertexBase + data.startIndices[index];
            }
            for (let index = 0; index < data.featureAddresses.length; ++index) {
                addresses[surfaceOffset + index] = picks.remap(
                    contribution,
                    data.featureAddresses[index]
                );
            }
            normals.set(data.surfaceNormals, surfaceOffset * 3);
            positionOffset += data.attributes.getPolygon.value.length;
            colorOffset += data.attributes.fillColors.value.length;
            surfaceOffset += data.length;
        }
        const first = contributions[0].data;
        const objectZIndexOffsets = zIndices
            ? buildZIndexOffsets(zIndices, addresses)
            : undefined;
        const zIndexOffsets = objectZIndexOffsets
            ? expandObjectValues(objectZIndexOffsets, startIndices)
            : undefined;
        return {
            pickResolver: picks.resolve,
            data: {
                length: addresses.length,
                depthTest: first.depthTest,
                coordinateOrigin: first.coordinateOrigin,
                startIndices,
                featureAddresses: addresses,
                surfaceNormals: normals,
                zIndices,
                attributes: {
                    getPolygon: {
                        value: positions,
                        size: 3
                    },
                    indices: {
                        value: indices,
                        size: 1
                    },
                    fillColors: {
                        value: colors,
                        size: 4
                    },
                    ...(zIndexOffsets
                        ? {zIndexOffsets: {
                            value: zIndexOffsets,
                            size: 1
                        }}
                        : {})
                }
            }
        };
    }

    private mergePathContributions(
        raw: ReadonlyMap<string, unknown>
    ): SharedPrimitiveContribution<DeckPathData> | null {
        const contributions = [...raw.values()] as Array<
            SharedPrimitiveContribution<DeckPathData>>;
        if (!contributions.length) {
            return null;
        }
        const picks = this.arenaPickTable(contributions);
        const variableOffset = Boolean(
            contributions[0].data.attributes.instanceVariableOffsets);
        const hasDashes = contributions.some(contribution =>
            !!contribution.data.attributes.instanceDashArrays);
        const hasZIndex = contributions.some(contribution =>
            Boolean(contribution.data.zIndices));
        let vertexCount = 0;
        let pathCount = 0;
        for (const {data} of contributions) {
            const contributionVertexCount =
                data.attributes.getPath.value.length / 3;
            if (variableOffset && (!data.offsetVectorsPx ||
                data.offsetVectorsPx.length < contributionVertexCount * 2)) {
                return null;
            }
            vertexCount += contributionVertexCount;
            pathCount += data.length;
        }
        const positions = new Float32Array(vertexCount * 3);
        const colors = new Uint8Array(vertexCount * 4);
        const widths = new Float32Array(vertexCount);
        const offsets = new Float32Array(vertexCount);
        const zIndices = hasZIndex
            ? new Float64Array(pathCount)
            : undefined;
        const offsetVectors = variableOffset
            ? new Float32Array(vertexCount * 2)
            : undefined;
        const offsetScaleThresholds = variableOffset
            ? new Float32Array(pathCount)
            : undefined;
        const dashes = hasDashes
            ? new Float32Array(vertexCount * 2)
            : undefined;
        const startIndices = new Uint32Array(pathCount + 1);
        const addresses = new Uint32Array(pathCount);
        let vertexOffset = 0;
        let pathOffset = 0;
        for (const contribution of contributions) {
            const data = contribution.data;
            const contributionVertexCount =
                data.attributes.getPath.value.length / 3;
            positions.set(
                data.attributes.getPath.value,
                vertexOffset * 3
            );
            colors.set(
                data.attributes.instanceColors.value,
                vertexOffset * 4
            );
            widths.set(
                data.attributes.instanceStrokeWidths.value,
                vertexOffset
            );
            offsets.set(
                data.attributes.instanceOffsets.value,
                vertexOffset
            );
            if (zIndices) {
                const values = data.zIndices;
                if (values) {
                    zIndices.set(values, pathOffset);
                } else {
                    zIndices.fill(
                        Number.NaN,
                        pathOffset,
                        pathOffset + data.length
                    );
                }
            }
            if (offsetVectors && offsetScaleThresholds) {
                offsetVectors.set(
                    data.offsetVectorsPx!.subarray(
                        0,
                        contributionVertexCount * 2
                    ),
                    vertexOffset * 2
                );
                for (let pathIndex = 0;
                     pathIndex < data.length;
                     ++pathIndex) {
                    offsetScaleThresholds[pathOffset + pathIndex] =
                        data.offsetScaleThresholds?.[pathIndex] ?? 0;
                }
            }
            const contributionDashes =
                data.attributes.instanceDashArrays?.value;
            if (dashes) {
                if (contributionDashes) {
                    dashes.set(
                        contributionDashes,
                        vertexOffset * 2
                    );
                } else {
                    for (let index = 0;
                         index < contributionVertexCount;
                         ++index) {
                        dashes[(vertexOffset + index) * 2] = 1;
                    }
                }
            }
            for (let index = 1; index < data.startIndices.length; ++index) {
                startIndices[pathOffset + index] =
                    vertexOffset + data.startIndices[index];
            }
            for (let index = 0;
                 index < data.featureAddressesByPath.length;
                 ++index) {
                addresses[pathOffset + index] = picks.remap(
                    contribution,
                    data.featureAddressesByPath[index]
                );
            }
            vertexOffset += contributionVertexCount;
            pathOffset += data.length;
        }
        const first = contributions[0].data;
        const objectZIndexOffsets = zIndices
            ? buildZIndexOffsets(zIndices, addresses)
            : undefined;
        const zIndexOffsets = objectZIndexOffsets
            ? expandObjectValues(objectZIndexOffsets, startIndices)
            : undefined;
        return {
            pickResolver: picks.resolve,
            data: {
                length: addresses.length,
                billboard: first.billboard,
                depthTest: first.depthTest,
                coordinateOrigin: first.coordinateOrigin,
                startIndices,
                featureAddressesByPath: addresses,
                offsetVectorsPx: offsetVectors,
                offsetScaleThresholds,
                zIndices,
                attributes: {
                    getPath: {
                        value: positions,
                        size: 3
                    },
                    instanceColors: {
                        value: colors,
                        size: 4
                    },
                    instanceStrokeWidths: {
                        value: widths,
                        size: 1
                    },
                    instanceOffsets: {
                        value: offsets,
                        size: 1
                    },
                    ...(zIndexOffsets
                        ? {zIndexOffsets: {
                            value: zIndexOffsets,
                            size: 1
                        }}
                        : {}),
                    ...(offsetVectors
                        ? {instanceVariableOffsets: {
                            value: packVariablePathOffsetVectors(
                                offsetVectors,
                                startIndices,
                                offsetScaleThresholds),
                            size: 4
                        }}
                        : {}),
                    ...(dashes
                        ? {instanceDashArrays: {
                            value: dashes,
                            size: 2
                        }}
                        : {})
                }
            }
        };
    }

    private mergePointContributions(
        raw: ReadonlyMap<string, unknown>
    ): SharedPrimitiveContribution<DeckPointData> | null {
        const contributions = [...raw.values()] as Array<
            SharedPrimitiveContribution<DeckPointData>>;
        if (!contributions.length) {
            return null;
        }
        const picks = this.arenaPickTable(contributions);
        const hasZIndex = contributions.some(contribution =>
            Boolean(contribution.data.zIndices));
        const pointCount = contributions.reduce(
            (sum, contribution) => sum + contribution.data.length,
            0
        );
        const positions = new Float32Array(pointCount * 3);
        const colors = new Uint8Array(pointCount * 4);
        const radii = new Float32Array(pointCount);
        const zIndices = hasZIndex
            ? new Float64Array(pointCount)
            : undefined;
        const addresses = new Uint32Array(pointCount);
        let pointOffset = 0;
        for (const contribution of contributions) {
            const data = contribution.data;
            positions.set(
                data.attributes.getPosition.value,
                pointOffset * 3
            );
            colors.set(
                data.attributes.getFillColor.value,
                pointOffset * 4
            );
            radii.set(data.attributes.getRadius.value, pointOffset);
            if (zIndices) {
                const values = data.zIndices;
                if (values) {
                    zIndices.set(values, pointOffset);
                } else {
                    zIndices.fill(
                        Number.NaN,
                        pointOffset,
                        pointOffset + data.length
                    );
                }
            }
            for (let index = 0; index < data.featureAddresses.length; ++index) {
                addresses[pointOffset + index] = picks.remap(
                    contribution,
                    data.featureAddresses[index]
                );
            }
            pointOffset += data.length;
        }
        const first = contributions[0].data;
        const zIndexOffsets = zIndices
            ? buildZIndexOffsets(zIndices, addresses)
            : undefined;
        return {
            pickResolver: picks.resolve,
            data: {
                length: addresses.length,
                billboard: first.billboard,
                depthTest: first.depthTest,
                coordinateOrigin: first.coordinateOrigin,
                featureAddresses: addresses,
                zIndices,
                attributes: {
                    getPosition: {
                        value: positions,
                        size: 3
                    },
                    getFillColor: {
                        value: colors,
                        size: 4
                    },
                    getRadius: {
                        value: radii,
                        size: 1
                    },
                    ...(zIndexOffsets
                        ? {zIndexOffsets: {
                            value: zIndexOffsets,
                            size: 1
                        }}
                        : {})
                }
            }
        };
    }

    private arenaPickTable<T>(
        contributions: Array<SharedPrimitiveContribution<T>>
    ): {
        remap: (
            contribution: SharedPrimitiveContribution<T>,
            localAddress: number
        ) => number;
        resolve: PickResolver;
    } {
        const entries: Array<{
            resolver: PickResolver;
            localAddress: number;
        }> = [];
        const byContribution = new Map<
            SharedPrimitiveContribution<T>,
            Map<number, number>>();
        return {
            remap: (contribution, localAddress) => {
                if (localAddress === UNSELECTABLE) {
                    return UNSELECTABLE;
                }
                let addresses = byContribution.get(contribution);
                if (!addresses) {
                    addresses = new Map();
                    byContribution.set(contribution, addresses);
                }
                const existing = addresses.get(localAddress);
                if (existing !== undefined) {
                    return existing;
                }
                const mapped = entries.length;
                entries.push({
                    resolver: contribution.pickResolver,
                    localAddress
                });
                addresses.set(localAddress, mapped);
                return mapped;
            },
            resolve: mappedAddress => {
                const entry = entries[mappedAddress];
                return entry
                    ? entry.resolver(entry.localAddress)
                    : [];
            }
        };
    }

    private arenaGroupKey(
        kind: string,
        depthTest: boolean,
        billboard: boolean,
        origin: [number, number, number]
    ): string {
        return [
            "subset-arena",
            encodeURIComponent(this.config.ownerId),
            `view-${this.config.viewIndex}`,
            kind,
            billboard ? "billboard" : "world",
            depthTest ? "depth" : "overlay",
            origin.map(value => value.toPrecision(15)).join(",")
        ].join("/");
    }

    private trackArenaRegistration(
        arena: DeckRenderBufferArena,
        groupKey: string,
        sourceId: string,
        desired: Set<string>
    ): void {
        const key = `${groupKey}\n${sourceId}`;
        const previous = this.arenaRegistrations.get(key);
        if (previous && previous.arena !== arena) {
            previous.arena.remove(previous.groupKey, previous.sourceId);
        }
        this.arenaRegistrations.set(key, {arena, groupKey, sourceId});
        desired.add(key);
    }

    private reconcileLayers(desired: ReadonlySet<string>): void {
        if (!this.registry) {
            return;
        }
        for (const key of this.layerKeys) {
            if (!desired.has(key)) {
                this.registry.remove(key);
            }
        }
        this.layerKeys.clear();
        for (const key of desired) {
            this.layerKeys.add(key);
        }
    }

    private reconcileArena(desired: ReadonlySet<string>): void {
        for (const [key, registration] of [...this.arenaRegistrations]) {
            if (desired.has(key)) {
                continue;
            }
            registration.arena.remove(
                registration.groupKey,
                registration.sourceId
            );
            this.arenaRegistrations.delete(key);
        }
    }

    private removeArenaContributions(): void {
        for (const registration of this.arenaRegistrations.values()) {
            registration.arena.remove(
                registration.groupKey,
                registration.sourceId
            );
        }
        this.arenaRegistrations.clear();
    }
}
