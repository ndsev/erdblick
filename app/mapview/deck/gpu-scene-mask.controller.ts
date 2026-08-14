import {COORDINATE_SYSTEM} from "@deck.gl/core";
import {Texture, type Device} from "@luma.gl/core";

import type {DeckInteractionEffect, DeckRgba} from
    "./deck-interaction-effect";
import type {DeckInteractionOutlineService} from
    "./deck-interaction-outline.service";
import {
    ErdblickVectorMaskLayer,
    type ErdblickVectorMaskConfiguration
} from "./erdblick-vector.layer";
import {GpuSceneMaskMode} from "./erdblick-vector.shaders";
import type {GpuScene} from "./gpu-scene";
import type {TileSubsetInteractionOverlay} from
    "./tile-subset-interaction.model";

const TARGET_TEXTURE_WIDTH = 1024;
const ZERO_INITIALIZATION_ROWS = 64;
const VECTOR_SOURCE_ID = "scene-vector";
const STYLE_GLOW_ORDER = 300;

interface MaskOwner {
    contributions: ReadonlySet<string>;
    stripeAnchor: [number, number, number];
    overlays: readonly TileSubsetInteractionOverlay[];
}

interface DesiredMaskGroup {
    groupId: string;
    effect: DeckInteractionEffect;
    order: number;
    stripeAnchor: [number, number, number];
    mode: GpuSceneMaskMode.Target | GpuSceneMaskMode.Union;
    materialKeys: ReadonlySet<bigint> | null;
    targetEntries: Map<number, DeckRgba>;
    identityColor: DeckRgba;
}

interface InstalledMaskGroup {
    targetTable: SparseMaskTargetTable;
    vectorLayer: ErdblickVectorMaskLayer;
}

/**
 * Sparse CPU index and GPU texture for one semantic interaction target set.
 *
 * Only selected object indices are retained on the CPU. Texture growth is
 * geometric and target changes upload contiguous changed row spans rather
 * than walking or copying any vector geometry.
 */
class SparseMaskTargetTable {
    private targetTexture: Texture;
    private height = 1;
    private entries = new Map<number, DeckRgba>();

    /** Allocate the minimum sampled texture; target updates grow it transactionally. */
    constructor(
        private readonly device: Device,
        private readonly id: string
    ) {
        this.targetTexture = this.createTexture(this.height);
    }

    /** Update sparse identities and return the current sampled texture. */
    update(next: ReadonlyMap<number, DeckRgba>, requiredRecords: number): Texture {
        const nextHeight = this.requiredHeight(requiredRecords);
        if (nextHeight !== this.height) {
            const replacement = this.createTexture(nextHeight);
            try {
                this.uploadChangedEntries(
                    replacement,
                    new Set(next.keys()),
                    next
                );
            } catch (error) {
                replacement.destroy();
                throw error;
            }
            const previous = this.targetTexture;
            this.targetTexture = replacement;
            this.height = nextHeight;
            this.entries = new Map(next);
            previous.destroy();
            return replacement;
        }
        const changed = new Set<number>();
        for (const [index, color] of next) {
            const current = this.entries.get(index);
            if (!current || current.some((value, offset) =>
                value !== color[offset])) {
                changed.add(index);
            }
        }
        for (const index of this.entries.keys()) {
            if (!next.has(index)) {
                changed.add(index);
            }
        }
        this.uploadChangedEntries(this.targetTexture, changed, next);
        this.entries = new Map(next);
        return this.targetTexture;
    }

    /** Release the sampled target texture. */
    destroy(): void {
        this.targetTexture.destroy();
        this.entries.clear();
    }

    get texture(): Texture {
        return this.targetTexture;
    }

    /** Resolve geometric texture growth without mutating the active table. */
    private requiredHeight(requiredRecords: number): number {
        let nextHeight = this.height;
        while (nextHeight * TARGET_TEXTURE_WIDTH < Math.max(1, requiredRecords)) {
            nextHeight *= 2;
        }
        return nextHeight;
    }

    /** Upload sorted changed indices as maximal contiguous spans within rows. */
    private uploadChangedEntries(
        texture: Texture,
        changed: ReadonlySet<number>,
        next: ReadonlyMap<number, DeckRgba>
    ): void {
        const indices = [...changed]
            .filter(index => Number.isInteger(index) && index >= 0)
            .sort((left, right) => left - right);
        for (let first = 0; first < indices.length;) {
            const firstIndex = indices[first];
            const row = Math.floor(firstIndex / TARGET_TEXTURE_WIDTH);
            let last = first;
            while (last + 1 < indices.length &&
                   indices[last + 1] === indices[last] + 1 &&
                   Math.floor(indices[last + 1] / TARGET_TEXTURE_WIDTH) === row) {
                last += 1;
            }
            const bytes = new Uint8Array((last - first + 1) * 4);
            for (let index = first; index <= last; ++index) {
                bytes.set(next.get(indices[index]) ?? [0, 0, 0, 0],
                    (index - first) * 4);
            }
            texture.writeData(bytes, {
                x: firstIndex % TARGET_TEXTURE_WIDTH,
                y: row,
                width: last - first + 1,
                height: 1
            });
            first = last + 1;
        }
    }

