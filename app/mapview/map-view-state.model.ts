export const DEFAULT_MAP_ZOOM_STEP = 0.5;

export const MIN_MAP_ZOOM_STEP = 0.001;

export const MAX_MAP_ZOOM_STEP = 1.0;

export const DEFAULT_FEATURE_ZOOM_CLEARANCE_METERS = 20;

export const MIN_FEATURE_ZOOM_CLEARANCE_METERS = 0;

export const MAX_FEATURE_ZOOM_CLEARANCE_METERS = 100;

export const DEFAULT_TILE_GRID_LEVEL = 13;

export const DEFAULT_TILE_GRID_COLOR = "f5f5f5";

export const DEFAULT_TILE_GRID_OPACITY = 39;

export const VIEW_SYNC_PROJECTION = "proj";

export const VIEW_SYNC_POSITION = "pos";

export const VIEW_SYNC_MOVEMENT = "mov";

export const VIEW_SYNC_LAYERS = "lay";

/** Minimal persisted camera state shared between 2D and 3D views. */
export interface CameraViewState {
    destination: { lon: number, lat: number, alt: number };
    orientation: { heading: number, pitch: number, roll: number };
    /** Local map-centre offset in metres; omitted legacy values resolve to zero. */
    position?: [x: number, y: number, z: number];
}

/** Persisted selected background-layer id plus per-view opacity. */
export interface BackgroundLayerViewState {
    layerId: string | null;
    opacity: number;
}

/** Enumerates view properties that can be synchronized across split views. */
export interface ViewSyncOptionDescriptor {
    name: string;
    code: string;
    icon: string;
    tooltip: string;
}

/** Tile-grid overlay labeling mode used by the map panel and Deck overlay. */
export type TileGridMode = "xyz" | "nds";

/** Returns the highest meaningful grid level for the selected coordinate mode. */
export function tileGridMaxLevel(mode: TileGridMode): number {
    return mode === "nds" ? 15 : 22;
}

/** Clamps a configured grid level to the selected coordinate mode. */
export function clampTileGridLevel(value: unknown, mode: TileGridMode): number {
    const numeric = Number(value);
    return Number.isFinite(numeric)
        ? Math.max(0, Math.min(tileGridMaxLevel(mode), Math.round(numeric)))
        : DEFAULT_TILE_GRID_LEVEL;
}

/** Normalizes a PrimeNG colour-picker value to six lowercase RGB digits. */
export function normalizeTileGridColor(value: unknown): string {
    const normalized = String(value).replace(/^#/, "").toLowerCase();
    return /^[0-9a-f]{6}$/.test(normalized) ? normalized : DEFAULT_TILE_GRID_COLOR;
}

/** Clamps tile-grid opacity to an integer percentage. */
export function clampTileGridOpacity(value: unknown): number {
    const numeric = Number(value);
    return Number.isFinite(numeric)
        ? Math.max(0, Math.min(100, Math.round(numeric)))
        : DEFAULT_TILE_GRID_OPACITY;
}

/** Converts persisted grid appearance values to the deck.gl RGBA tuple. */
export function tileGridRgba(color: string, opacity: number): [number, number, number, number] {
    const normalized = normalizeTileGridColor(color);
    return [
        Number.parseInt(normalized.slice(0, 2), 16),
        Number.parseInt(normalized.slice(2, 4), 16),
        Number.parseInt(normalized.slice(4, 6), 16),
        Math.round(clampTileGridOpacity(opacity) * 255 / 100)
    ];
}

/** Clamps persisted zoom-step settings to the supported deck interaction range. */
export function clampMapZoomStep(value: number): number {
    if (!Number.isFinite(value)) {
        return DEFAULT_MAP_ZOOM_STEP;
    }
    return Math.min(MAX_MAP_ZOOM_STEP, Math.max(MIN_MAP_ZOOM_STEP, value));
}

/** Clamps the persisted minimum feature-navigation camera distance. */
export function clampFeatureZoomClearanceMeters(value: number): number {
    if (!Number.isFinite(value)) {
        return DEFAULT_FEATURE_ZOOM_CLEARANCE_METERS;
    }
    return Math.min(
        MAX_FEATURE_ZOOM_CLEARANCE_METERS,
        Math.max(MIN_FEATURE_ZOOM_CLEARANCE_METERS, value)
    );
}
