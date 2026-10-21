import { z } from "zod";
import type { LayerPresetRef } from "../styledata/layer-preset.model";

export {
clampLod3TileThreshold,
DEFAULT_LOD3_TILE_THRESHOLD,
MAX_LOD3_TILE_THRESHOLD,
MIN_LOD3_TILE_THRESHOLD
} from "./lod-policy";
export {
AUTO_TILE_SUBSET_RENDER_WORKER_COUNT,
clampTileSubsetRenderWorkerCount,
MAX_TILE_SUBSET_RENDER_WORKER_COUNT,
MIN_TILE_SUBSET_RENDER_WORKER_COUNT
} from "./tile-render-policy";

export const COORDINATE_STATE_DECIMAL_PLACES = 8;
export const COORDINATE_STATE_PRECISION = 10 ** COORDINATE_STATE_DECIMAL_PLACES;
export const DEFAULT_FEATURE_SEARCH_GROUPING = [1];
export const FEATURE_SEARCH_GROUPING_OPTION_IDS = new Set([1, 2, 3, 4]);

export const MAX_SIMULTANEOUS_INSPECTIONS = 50;
export const DEFAULT_DRILL_PICK_RADIUS = 3;
export const MIN_DRILL_PICK_RADIUS = 1;
export const MAX_DRILL_PICK_RADIUS = 10;
export const MAX_COMPARE_PANELS = 4;
export const MAX_NUM_TILES_TO_LOAD = 512;
export const DEFAULT_LOCATION_SEARCH_RESULT_LIMIT = 10;
export const MAX_LOCATION_SEARCH_RESULT_LIMIT = 50;
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
export const DEFAULT_EM_WIDTH = 30;
export const DEFAULT_EM_HEIGHT = 40;
export const DEFAULT_DOCKED_EM_HEIGHT = 20;
export const ABOUT_DIALOG_LAYOUT_ID = 'about-dialog';
export const LEGAL_INFO_DIALOG_LAYOUT_ID = 'legal-info-dialog';
export const PREFERENCES_DIALOG_LAYOUT_ID = 'preferences-dialog';
export const KEYBOARD_DIALOG_LAYOUT_ID = 'keyboard-dialog';
export const DATASOURCES_EDITOR_DIALOG_LAYOUT_ID = 'datasources-editor-dialog';
export const ADVANCED_PREFERENCES_DIALOG_LAYOUT_ID = 'advanced-preferences-dialog';
export const DIAGNOSTICS_PERFORMANCE_DIALOG_LAYOUT_ID = 'diagnostics-performance';
export const DIAGNOSTICS_LOG_DIALOG_LAYOUT_ID = 'diagnostics-log';
export const DIAGNOSTICS_EXPORT_DIALOG_LAYOUT_ID = 'diagnostics-export';
export const CACHE_RESET_DIALOG_LAYOUT_ID = 'cache-reset-dialog';
export const STYLES_DIALOG_LAYOUT_ID = 'styles-dialog';
export const STYLE_EDITOR_DIALOG_LAYOUT_ID = 'style-editor-dialog';
export const STYLE_PRESET_EDITOR_DIALOG_LAYOUT_ID = 'style-preset-editor-dialog';
export const FEATURE_SEARCH_DIALOG_LAYOUT_ID = 'feature-search';
export const FEATURE_SEARCH_EXPORT_DIALOG_LAYOUT_ID = 'feature-search-export';
export const SOURCE_DATA_SELECTION_DIALOG_LAYOUT_ID = 'source-data-selection-dialog';
export const INSPECTION_DOCK_TAB_ID = 'inspection';
export const SEARCH_DOCK_TAB_ID = 'search';
export const DEFAULT_HIGHLIGHT_COLORS = [
    "#fff314",
    "#4ad6d6",
    "#8f52ff",
    "#ff1212",
    "#3474ff",
    "#ff04d6",
    "#ffa600",
    "#b3ff99",
    "#ccefff",
    "#58cf08"
]