    /** Allocate a nearest-sampled normalized identity texture. */
    private createTexture(height: number): Texture {
        const texture = this.device.createTexture({
            id: this.id,
            dimension: "2d",
            format: "rgba8unorm",
            width: TARGET_TEXTURE_WIDTH,
            height,
            usage: Texture.SAMPLE | Texture.COPY_DST,
            sampler: {
                minFilter: "nearest",
                magFilter: "nearest",
                addressModeU: "clamp-to-edge",
                addressModeV: "clamp-to-edge"
            }
        });
        // Newly allocated WebGL texture storage has undefined contents. Clear
        // it in bounded chunks so sparse mask lookups can never select stale
        // identities outside the explicitly uploaded target entries.
        const zeroRows = new Uint8Array(
            TARGET_TEXTURE_WIDTH * ZERO_INITIALIZATION_ROWS * 4
        );
        try {
            for (let y = 0; y < height; y += ZERO_INITIALIZATION_ROWS) {
                const rowCount = Math.min(ZERO_INITIALIZATION_ROWS, height - y);
                texture.writeData(
                    rowCount === ZERO_INITIALIZATION_ROWS
                        ? zeroRows
                        : zeroRows.subarray(
                            0,
                            TARGET_TEXTURE_WIDTH * rowCount * 4
                        ),
                    {
                        x: 0,
                        y,
                        width: TARGET_TEXTURE_WIDTH,
                        height: rowCount
                    }
                );
            }
        } catch (error) {
            texture.destroy();
            throw error;
        }
        return texture;
    }
}

/**
 * Per-view interaction/glow owner over the persistent GpuScene buffers.
 *
 * Visualizations contribute only semantic target sets and stripe anchors.
 * The controller coalesces them into a bounded number of sparse target
 * textures and mask passes; it never creates geometry-sized JavaScript data.
 */
export class GpuSceneMaskController {
    private readonly owners = new Map<string, MaskOwner>();
    private readonly groups = new Map<string, InstalledMaskGroup>();
    private reconcileHandle: number | null = null;
    private destroyed = false;

    /** Bind semantic overlays to one scene and its shared outline compositor. */
    constructor(
        private readonly device: Device,
        private readonly scene: GpuScene,
        private readonly outlineService: DeckInteractionOutlineService,
        private readonly flattenZ: boolean
    ) {}

    /** Replace one visualization's exact local targets and schedule one reconciliation. */
    setOverlays(
        ownerId: string,
        contributionIdentities: ReadonlySet<string>,
        stripeAnchor: [number, number, number],
        overlays: readonly TileSubsetInteractionOverlay[]
    ): void {
        if (this.destroyed) {
            return;
        }
        if (overlays.length === 0) {
            this.removeOwner(ownerId);
            return;
        }
        this.owners.set(ownerId, {
            contributions: new Set(contributionIdentities),
            stripeAnchor: [...stripeAnchor],
            overlays: [...overlays]
        });
        this.scheduleReconcile();
    }

    /** Remove every transient mask contribution associated with one visualization. */
    removeOwner(ownerId: string): void {
        if (this.owners.delete(ownerId)) {
            this.scheduleReconcile();
        }
    }

    /** Refresh sparse targets and shared material models after a scene packet mutation. */
    sceneChanged(): void {
        if (!this.destroyed) {
            this.scheduleReconcile();
        }
    }

