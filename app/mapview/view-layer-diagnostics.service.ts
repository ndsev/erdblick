import {Injectable} from "@angular/core";
import {Subject} from "rxjs";
import type {StyledMapgetLayer} from "../mapdata/styled-mapget-layer.model";
import type {PresentationKind} from "../mapdata/styled-mapget-layer.model";
import type {FilterTileState} from "../mapdata/filter-tile-state.model";

export interface SubsetDiagnosticsTile {
    viewIndex: number;
    ownerId: string;
    presentationKind: PresentationKind;
    mapName: string;
    layerName: string;
    tileId: number;
    mapTileKey: string;
    conversionTimestampMs: number | null;
    ready: boolean;
    error: string | null;
    sourceFeatureCount: number | null;
    renderedEntryCount: number;
    stats: Map<string, number[]>;
}

export interface SubsetDiagnosticsError {
    viewIndex: number;
    ownerId: string;
    presentationKind: PresentationKind;
    mapName: string;
    layerName: string;
    mapTileKey: string;
    message: string;
}

export interface ViewLayerDiagnosticsSummary {
    expected: number;
    ready: number;
    errors: number;
    sourceFeatures: number;
    vertices: number;
}

type StyledLayerProvider = () => Iterable<StyledMapgetLayer>;
type PresentationDemandProvider = (
    layer: StyledMapgetLayer,
    state: FilterTileState
) => boolean;

interface DiagnosticsProvider {
    layers: StyledLayerProvider;
    presentationDemanded: PresentationDemandProvider;
}

/**
 * Read-through registry for current view presentation diagnostics.
 *
 * It owns neither subsets nor historical samples. Every read is rebuilt from
 * the StyledMapgetLayers currently owned or consumed by live view controllers.
 */
@Injectable({providedIn: "root"})
export class ViewLayerDiagnosticsService {
    readonly changed = new Subject<void>();
    readonly tileError = new Subject<SubsetDiagnosticsError>();
    private readonly providers = new Map<number, DiagnosticsProvider>();
    private cachedTiles: SubsetDiagnosticsTile[] | null = null;
    private cachedSummary: ViewLayerDiagnosticsSummary | null = null;

    register(
        viewIndex: number,
        provider: StyledLayerProvider,
        presentationDemanded: PresentationDemandProvider = () => true
    ): () => void {
        const registration = {layers: provider, presentationDemanded};
        this.providers.set(viewIndex, registration);
        this.invalidate();
        this.changed.next();
        return () => {
            if (this.providers.get(viewIndex) === registration) {
                this.providers.delete(viewIndex);
                this.invalidate();
                this.changed.next();
            }
        };
    }

    notifyChanged(): void {
        this.invalidate();
        this.changed.next();
    }

    /** Invalidates aggregate state and forwards a layer's terminal failures. */
    notifyLayerErrors(
        viewIndex: number,
        layer: StyledMapgetLayer
    ): void {
        this.invalidate();
        for (const state of layer.tileStates.values()) {
            if (!state.error) {
                continue;
            }
            this.tileError.next({
                viewIndex,
                ownerId: layer.ownerId,
                presentationKind: layer.identity.presentationKind,
                mapName: state.mapId,
                layerName: state.layerId,
                mapTileKey: state.mapTileKey,
                message: state.error
            });
        }
        this.changed.next();
    }

    /**
     * Returns progress counters without constructing per-tile statistic maps.
     *
     * This is the normal loading/UI path. `currentTiles()` remains the
     * intentionally richer on-demand performance/export path.
     */
    currentSummary(): ViewLayerDiagnosticsSummary {
        if (this.cachedSummary) {
            return this.cachedSummary;
        }
        const presentationTileSeen = new Set<string>();
        const sourceFeatureCounts = new Map<string, number>();
        const result: ViewLayerDiagnosticsSummary = {
            expected: 0,
            ready: 0,
            errors: 0,
            sourceFeatures: 0,
            vertices: 0
        };
        for (const [viewIndex, provider] of this.providers) {
            for (const layer of provider.layers()) {
                for (const state of layer.tileStates.values()) {
                    const presentationTileKey =
                        `${viewIndex}|${layer.ownerId}|${state.mapTileKey}`;
                    if (presentationTileSeen.has(presentationTileKey)) {
                        continue;
                    }
                    presentationTileSeen.add(presentationTileKey);
                    result.expected += 1;
                    if (this.presentationReady(provider, layer, state)) {
                        result.ready += 1;
                    }
                    if (state.error) {
                        result.errors += 1;
                    }
                    if (layer.identity.presentationKind === "regular" &&
                        state.sourceFeatureCount !== null) {
                        sourceFeatureCounts.set(
                            `${state.mapId}|${state.layerId}|${state.mapTileKey}`,
                            state.sourceFeatureCount
                        );
                    }
                    const vertices = state.renderStats["vertexCount"];
                    if (Number.isFinite(vertices)) {
                        result.vertices += vertices;
                    }
                }
            }
        }
        result.sourceFeatures = [...sourceFeatureCounts.values()]
            .reduce((sum, value) => sum + value, 0);
        this.cachedSummary = result;
        return result;
    }