/** Normalizes feature search grouping values from persisted state. */
export function normalizeFeatureSearchGrouping(value: unknown): number[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const result: number[] = [];
    for (const item of value) {
        const numeric = Number(item);
        if (!Number.isInteger(numeric) || !FEATURE_SEARCH_GROUPING_OPTION_IDS.has(numeric) || result.includes(numeric)) {
            continue;
        }
        result.push(numeric);
    }
    return result;
}

/** Clamps location-search hit limits from persisted state and preferences UI. */
export function clampLocationSearchResultLimit(value: unknown): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return DEFAULT_LOCATION_SEARCH_RESULT_LIMIT;
    }
    return Math.min(MAX_LOCATION_SEARCH_RESULT_LIMIT, Math.max(1, Math.trunc(numeric)));
}

/** Version information shown in diagnostics and about dialogs. */
export interface Versions {
    name: string;
    tag: string;
    whatsnew?: string;
}

/** Canonical frontend selection identity for one feature inside one map tile. */
export interface TileFeatureId {
    featureId: string;
    mapTileKey: string;
}

/** One ordered SIMFIL field shown in the map feature-hover popover. */
export interface HoverLabelFieldConfig {
    expression: string;
    customExpression: boolean;
    /** Optional short key shown next to the value; the expression leaf is used when absent. */
    displayKey?: string;
}

/** Derives the concise key used for a hover field when no override was configured. */
export function defaultHoverLabelFieldKey(expression: string): string {
    const trimmed = expression.trim();
    const leaf = trimmed.split(".").filter(segment => segment.length).at(-1);
    return leaf ?? trimmed;
}

/** Initial hover overlay preserves the previous feature-id-only behavior. */
export const DEFAULT_HOVER_LABEL_FIELDS: HoverLabelFieldConfig[] = [{
    expression: "id",
    customExpression: false
}];

/** Selection payload used for source-data/meta-data rows that are not regular features. */
export interface SelectedSourceData {
    mapTileKey: string;
    address?: bigint;
}

/** Runtime model for one inspection panel, docked or floating. */
export interface InspectionPanelModel<FeatureRepresentation> {
    id: number;
    features: FeatureRepresentation[];
    locked: boolean;
    focused?: boolean;
    size: [number, number];
    sourceData?: SelectedSourceData;
    color: string;
    undocked: boolean;
    /** Runtime-only marker used while feature identities are resolving into inspectable wrappers. */
    loading?: boolean;
}

/** Transient expansion state for one mounted inspection tree. */
export type InspectionTreeExpansionSnapshot = Map<string, boolean | undefined>;

/** Transient inspection-tree UI state kept while moving panels between docked and floating hosts. */
export interface InspectionTreeExpansionState {
    expandedNodes: InspectionTreeExpansionSnapshot;
    fullExpansionActive: boolean;
    expansionSnapshotBeforeFullExpand?: InspectionTreeExpansionSnapshot;
    fullCollapseActive: boolean;
    expansionSnapshotBeforeFullCollapse?: InspectionTreeExpansionSnapshot;
}

/** Persisted top-left dialog position in viewport pixels. */
export interface AppDialogPosition {
    left: number;
    top: number;
}

/** Persisted dialog size in viewport pixels. */
export interface AppDialogSize {
    width: number;
    height: number;
}

/** Generic persisted dialog layout record. */
export interface AppDialogLayout {
    position: AppDialogPosition;
    size: AppDialogSize;
    open?: boolean;
    docked?: boolean;
    dockTab?: string;
    dockOrder?: number;
    panelSize?: AppDialogSize;
    panelCollapsed?: boolean;
    panelExpanded?: boolean;
}

/** Persisted layout for floating inspection dialogs, including dock preference. */
export interface InspectionDialogLayout extends AppDialogLayout {
    panelId: number;
    slot: number;
}

/** One selectable comparison candidate for the inspection comparison dialog. */
export interface InspectionComparisonEntry {
    panelId: number;
    mapId: string;
    label: string;
    featureIds: TileFeatureId[];
}

