import { COORDINATE_SYSTEM } from "@deck.gl/core";
import { IconLayer } from "@deck.gl/layers";
import { ScreenSpaceSizeExtension } from "./screen-space-size.extension";
import { coreLib } from "../../integrations/wasm.adapter";
import type { SearchResultDensityMarker, SearchResultPoint } from "../../search/search-results.model";
import type { FeatureSearchOverlayLayer } from "../../search/search-session.model";
import type { DeckLayerRegistry } from "./deck-layer-registry.util";
import {
    DECK_OVERLAY_PARAMETERS,
    LOCATION_MARKER_ICON_NAME,
    LOCATION_MARKER_ICON_SIZE_PX
} from "./deck-overlay.constants";
import {
    createSearchResultDensityLabelLayer,
    createSearchResultDensityLayer,
    layoutSearchResultDensityMarkers,
    SEARCH_RESULT_DENSITY_DEFAULT_SIZE_SCALE,
    searchResultDensityCountDomain,
    type SearchResultDensityCountDomain,
    type SearchResultDensityLayoutEntry
} from "./deck-search-result-density.layer";

/** One active search layer together with the visible source tiles it contributes to this view. */
interface SearchResultOverlayInput {
    searchLayer: FeatureSearchOverlayLayer;
    dotLayerKey: string;
    labelLayerKey: string;
    pinLayerKey: string;
    lowFiSourceTileKeys: Set<string>;
    highFiPinMarkers: SearchResultDensityMarker[];
    targetLevel: number;
    densitySizeScale: number;
    sourceTileKeySignature: string;
}

/** Search-result marker data plus its observed count range for one deck dot layer. */
interface SearchResultOverlayLayerData {
    markers: SearchResultDensityMarker[];
    countDomain: SearchResultDensityCountDomain;
}
/** Search values and the active view's visibility decisions, resolved at the application boundary. */
export interface DeckSearchOverlayFrame {
    layers: readonly FeatureSearchOverlayLayer[];
    markerAtlas(): string;
    showsTile(mapId: string, layerId: string, tileId: number): boolean;
    prefersHighFidelity(tileId: number, maxVisibleTiles: number): boolean;
    densityTargetLevel(maxVisibleLevel: number, maxVisibleTiles: number): number;
}

/** One canvas's scheduled density/pin presentation and registered layer identities. */
export class DeckSearchOverlay {

    private static readonly SEARCH_RESULTS_LAYER_PREFIX = "builtin/search-results";
    private static readonly SEARCH_RESULT_PIN_RENDER_SIZE_PX = 24;
    private static readonly SEARCH_RESULT_DENSITY_SIZE_SCALE = SEARCH_RESULT_DENSITY_DEFAULT_SIZE_SCALE;
    private static readonly SEARCH_RESULT_SOURCE_TILE_HASH_OFFSET = 0x811c9dc5;
    private static readonly SEARCH_RESULT_SOURCE_TILE_HASH_PRIME = 0x01000193;

    private searchResultsOverlayUpdateRaf: number | null = null;
    private searchResultsOverlayDataRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private lastSearchResultsSignature = "";
    private searchResultLayerKeys = new Set<string>();
    private frame: DeckSearchOverlayFrame | null = null;
    private destroyed = false;

    /** Read inputs lazily after frame coalescing so streaming progress does not scan results per event. */
    constructor(private readonly layerRegistry: DeckLayerRegistry,
                private readonly readFrame: () => DeckSearchOverlayFrame | null) {}

    /** Retire pending refreshes and layers before the renderer releases its registry/device. */
    destroy(): void {
        this.destroyed = true;
        this.cancelScheduling();
        this.removeSearchResultLayers();
        this.lastSearchResultsSignature = "";
        this.frame = null;
    }

    /** Schedules one search-result overlay refresh on the next animation frame. */
    scheduleUpdate(): void {
        if (this.destroyed || this.searchResultsOverlayUpdateRaf !== null) {
            return;
        }
        this.searchResultsOverlayUpdateRaf = requestAnimationFrame(() => {
            this.searchResultsOverlayUpdateRaf = null;
            this.updateSearchResultsOverlay();
        });
    }

