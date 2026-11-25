import type { Device } from "@luma.gl/core";
import { Matrix4 } from "@math.gl/core";
import type { TileFeatureId } from "../../inspection/inspection.model";
import { SceneMode } from "../../integrations/geo.adapter";
import { coreLib, uint8ArrayToWasm } from "../../integrations/wasm.adapter";
import type { FilterTileState } from "../../mapdata/filter-tile-state.model";
import type { StyledMapgetLayer } from "../../mapdata/styled-mapget-layer.presentation";
import type { PointCloudRenderPolicy } from "../point-cloud-policy.model";
import {
    formatFeatureInspectionTarget,
    parseFeatureInspectionTarget,
    type FeaturePickIdentity,
    type FeaturePickTarget
} from "../../inspection/feature-identity.model";
import { sipHash64Hex } from "../../utils/hash.util";
import type { StyleValidationReportService } from "../../mapstyle/style-validation-report.service";
import type { IRenderSceneHandle } from "../render-view.model";
import { DeckLayerRegistry } from "./deck-layer-registry.util";
import {
    deckSubsetInteractionProps,
    type SubsetPickResolver as PickResolver
} from "./deck-subset-picking.util";
import { gpuIconAtlas } from "./gpu-icon-atlas.visualization";
import {
    GpuResourceKind,
    type GpuResourceRequestView,
    type GpuRuntimeIssueView
} from "./gpu-render-packet.model";
import {
    GpuScene,
    type GpuSceneApplyResult,
    type GpuScenePickReference,
    type GpuSceneRenderReservation
} from "./gpu-scene.visualization";
import type { GpuSceneMaskController } from "./gpu-scene-mask.controller";
import {
    TileSubsetGltfPresentation,
    type TileSubsetGltfSource
} from "./tile-subset-gltf.presentation";
import {
    type TileSubsetInteractionOverlay
} from "./tile-subset-interaction.model";
import { StaleSubsetRenderError, TileSubsetLayerRenderService } from "./tile-subset-layer-render.service";
import type {
    PointCloudPickResult,
    TileSubsetLayerRenderBuffers,
    TileSubsetPickResult
} from "./tile-subset-layer-render.worker.protocol";

export type { TileSubsetInteractionOverlay } from "./tile-subset-interaction.model";

interface DeckScene {
    layerRegistry?: DeckLayerRegistry;
    sceneMode?: SceneMode;
    device?: Device | null;
    gpuScene?: GpuScene | null;
    gpuMaskController?: GpuSceneMaskController | null;
}

interface GpuPickSubset {
    numEntries(): number;
    channelSchema(ordinal: number): {scope: string; entryCount: number} | undefined;
    resolvePick(
        channelOrdinal: number,
        entryOrdinal: number,
        endpointRole: number
    ): TileSubsetPickResult | undefined;
    findPickReferences(
        featureId: string,
        scope: string,
        entryIndex: bigint,
        validityIndex: bigint
    ): GpuScenePickReference[];
    findShapePointPickReferences(
        featureId: string,
        geometryOrdinal: number,
        pointIndex: number,
        sourceId: string
    ): GpuScenePickReference[];
    delete(): void;
}

/** Bytes used by one installed GPU packet, with the catalog needed to decode its dictionary. */
interface SubsetPickSnapshot {
    readonly blob: Uint8Array;
    readonly valueVersion: number;
    readonly catalogRevision: number;
    /** False for foreign or mixed rows; classify local subsets only when picked. */
    singleLocalFeatureChannel?: boolean;
    lastFeatureRow?: {featureId: string; reference: GpuScenePickReference};
}

// A point-cloud worker can release the full subset after supplying compact pick identities.
type GpuPickSource = SubsetPickSnapshot | readonly PointCloudPickResult[];

const FLAT_2D_MODEL_MATRIX = new Matrix4().scale([1, 1, 0]);
const UNSELECTABLE = 0xffffffff;

/**
 * One logical Deck visualization for one independently owned TileSubsetLayer.
 *
 * Each installed packet retains the subset bytes that its picks address. The
 * first interaction decodes those bytes on the main thread. Point-cloud workers
 * return compact identities so the packet can release its full point payload.
 */
