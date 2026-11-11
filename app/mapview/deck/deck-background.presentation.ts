import { BitmapLayer } from "@deck.gl/layers";
import { WMSImageSource } from "@loaders.gl/wms";
import { type TileLayerProps, WMSLayer } from "../../integrations/deckgl.adapter";
import type {
    BackgroundLayerConfig,
    WmsBackgroundLayerConfig,
    XyzBackgroundLayerConfig
} from "../background-layer.model";
import { BatchedTileLayer } from "./batched-tile.layer";
import type { DeckLayerRegistry } from "./deck-layer-registry.util";
import { DECK_OVERLAY_PARAMETERS } from "./deck-overlay.constants";

/** Per-canvas raster background, including request options and registered layer lifetime. */
export class DeckBackground {
    private static readonly BACKGROUND_LAYER_KEY = "background/layer";
    private backgroundLayerSignature = "";

    /** Use the renderer's registry; application configuration is resolved at the caller. */
    constructor(private readonly layerRegistry: DeckLayerRegistry) {}

    /** Reconcile an already resolved background choice without consulting application state. */
    update(selectedLayer: BackgroundLayerConfig | undefined, opacityPercent: number, mode2d: boolean): void {
        if (!selectedLayer || (!mode2d && selectedLayer.type === "wms")) {
            // WMS remains a 2D-only background; do not carry it into a pitched 3D view.
            this.destroy();
            return;
        }
        const opacity = Math.max(0, Math.min(1, opacityPercent / 100));
        const signature = JSON.stringify({layerId: selectedLayer.id, opacity, mode2d});
        if (signature === this.backgroundLayerSignature) return;
        const layer = selectedLayer.type === "xyz"
            ? this.createXyzBackgroundLayer(selectedLayer, opacity)
            : this.createWmsBackgroundLayer(selectedLayer, opacity);
        this.layerRegistry.upsert(DeckBackground.BACKGROUND_LAYER_KEY, layer, -1000);
        this.backgroundLayerSignature = signature;
    }

    /** Removes the current background layer and clears the memoized render signature. */
    destroy(): void {
        this.layerRegistry.remove(DeckBackground.BACKGROUND_LAYER_KEY);
        this.backgroundLayerSignature = "";
    }

    /**
     * Builds a fetch override for authenticated background layers while preserving deck/loaders.gl
     * request options such as abort signals.
     */
    private createBackgroundFetchOverride(headers: Readonly<Record<string, string>>): typeof fetch | undefined {
        if (Object.keys(headers).length === 0) {
            return undefined;
        }

        return async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
            const mergedHeaders = new Headers(init?.headers);
            for (const [name, value] of Object.entries(headers)) {
                mergedHeaders.set(name, value);
            }

            return fetch(input, {
                ...init,
                headers: mergedHeaders
            });
        };
    }

    /** Wraps the optional background fetch override in the deck/loaders.gl `loadOptions` structure. */
    private createBackgroundLoadOptions(headers: Readonly<Record<string, string>>): { core: { fetch: typeof fetch } } | undefined {
        const fetchOverride = this.createBackgroundFetchOverride(headers);
        if (!fetchOverride) {
            return undefined;
        }

        return {
            core: {
                fetch: fetchOverride
            }
        };
    }

    /**
     * Creates the tiled XYZ background layer used for OSM and bundled imagery.
     *
     * The deck layer id includes the configured background id so switching
     * sources forces a fresh TileLayer instance and tile selection pass.
     * The layer also prefers deck's `best-available` refinement so panning
     * keeps already loaded detailed tiles visible instead of collapsing to a
     * coarse parent tile while sibling requests are still in flight. Bitmap
     * opacity is blended against the map's black background inside the shader
     * so overlapping parent/child placeholders do not briefly compound alpha.
     * When `headers` are configured, tile requests use them for authenticated
     * HTTP endpoints without changing local bundled backgrounds.
     */
    private createXyzBackgroundLayer(layerConfig: XyzBackgroundLayerConfig, opacity: number): BatchedTileLayer<string> {
        return new BatchedTileLayer<string>({
            id: `${DeckBackground.BACKGROUND_LAYER_KEY}/${layerConfig.id}`,
            data: layerConfig.urlTemplate,
            loadOptions: this.createBackgroundLoadOptions(layerConfig.headers),
            minZoom: layerConfig.minZoom,
            maxZoom: layerConfig.maxZoom,
            tileSize: layerConfig.tileSize,
            extent: layerConfig.extent,
            opacity,
            pickable: false,
            refinementStrategy: "best-available",
            updateTriggers: {
                renderSubLayers: [opacity]
            },
            renderSubLayers: (
                props: Parameters<NonNullable<TileLayerProps<string>["renderSubLayers"]>>[0]
            ) => {
                const boundingBox = props.tile?.boundingBox;
                if (!boundingBox || !props.data) {
                    return null;
                }
                return new BitmapLayer({
                    id: `${props.id}-bitmap`,
                    image: props.data,
                    bounds: [
                        boundingBox[0][0],
                        boundingBox[0][1],
                        boundingBox[1][0],
                        boundingBox[1][1]
                    ],
                    opacity,
                    transparentColor: [0, 0, 0, 255],
                    pickable: false,
                    parameters: { depthTest: false }
                });
            }
        });
    }

    /**
     * Creates the experimental WMS background layer from the config-driven service parameters.
     *
     * The source-specific layer id mirrors the XYZ path so deck does not reuse
     * stale internal state when the selected background changes. WMS metadata
     * and image requests reuse the same optional header override as XYZ tiles.
     */
    private createWmsBackgroundLayer(layerConfig: WmsBackgroundLayerConfig, opacity: number): WMSLayer {
        const imageSource = new WMSImageSource(layerConfig.url, {
            core: {
                loadOptions: this.createBackgroundLoadOptions(layerConfig.headers) ?? {}
            },
            wms: {
                wmsParameters: {
                    layers: layerConfig.layers,
                    version: layerConfig.version,
                    crs: layerConfig.crs,
                    format: layerConfig.format,
                    transparent: layerConfig.transparent
                },
                vendorParameters: layerConfig.vendorParameters
            }
        });

        return new WMSLayer({
            id: `${DeckBackground.BACKGROUND_LAYER_KEY}/${layerConfig.id}`,
            data: imageSource,
            layers: layerConfig.layers,
            serviceType: "wms",
            srs: layerConfig.crs,
            opacity,
            pickable: false,
            parameters: DECK_OVERLAY_PARAMETERS,
            onMetadataLoadError: (error) => console.error("[DeckMapView] Failed to load WMS metadata", error),
            onImageLoadError: (_requestId, error) => console.error("[DeckMapView] Failed to load WMS image", error)
        });
    }
}
