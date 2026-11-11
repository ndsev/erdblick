import { Subscription } from "rxjs";
import { coreLib } from "../integrations/wasm.adapter";
import { filterSubscriptionCoverageEqual, type FilterSubscriptionCoverage } from "../mapdata/filter-subscription.model";
import { MapTileStreamService } from "../mapdata/map-tile-stream.service";
import { MapDataService } from "../mapdata/mapdata.service";
import type { MapgetLayer } from "../mapdata/mapget-layer.model";
import { partitionKey, tilePartition } from "../mapdata/partition.model";
import { type StyledMapgetLayerEvent } from "../mapdata/styled-mapget-layer.model";
import { StyledMapgetLayer } from "../mapdata/styled-mapget-layer.presentation";
import { MAX_STYLE_LOD } from "../mapstyle/style-lod.model";
import { FeatureSearchResolvedDefinition } from "./feature-search-runtime-state.model";
import { compileFeatureSearchStyle, type CompiledFeatureSearchStyle } from "./feature-search-style.adapter";

/** Viewport decisions supplied by the controller; this owner handles their resource lifetime. */
export type SearchCoverageRequest =
    | {kind: "tile"; tileIds: number[]}
    | {kind: "object"; discoveryTileIds: number[]};

/** Identity and compiled-style inputs for one transactional presentation replacement. */
export interface SearchPresentationOptions {
    key: string;
    definition: FeatureSearchResolvedDefinition;
    mapgetLayer: MapgetLayer;
    featureTypes: string[];
    definitionSignature: string;
    instanceId: string;
}

/** Owns one search/layer subscription, coverage discovery, and compiled rendering resource. */
export class SearchPresentation {
    readonly key: string;
    readonly sessionId: string;
    readonly mapgetLayer: MapgetLayer;
    readonly definitionSignature: string;
    readonly compiled: CompiledFeatureSearchStyle;
    readonly styledLayer: StyledMapgetLayer;
    private readonly subscription: Subscription;
    coverage: FilterSubscriptionCoverage | null = null;
    coverageOrder = new Map<string, number>();
    spatialTileByPartition = new Map<string, number>();
    private objectDiscoverySignature = "";
    private objectDiscoveryVersion = 0;
    private objectCoverage: FilterSubscriptionCoverage | null = null;
    private objectDiscoveryTimer: ReturnType<typeof setTimeout> | null = null;
    private destroyed = false;

    /** Builds a complete replacement before the controller retires the previous presentation. */
    constructor(
        options: SearchPresentationOptions,
        mapInfo: MapDataService,
        private readonly tileStream: MapTileStreamService,
        onEvent: (presentation: SearchPresentation, event: StyledMapgetLayerEvent) => void,
        private readonly coverageChanged: () => void,
        private readonly onError: (message: string) => void
    ) {
        const {key, definition, mapgetLayer, featureTypes, definitionSignature, instanceId} = options;
        this.key = key;
        this.sessionId = definition.id;
        this.mapgetLayer = mapgetLayer;
        this.definitionSignature = definitionSignature;
        this.compiled = compileFeatureSearchStyle(definition, mapgetLayer, mapInfo, featureTypes);
        try {
            this.styledLayer = new StyledMapgetLayer(
                {
                    viewIndex: -1,
                    mapId: mapgetLayer.mapId,
                    layerId: mapgetLayer.layerId,
                    presentationKind: "search",
                    // Separate concrete identities allow old and new resources to coexist during replacement.
                    presentationInstanceId: instanceId
                },
                mapgetLayer, this.compiled.style, {}, mapInfo, tileStream,
                coreLib.HighlightMode.NO_HIGHLIGHT, MAX_STYLE_LOD, this.compiled.filterPlan
            );
        } catch (error) {
            this.compiled.style.featureLayerStyle.delete?.();
            throw error;
        }
        this.subscription = this.styledLayer.events.subscribe(event => onEvent(this, event));
    }