export class TileSubsetLayerVisualization {
    readonly visualizationId: string;
    private readonly gltfPresentation: TileSubsetGltfPresentation;
    private readonly contributionIdentities = new Set<string>();
    private interactionOverlays: readonly TileSubsetInteractionOverlay[] = [];
    private gltfPickResults: TileSubsetPickResult[] = [];
    private interactionGltf: TileSubsetGltfSource | null = null;
    private renderedSignature = "";
    private requestedSignature = "";
    private failedSignature = "";
    private disposed = false;
    private gpuPicksRetired = false;
    private pointCloud: PointCloudRenderPolicy | undefined;
    private pointCloudScale: number | null = null;
    private sceneHandle: IRenderSceneHandle | null = null;
    private sceneRevision = 0;
    private lod: number;
    private lineSimplificationToleranceMeters: number;
    private readonly reportedRuntimeIssueIds = new Set<string>();
    private readonly pendingIconUris = new Set<string>();
    private readonly failedIconUris = new Set<string>();
    private pickSubset: GpuPickSubset | null = null;
    private pickSubsetValueVersion = -1;
    private pickSubsetCatalogRevision = -1;

    /** Retain one immutable tile subset and its stable scene contribution identity. */
    constructor(
        readonly owner: StyledMapgetLayer,
        readonly state: FilterTileState,
        readonly renderKey: string,
        private coordinateOrigin: [number, number, number] | null,
        private readonly renderService: TileSubsetLayerRenderService,
        private readonly styleValidationReports: StyleValidationReportService,
        lod: number,
        lineSimplificationToleranceMeters: number,
        readonly viewIndex: number,
        private readonly requestRerender: (
            visualization: TileSubsetLayerVisualization
        ) => void
    ) {
        this.visualizationId = [
            owner.ownerId,
            `view-${viewIndex}`,
            encodeURIComponent(renderKey)
        ].join("/");
        this.gltfPresentation = new TileSubsetGltfPresentation(
            owner,
            state
        );
        this.lod = lod;
        this.lineSimplificationToleranceMeters =
            lineSimplificationToleranceMeters;
        this.contributionIdentities.add(this.contributionIdentity(state));
        owner.retainTileState(state);
    }

    /** Reports whether an exact feature/validity/relation/group pick is retained locally. */
    hasLocalInteractionTarget(
        target: TileFeatureId
    ): boolean {
        const scene = this.sceneHandle
            ? this.gpuScene(this.sceneHandle)
            : null;
        return scene?.hasInteractionTarget(
            this.contributionIdentities,
            target
        ) ?? false;
    }

    /** Replaces this visualization's view-owned local interaction overlay definitions. */
    setInteractionOverlays(
        overlays: readonly TileSubsetInteractionOverlay[]
    ): void {
        this.interactionOverlays = overlays;
        if (!this.sceneHandle || !this.coordinateOrigin) {
            return;
        }
        this.maskController(this.sceneHandle)?.setOverlays(
            this.interactionMaskOwnerId(),
            this.contributionIdentities,
            this.coordinateOrigin,
            overlays
        );
        const registry = this.registry(this.sceneHandle);
        if (registry) {
            this.refreshGltfInteractions(registry);
        }
    }

    /** Refresh count-based sampling and the immutable worker cache identity. */
    setPointCloudScale(metersPerPixel: number | null): void {
        this.pointCloudScale = metersPerPixel;
        if (!this.owner.filterPlan.channels.some(channel => channel.pointCloudMaxPoints !== undefined)) return;
        this.renderService.registerPointCloud(this.visualizationId);
        const next = this.renderService.pointCloudPolicyFor(this.visualizationId, metersPerPixel,
            this.pointCloud?.spacingMeters);
        next.cacheKey = JSON.stringify([this.owner.mapInfo.mapMetadataGeneration(this.state.mapId), this.owner.ownerId,
        this.state.mapTileKey, this.state.valueVersion]);
        if (JSON.stringify(next) === JSON.stringify(this.pointCloud)) return;
        this.pointCloud = next;
        this.renderService.cancel(this.visualizationId);
        this.renderedSignature = "";
        this.requestedSignature = "";
    }

    /** Rerender changed line detail without tearing down the installed GLTF asset. */
    setLineSimplificationTolerance(lineSimplificationToleranceMeters: number): void {
        if (this.lineSimplificationToleranceMeters === lineSimplificationToleranceMeters) {
            return;
        }
        this.lineSimplificationToleranceMeters = lineSimplificationToleranceMeters;
        // Keep the current geometry visible until its successor is ready, but
        // reject in-flight output using the previous camera's simplification.
        this.renderedSignature = "";
        this.requestedSignature = "";
    }

    /** Update GPU-filtered entry and label visibility without rerendering the subset. */
    setLod(lod: number): void {
        if (lod === this.lod) {
            return;
        }
        this.lod = lod;
        const scene = this.sceneHandle
            ? this.gpuScene(this.sceneHandle)
            : null;
        scene?.setContributionLod(
            this.contributionIdentity(this.state),
            lod
        );
    }