    /** Debounces search-result overlay rebuilds after search progress changes. */
    scheduleDataRefresh(): void {
        if (this.destroyed || this.searchResultsOverlayDataRefreshTimer !== null) {
            return;
        }
        this.searchResultsOverlayDataRefreshTimer = setTimeout(() => {
            this.searchResultsOverlayDataRefreshTimer = null;
            this.scheduleUpdate();
        }, 120);
    }

    /** Cancels pending search-result overlay refresh work. */
    private cancelScheduling(): void {
        if (this.searchResultsOverlayUpdateRaf !== null) {
            cancelAnimationFrame(this.searchResultsOverlayUpdateRaf);
            this.searchResultsOverlayUpdateRaf = null;
        }
        if (this.searchResultsOverlayDataRefreshTimer !== null) {
            clearTimeout(this.searchResultsOverlayDataRefreshTimer);
            this.searchResultsOverlayDataRefreshTimer = null;
        }
    }

    /** Rebuilds the search-result dot/density overlay. */
    private updateSearchResultsOverlay(): void {
        this.frame = this.readFrame();
        if (!this.frame) {
            this.removeSearchResultLayers();
            this.lastSearchResultsSignature = "";
            return;
        }

        const searchLayers = this.frame.layers;
        const overlayInputs: SearchResultOverlayInput[] = searchLayers.map(searchLayer => {
            const lowFiSourceTileKeys = new Set<string>();
            const highFiPinMarkers: SearchResultDensityMarker[] = [];
            const highFidelityByLevel = new Map<number, boolean>();
            let sourceTileKeyHash = DeckSearchOverlay.SEARCH_RESULT_SOURCE_TILE_HASH_OFFSET;
            let sourceTileKeyCount = 0;
            let maxVisibleLevel = 0;
            for (const bucket of searchLayer.pointBuckets) {
                if (!this.frame!.showsTile(bucket.mapId, bucket.layerId, bucket.tileId)) {
                    continue;
                }
                const bucketLevel = Number(coreLib.getTileLevel(bucket.tileId));
                sourceTileKeyHash = this.hashSearchResultSourceTileKey(sourceTileKeyHash, bucket.sourceTileKey);
                sourceTileKeyCount += 1;
                let highFidelityActive = highFidelityByLevel.get(bucketLevel);
                if (highFidelityActive === undefined) {
                    highFidelityActive = this.prefersHighFidelityForSearchResultOverlay(searchLayer, bucket.tileId);
                    highFidelityByLevel.set(bucketLevel, highFidelityActive);
                }
                if (highFidelityActive) {
                    if (searchLayer.renderStrategy.showHighFiResultDots) {
                        // Dense searches can produce more per-feature pins than V8 accepts
                        // as spread-call arguments; append one marker at a time.
                        for (const point of bucket.points) {
                            highFiPinMarkers.push(this.searchResultPointMarker(point));
                        }
                    }
                    continue;
                }
                if (!searchLayer.renderStrategy.showLowFiDots) {
                    continue;
                }
                lowFiSourceTileKeys.add(bucket.sourceTileKey);
                maxVisibleLevel = Math.max(maxVisibleLevel, bucketLevel);
            }
            const targetLevel = this.frame!.densityTargetLevel(
                maxVisibleLevel,
                searchLayer.renderStrategy.highFidelityMaxVisibleTiles);
            return {
                searchLayer,
                dotLayerKey: this.searchResultLayerKey(searchLayer.id, "dot"),
                labelLayerKey: this.searchResultLayerKey(searchLayer.id, "label"),
                pinLayerKey: this.searchResultLayerKey(searchLayer.id, "pin"),
                lowFiSourceTileKeys,
                highFiPinMarkers,
                targetLevel,
                densitySizeScale: this.searchResultDensitySizeScale(searchLayer.renderStrategy.densitySizeMultiplier),
                sourceTileKeySignature: `${sourceTileKeyCount}:${sourceTileKeyHash.toString(16)}`
            };
        });

        const signature = overlayInputs
            .map(input => [
                input.searchLayer.id,
                input.searchLayer.pointsVersion,
                input.searchLayer.pointColor,
                input.searchLayer.styleRuleCount,
                JSON.stringify(input.searchLayer.renderStrategy),
                input.targetLevel,
                input.sourceTileKeySignature
            ].join(":"))
            .join("|");
        if (this.lastSearchResultsSignature === signature) {
            return;
        }
        this.lastSearchResultsSignature = signature;

        const densityMarkersByLayerKey = new Map<string, SearchResultOverlayLayerData>();
        const layoutEntries: SearchResultDensityLayoutEntry[] = [];
        for (const input of overlayInputs) {
            const lowFiDensityMarkers = input.lowFiSourceTileKeys.size > 0 && !input.searchLayer.densityIndex.isEmpty
                ? input.searchLayer.densityIndex.materialize({
                    sourceTileKeys: input.lowFiSourceTileKeys,
                    targetLevel: input.targetLevel
                })
                : [];
            const layerMarkers = lowFiDensityMarkers;
            const countDomain = searchResultDensityCountDomain(layerMarkers);
            for (const marker of lowFiDensityMarkers) {
                layoutEntries.push({
                    marker,
                    sortKey: `${input.searchLayer.id}\n${marker.resultKey}`,
                    countDomain,
                    sizeScale: input.densitySizeScale
                });
            }
            densityMarkersByLayerKey.set(input.dotLayerKey, { markers: layerMarkers, countDomain });
        }
        layoutSearchResultDensityMarkers(layoutEntries, DeckSearchOverlay.SEARCH_RESULT_DENSITY_SIZE_SCALE);

        const nextKeys = new Set<string>();
        for (const input of overlayInputs) {
            if ((densityMarkersByLayerKey.get(input.dotLayerKey)?.markers.length ?? 0) > 0) {
                nextKeys.add(input.dotLayerKey);
                if (input.searchLayer.renderStrategy.showBucketLabels) {
                    nextKeys.add(input.labelLayerKey);
                }
            }
            if (input.highFiPinMarkers.length > 0) {
                nextKeys.add(input.pinLayerKey);
            }
        }
        for (const layerKey of this.searchResultLayerKeys) {
            if (!nextKeys.has(layerKey)) {
                this.layerRegistry.remove(layerKey);
            }
        }
        this.searchResultLayerKeys = nextKeys;

        for (const input of overlayInputs) {
            const layerData = densityMarkersByLayerKey.get(input.dotLayerKey);
            if (layerData?.markers.length) {
                this.layerRegistry.upsert(
                    input.dotLayerKey,
                    createSearchResultDensityLayer({
                        id: input.dotLayerKey,
                        data: layerData.markers,
                        pickable: false,
                        sizeScale: input.densitySizeScale,
                        dotColor: input.searchLayer.pointColorRgba,
                        countDomain: layerData.countDomain,
                        heatGradient: input.searchLayer.renderStrategy.densityHeatGradient
                    }),
                    650);
                if (input.searchLayer.renderStrategy.showBucketLabels) {
                    this.layerRegistry.upsert(
                        input.labelLayerKey,
                        createSearchResultDensityLabelLayer({
                            id: input.labelLayerKey,
                            data: layerData.markers,
                            pickable: false
                        }),
                        651);
                }
            } else {
                this.layerRegistry.remove(input.dotLayerKey);
                this.layerRegistry.remove(input.labelLayerKey);
            }
            if (input.highFiPinMarkers.length) {
                this.layerRegistry.upsert(
                    input.pinLayerKey,
                    this.createSearchResultPinLayer(input.pinLayerKey, input.highFiPinMarkers, input.searchLayer.pointColorRgba),
                    652);
            } else {
                this.layerRegistry.remove(input.pinLayerKey);
            }
        }
    }

