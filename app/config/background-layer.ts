/** Background definitions and bounds shared by config, stores and renderers. */

/** Background layer id used when neither URL nor stored state selects a layer. */
export const DEFAULT_BACKGROUND_LAYER_ID = "osm";

/** Default background opacity chosen for the shipped OSM layer so map data stays dominant. */
export const DEFAULT_BACKGROUND_OPACITY = 6;

/** Highest XYZ zoom requested when a custom background does not declare its own maxZoom. */
export const DEFAULT_XYZ_BACKGROUND_MAX_ZOOM = 22;

/** Highest WMS zoom requested when a custom background does not declare its own maxZoom. */
export const DEFAULT_WMS_BACKGROUND_MAX_ZOOM = 22;

/** Tooltip shown for WMS backgrounds to make the known deck.gl limitations explicit. */
export const WMS_BACKGROUND_EXPERIMENTAL_TOOLTIP =
    "WMS backgrounds use deck.gl's experimental WMSLayer. They are intended for 2D use first and may lag or render incorrectly in pitched 3D views.";

/** Common metadata shared by every raster background source. */
export interface BackgroundLayerBaseConfig {
    id: string;
    name: string;
    attribution?: string;
    headers: Record<string, string>;
    defaultOpacity: number;
    minZoom: number;
    maxZoom: number;
}

/** XYZ raster-tile background configuration. */
export interface XyzBackgroundLayerConfig extends BackgroundLayerBaseConfig {
    type: "xyz";
    urlTemplate: string | string[];
    tileSize: number;
    extent?: [number, number, number, number];
}

/** WMS background configuration backed by deck.gl's experimental `WMSLayer`. */
export interface WmsBackgroundLayerConfig extends BackgroundLayerBaseConfig {
    type: "wms";
    url: string;
    layers: string[];
    version: "1.3.0" | "1.1.1";
    crs: "EPSG:3857" | "EPSG:4326";
    format: "image/png";
    transparent: boolean;
    vendorParameters: Record<string, string | number | boolean>;
}

/** Discriminated union of every currently supported background-layer type. */
export type BackgroundLayerConfig = XyzBackgroundLayerConfig | WmsBackgroundLayerConfig;

/** Clamps persisted and config-driven background opacity to the supported percentage range. */
export function clampBackgroundOpacity(value: number): number {
    if (!Number.isFinite(value)) {
        return 100;
    }
    return Math.max(0, Math.min(100, Math.round(value)));
}