    currentTiles(): SubsetDiagnosticsTile[] {
        if (this.cachedTiles) {
            return this.cachedTiles;
        }
        const result: SubsetDiagnosticsTile[] = [];
        const sourceInfoSeen = new Set<string>();
        const requestStatusSeen = new Set<string>();
        const presentationTileSeen = new Set<string>();

        for (const [viewIndex, provider] of [...this.providers.entries()]
            .sort(([left], [right]) => left - right)) {
            for (const layer of provider.layers()) {
                for (const state of layer.tileStates.values()) {
                    const presentationTileKey = [
                        viewIndex,
                        layer.ownerId,
                        state.mapTileKey
                    ].join("|");
                    if (presentationTileSeen.has(presentationTileKey)) {
                        continue;
                    }
                    presentationTileSeen.add(presentationTileKey);
                    const stats = new Map<string, number[]>();
                    const sourceKey = [
                        state.mapId,
                        state.layerId,
                        state.mapTileKey
                    ].join("|");
                    const includeSourceInfo =
                        layer.identity.presentationKind === "regular" &&
                        !sourceInfoSeen.has(sourceKey);
                    if (includeSourceInfo) {
                        sourceInfoSeen.add(sourceKey);
                    }
                    for (const [key, rawValue] of Object.entries(state.info)) {
                        const isFilterStat = key.startsWith("Filter/");
                        if (!isFilterStat && !includeSourceInfo) {
                            continue;
                        }
                        const values = this.numericValues(rawValue);
                        if (values.length) {
                            stats.set(
                                isFilterStat ? `Rendering/${key}` : key,
                                values
                            );
                        }
                    }
                    if (state.subsetBlob) {
                        stats.set(
                            "Rendering/Filter/Subset-Size#bytes",
                            [state.subsetBlob.byteLength]
                        );
                    }
                    const wasmStatKeys: Record<string, string> = {
                        deserializeMs: "Deserialize#ms",
                        renderMs: "Render#ms",
                        totalMs: "Total#ms",
                        clientWallMs: "Client-Wall#ms",
                        vertexCount: "Vertices#count"
                    };
                    for (const [key, value] of Object.entries(state.renderStats)) {
                        if (Number.isFinite(value)) {
                            const mapped = wasmStatKeys[key];
                            if (mapped) {
                                stats.set(`Rendering/WASM/${mapped}`, [value]);
                            }
                        }
                    }
                    const status = layer.latestStatus;
                    if (status) {
                        const requestKey = `${status.filterId}|${status.generation}`;
                        if (!requestStatusSeen.has(requestKey)) {
                            requestStatusSeen.add(requestKey);
                            for (const field of [
                                "outputTilesRequested",
                                "sourceTilesQueued",
                                "sourceTilesLoaded",
                                "sourceTilesEvaluated",
                                "outputTilesReady",
                                "outputTilesEmitted",
                                "entriesEmitted"
                            ] as const) {
                                const value = status[field];
                                if (typeof value === "number" &&
                                    Number.isFinite(value)) {
                                    stats.set(
                                        `Rendering/Filter/Request/${field}#count`,
                                        [value]
                                    );
                                }
                            }
                        }
                    }
                    result.push({
                        viewIndex,
                        ownerId: layer.ownerId,
                        presentationKind: layer.identity.presentationKind,
                        mapName: state.mapId,
                        layerName: state.layerId,
                        tileId: state.tileId,
                        mapTileKey: state.mapTileKey,
                        conversionTimestampMs: includeSourceInfo
                            ? state.conversionTimestampMs
                            : null,
                        ready: this.presentationReady(provider, layer, state),
                        error: state.error,
                        sourceFeatureCount: state.sourceFeatureCount,
                        renderedEntryCount: state.renderedEntryCount,
                        stats
                    });
                }
            }
        }
        this.cachedTiles = result;
        return result;
    }

    private presentationReady(
        provider: DiagnosticsProvider,
        layer: StyledMapgetLayer,
        state: FilterTileState
    ): boolean {
        return state.status === "ready" &&
            (!provider.presentationDemanded(layer, state) ||
                state.renderedValueVersion === state.valueVersion);
    }

    private invalidate(): void {
        this.cachedTiles = null;
        this.cachedSummary = null;
    }

    private numericValues(value: unknown): number[] {
        if (typeof value === "number" && Number.isFinite(value)) {
            return [value];
        }
        if (!Array.isArray(value)) {
            return [];
        }
        return value.filter(
            (entry): entry is number =>
                typeof entry === "number" && Number.isFinite(entry)
        );
    }
}