    /** Applies a view-derived request and returns whether transport coverage changed. */
    setCoverage(request: SearchCoverageRequest): boolean {
        if (this.destroyed) return false;
        let coverage: FilterSubscriptionCoverage;
        if (request.kind === "object") {
            coverage = this.objectSearchCoverage(request.discoveryTileIds);
        } else {
            const partitions = request.tileIds.map(tilePartition);
            this.spatialTileByPartition = new Map(partitions.map(partition => [partitionKey(partition), partition.id as number]));
            coverage = {partitions, priorityPartitions: []};
        }
        if (this.coverage && filterSubscriptionCoverageEqual(coverage, this.coverage)) return false;
        this.coverage = {
            partitions: coverage.partitions.map(partition => ({...partition})),
            ...(coverage.priorityPartitions ? {priorityPartitions: coverage.priorityPartitions.map(partition => ({...partition}))} : {})
        };
        this.coverageOrder = new Map(coverage.partitions.map((partition, index) => [partitionKey(partition), index]));
        this.styledLayer.setPartitionCoverage(coverage.partitions, coverage.priorityPartitions);
        return true;
    }

    /** Cancels discovery before disposing the subscription and its native style. */
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        if (this.objectDiscoveryTimer !== null) clearTimeout(this.objectDiscoveryTimer);
        this.objectDiscoveryTimer = null;
        this.objectDiscoveryVersion += 1;
        this.subscription.unsubscribe();
        this.styledLayer.dispose();
        this.compiled.style.featureLayerStyle.delete?.();
        this.spatialTileByPartition.clear();
        this.coverageOrder.clear();
        this.coverage = null;
        this.objectCoverage = null;
    }

    /** Resolves object associations and ignores late discovery after replacement or disposal. */
    private objectSearchCoverage(discoveryTileIds: number[]): FilterSubscriptionCoverage {
        const layer = this.mapgetLayer;
        const signature = discoveryTileIds.join(",");
        if (this.objectDiscoverySignature !== signature) {
            this.objectDiscoverySignature = signature;
            const version = ++this.objectDiscoveryVersion;
            if (this.objectDiscoveryTimer !== null) {
                clearTimeout(this.objectDiscoveryTimer);
                this.objectDiscoveryTimer = null;
            }
            void this.tileStream.discoverObjectPartitions(
                layer,
                discoveryTileIds
            ).then(result => {
                if (this.objectDiscoveryVersion !== version ||
                    this.objectDiscoverySignature !== signature ||
                    this.destroyed) {
                    return;
                }
                const partitions = result.associations.map(
                    association => association.partition
                );
                this.objectCoverage = {
                    partitions,
                    priorityPartitions: []
                };
                this.spatialTileByPartition = new Map(
                    result.associations.map(association => [
                        partitionKey(association.partition),
                        association.discoveryTileId
                    ])
                );
                if (result.expiresAtMs !== null) {
                    const delay = Math.min(
                        0x7fff_ffff,
                        Math.max(
                            0,
                            Math.ceil(result.expiresAtMs - Date.now()) + 1
                        )
                    );
                    this.objectDiscoveryTimer = setTimeout(() => {
                        this.objectDiscoveryTimer = null;
                        if (this.objectDiscoverySignature === signature) {
                            this.objectDiscoverySignature = "";
                            this.coverageChanged();
                        }
                    }, delay);
                }
                this.coverageChanged();
            }).catch(error => {
                if (this.objectDiscoveryVersion === version &&
                    this.objectDiscoverySignature === signature &&
                    !this.destroyed) {
                    this.onError(error instanceof Error ? error.message : String(error));
                    this.objectDiscoveryTimer = setTimeout(() => {
                        this.objectDiscoveryTimer = null;
                        if (this.objectDiscoverySignature === signature &&
                            !this.destroyed) {
                            this.objectDiscoverySignature = "";
                            this.coverageChanged();
                        }
                    }, 1_000);
                }
            });
        }
        return this.objectCoverage ?? { partitions: [] };
    }
}
