/** Background input schemas, normalized values and bounds shared by configuration and renderers. */
import { z } from "zod";

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

/** Accepted deployment input; normalizeBackgroundLayer supplies the runtime defaults. */
const BACKGROUND_LAYER_BASE_SCHEMA = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    attribution: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    defaultOpacity: z.coerce.number().optional(),
    minZoom: z.coerce.number().int().optional(),
    maxZoom: z.coerce.number().int().optional()
});

const XYZ_BACKGROUND_LAYER_SCHEMA = BACKGROUND_LAYER_BASE_SCHEMA.extend({
    type: z.literal("xyz"),
    urlTemplate: z.union([
        z.string().min(1),
        z.array(z.string().min(1)).min(1)
    ]),
    tileSize: z.coerce.number().int().positive().optional(),
    extent: z.tuple([
        z.coerce.number(),
        z.coerce.number(),
        z.coerce.number(),
        z.coerce.number()
    ]).optional()
});

const WMS_BACKGROUND_LAYER_SCHEMA = BACKGROUND_LAYER_BASE_SCHEMA.extend({
    type: z.literal("wms"),
    url: z.string().min(1),
    layers: z.array(z.string().min(1)).min(1),
    version: z.enum(["1.3.0", "1.1.1"]).optional(),
    crs: z.enum(["EPSG:3857", "EPSG:4326"]).optional(),
    format: z.literal("image/png").optional(),
    transparent: z.boolean().optional(),
    vendorParameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
});

export const BACKGROUND_LAYER_SCHEMA = z.union([
    XYZ_BACKGROUND_LAYER_SCHEMA,
    WMS_BACKGROUND_LAYER_SCHEMA
]);

export type RawBackgroundLayerConfig = z.infer<typeof BACKGROUND_LAYER_SCHEMA>;

export const DEFAULT_BACKGROUND_LAYERS: BackgroundLayerConfig[] = [
    {
        id: "osm",
        name: "OpenStreetMap",
        type: "xyz",
        urlTemplate: "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
        attribution: "© OpenStreetMap contributors",
        headers: {},
        defaultOpacity: DEFAULT_BACKGROUND_OPACITY,
        minZoom: 0,
        maxZoom: 19,
        tileSize: 256
    }
];

/** Applies per-layer defaults so rendering code can avoid scattered `undefined` handling. */
export function normalizeBackgroundLayer(layer: RawBackgroundLayerConfig): BackgroundLayerConfig {
    const defaultOpacity = clampBackgroundOpacity(layer.defaultOpacity ?? 100);
    const minZoom = layer.minZoom ?? 0;
    const maxZoom = layer.maxZoom ?? (
        layer.type === "xyz"
            ? DEFAULT_XYZ_BACKGROUND_MAX_ZOOM
            : DEFAULT_WMS_BACKGROUND_MAX_ZOOM
    );

    if (layer.type === "xyz") {
        return {
            ...layer,
            headers: layer.headers ?? {},
            defaultOpacity,
            minZoom,
            maxZoom,
            tileSize: layer.tileSize ?? 256
        };
    }

    return {
        ...layer,
        headers: layer.headers ?? {},
        defaultOpacity,
        minZoom,
        maxZoom,
        version: layer.version ?? "1.3.0",
        crs: layer.crs ?? "EPSG:3857",
        format: layer.format ?? "image/png",
        transparent: layer.transparent ?? false,
        vendorParameters: layer.vendorParameters ?? {}
    };
}

/** Chooses a valid default background id or falls back to the first available layer. */
export function resolveDefaultBackgroundLayerId(requestedDefaultId: string | null, backgroundLayers: BackgroundLayerConfig[]): string | null {
    if (backgroundLayers.length === 0) {
        return null;
    }
    if (requestedDefaultId && backgroundLayers.some(layer => layer.id === requestedDefaultId)) {
        return requestedDefaultId;
    }
    // Falling back to the first configured layer keeps persisted state valid even when a
    // previously configured default disappears from a newer config.json.
    return backgroundLayers[0].id;
}