    /** Returns whether this search wants high-fidelity overlay state for the supplied source tile. */
    private prefersHighFidelityForSearchResultOverlay(
        searchLayer: FeatureSearchOverlayLayer,
        tileId: number
    ): boolean {
        const strategy = searchLayer.renderStrategy;
        const hasHighFidelityVisualization = strategy.showHighFiResultDots
            || (strategy.showHighFiGeometry && searchLayer.styleRuleCount > 0);
        if (!hasHighFidelityVisualization) {
            return false;
        }
        if (!strategy.showLowFiDots) {
            return true;
        }
        return this.frame!.prefersHighFidelity(
            tileId,
            strategy.highFidelityMaxVisibleTiles
        );
    }

    /** Applies the user-visible density marker size multiplier to the default deck icon scale. */
    private searchResultDensitySizeScale(multiplier: number): number {
        const normalizedMultiplier = Number.isFinite(multiplier)
            ? Math.max(0.5, Math.min(10, multiplier))
            : 1;
        return DeckSearchOverlay.SEARCH_RESULT_DENSITY_SIZE_SCALE * normalizedMultiplier;
    }

    /** Creates the explicit per-feature high-fidelity result-pin layer. */
    private createSearchResultPinLayer(
        layerKey: string,
        markers: SearchResultDensityMarker[],
        color: [number, number, number, number]
    ): IconLayer<SearchResultDensityMarker> {
        const iconSize = LOCATION_MARKER_ICON_SIZE_PX;
        return new IconLayer<SearchResultDensityMarker>({
            id: layerKey,
            data: markers,
            coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
            iconAtlas: this.frame!.markerAtlas(),
            iconMapping: {
                [LOCATION_MARKER_ICON_NAME]: {
                    x: 0,
                    y: 0,
                    width: iconSize,
                    height: iconSize,
                    anchorX: iconSize / 2,
                    anchorY: iconSize,
                    mask: true
                }
            },
            getIcon: () => LOCATION_MARKER_ICON_NAME,
            getPosition: marker => marker.coordinates,
            getColor: () => color,
            getSize: () => DeckSearchOverlay.SEARCH_RESULT_PIN_RENDER_SIZE_PX,
            extensions: [new ScreenSpaceSizeExtension()],
            sizeUnits: "pixels",
            billboard: true,
            pickable: false,
            alphaCutoff: 0.05,
            parameters: DECK_OVERLAY_PARAMETERS
        });
    }