    /** Tear down all hidden layers, sparse textures, and scheduled work. */
    destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        if (this.reconcileHandle !== null) {
            window.cancelAnimationFrame(this.reconcileHandle);
            this.reconcileHandle = null;
        }
        this.owners.clear();
        for (const [groupId, group] of this.groups) {
            this.outlineService.removeMask(groupId, VECTOR_SOURCE_ID);
            group.targetTable.destroy();
        }
        this.groups.clear();
    }

    /** Collapse scene materials and owner overlays into final compositor groups. */
    private desiredGroups(): Map<string, DesiredMaskGroup> {
        const result = new Map<string, DesiredMaskGroup>();
        this.addStyleGlowGroups(result);
        for (const owner of this.owners.values()) {
            for (const overlay of owner.overlays) {
                const groupId = `gpu-interaction/${overlay.id}`;
                let group = result.get(groupId);
                if (!group) {
                    group = {
                        groupId,
                        effect: overlay.effect,
                        order: overlay.order + 1,
                        stripeAnchor: [...owner.stripeAnchor],
                        mode: GpuSceneMaskMode.Target,
                        materialKeys: null,
                        targetEntries: new Map(),
                        identityColor: [0, 0, 0, 0]
                    };
                    result.set(groupId, group);
                }
                for (const pick of this.scene.interactionPicks(
                    owner.contributions,
                    overlay.targets
                )) {
                    group.targetEntries.set(
                        pick.globalPickIndex,
                        this.outlineService.identityColor(
                            groupId,
                            pick.identityKey,
                            overlay.effect,
                            overlay.order + 1
                        )
                    );
                }
            }
        }
        for (const [groupId, group] of result) {
            if (group.mode === GpuSceneMaskMode.Target &&
                group.targetEntries.size === 0) {
                result.delete(groupId);
            }
        }
        return result;
    }

    /** Build union-glow groups directly from exact stream material metadata. */
    private addStyleGlowGroups(
        result: Map<string, DesiredMaskGroup>
    ): void {
        // Style glows do not use map-anchored striping. Avoid retaining an
        // otherwise empty owner merely to supply an irrelevant anchor.
        const anchor: [number, number, number] = [0, 0, 0];
        for (const material of this.scene.materialStores()) {
            if (material.store.activeRecordCount === 0 ||
                material.glowColor[3] === 0 || material.glowRadius <= 0) {
                continue;
            }
            const materialId = `${material.glowColor.join(",")}:` +
                `${material.glowRadius}`;
            const groupId = `gpu-style-glow/${materialId}`;
            const effect = styleGlowEffect(
                material.glowColor,
                material.glowRadius
            );
            let group = result.get(groupId);
            if (!group) {
                group = {
                    groupId,
                    effect,
                    order: STYLE_GLOW_ORDER,
                    stripeAnchor: [...anchor],
                    mode: GpuSceneMaskMode.Union,
                    materialKeys: new Set<bigint>(),
                    targetEntries: new Map(),
                    identityColor: this.outlineService.identityColor(
                        groupId,
                        "style-glow-union",
                        effect,
                        STYLE_GLOW_ORDER
                    )
                };
                result.set(groupId, group);
            }
            (group.materialKeys as Set<bigint>).add(
                material.store.materialKey
            );
        }
    }

    /** Install, mutate, or remove the bounded hidden layer set. */
    private reconcile(): void {
        this.reconcileHandle = null;
        if (this.destroyed) {
            return;
        }
        const desired = this.desiredGroups();
        for (const [groupId, installed] of this.groups) {
            if (desired.has(groupId)) {
                continue;
            }
            this.outlineService.removeMask(groupId, VECTOR_SOURCE_ID);
            installed.targetTable.destroy();
            this.groups.delete(groupId);
        }
        for (const [groupId, group] of desired) {
            this.outlineService.configureGroup(
                groupId,
                group.effect,
                group.order,
                group.stripeAnchor
            );
            let installed = this.groups.get(groupId);
            if (!installed) {
                installed = this.installGroup(group);
                this.groups.set(groupId, installed);
            }
            const targetTexture = installed.targetTable.update(
                group.targetEntries,
                group.mode === GpuSceneMaskMode.Target
                    ? this.scene.pickingHighWater
                    : 0
            );
            const vectorConfiguration: ErdblickVectorMaskConfiguration = {
                targetTexture,
                mode: group.mode,
                identityColor: group.identityColor,
                materialKeys: group.materialKeys
            };
            installed.vectorLayer.configure(vectorConfiguration);
            installed.vectorLayer.sceneChanged();
        }
    }

    /** Register one identity pass whose private depth buffer contains only target geometry. */
    private installGroup(group: DesiredMaskGroup): InstalledMaskGroup {
        const targetTable = new SparseMaskTargetTable(
            this.device,
            `gpu-mask-target-${encodeURIComponent(group.groupId)}`
        );
        const baseProps = {
            data: [],
            scene: this.scene,
            flattenZ: this.flattenZ,
            coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
            pickable: true,
            drillPickEligible: false
        };
        let vectorLayer!: ErdblickVectorMaskLayer;
        this.outlineService.upsertMask(
            group.groupId,
            VECTOR_SOURCE_ID,
            group.effect,
            group.order,
            group.stripeAnchor,
            layerId => vectorLayer = new ErdblickVectorMaskLayer({
                ...baseProps,
                id: layerId,
                configuration: {
                    targetTexture: targetTable.texture,
                    mode: group.mode,
                    identityColor: group.identityColor,
                    materialKeys: group.materialKeys
                }
            })
        );
        return {
            targetTable,
            vectorLayer
        };
    }

    /** Coalesce arbitrary packet/selection bursts behind one animation frame. */
    private scheduleReconcile(): void {
        if (this.reconcileHandle !== null) {
            return;
        }
        this.reconcileHandle = window.requestAnimationFrame(() =>
            this.reconcile());
    }
}

/** Convert one native stream glow material into the common compositor effect. */
function styleGlowEffect(
    color: DeckRgba,
    radius: number
): DeckInteractionEffect {
    return {
        tintMix: 0,
        opacity: 1,
        edgeWidth: 0,
        haloColor: color,
        haloRadius: radius,
        haloOpacity: 1,
        interiorHalo: false,
        stripeSpacing: 0,
        stripeWidth: 0,
        stripeOpacity: 0,
        stripeAngle: 45,
        stripeOffset: 0,
        stripeSoftness: 1
    };
}