/** Complete model for the inspection comparison dialog. */
export interface InspectionComparisonModel {
    base: InspectionComparisonEntry;
    others: InspectionComparisonEntry[];
}

/** Command-style option that can populate an inspection comparison slot. */
export interface InspectionComparisonOption {
    label: string;
    value: number;
}

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

/** Per-view configuration entry for one map/layer selection. */
export interface LayerViewConfig {
    autoLevel: boolean;
    level: number;
    visible: boolean;
}

/** One complete per-option value array written through the atomic style-state batch API. */
export interface StyleOptionStateUpdate {
    mapId: string;
    layerId: string;
    shortStyleId: string;
    optionId: string;
    values: Array<string | number | boolean>;
}

/** Qualified layer-preset selections for concrete map/layer pairs within one map view. */
export type LayerPresetSelections = Record<string, Record<string, LayerPresetRef>>;

/** Map-preset selections for concrete maps within one map view. */
export type MapPresetSelections = Record<string, string>;

export const LAYER_PRESET_REF_SCHEMA = z.object({
    styleId: z.string(),
    presetId: z.string().min(1)
}).strict();

// A stored unqualified id from the former global preset implementation is retained
// with an empty style id so the map tree can migrate it only when resolution is unique.
export const STORED_LAYER_PRESET_REF_SCHEMA = z.union([
    LAYER_PRESET_REF_SCHEMA,
    z.string().min(1).transform(presetId => ({styleId: "", presetId}))
]);

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

/** Limits used while validating imported viewer snapshots. */
export interface SnapshotImportLimits {
    maxFileSizeBytes: number;
    maxTopLevelEntries: number;
    maxNestingDepth: number;
    maxCollectionEntries: number;
    maxStringLength: number;
}

/** Result of snapshot normalization before schema validation is applied. */
export interface SnapshotNormalizationResult {
    normalized?: Record<string, unknown>;
    errors: string[];
}

export interface ConfigDefaultStateMetaEntry {
    owner: "config" | "user";
    valueHash: string;
}

export interface ConfigDefaultStateMeta {
    version: 1;
    sourceHash: string;
    entries: Record<string, ConfigDefaultStateMetaEntry>;
}

/** Returns whether the layer id refers to source or meta-data rather than a feature layer. */
export function isSourceOrMetaData(mapLayerNameOrLayerId: string): boolean {
    return mapLayerNameOrLayerId.includes('/SourceData-') ||
        mapLayerNameOrLayerId.includes('/Metadata-');
}

/** Rounds persisted coordinates so URLs remain stable and reasonably short. */
export function roundCoordinateStateValue(value: number): number {
    if (!Number.isFinite(value)) {
        return value;
    }
    return Math.round(value * COORDINATE_STATE_PRECISION) / COORDINATE_STATE_PRECISION;
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

/** Produces a detached clone suitable for app-state snapshots and comparisons. */
export function cloneStateValue<T>(value: T): T {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (value instanceof Date) {
        return new Date(value.getTime()) as unknown as T;
    }
    if (Array.isArray(value)) {
        return value.map(entry => cloneStateValue(entry)) as unknown as T;
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        result[key] = cloneStateValue(entry);
    }
    return result as T;
}

/** Serializes state values with deterministic key ordering. */
export function stableSerializeStateValue(value: unknown): string {
    if (value === null) {
        return "null";
    }
    if (value === undefined) {
        return "undefined";
    }
    if (typeof value === "string") {
        return JSON.stringify(value);
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(entry => stableSerializeStateValue(entry)).join(",")}]`;
    }
    if (value && typeof value === "object") {
        const objectValue = value as Record<string, unknown>;
        const keys = Object.keys(objectValue).sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${stableSerializeStateValue(objectValue[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

/** Computes a stable hash for a state value. */
export function hashStateValue(value: unknown): string {
    const serialized = stableSerializeStateValue(value);
    let hash = 0x811c9dc5;
    for (let i = 0; i < serialized.length; i++) {
        hash ^= serialized.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}