    /** Require a complete immutable subset before consuming worker credit. */
    private isReadyForRender(): boolean {
        return this.state.status === "ready" && !!this.state.subsetBlob;
    }

    /** True once every current immutable input version is installed in Deck. */
    isCurrentPresentationInstalled(): boolean {
        return this.renderedSignature.length > 0 &&
            this.state.status === "ready" &&
            this.state.renderedValueVersion === this.state.valueVersion;
    }

    /** Render one tile in WASM and publish all packet fragments as one scene revision. */
    async render(sceneHandle: IRenderSceneHandle): Promise<boolean> {
        if (this.sceneHandle && this.sceneHandle !== sceneHandle) {
            this.sceneRevision += 1;
        }
        this.sceneHandle = sceneHandle;
        if (this.disposed || !this.isReadyForRender()) {
            return false;
        }
        const dataSourceInfoBlob =
            this.owner.mapInfo.getRenderDataSourceInfoBlob(this.state.mapId);
        if (!dataSourceInfoBlob) {
            return false;
        }
        // Add-on composition may give a delivered layer a combined string-pool
        // namespace which differs from the catalog datasource's namespace.
        // The worker must decode the subset against the namespace serialized in
        // that exact value, not the MapgetLayer catalog entry.
        const stringPoolId = this.state.stringPoolId;
        const fieldDictBlob = this.owner.mapInfo.getFieldDictBlob(
            stringPoolId
        );
        if (!fieldDictBlob) {
            return false;
        }
        const scene = this.gpuScene(sceneHandle);
        if (!scene) {
            return false;
        }
        const renderOrigin: [number, number, number] =
            this.coordinateOrigin ?? [0, 0, 0];
        const nativeOrigin = this.state.partition.kind === "object";
        this.setPointCloudScale(this.pointCloudScale);
        const signature = [
            `${this.state.mapTileKey}:${this.state.valueVersion}`,
            this.owner.plannedLod,
            this.lineSimplificationToleranceMeters,
            JSON.stringify(this.pointCloud),
            this.owner.style.id,
            this.owner.renderStyleKey,
            this.owner.styleOrder,
            nativeOrigin ? "native-origin" : renderOrigin.join(","),
            this.sceneRevision,
            gpuIconAtlas.catalogVersion
        ].join("|");
        if (signature === this.renderedSignature || signature === this.requestedSignature) {
            return true;
        }
        // A rejected immutable job must not be resubmitted on every scheduler tick.
        if (signature === this.failedSignature)
            return false;
        this.requestedSignature = signature;
        const valueVersion = this.state.valueVersion;
        const subsetBlob = this.state.subsetBlob!;
        const catalogRevision = this.owner.mapInfo.mapMetadataGeneration(this.state.mapId);
        const sceneRevision = this.sceneRevision;
        const startedAt = performance.now();
        // The old packet stays interactive while its replacement is being prepared.
        // Its row ordinals continue to address the snapshot that produced it.
        const dependencies = this.state.dependencies;
        let pickSource: GpuPickSource = this.pointCloud ? [] : {
            blob: subsetBlob, valueVersion, catalogRevision,
            singleLocalFeatureChannel: dependencies.length === 1 &&
                dependencies[0].sourceTileKey === this.state.mapTileKey ? undefined : false
        };
        const picksAvailable = () => !this.gpuPicksRetired &&
            catalogRevision === this.owner.mapInfo.mapMetadataGeneration(this.state.mapId);
        const reservation = scene.prepareRender(
            `${this.viewIndex}:${nativeOrigin
                ? this.state.mapTileKey
                : this.renderKey}`,
            nativeOrigin ? null : renderOrigin,
            [{
                identity: this.contributionIdentity(this.state),
                mapTileKey: this.state.mapTileKey,
                styleOrder: this.owner.styleOrder,
                lod: this.lod,
                resolvePick: reference =>
                    picksAvailable() ? this.resolveGpuPick(reference, pickSource) : undefined,
                findPickReferences: targetFeatureId =>
                    picksAvailable() ? this.findGpuPickReferences(targetFeatureId, pickSource) : []
            }]
        );
        const contribution = reservation.contributions[0];
        const admitted = { result: null as GpuSceneApplyResult | null };
        try {
            const result = await this.renderService.render({
                visualizationId: this.visualizationId,
                renderSignature: signature,
                viewIndex: this.viewIndex,
                renderKey: this.renderKey,
                mapTileKey: this.state.mapTileKey,
                ...(nativeOrigin ? {} : { coordinateOrigin: renderOrigin }),
                sceneGeneration: reservation.sceneGeneration,
                packetSequence: reservation.packetSequence,
                iconCatalogVersion: gpuIconAtlas.catalogVersion,
                originSlot: reservation.origin.slot,
                originKeyLow: Number(reservation.origin.key & 0xffffffffn),
                originKeyHigh: Number(
                    (reservation.origin.key >> 32n) & 0xffffffffn
                ),
                contribution: {
                    keyLow: Number(contribution.key & 0xffffffffn),
                    keyHigh: Number((contribution.key >> 32n) & 0xffffffffn),
                    revision: contribution.revision,
                    slot: contribution.slot,
                    activationToken: contribution.activationToken
                },
                mapId: this.state.mapId,
                catalogRevision,
                dataSourceInfoBlob,
                schemas: this.owner.mapInfo.getSchemaArtifacts([this.state.mapId]),
                stringPoolId,
                fieldDictBlob,
                subsetBlob,
                inputGeometryVertexCount: this.state.geometryVertexCount,
                styleKey: this.owner.renderStyleKey,
                styleSource: this.owner.style.source,
                highlightModeValue: this.owner.highlightMode.value,
                lod: this.owner.plannedLod,
                lineSimplificationToleranceMeters:
                    this.lineSimplificationToleranceMeters,
                pointCloud: this.pointCloud
            }, packet => {
                if (!this.isRenderCurrent(
                    sceneHandle,
                    scene,
                    reservation,
                    signature,
                    sceneRevision,
                    valueVersion
                )) {
                    throw new StaleSubsetRenderError();
                }
                admitted.result = scene.applyPacket(
                    packet,
                    reservation
                );
            }, buffers => {
                if (!this.isRenderCurrent(
                    sceneHandle,
                    scene,
                    reservation,
                    signature,
                    sceneRevision,
                    valueVersion
                )) {
                    throw new StaleSubsetRenderError();
                }
                const origin = this.parseCoordinateOrigin(
                    buffers.bridge.coordinateOrigin
                );
                if (!origin) {
                    throw new Error(
                        "Subset renderer returned an invalid geometry anchor."
                    );
                }
                if (!("blob" in pickSource)) {
                    pickSource = buffers.bridge.pointCloudPicks ?? [];
                }
                scene.resolveRenderOrigin(reservation, origin);
                this.coordinateOrigin = origin;
            });
            if (!admitted.result || !this.isRenderCurrent(
                sceneHandle,
                scene,
                reservation,
                signature,
                sceneRevision,
                valueVersion
            )) {
                return false;
            }
            const runtimeIssues = await this.applyResult(
                sceneHandle,
                result,
                signature,
                sceneRevision,
                reservation,
                admitted.result
            );
            if (!runtimeIssues) {
                return false;
            }
            this.renderedSignature = signature;
            this.failedSignature = "";
            this.requestedSignature = "";
            this.installRenderStats(
                result,
                valueVersion,
                performance.now() - startedAt
            );
            this.recordRuntimeStyleIssues(runtimeIssues);
            return true;
        } catch (error) {
            if (error instanceof StaleSubsetRenderError) {
                return false;
            }
            this.requestedSignature = "";
            this.failedSignature = signature;
            throw error;
        } finally {
            scene.finishRender(reservation);
        }
    }