    /** Updates the FNV-1a source-key hash used to avoid sorting visible search tiles per overlay refresh. */
    private hashSearchResultSourceTileKey(hash: number, sourceTileKey: string): number {
        let nextHash = hash;
        for (let index = 0; index < sourceTileKey.length; index++) {
            nextHash ^= sourceTileKey.charCodeAt(index);
            nextHash = Math.imul(nextHash, DeckSearchOverlay.SEARCH_RESULT_SOURCE_TILE_HASH_PRIME);
        }
        return nextHash >>> 0;
    }

    /** Returns a stable deck-layer key for one feature-search session. */
    private searchResultLayerKey(searchId: string, kind: "dot" | "label" | "pin"): string {
        return `${DeckSearchOverlay.SEARCH_RESULTS_LAYER_PREFIX}/${searchId}/${kind}`;
    }

    /** Converts an individual high-fidelity search result into a positioned dot marker. */
    private searchResultPointMarker(point: SearchResultPoint): SearchResultDensityMarker {
        return {
            coordinates: point.coordinates,
            count: 1,
            mapId: point.mapId,
            layerId: point.layerId,
            tileId: point.tileId,
            featureId: point.featureId,
            resultKey: point.resultKey,
            featureKey: point.featureKey,
            featureKeys: [point.featureKey],
            resultKeys: [point.resultKey],
            showBucketLabel: false
        };
    }

    /** Removes every feature-search result layer from this deck view. */
    private removeSearchResultLayers(): void {
        for (const layerKey of this.searchResultLayerKeys) {
            this.layerRegistry.remove(layerKey);
        }
        this.searchResultLayerKeys.clear();
    }
}
