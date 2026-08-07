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
import type {
    TileSubsetLabelDatum,
    TileSubsetLayerRenderBuffers
} from "./tile-subset-layer-render.worker.protocol";
import {
    compileTileSubsetArrowMarkers,
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
        extensions: variableOffset
            ? [
                new PathStyleExtension({dash: true}),
                new DeckVariablePathOffsetExtension()
            ]
            : [new PathStyleExtension({dash: true, offset: true})],
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
        extensions: [new DeckLocalPixelOffsetExtension()],
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

        const labels = [...result.labelWorld, ...result.labelBillboard].map(
            label => ({
                ...label,
                position: [
                    label.position.x,
                    label.position.y,
                    label.position.z
                ] as [number, number, number]
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
        const positions: number[] = [];
        const colors: number[] = [];
        const indices: number[] = [];
        const starts = [0];
        const addresses: number[] = [];
        const normals: number[] = [];
        for (const contribution of contributions) {
            const data = contribution.data;
            const vertexBase = positions.length / 3;
            this.appendValues(positions, data.attributes.getPolygon.value);
            this.appendValues(colors, data.attributes.fillColors.value);
            for (const index of data.attributes.indices.value) {
                indices.push(index + vertexBase);
            }
            for (let index = 1; index < data.startIndices.length; ++index) {
                starts.push(vertexBase + data.startIndices[index]);
            }
            for (const address of data.featureAddresses) {
                addresses.push(picks.remap(contribution, address));
            }
            this.appendValues(normals, data.surfaceNormals);
        }
        const first = contributions[0].data;
        return {
            pickResolver: picks.resolve,
            data: {
                length: addresses.length,
                depthTest: first.depthTest,
                coordinateOrigin: first.coordinateOrigin,
                startIndices: new Uint32Array(starts),
                featureAddresses: new Uint32Array(addresses),
                surfaceNormals: new Float32Array(normals),
                attributes: {
                    getPolygon: {
                        value: new Float32Array(positions),
                        size: 3
                    },
                    indices: {
                        value: new Uint32Array(indices),
                        size: 1
                    },
                    fillColors: {
                        value: new Uint8Array(colors),
                        size: 4
                    }
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
        const positions: number[] = [];
        const colors: number[] = [];
        const widths: number[] = [];
        const offsets: number[] = [];
        const offsetVectors: number[] = [];
        const offsetScaleThresholds: number[] = [];
        const dashes: number[] = [];
        const starts = [0];
        const addresses: number[] = [];
        const hasDashes = contributions.some(contribution =>
            !!contribution.data.attributes.instanceDashArrays);
        for (const contribution of contributions) {
            const data = contribution.data;
            const vertexBase = positions.length / 3;
            const vertexCount = data.attributes.getPath.value.length / 3;
            this.appendValues(positions, data.attributes.getPath.value);
            this.appendValues(colors, data.attributes.instanceColors.value);
            this.appendValues(widths, data.attributes.instanceStrokeWidths.value);
            this.appendValues(offsets, data.attributes.instanceOffsets.value);
            if (variableOffset) {
                if (!data.offsetVectorsPx ||
                    data.offsetVectorsPx.length < vertexCount * 2) {
                    return null;
                }
                this.appendValues(offsetVectors, data.offsetVectorsPx);
                for (let pathIndex = 0;
                     pathIndex < data.length;
                     ++pathIndex) {
                    offsetScaleThresholds.push(
                        data.offsetScaleThresholds?.[pathIndex] ?? 0);
                }
            }
            const contributionDashes =
                data.attributes.instanceDashArrays?.value;
            if (hasDashes) {
                if (contributionDashes) {
                    this.appendValues(dashes, contributionDashes);
                } else {
                    for (let index = 0; index < vertexCount; ++index) {
                        dashes.push(1, 0);
                    }
                }
            }
            for (let index = 1; index < data.startIndices.length; ++index) {
                starts.push(vertexBase + data.startIndices[index]);
            }
            for (const address of data.featureAddressesByPath) {
                addresses.push(picks.remap(contribution, address));
            }
        }
        const first = contributions[0].data;
        const startIndices = new Uint32Array(starts);
        const offsetValues = new Float32Array(offsets);
        const offsetVectorValues = variableOffset
            ? new Float32Array(offsetVectors)
            : undefined;
        return {
            pickResolver: picks.resolve,
            data: {
                length: addresses.length,
                billboard: first.billboard,
                depthTest: first.depthTest,
                coordinateOrigin: first.coordinateOrigin,
                startIndices,
                featureAddressesByPath: new Uint32Array(addresses),
                offsetVectorsPx: offsetVectorValues,
                offsetScaleThresholds: variableOffset
                    ? new Float32Array(offsetScaleThresholds)
                    : undefined,
                attributes: {
                    getPath: {
                        value: new Float32Array(positions),
                        size: 3
                    },
                    instanceColors: {
                        value: new Uint8Array(colors),
                        size: 4
                    },
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
                    ...(hasDashes
                        ? {instanceDashArrays: {
                            value: new Float32Array(dashes),
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
        const positions: number[] = [];
        const colors: number[] = [];
        const radii: number[] = [];
        const addresses: number[] = [];
        for (const contribution of contributions) {
            const data = contribution.data;
            this.appendValues(positions, data.attributes.getPosition.value);
            this.appendValues(colors, data.attributes.getFillColor.value);
            this.appendValues(radii, data.attributes.getRadius.value);
            for (const address of data.featureAddresses) {
                addresses.push(picks.remap(contribution, address));
            }
        }
        const first = contributions[0].data;
        return {
            pickResolver: picks.resolve,
            data: {
                length: addresses.length,
                billboard: first.billboard,
                depthTest: first.depthTest,
                coordinateOrigin: first.coordinateOrigin,
                featureAddresses: new Uint32Array(addresses),
                attributes: {
                    getPosition: {
                        value: new Float32Array(positions),
                        size: 3
                    },
                    getFillColor: {
                        value: new Uint8Array(colors),
                        size: 4
                    },
                    getRadius: {
                        value: new Float32Array(radii),
                        size: 1
                    }
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

    private appendValues(
        target: number[],
        source: ArrayLike<number>
    ): void {
        for (let index = 0; index < source.length; ++index) {
            target.push(Number(source[index]));
        }
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