    /** Verify that a completed worker packet still targets the active tile revision. */
    private isRenderCurrent(
        sceneHandle: IRenderSceneHandle,
        scene: GpuScene,
        reservation: GpuSceneRenderReservation,
        signature: string,
        sceneRevision: number,
        valueVersion: number
    ): boolean {
        return !this.disposed &&
            signature === this.requestedSignature &&
            this.sceneHandle === sceneHandle &&
            this.sceneRevision === sceneRevision &&
            scene.accepts(reservation) &&
            this.state.valueVersion === valueVersion;
    }

    /** Expands compact worker diagnostics into the application's canonical style-issue stream. */
    private recordRuntimeStyleIssues(
        issues: readonly GpuRuntimeIssueView[]
    ): void {
        for (const issue of issues) {
            const id = [
                "subset-runtime",
                this.owner.renderStyleKey,
                this.renderKey,
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
                source: { ...this.owner.style.sourceRef },
                message: issue.occurrenceCount > 1
                    ? `${issue.message} (${issue.occurrenceCount} occurrences)`
                    : issue.message,
                ruleIndex: issue.ruleIndex,
                rulePath: `rules[${issue.ruleIndex}]`,
                property: issue.property,
                expression: issue.expression,
                runtimeContext: {
                    mapName: this.state.mapId,
                    layerName: this.owner.mapgetLayer.layerId,
                    tileKey: this.renderKey,
                    renderPath: "worker"
                }
            });
        }
    }

    /** Publish native and client timings only after the matching revision is visible. */
    private installRenderStats(
        result: TileSubsetLayerRenderBuffers,
        valueVersion: number,
        clientWallMs: number
    ): void {
        this.state.renderedValueVersion = valueVersion;
        this.state.renderStats = {
            subsetBytes: this.state.subsetBlob?.byteLength ?? 0,
            deserializeMs: result.timings.deserializeMs,
            runMs: result.timings.runMs,
            packetMs: result.timings.packetMs,
            bridgeMs: result.timings.bridgeMs,
            renderMs: result.timings.renderMs,
            totalMs: result.timings.deserializeMs + result.timings.renderMs,
            clientWallMs,
            vertexCount: result.vertexCount,
            ...(this.pointCloud ? {
                pointCloudDeliveredCount: result.pointCloudDeliveredCount ?? 0,
                pointCloudRenderedCount: result.pointCloudRenderedCount ?? 0,
                workerMemoryBytes: result.wasmMemoryBytes ?? 0
            } : {})
        };
    }

    /** Rebind to a recreated GPU scene without bypassing controller backpressure. */
    reattach(sceneHandle: IRenderSceneHandle): void {
        if (this.sceneHandle !== sceneHandle) {
            this.sceneRevision += 1;
        }
        this.sceneHandle = sceneHandle;
        this.renderedSignature = "";
        this.requestedSignature = "";
    }

    /** Remove one stable contribution identity and refresh every shared scene host it affects. */
    static retireContribution(
        sceneHandle: IRenderSceneHandle | null,
        identity: string
    ): void {
        this.retireContributions(sceneHandle, [identity]);
    }

    /** Remove many persistent vector owners in one scene transaction. */
    static retireContributions(
        sceneHandle: IRenderSceneHandle | null,
        identities: Iterable<string>
    ): void {
        if (!sceneHandle) {
            return;
        }
        const retiredIdentities = [...identities];
        const scene = sceneHandle.scene as DeckScene | undefined;
        for (const identity of retiredIdentities) {
            scene?.gpuMaskController?.removeOwner(
                this.interactionMaskOwnerId(identity)
            );
        }
        scene?.gpuScene?.removeContributions(retiredIdentities);
    }

    /** Permanently retire many independent tile owners as one GPU mutation. */
    static destroyMany(
        visualizations: readonly TileSubsetLayerVisualization[],
        sceneHandle: IRenderSceneHandle | null
    ): void {
        const retiredIdentities: string[] = [];
        for (const visualization of visualizations) {
            visualization.dispose(
                sceneHandle,
                false,
                identity => retiredIdentities.push(identity)
            );
        }
        this.retireContributions(sceneHandle, retiredIdentities);
    }

    /**
     * Destroy this tile owner, optionally transferring its stable GPU identity
     * to the pending successor which will replace the same tile atomically.
     */
    destroy(
        sceneHandle: IRenderSceneHandle | null = this.sceneHandle,
        preserveContribution = false
    ): string | null {
        return this.dispose(
            sceneHandle,
            preserveContribution,
            identity => TileSubsetLayerVisualization.retireContribution(
                sceneHandle,
                identity
            )
        );
    }

    /** Release local ownership while delegating persistent-scene retirement. */
    private dispose(
        sceneHandle: IRenderSceneHandle | null,
        preserveContribution: boolean,
        retireContribution: (identity: string) => void
    ): string | null {
        if (this.disposed) {
            return null;
        }
        this.disposed = true;
        this.renderService.unregisterPointCloud(this.visualizationId);
        const preservedIdentity = preserveContribution && sceneHandle
            ? this.contributionIdentity(this.state)
            : null;
        this.gpuPicksRetired = preservedIdentity === null;
        this.renderService.cancel(this.visualizationId);
        const registry = sceneHandle ? this.registry(sceneHandle) : null;
        this.gltfPresentation.destroy(registry);
        this.interactionGltf = null;
        if (sceneHandle) {
            const identity = this.contributionIdentity(this.state);
            if (identity !== preservedIdentity) {
                retireContribution(identity);
            }
        }
        this.owner.releaseTileState(this.state);
        this.contributionIdentities.clear();
        this.interactionOverlays = [];
        this.gltfPickResults = [];
        this.pickSubset?.delete();
        this.pickSubset = null;
        this.pickSubsetValueVersion = -1;
        this.pickSubsetCatalogRevision = -1;
        this.pendingIconUris.clear();
        this.failedIconUris.clear();
        this.sceneHandle = null;
        return preservedIdentity;
    }

    /** Refresh stable scene hosts and install the temporary GLTF bridge atomically. */
    private async applyResult(
        sceneHandle: IRenderSceneHandle,
        result: TileSubsetLayerRenderBuffers,
        signature: string,
        sceneRevision: number,
        reservation: GpuSceneRenderReservation,
        applied: GpuSceneApplyResult
    ): Promise<readonly GpuRuntimeIssueView[] | null> {
        const registry = this.registry(sceneHandle);
        if (!registry) {
            return null;
        }
        const scene = this.gpuScene(sceneHandle);
        if (!scene || !scene.accepts(reservation)) {
            return null;
        }
        this.requestMissingIcons(applied.resourceRequests);
        const maskController = this.maskController(sceneHandle);
        const origin = this.parseCoordinateOrigin(
            result.bridge.coordinateOrigin
        );
        if (!origin) {
            this.gltfPresentation.clear(registry);
            this.interactionGltf = null;
            return applied.issues;
        }
        this.coordinateOrigin = origin;
        maskController?.setOverlays(
            this.interactionMaskOwnerId(),
            this.contributionIdentities,
            origin,
            this.interactionOverlays
        );
        const preparedGltf = await this.gltfPresentation.prepare(
            result.bridge,
            (sceneHandle.scene as DeckScene | undefined)?.device ?? null,
            origin
        );
        if (this.disposed ||
            signature !== this.requestedSignature ||
            this.sceneHandle !== sceneHandle ||
            this.sceneRevision !== sceneRevision) {
            this.gltfPresentation.discard(preparedGltf);
            return null;
        }
        const modelMatrix = this.modelMatrix(sceneHandle);
        const interaction = deckSubsetInteractionProps(
            this.owner.identity.presentationKind,
            this.owner.highlightMode.value,
            coreLib.HighlightMode.NO_HIGHLIGHT.value,
            (sceneHandle.scene as DeckScene | undefined)?.sceneMode
        );
        this.gltfPickResults = result.bridge.pickResults ?? [];
        const pickResolver: PickResolver = pickIndex => this.resolvePick(pickIndex);
        this.interactionGltf = this.gltfPresentation.install(
            registry,
            result.bridge,
            origin,
            modelMatrix,
            pickResolver,
            interaction,
            preparedGltf
        );
        this.refreshGltfInteractions(registry);
        return applied.issues;
    }

    /** Load unresolved packet icons once, then rerender against the advanced catalog. */
    private requestMissingIcons(
        requests: readonly GpuResourceRequestView[]
    ): void {
        for (const request of requests) {
            const uri = request.uri.trim();
            if (request.resourceKind !== GpuResourceKind.Icon || !uri ||
                this.pendingIconUris.has(uri) || this.failedIconUris.has(uri)) {
                continue;
            }
            this.pendingIconUris.add(uri);
            gpuIconAtlas.ensureResource(uri).then(loaded => {
                this.pendingIconUris.delete(uri);
                if (!loaded) {
                    this.failedIconUris.add(uri);
                    return;
                }
                if (this.disposed || !this.sceneHandle) {
                    return;
                }
                this.requestedSignature = "";
                this.requestRerender(this);
            });
        }
    }

    /** Rebuild only the small GLTF tint bridge for active semantic overlays. */
    private refreshGltfInteractions(registry: DeckLayerRegistry): void {
        const source = this.interactionGltf;
        const desired = new Set<string>();
        if (source) {
            for (const overlay of this.interactionOverlays) {
                const targets = new Set(overlay.targets.map(target =>
                    `${target.mapTileKey}\u0000${target.featureId}`
                ));
                const token = this.gltfPresentation.installInteraction(
                    registry,
                    source,
                    overlay,
                    address => this.resolvePick(address).some(target =>
                        targets.has(
                            `${target.mapTileKey}\u0000${target.featureId}`
                        )
                    )
                );
                if (token) {
                    desired.add(token);
                }
            }
        }
        this.gltfPresentation.reconcileInteractions(registry, desired);
    }

    /** Resolve GLTF-local pick addresses through the singleton worker bridge. */
    private resolvePick(pickIndex: number): FeaturePickTarget[] {
        if (!Number.isInteger(pickIndex) ||
            pickIndex < 0 ||
            pickIndex === UNSELECTABLE) {
            return [];
        }
        const result = this.gltfPickResults[pickIndex];
        const featureIds = this.featureIdsForPickResult(result);
        if (featureIds === undefined) {
            return [];
        }
        const identities: readonly FeaturePickIdentity[] = Array.isArray(featureIds)
            ? featureIds : [featureIds as FeaturePickIdentity];
        return identities.map(identity => typeof identity === "string"
            ? {mapTileKey: this.state.mapTileKey, featureId: identity}
            : {mapTileKey: this.state.mapTileKey, ...identity});
    }

    /** Resolve one compact GPU tuple only after Deck reports an actual interaction. */
    private resolveGpuPick(
        reference: GpuScenePickReference,
        source: GpuPickSource
    ): FeaturePickIdentity | readonly FeaturePickIdentity[] | undefined {
        if (!("blob" in source)) {
            return this.featureIdsForPickResult(source.find(pick =>
                pick.channelOrdinal === reference.channelOrdinal &&
                pick.entryOrdinal === reference.entryOrdinal &&
                pick.endpointRole === reference.endpointRole));
        }
        return this.withGpuPickSubset(source, subset => {
            const identity = this.featureIdsForPickResult(subset.resolvePick(
                reference.channelOrdinal, reference.entryOrdinal, reference.endpointRole));
            if (typeof identity === "string" && reference.endpointRole === 0 && source.singleLocalFeatureChannel !== false) {
                // /filter visits each local host once per feature channel. If this channel owns
                // every row, its pointer tuple is the complete reverse lookup for that host.
                if (source.singleLocalFeatureChannel === undefined) {
                    const channel = subset.channelSchema(reference.channelOrdinal);
                    source.singleLocalFeatureChannel = channel?.scope === "feature" &&
                        channel.entryCount < 0xffffffff && channel.entryCount === subset.numEntries();
                }
                if (source.singleLocalFeatureChannel) source.lastFeatureRow = {featureId: identity, reference};
            }
            return identity;
        });
    }

    /** Find all source rows for a mask; a restored target may need a full semantic lookup. */
    private findGpuPickReferences(
        targetFeatureId: string,
        source: GpuPickSource
    ): readonly GpuScenePickReference[] {
        if (!("blob" in source)) {
            const target = parseFeatureInspectionTarget(targetFeatureId);
            return source.filter(pick => {
                if (target.scope === "relation" && pick.relationId) {
                    // A merged two-way identity contains both source descriptor
                    // ordinals. Mirror the native lookup for either endpoint.
                    const marker = `:${target.baseFeatureId}#`;
                    const offset = pick.relationId.indexOf(marker);
                    const ordinal = offset < 0 ? undefined :
                        pick.relationId.slice(offset + marker.length).match(/^\d+/)?.[0];
                    return ordinal !== undefined && Number(ordinal) === target.relationIndex;
                }
                if (target.scope === "feature" &&
                    (pick.attributeIndex !== undefined || pick.relationIndex !== undefined)) {
                    return false;
                }
                const ids = this.featureIdsForPickResult(pick);
                const identities: readonly FeaturePickIdentity[] = ids === undefined ? []
                    : Array.isArray(ids) ? ids : [ids as FeaturePickIdentity];
                return identities.some(id =>
                    id === targetFeatureId);
            });
        }
        const target = parseFeatureInspectionTarget(targetFeatureId);
        if (target.scope === "feature" && source.lastFeatureRow?.featureId === targetFeatureId) {
            return [source.lastFeatureRow.reference];
        }
        if (target.scope === "shapepoint") {
            return this.withGpuPickSubset(source, subset => subset.findShapePointPickReferences(
                target.baseFeatureId,
                target.geometryOrdinal,
                target.pointIndex,
                target.sourceId
            )) ?? [];
        }
        const entryIndex = target.scope === "attribute"
            ? target.attributeIndex
            : target.scope === "relation"
                ? target.relationIndex
                : -1;
        return this.withGpuPickSubset(source, subset => subset.findPickReferences(
            target.baseFeatureId,
            target.scope,
            BigInt(entryIndex),
            BigInt(target.scope === "feature" ? -1 : target.validityIndex ?? -1)
        )) ?? [];
    }

    /** Keep one decoded model while the tile owner can release it on disposal. */
    private withGpuPickSubset<T>(
        snapshot: SubsetPickSnapshot,
        read: (subset: GpuPickSubset) => T
    ): T | undefined {
        if (!this.disposed && this.pickSubsetValueVersion === snapshot.valueVersion &&
            this.pickSubsetCatalogRevision === snapshot.catalogRevision) {
            return this.pickSubset ? read(this.pickSubset) : undefined;
        }
        this.pickSubset?.delete();
        this.pickSubset = null;
        const subset: GpuPickSubset | null = uint8ArrayToWasm(
            data => this.owner.mapInfo.tileLayerParser.readTileSubsetLayer(data),
            snapshot.blob
        );
        if (this.disposed) {
            // A style replacement can preserve this visible packet beyond its
            // owner's lifetime. Release its temporary WASM model after the pick.
            try {
                return subset ? read(subset) : undefined;
            } finally {
                subset?.delete();
            }
        }
        this.pickSubsetValueVersion = snapshot.valueVersion;
        this.pickSubsetCatalogRevision = snapshot.catalogRevision;
        this.pickSubset = subset;
        return subset ? read(subset) : undefined;
    }

    /** Keep foreign references structural while formatting local inspection row suffixes. */
    private featureIdsForPickResult(
        result: TileSubsetPickResult | undefined
    ): FeaturePickIdentity | readonly FeaturePickIdentity[] | undefined {
        if (!result) {
            return undefined;
        }
        if (result.memberFeatureIds?.length || result.memberFeatureReferences?.length) {
            return [...new Set(result.memberFeatureIds ?? []),
                ...(result.memberFeatureReferences ?? []).map(featureReference => ({featureReference}))];
        }
        if (result.relationSourceFeatureId && typeof result.relationIndex === "number" &&
            Number.isInteger(result.relationIndex)) {
            return formatFeatureInspectionTarget({scope: "relation",
                baseFeatureId: result.relationSourceFeatureId, relationIndex: result.relationIndex});
        }
        if (result.featureReference) {
            return {featureReference: result.featureReference,
                ...(result.attributeIndex !== undefined ? {attributeIndex: result.attributeIndex} : {}),
                ...(result.hasValidity ? {validityIndex: result.validityIndex} : {})};
        }
        if (!result.featureId) {
            return undefined;
        }
        if (result.scope === "shapepoint") {
            if (result.geometryOrdinal === undefined || result.pointIndex === undefined ||
                result.sourceId === undefined) {
                return undefined;
            }
            return formatFeatureInspectionTarget({
                scope: "shapepoint",
                baseFeatureId: result.featureId,
                geometryOrdinal: result.geometryOrdinal,
                pointIndex: result.pointIndex,
                sourceId: result.sourceId
            });
        }
        let featureId = result.featureId;
        const attributeIndex = result.attributeIndex;
        const validityIndex = result.validityIndex;
        if (typeof attributeIndex === "number" &&
            Number.isInteger(attributeIndex)) {
            featureId = formatFeatureInspectionTarget({
                scope: "attribute",
                baseFeatureId: result.featureId,
                attributeIndex,
                ...(result.hasValidity &&
                    typeof validityIndex === "number" &&
                    Number.isInteger(validityIndex)
                    ? { validityIndex }
                    : {})
            });
        }
        return featureId;
    }

    /** Read the Deck registry without coupling the generic scene handle interface to Deck. */
    private registry(sceneHandle: IRenderSceneHandle): DeckLayerRegistry | null {
        return (sceneHandle.scene as DeckScene | undefined)?.layerRegistry ?? null;
    }

    /** Resolve the persistent scene owned by the current Deck view generation. */
    private gpuScene(sceneHandle: IRenderSceneHandle): GpuScene | null {
        return (sceneHandle.scene as DeckScene | undefined)?.gpuScene ?? null;
    }

    /** Resolve the shared semantic mask/glow controller for this view. */
    private maskController(
        sceneHandle: IRenderSceneHandle
    ): GpuSceneMaskController | null {
        return (sceneHandle.scene as DeckScene | undefined)
            ?.gpuMaskController ?? null;
    }

    /** Validate the native GLTF bridge origin before constructing a model matrix. */
    private parseCoordinateOrigin(
        raw: Float64Array
    ): [number, number, number] | null {
        return raw.length >= 3 ? [raw[0], raw[1], raw[2]] : null;
    }

    /** Reuse the view's double-precision origin transform, including 2D flattening. */
    private modelMatrix(sceneHandle: IRenderSceneHandle): Matrix4 | null {
        return (sceneHandle.scene as DeckScene | undefined)?.sceneMode === SceneMode.SCENE2D
            ? FLAT_2D_MODEL_MATRIX
            : null;
    }

    /** Stable semantic owner key independent of the worker batch which carries it. */
    private contributionIdentity(state: FilterTileState): string {
        return [
            this.owner.ownerId,
            `view-${this.viewIndex}`,
            state.mapTileKey
        ].join("\u0000");
    }

    /** Keep the semantic mask attached while render-key-specific owners are replaced. */
    private interactionMaskOwnerId(): string {
        return TileSubsetLayerVisualization.interactionMaskOwnerId(
            this.contributionIdentity(this.state)
        );
    }

    /** Derive the mask owner from the contribution identity shared by atomic replacements. */
    private static interactionMaskOwnerId(contributionIdentity: string): string {
        return `interaction-mask\u0000${contributionIdentity}`;
    }

}
