import {Matrix4} from "@math.gl/core";
import type {Device} from "@luma.gl/core";
import type {FilterTileState} from "../../mapdata/filter-tile-state.model";
import type {StyledMapgetLayer} from "../../mapdata/styled-mapget-layer.model";
import type {TileFeatureId} from "../../shared/appstate.service";
import {
    formatFeatureInspectionTarget,
    parseFeatureInspectionTarget
} from "../../shared/tile-feature-id";
import {sipHash64Hex} from "../../styledata/hash";
import {SceneMode} from "../../integrations/geo";
import {coreLib, uint8ArrayToWasm} from "../../integrations/wasm";
import type {IRenderSceneHandle} from "../render-view.model";
import {DeckLayerRegistry} from "./deck-layer-registry";
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
import {
    TileSubsetGltfPresentation,
    type TileSubsetGltfSource
} from "./tile-subset-gltf-presentation";
import {
    type TileSubsetInteractionOverlay
} from "./tile-subset-interaction.model";
import {
    GpuScene,
    type GpuSceneApplyResult,
    type GpuScenePickReference,
    type GpuSceneRenderReservation
} from "./gpu-scene";
import {
    GpuResourceKind,
    type GpuResourceRequestView,
    type GpuRuntimeIssueView
} from "./gpu-render-packet";
import type {ErdblickVectorLayer} from "./erdblick-vector.layer";
import type {GpuTextLayerHost} from "./gpu-text-layer.host";
import type {GpuSceneMaskController} from "./gpu-scene-mask.controller";
import {gpuIconAtlasService} from "./gpu-icon-atlas.service";

export type {TileSubsetInteractionOverlay} from
    "./tile-subset-interaction.model";

interface DeckScene {
    layerRegistry?: DeckLayerRegistry;
    sceneMode?: SceneMode;
    device?: Device | null;
    gpuScene?: GpuScene | null;
    gpuVectorLayers?: readonly ErdblickVectorLayer[];
    gpuTextLayerHost?: GpuTextLayerHost | null;
    gpuMaskController?: GpuSceneMaskController | null;
}

interface GpuPickSubset {
    resolvePick(
        channelOrdinal: number,
        entryOrdinal: number,
        endpointRole: number
    ): TileSubsetPickResult | undefined;
    findPickReferences(
        featureId: string,
        scope: string,
        entryIndex: number,
        validityIndex: number
    ): GpuScenePickReference[];
    delete(): void;
}

