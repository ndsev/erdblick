import type {Device} from "@luma.gl/core";
import type {Matrix4} from "@math.gl/core";

import type {FilterTileState} from "../../mapdata/filter-tile-state.model";
import type {TileAttachmentRef} from "../../mapdata/filter-subscription.model";
import type {StyledMapgetLayer} from "../../mapdata/styled-mapget-layer.model";
import {coreLib} from "../../integrations/wasm";
import {
    DeckGltfNodeLayer,
    DeckGltfPickProxyLayer,
    type DeckGltfNodeStyleContribution,
    type DeckGltfPickProxyDatum,
    type DeckGltfPickProxyStyleContribution
} from "./deck-gltf-node.layer";
import {
    deckTileGltfAssetStore,
    type DeckTileGltfAsset,
    type DeckTileGltfAssetRef,
    type DeckTileGltfAttachmentSource
} from "./deck-tile-gltf-asset";
import {DeckLayerRegistry} from "./deck-layer-registry";
import type {DeckInteractionEffect} from "./deck-interaction-effect";
import {
    deckSubsetGltfPickProxyKey,
    remapGltfPickContributions,
    type DeckSubsetInteractionProps,
    type SubsetPickResolver
} from "./deck-subset-picking";
import {MAX_TILE_SUBSET_RENDER_VERTICES} from "./tile-subset-render-data";
import type {TileSubsetLayerRenderBuffers} from
    "./tile-subset-layer-render.worker.protocol";

const UNSELECTABLE = 0xffffffff;

/** A parsed attachment retained while it is still awaiting atomic installation. */
export interface PreparedTileSubsetGltf {
    asset: DeckTileGltfAsset;
    assetRef: DeckTileGltfAssetRef;
    attachmentRef: TileAttachmentRef;
}

/** GLTF data retained beside vector buffers for local interaction overlays. */
export interface TileSubsetGltfSource {
    key: string;
    asset: DeckTileGltfAsset;
    data: DeckGltfNodeStyleContribution["data"];
    modelMatrix: Matrix4 | null;
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
    pickResolver: SubsetPickResolver;
}

/** Injectable parsed-asset boundary used to keep attachment ownership testable. */
export interface TileSubsetGltfAssetStore {
    retain(source: DeckTileGltfAttachmentSource): DeckTileGltfAssetRef;
}

/**
 * Exact tile-scoped owner for attachment transfer, parsed GLTF retention and
 * all shared Deck contributions derived from one subset presentation.
 */
export class TileSubsetGltfPresentation {
    private active: PreparedTileSubsetGltf | null = null;
    private lifecycleVersion = 0;
    private readonly pendingAttachmentRefs = new Set<TileAttachmentRef>();
    private baseSourceActive = false;
    private pickSourceActive = false;
    private readonly interactionSources = new Map<
        string,
        {key: string; sourceId: string}
    >();

    constructor(
        private readonly owner: StyledMapgetLayer,
        private readonly state: FilterTileState,
        private readonly blockKey: string,
        private readonly blockTileCount: number,
        private readonly assetStore: TileSubsetGltfAssetStore =
            deckTileGltfAssetStore
    ) {}

    /** Fetches and parses the separately transferred GLB without publishing it. */
    async prepare(
        result: TileSubsetLayerRenderBuffers,
        device: Device | null
    ): Promise<PreparedTileSubsetGltf | null> {
        const attachmentName = result.glbAttachmentName?.trim() ?? "";
        if (!attachmentName || !result.gltfNodes.nodeIndices.length || !device) {
            return null;
        }
        if (this.blockTileCount !== 1) {
            throw new Error(
                `GLB-backed subset block '${this.blockKey}' must remain a singleton.`
            );
        }

        const attachmentRef = this.owner.retainAttachment(
            this.state,
            attachmentName
        );
        const lifecycleVersion = this.lifecycleVersion;
        this.pendingAttachmentRefs.add(attachmentRef);
        const tilePosition = coreLib.getTilePosition(this.state.tileId);
        const source: DeckTileGltfAttachmentSource = {
            cacheKey: `${this.state.mapTileKey}:${attachmentName}`,
            attachmentName,
            tilePosition: [
                Number(tilePosition.x),
                Number(tilePosition.y),
                Number(tilePosition.z)
            ],
            readBytes: async () => (await attachmentRef.ready)?.bytes ?? null
        };
        const assetRef = this.assetStore.retain(source);
        let asset: DeckTileGltfAsset | null = null;
        try {
            asset = await assetRef.ready;
        } catch (error) {
            if (attachmentRef.state !== "released") {
                console.warn(
                    `Could not realize GLB attachment '${attachmentName}' for ` +
                    `'${this.state.mapTileKey}'.`,
                    error
                );
            }
        } finally {
            this.pendingAttachmentRefs.delete(attachmentRef);
        }
        if (!asset) {
            assetRef.release();
            attachmentRef.release();
            return null;
        }
        if (lifecycleVersion !== this.lifecycleVersion) {
            assetRef.release();
            attachmentRef.release();
            return null;
        }
        return {asset, assetRef, attachmentRef};
    }

