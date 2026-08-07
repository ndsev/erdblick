import type {Matrix4} from "@math.gl/core";

import type {PresentationKind} from
    "../../mapdata/styled-mapget-layer.model";
import type {TileFeatureId} from "../../shared/appstate.service";
import {DeckLayerRegistry} from "./deck-layer-registry";
import type {
    DeckInteractionEffect
} from "./deck-interaction-effect";
import {DeckInteractionOutlineService} from
    "./deck-interaction-outline.service";
import type {
    DeckSubsetInteractionProps,
    SubsetPickResolver
} from "./deck-subset-picking";
import {
    buildTileSubsetInteractionPathData,
    buildTileSubsetInteractionPathMask,
    buildTileSubsetInteractionPointData,
    buildTileSubsetInteractionPointMask,
    buildTileSubsetInteractionSurfaceMask,
    groupTileSubsetGlows,
    tileSubsetGlowEffect,
    type DeckGlowMaterial
} from "./tile-subset-interaction-data";
import {TileSubsetGltfPresentation, type TileSubsetGltfSource} from
    "./tile-subset-gltf-presentation";
import {
    compileTileSubsetArrowMarkers,
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
    type TileSubsetVectorSource
} from "./tile-subset-vector-presentation";

const UNSELECTABLE = 0xffffffff;
const MASK_NO_DEPTH_PARAMETERS = {
    depthTest: false,
    depthMask: false,
    blend: false
} as any;

export type TileSubsetInteractionScope =
    "feature" | "attribute" | "relation" | "group";

/** One view-owned interaction material applied to exact locally retained picks. */
export interface TileSubsetInteractionOverlay {
    id: string;
    targets: readonly TileFeatureId[];
    effect: DeckInteractionEffect;
    order: number;
}

export interface TileSubsetInteractionSource extends TileSubsetVectorSource {
    gltf: TileSubsetGltfSource | null;
}

export interface TileSubsetInteractionPresentationOptions {
    visualizationId: string;
    ownerId: string;
    presentationKind: PresentationKind;
    styleOrder: number;
    viewIndex: number;
}

interface InstalledOutlineSource {
    groupId: string;
    sourceId: string;
}

/**
 * Exact lifecycle owner for style glows and local hover/selection overlays.
 *
 * It consumes immutable vector/GLTF presentation sources, owns every direct
 * interaction layer and compositor mask derived from them, and maintains the
 * address-to-terminal-scope index used by `ViewLayerController`.
 */
export class TileSubsetInteractionPresentation {
    private readonly layerKeys = new Set<string>();
    private readonly interactionOutlineSources = new Map<
        string,
        InstalledOutlineSource
    >();
    private readonly styleGlowOutlineSources = new Map<
        string,
        InstalledOutlineSource
    >();
    private readonly targetKeys = new Set<string>();
    private readonly scopesByTarget = new Map<
        string,
        Set<TileSubsetInteractionScope>
    >();
    private source: TileSubsetInteractionSource | null = null;
    private overlays: readonly TileSubsetInteractionOverlay[] = [];
    private registry: DeckLayerRegistry | null = null;
    private outlineService: DeckInteractionOutlineService | null = null;
    private destroyed = false;

    constructor(
        private readonly options: TileSubsetInteractionPresentationOptions,
        private readonly gltfPresentation: TileSubsetGltfPresentation,
        private readonly resolvePick: SubsetPickResolver,
        private readonly resolveScope: (
            address: number
        ) => TileSubsetInteractionScope
    ) {}

    hasLocalTarget(
        target: TileFeatureId,
        scope?: TileSubsetInteractionScope
    ): boolean {
        if (!this.source) {
            return false;
        }
        const key = this.targetKey(target);
        return scope
            ? this.scopesByTarget.get(key)?.has(scope) ?? false
            : this.targetKeys.has(key);
    }

    setOverlays(overlays: readonly TileSubsetInteractionOverlay[]): void {
        if (this.destroyed) {
            return;
        }
        // Hover/selection subsets are already authored interaction
        // visualizations. Feeding them into the generic mask would compound
        // translucent geometry and apply the material twice.
        const kind = this.options.presentationKind;
        this.overlays = kind === "hover" || kind === "selection"
            ? []
            : overlays;
        this.refreshInteractionOverlays();
    }