const FLAT_2D_MODEL_MATRIX = new Matrix4().scale([1, 1, 0]);
const UNSELECTABLE = 0xffffffff;
/**
 * One logical Deck visualization for one independently owned TileSubsetLayer.
 *
 * Workers resolve compact pick identities while they own the exact parsed
 * subset. The main thread retains only raw immutable bytes and render output.
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
    private disposed = false;
    private sceneHandle: IRenderSceneHandle | null = null;
    private sceneRevision = 0;
    private readonly fidelityValue: number;
    private readonly lineSimplificationToleranceMeters: number;
    private readonly reportedRuntimeIssueIds = new Set<string>();
    private readonly pendingIconUris = new Set<string>();
    private readonly failedIconUris = new Set<string>();
    private pickSubset: GpuPickSubset | null = null;
    private pickSubsetValueVersion = -1;

    /** Retain one immutable tile subset and its stable scene contribution identity. */
    constructor(
        readonly owner: StyledMapgetLayer,
        readonly state: FilterTileState,
        readonly renderKey: string,
        private readonly coordinateOrigin: [number, number, number],
        private readonly renderService: TileSubsetLayerRenderService,
        private readonly styleValidationReports: StyleValidationReportService,
        fidelityValue: number,
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
        this.fidelityValue = fidelityValue;
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
        if (!this.sceneHandle) {
            return;
        }
        this.maskController(this.sceneHandle)?.setOverlays(
            this.visualizationId,
            this.contributionIdentities,
            this.coordinateOrigin,
            overlays
        );
        const registry = this.registry(this.sceneHandle);
        if (registry) {
            this.refreshGltfInteractions(registry);
        }
    }

    /** Test whether reconciliation can preserve this exact visualization owner. */
    hasSameState(
        state: FilterTileState,
        fidelityValue: number,
        lineSimplificationToleranceMeters: number
    ): boolean {
        return this.fidelityValue === fidelityValue &&
            this.lineSimplificationToleranceMeters ===
                lineSimplificationToleranceMeters &&
            state === this.state;
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
        const renderOrigin = this.coordinateOrigin;
        const signature = [
            `${this.state.mapTileKey}:${this.state.valueVersion}`,
            this.fidelityValue,
            this.lineSimplificationToleranceMeters,
            this.owner.style.id,
            this.owner.renderStyleKey,
            this.owner.styleOrder,
            ...renderOrigin,
            this.sceneRevision,
            gpuIconAtlasService.catalogVersion
        ].join("|");
        if (signature === this.renderedSignature || signature === this.requestedSignature) {
            return true;
        }
        this.requestedSignature = signature;
        const valueVersion = this.state.valueVersion;
        const sceneRevision = this.sceneRevision;
        const startedAt = performance.now();
        const reservation = scene.prepareRender(
            `${this.viewIndex}:${this.renderKey}`,
            renderOrigin,
            [{
                identity: this.contributionIdentity(this.state),
                mapTileKey: this.state.mapTileKey,
                styleOrder: this.owner.styleOrder,
                resolvePick: reference =>
                    this.resolveGpuPick(reference),
                findPickReferences: targetFeatureId =>
                    this.findGpuPickReferences(targetFeatureId)
            }]
        );
        const contribution = reservation.contributions[0];
        const admitted = {result: null as GpuSceneApplyResult | null};
        try {
            const result = await this.renderService.render({
                visualizationId: this.visualizationId,
                renderSignature: signature,
                viewIndex: this.viewIndex,
                renderKey: this.renderKey,
                mapTileKey: this.state.mapTileKey,
                tileId: this.state.tileId,
                coordinateOrigin: renderOrigin,
                sceneGeneration: reservation.sceneGeneration,
                packetSequence: reservation.packetSequence,
                iconCatalogVersion: gpuIconAtlasService.catalogVersion,
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
                catalogRevision: this.owner.mapInfo.sourceCatalogRevision ?? 0,
                dataSourceInfoBlob,
                stringPoolId,
                fieldDictBlob,
                subsetBlob: this.state.subsetBlob!,
                inputGeometryVertexCount: this.state.geometryVertexCount,
                styleKey: this.owner.renderStyleKey,
                styleSource: this.owner.style.source,
                highlightModeValue: this.owner.highlightMode.value,
                fidelityValue: this.fidelityValue,
                lineSimplificationToleranceMeters:
                    this.lineSimplificationToleranceMeters
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
                source: {...this.owner.style.sourceRef},
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
            vertexCount: result.vertexCount
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

    /** Remove many persistent vector owners with one scene-host refresh. */
    static retireContributions(
        sceneHandle: IRenderSceneHandle | null,
        identities: Iterable<string>
    ): void {
        if (!sceneHandle) {
            return;
        }
        const scene = (sceneHandle.scene as DeckScene | undefined)
            ?.gpuScene ?? null;
        const labelsChanged = scene?.removeContributions(identities) ?? false;
        for (const layer of (sceneHandle.scene as DeckScene | undefined)
            ?.gpuVectorLayers ?? []) {
            layer.sceneChanged();
        }
        if (labelsChanged) {
            (sceneHandle.scene as DeckScene | undefined)
                ?.gpuTextLayerHost?.sceneChanged();
        }
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
        const preservedIdentity = preserveContribution && sceneHandle
            ? this.contributionIdentity(this.state)
            : null;
        this.renderService.cancel(this.visualizationId);
        const registry = sceneHandle ? this.registry(sceneHandle) : null;
        if (sceneHandle) {
            this.maskController(sceneHandle)?.removeOwner(this.visualizationId);
        }
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
        for (const layer of this.vectorLayers(sceneHandle)) {
            layer.sceneChanged();
        }
        if (applied.labelsChanged) {
            this.textLayerHost(sceneHandle)?.sceneChanged();
        }
        const maskController = this.maskController(sceneHandle);
        maskController?.setOverlays(
            this.visualizationId,
            this.contributionIdentities,
            this.coordinateOrigin,
            this.interactionOverlays
        );
        maskController?.sceneChanged();

        const origin = this.parseCoordinateOrigin(
            result.bridge.coordinateOrigin
        );
        if (!origin) {
            this.gltfPresentation.clear(registry);
            this.interactionGltf = null;
            return applied.issues;
        }
        const preparedGltf = await this.gltfPresentation.prepare(
            result.bridge,
            (sceneHandle.scene as DeckScene | undefined)?.device ?? null
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
            gpuIconAtlasService.ensureResource(uri).then(loaded => {
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
    private resolvePick(pickIndex: number): TileFeatureId[] {
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
        return (typeof featureIds === "string" ? [featureIds] : featureIds)
            .map(featureId => ({
                mapTileKey: this.state.mapTileKey,
                featureId
            }));
    }

    /** Resolve one compact GPU tuple only after Deck reports an actual interaction. */
    private resolveGpuPick(
        reference: GpuScenePickReference
    ): string | readonly string[] | undefined {
        const subset = this.gpuPickSubset();
        return subset
            ? this.featureIdsForPickResult(subset.resolvePick(
                reference.channelOrdinal,
                reference.entryOrdinal,
                reference.endpointRole
            ))
            : undefined;
    }

    /** Locate packet tuples for one restored semantic target without scanning strings. */
    private findGpuPickReferences(
        targetFeatureId: string
    ): readonly GpuScenePickReference[] {
        const subset = this.gpuPickSubset();
        if (!subset) {
            return [];
        }
        const target = parseFeatureInspectionTarget(targetFeatureId);
        const entryIndex = target.scope === "attribute"
            ? target.attributeIndex
            : target.scope === "relation"
                ? target.relationIndex
                : -1;
        return subset.findPickReferences(
            target.baseFeatureId,
            target.scope,
            entryIndex,
            target.scope === "feature"
                ? -1
                : target.validityIndex ?? -1
        );
    }

    /** Lazily parse and retain only an interacted immutable subset revision. */
    private gpuPickSubset(): GpuPickSubset | null {
        if (this.pickSubsetValueVersion === this.state.valueVersion) {
            return this.pickSubset;
        }
        this.pickSubset?.delete();
        this.pickSubset = null;
        this.pickSubsetValueVersion = this.state.valueVersion;
        const blob = this.state.subsetBlob;
        if (!blob) {
            return null;
        }
        this.pickSubset = uint8ArrayToWasm(
            data => this.owner.mapInfo.tileLayerParser.readTileSubsetLayer(data),
            blob
        ) as unknown as GpuPickSubset | null;
        return this.pickSubset;
    }

    /** Convert one native subset result into the canonical inspection target grammar. */
    private featureIdsForPickResult(
        result: TileSubsetPickResult | undefined
    ): string | readonly string[] | undefined {
        if (!result?.featureId) {
            return undefined;
        }
        if (result.memberFeatureIds?.length) {
            return [...new Set(result.memberFeatureIds)];
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

    /** Resolve both fixed vector pass shells associated with the current scene. */
    private vectorLayers(
        sceneHandle: IRenderSceneHandle
    ): readonly ErdblickVectorLayer[] {
        return (sceneHandle.scene as DeckScene | undefined)?.gpuVectorLayers ?? [];
    }

    /** Resolve the single bounded-snapshot TextLayer host for the current scene. */
    private textLayerHost(
        sceneHandle: IRenderSceneHandle
    ): GpuTextLayerHost | null {
        return (sceneHandle.scene as DeckScene | undefined)?.gpuTextLayerHost ?? null;
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

}
