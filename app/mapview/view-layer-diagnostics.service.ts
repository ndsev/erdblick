import {Injectable} from "@angular/core";
import {Subject} from "rxjs";
import type {StyledMapgetLayer} from "../mapdata/styled-mapget-layer.model";
import type {PresentationKind} from "../mapdata/styled-mapget-layer.model";

export interface SubsetDiagnosticsTile {
    viewIndex: number;
    ownerId: string;
    presentationKind: PresentationKind;
    mapName: string;
    layerName: string;
    tileId: number;
    mapTileKey: string;
    ready: boolean;
    error: string | null;
    sourceFeatureCount: number | null;
    renderedEntryCount: number;
    stats: Map<string, number[]>;
}

type StyledLayerProvider = () => Iterable<StyledMapgetLayer>;

/**
 * Read-through registry for current view presentation diagnostics.
 *
 * It owns neither subsets nor historical samples. Every read is rebuilt from
 * the StyledMapgetLayers currently owned or consumed by live view controllers.
 */
@Injectable({providedIn: "root"})
export class ViewLayerDiagnosticsService {
    readonly changed = new Subject<void>();
    private readonly providers = new Map<number, StyledLayerProvider>();
    private cachedTiles: SubsetDiagnosticsTile[] | null = null;

    register(viewIndex: number, provider: StyledLayerProvider): () => void {
        this.providers.set(viewIndex, provider);
        this.cachedTiles = null;
        this.changed.next();
        return () => {
            if (this.providers.get(viewIndex) === provider) {
                this.providers.delete(viewIndex);
                this.cachedTiles = null;
                this.changed.next();
            }
        };
    }

    notifyChanged(): void {
        this.cachedTiles = null;
        this.changed.next();
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
            for (const layer of provider()) {
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
                        ready: state.status === "ready" &&
                            state.renderedValueVersion === state.valueVersion,
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