    /** Releases a prepared value rejected by the visualization's stale guard. */
    discard(prepared: PreparedTileSubsetGltf | null): void {
        if (!prepared) {
            return;
        }
        prepared.assetRef.release();
        prepared.attachmentRef.release();
    }

    /** Atomically replaces the base node and pick-proxy contributions. */
    install(
        registry: DeckLayerRegistry,
        result: TileSubsetLayerRenderBuffers,
        origin: [number, number, number],
        modelMatrix: Matrix4 | null,
        pickResolver: SubsetPickResolver,
        interaction: DeckSubsetInteractionProps,
        prepared: PreparedTileSubsetGltf | null
    ): TileSubsetGltfSource | null {
        const raw = result.gltfNodes;
        let source: TileSubsetGltfSource | null = null;
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
            const key = this.gltfKey;
            this.upsertSharedGltf(
                registry,
                key,
                this.owner.ownerId,
                {
                    asset: prepared.asset,
                    order: 375 + this.owner.styleOrder,
                    priority,
                    styleOrder: this.owner.styleOrder,
                    data
                },
                modelMatrix
            );
            this.baseSourceActive = true;
            source = {
                key,
                asset: prepared.asset,
                data,
                modelMatrix
            };
        } else {
            this.removeBaseSource(registry);
        }

        const proxyData = !flatTint ? this.pickProxyData(result) : [];
        if (proxyData.length) {
            const contribution: SharedGltfPickContribution = {
                order: 374 + this.owner.styleOrder,
                coordinateOrigin: origin,
                data: proxyData,
                pickResolver
            };
            registry.upsertShared(
                this.pickKey,
                this.owner.ownerId,
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
                            tileKey: this.state.mapTileKey,
                            subsetPickResolver: remapped.pickResolver
                        })
                    };
                }
            );
            this.pickSourceActive = true;
        } else {
            this.removePickSource(registry);
        }

        this.releaseActive();
        this.active = prepared;
        return source;
    }

    /** Adds one transient hover/selection tint to the shared tile GLTF layer. */
    installInteraction(
        registry: DeckLayerRegistry,
        source: TileSubsetGltfSource,
        overlay: {
            id: string;
            effect: DeckInteractionEffect;
            order: number;
        },
        matches: (featureAddress: number) => boolean
    ): string | null {
        const data = source.data
            .filter(datum => matches(datum.featureAddress))
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
        if (!data.length) {
            return null;
        }
        const sourceId = [
            this.owner.ownerId,
            "interaction",
            overlay.id
        ].join("/");
        const token = `${source.key}\n${sourceId}`;
        this.upsertSharedGltf(
            registry,
            source.key,
            sourceId,
            {
                asset: source.asset,
                order: overlay.order,
                priority: overlay.order,
                styleOrder: overlay.order,
                data
            },
            source.modelMatrix
        );
        this.interactionSources.set(token, {key: source.key, sourceId});
        return token;
    }

    /** Removes interaction contributions not rebuilt by the current overlay set. */
    reconcileInteractions(
        registry: DeckLayerRegistry,
        desired: ReadonlySet<string>
    ): void {
        for (const [token, source] of this.interactionSources) {
            if (!desired.has(token)) {
                registry.removeShared(source.key, source.sourceId);
                this.interactionSources.delete(token);
            }
        }
    }

    /** Removes all GLTF presentation state while retaining this owner for reuse. */
    clear(registry: DeckLayerRegistry | null): void {
        this.lifecycleVersion += 1;
        for (const ref of this.pendingAttachmentRefs) {
            ref.release();
        }
        this.pendingAttachmentRefs.clear();
        if (registry) {
            this.removeBaseSource(registry);
            this.removePickSource(registry);
            this.reconcileInteractions(registry, new Set());
        } else {
            this.baseSourceActive = false;
            this.pickSourceActive = false;
            this.interactionSources.clear();
        }
        this.releaseActive();
    }

    destroy(registry: DeckLayerRegistry | null): void {
        this.clear(registry);
    }

    private get gltfKey(): string {
        return `${this.state.mapTileKey}/gltf`;
    }

    private get pickKey(): string {
        return deckSubsetGltfPickProxyKey(
            this.state.mapTileKey,
            this.owner.ownerId
        );
    }

    private removeBaseSource(registry: DeckLayerRegistry): void {
        if (!this.baseSourceActive) {
            return;
        }
        registry.removeShared(this.gltfKey, this.owner.ownerId);
        this.baseSourceActive = false;
    }

    private removePickSource(registry: DeckLayerRegistry): void {
        if (!this.pickSourceActive) {
            return;
        }
        registry.removeShared(this.pickKey, this.owner.ownerId);
        this.pickSourceActive = false;
    }

    private releaseActive(): void {
        if (!this.active) {
            return;
        }
        this.active.assetRef.release();
        this.active.attachmentRef.release();
        this.active = null;
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
            }
        );
    }

    private pickProxyData(
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
}