    /** Installs a new immutable source and refreshes source-authored glows. */
    installSource(
        source: TileSubsetInteractionSource,
        registry: DeckLayerRegistry,
        outlineService: DeckInteractionOutlineService | null
    ): void {
        if (this.destroyed) {
            return;
        }
        this.attach(registry, outlineService);
        this.source = source;
        this.refreshStyleGlows();
    }

    /** Rebuilds semantic target indices after the owning pick table changes. */
    refreshPickTargets(): void {
        if (this.destroyed) {
            return;
        }
        this.rebuildTargetIndex();
        this.refreshInteractionOverlays();
    }

    /** Removes all source-derived state while retaining this owner for reuse. */
    clear(
        registry: DeckLayerRegistry,
        outlineService: DeckInteractionOutlineService | null
    ): void {
        if (this.destroyed) {
            return;
        }
        this.attach(registry, outlineService);
        this.source = null;
        this.targetKeys.clear();
        this.scopesByTarget.clear();
        this.refreshStyleGlows();
        this.refreshInteractionOverlays();
    }

    destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.removeDirectLayers(this.registry);
        if (this.registry) {
            this.gltfPresentation.reconcileInteractions(
                this.registry,
                new Set()
            );
        }
        this.removeOutlineSources(
            this.outlineService,
            this.interactionOutlineSources
        );
        this.removeOutlineSources(
            this.outlineService,
            this.styleGlowOutlineSources
        );
        this.source = null;
        this.overlays = [];
        this.targetKeys.clear();
        this.scopesByTarget.clear();
        this.registry = null;
        this.outlineService = null;
    }

    private attach(
        registry: DeckLayerRegistry,
        outlineService: DeckInteractionOutlineService | null
    ): void {
        if (this.registry !== registry) {
            this.removeDirectLayers(this.registry);
            if (this.registry) {
                this.gltfPresentation.reconcileInteractions(
                    this.registry,
                    new Set()
                );
            }
            this.registry = registry;
        }
        if (this.outlineService !== outlineService) {
            this.removeOutlineSources(
                this.outlineService,
                this.interactionOutlineSources
            );
            this.removeOutlineSources(
                this.outlineService,
                this.styleGlowOutlineSources
            );
            this.outlineService = outlineService;
        }
    }

    /** Installs persistent style-owned glows through the shared mask compositor. */
    private refreshStyleGlows(): void {
        const source = this.source;
        const service = this.outlineService;
        if (!source || !service || this.destroyed) {
            this.reconcileOutlineSources(
                service,
                this.styleGlowOutlineSources,
                new Set()
            );
            return;
        }
        const desired = new Set<string>();
        const noPick: SubsetPickResolver = () => [];
        const maskInteraction: DeckSubsetInteractionProps = {
            pickable: true,
            drillPickEligible: false
        };
        const order = 300 + this.options.styleOrder;
        const register = (
            kind: "path" | "arrow" | "point" | "surface",
            bucketIndex: number,
            material: DeckGlowMaterial,
            indices: ReadonlySet<number>,
            data: DeckPathData | DeckPointData | DeckSurfaceData
        ): void => {
            const effect = tileSubsetGlowEffect(material);
            const groupId = this.styleGlowGroupId(material);
            const sourceId = [
                this.options.visualizationId,
                kind,
                bucketIndex,
                material.key
            ].join("/");
            const token = `${groupId}\n${sourceId}`;
            // One literal style glow is a union silhouette. A shared identity
            // removes dark seams where glowing paths or triangles overlap.
            const identity = (_address: number) => service.identityColor(
                groupId,
                "style-glow-union",
                effect,
                order
            );
            let mask: DeckPathData | DeckPointData | DeckSurfaceData |
                DeckArrowMarker[] | null;
            if (kind === "arrow") {
                mask = compileTileSubsetArrowMarkers(
                    data as DeckPathData,
                    index => indices.has(index));
            } else if (kind === "path") {
                mask = buildTileSubsetInteractionPathMask(
                    data as DeckPathData,
                    () => true,
                    identity,
                    index => indices.has(index));
            } else if (kind === "point") {
                mask = buildTileSubsetInteractionPointMask(
                    data as DeckPointData,
                    () => true,
                    identity,
                    index => indices.has(index));
            } else {
                mask = buildTileSubsetInteractionSurfaceMask(
                    data as DeckSurfaceData,
                    () => true,
                    identity,
                    index => indices.has(index));
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
            for (const {material, indices} of groupTileSubsetGlows(
                data.glowColors,
                data.glowRadii,
                data.length)) {
                register("path", bucketIndex, material, indices, data);
            }
        });
        source.arrows.forEach((data, bucketIndex) => {
            for (const {material, indices} of groupTileSubsetGlows(
                data.glowColors,
                data.glowRadii,
                data.length)) {
                register("arrow", bucketIndex, material, indices, data);
            }
        });
        source.points.forEach((data, bucketIndex) => {
            for (const {material, indices} of groupTileSubsetGlows(
                data.glowColors,
                data.glowRadii,
                data.length)) {
                register("point", bucketIndex, material, indices, data);
            }
        });
        source.surfaces.forEach((data, bucketIndex) => {
            for (const {material, indices} of groupTileSubsetGlows(
                data.glowColors,
                data.glowRadii,
                data.length)) {
                register("surface", bucketIndex, material, indices, data);
            }
        });
        this.reconcileOutlineSources(
            service,
            this.styleGlowOutlineSources,
            desired
        );
    }

    /** Rebuilds only the small layers/masks whose exact pick rows are active. */
    private refreshInteractionOverlays(): void {
        const registry = this.registry;
        const source = this.source;
        if (!registry || this.destroyed) {
            return;
        }
        if (!source) {
            this.removeDirectLayers(registry);
            this.gltfPresentation.reconcileInteractions(registry, new Set());
            this.reconcileOutlineSources(
                this.outlineService,
                this.interactionOutlineSources,
                new Set()
            );
            return;
        }
        const desired = new Set<string>();
        const desiredGltf = new Set<string>();
        const desiredOutlines = new Set<string>();
        const service = this.outlineService;
        const overlays = this.overlays.map(overlay => ({
            id: overlay.id,
            targets: new Set(overlay.targets.map(target =>
                this.targetKey(target))),
            effect: overlay.effect,
            order: overlay.order
        }));
        const noInteraction: DeckSubsetInteractionProps = {
            pickable: false,
            drillPickEligible: false
        };
        const noPick: SubsetPickResolver = () => [];

        for (const overlay of overlays) {
            if (overlay.targets.size === 0) {
                continue;
            }
            const matches = (address: number) =>
                this.matchesAddress(address, overlay.targets);
            const groupId = service
                ? this.interactionOutlineGroupId(overlay.id)
                : null;

            for (let pathIndex = 0;
                 pathIndex < source.paths.length;
                 ++pathIndex) {
                const path = source.paths[pathIndex];
                if (service && groupId) {
                    const mask = buildTileSubsetInteractionPathMask(
                        path,
                        matches,
                        address => service.identityColor(
                            groupId,
                            this.maskIdentity(address),
                            overlay.effect,
                            overlay.order + 1));
                    if (!mask) {
                        continue;
                    }
                    const sourceId = [
                        this.options.visualizationId,
                        `path-${pathIndex}`,
                        path.billboard ? "billboard" : "world",
                        path.depthTest ? "depth" : "overlay"
                    ].join("/");
                    const token = `${groupId}\n${sourceId}`;
                    service.upsertMask(
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
                const main = buildTileSubsetInteractionPathData(
                    path,
                    overlay.effect,
                    matches);
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
                if (service && groupId) {
                    const mask = buildTileSubsetInteractionPointMask(
                        point,
                        matches,
                        address => service.identityColor(
                            groupId,
                            this.maskIdentity(address),
                            overlay.effect,
                            overlay.order + 1));
                    if (!mask) {
                        continue;
                    }
                    const sourceId = [
                        this.options.visualizationId,
                        `point-${pointIndex}`,
                        point.billboard ? "billboard" : "world",
                        point.depthTest ? "depth" : "overlay"
                    ].join("/");
                    const token = `${groupId}\n${sourceId}`;
                    service.upsertMask(
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
                const main = buildTileSubsetInteractionPointData(
                    point,
                    overlay.effect,
                    matches);
                if (!main) {
                    continue;
                }
                const key = this.interactionKey(
                    overlay.id,
                    `point-${pointIndex}`,
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

            if (service && groupId) {
                for (let surfaceIndex = 0;
                     surfaceIndex < source.surfaces.length;
                     ++surfaceIndex) {
                    const surface = source.surfaces[surfaceIndex];
                    const mask = buildTileSubsetInteractionSurfaceMask(
                        surface,
                        matches,
                        address => service.identityColor(
                            groupId,
                            this.maskIdentity(address),
                            overlay.effect,
                            overlay.order + 1));
                    if (!mask) {
                        continue;
                    }
                    const sourceId = [
                        this.options.visualizationId,
                        `surface-${surfaceIndex}`,
                        surface.depthTest ? "depth" : "overlay"
                    ].join("/");
                    const token = `${groupId}\n${sourceId}`;
                    service.upsertMask(
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

            // Arrowheads and labels remain semantic decorations of their
            // owning path/feature and are not independently highlighted.
            if (source.gltf) {
                const token = this.gltfPresentation.installInteraction(
                    registry,
                    source.gltf,
                    overlay,
                    matches
                );
                if (token) {
                    desiredGltf.add(token);
                }
            }
        }

        this.reconcileDirectLayers(registry, desired);
        this.gltfPresentation.reconcileInteractions(registry, desiredGltf);
        this.reconcileOutlineSources(
            service,
            this.interactionOutlineSources,
            desiredOutlines
        );
    }

    private featureAddresses(): number[] {
        const source = this.source;
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

    private rebuildTargetIndex(): void {
        this.targetKeys.clear();
        this.scopesByTarget.clear();
        for (const address of this.featureAddresses()) {
            const scope = this.resolveScope(address);
            for (const target of this.resolvePick(address)) {
                const key = this.targetKey(target);
                this.targetKeys.add(key);
                let scopes = this.scopesByTarget.get(key);
                if (!scopes) {
                    scopes = new Set<TileSubsetInteractionScope>();
                    this.scopesByTarget.set(key, scopes);
                }
                scopes.add(scope);
            }
        }
    }

    private matchesAddress(
        address: number,
        targets: ReadonlySet<string>
    ): boolean {
        return address !== UNSELECTABLE &&
            this.resolvePick(address).some(feature =>
                targets.has(this.targetKey(feature)));
    }

    private targetKey(target: TileFeatureId): string {
        return `${target.mapTileKey}\n${target.featureId}`;
    }

    private maskIdentity(address: number): string {
        const targets = this.resolvePick(address)
            .map(target => this.targetKey(target))
            .sort();
        return targets.length
            ? targets.join("\n")
            : `${this.options.visualizationId}\n${address}`;
    }

    private styleGlowGroupId(material: DeckGlowMaterial): string {
        return [
            this.options.ownerId,
            `view-${this.options.viewIndex}`,
            "style-glow",
            encodeURIComponent(material.key)
        ].join("/");
    }

    private interactionOutlineGroupId(overlayId: string): string {
        return [
            this.options.ownerId,
            `view-${this.options.viewIndex}`,
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
            this.options.visualizationId,
            "interaction",
            encodeURIComponent(overlayId),
            kind,
            billboard ? "billboard" : "world",
            depthTest ? "source-depth" : "source-overlay"
        ].join("/");
    }

    private reconcileDirectLayers(
        registry: DeckLayerRegistry,
        desired: ReadonlySet<string>
    ): void {
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

    private removeDirectLayers(registry: DeckLayerRegistry | null): void {
        if (registry) {
            for (const key of this.layerKeys) {
                registry.remove(key);
            }
        }
        this.layerKeys.clear();
    }

    private reconcileOutlineSources(
        service: DeckInteractionOutlineService | null,
        installed: Map<string, InstalledOutlineSource>,
        desired: ReadonlySet<string>
    ): void {
        if (!service) {
            installed.clear();
            return;
        }
        for (const [token, source] of installed) {
            if (!desired.has(token)) {
                service.removeMask(source.groupId, source.sourceId);
                installed.delete(token);
            }
        }
    }

    private removeOutlineSources(
        service: DeckInteractionOutlineService | null,
        installed: Map<string, InstalledOutlineSource>
    ): void {
        if (service) {
            for (const source of installed.values()) {
                service.removeMask(source.groupId, source.sourceId);
            }
        }
        installed.clear();
    }
}
