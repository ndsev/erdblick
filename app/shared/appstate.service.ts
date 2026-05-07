import {Injectable, OnDestroy} from "@angular/core";
import {NavigationEnd, NavigationStart, Params, Router} from "@angular/router";
import {BehaviorSubject, skip, Subscription, take} from "rxjs";
import {filter} from "rxjs/operators";
import {Cartographic, GeoMath} from "../integrations/geo";
import {AppState, AppStateOptions, Boolish, MapViewState, StyleState} from "./app-state";
import {z} from "zod";
import {MapTreeNode} from "../mapdata/map.tree.model";
import {ErdblickStyle} from "../styledata/style.service";
import {coreLib} from "../integrations/wasm";
import {InfoMessageService} from "./info.service";
import type {FeatureWrapper} from "../mapdata/features.model";
import type {DiagnosticsExportOptions, DiagnosticsLogFilter} from "../diagnostics/diagnostics.model";
import {
    BackgroundLayerConfig,
    clampBackgroundOpacity,
    DEFAULT_BACKGROUND_LAYER_ID
} from "./app-config.service";
import {
    historyEntryDedupeKey,
    normalizeResolvedSearchHistoryEntry,
    normalizeSearchHistoryEntry,
    normalizeSearchStateValue,
    SearchHistoryEntry,
    SearchHistoryStateEntry,
    SearchStateSchema,
    SearchStateValue,
    SearchHistoryStateEntrySchema,
    serializeSearchStateValue
} from "./search-history";

const COORDINATE_STATE_DECIMAL_PLACES = 8;
const COORDINATE_STATE_PRECISION = 10 ** COORDINATE_STATE_DECIMAL_PLACES;

export const MAX_SIMULTANEOUS_INSPECTIONS = 50;
export const MAX_COMPARE_PANELS = 4;
export const MAX_NUM_TILES_TO_LOAD = 512;
export const DEFAULT_MAP_ZOOM_STEP = 0.5;
export const MIN_MAP_ZOOM_STEP = 0.001;
export const MAX_MAP_ZOOM_STEP = 1.0;
export const VIEW_SYNC_PROJECTION = "proj";
export const VIEW_SYNC_POSITION = "pos";
export const VIEW_SYNC_MOVEMENT = "mov";
export const VIEW_SYNC_LAYERS = "lay";
export const DEFAULT_EM_WIDTH = 30;
export const DEFAULT_EM_HEIGHT = 40;
export const DEFAULT_DOCKED_EM_HEIGHT = 20;
export const MAX_DECK_STYLE_WORKERS = 32;
export const DEFAULT_DECK_STYLE_WORKER_COUNT = 2;
export const ABOUT_DIALOG_LAYOUT_ID = 'about-dialog';
export const LEGAL_INFO_DIALOG_LAYOUT_ID = 'legal-info-dialog';
export const PREFERENCES_DIALOG_LAYOUT_ID = 'preferences-dialog';
export const KEYBOARD_DIALOG_LAYOUT_ID = 'keyboard-dialog';
export const DATASOURCES_EDITOR_DIALOG_LAYOUT_ID = 'datasources-editor-dialog';
export const ADVANCED_PREFERENCES_DIALOG_LAYOUT_ID = 'advanced-preferences-dialog';
export const DIAGNOSTICS_PERFORMANCE_DIALOG_LAYOUT_ID = 'diagnostics-performance';
export const DIAGNOSTICS_LOG_DIALOG_LAYOUT_ID = 'diagnostics-log';
export const DIAGNOSTICS_EXPORT_DIALOG_LAYOUT_ID = 'diagnostics-export';
export const STYLES_DIALOG_LAYOUT_ID = 'styles-dialog';
export const STYLE_EDITOR_DIALOG_LAYOUT_ID = 'style-editor-dialog';
export const FEATURE_SEARCH_DIALOG_LAYOUT_ID = 'feature-search';
export const SOURCE_DATA_SELECTION_DIALOG_LAYOUT_ID = 'source-data-selection-dialog';
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
    size: [number, number];
    sourceData?: SelectedSourceData;
    color: string;
    undocked: boolean;
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

/** Enumerates view properties that can be synchronized across split views. */
export interface ViewSyncOptionDescriptor {
    name: string;
    code: string;
    icon: string;
    tooltip: string;
}

/** Tile-grid overlay labeling mode used by the map panel and Deck overlay. */
export type TileGridMode = "xyz" | "nds";

/** Limits used while validating imported viewer snapshots. */
interface SnapshotImportLimits {
    maxFileSizeBytes: number;
    maxTopLevelEntries: number;
    maxNestingDepth: number;
    maxCollectionEntries: number;
    maxStringLength: number;
}

/** Result of snapshot normalization before schema validation is applied. */
interface SnapshotNormalizationResult {
    normalized?: Record<string, unknown>;
    errors: string[];
}

interface ConfigDefaultStateMetaEntry {
    owner: "config" | "user";
    valueHash: string;
}

interface ConfigDefaultStateMeta {
    version: 1;
    sourceHash: string;
    entries: Record<string, ConfigDefaultStateMetaEntry>;
}

/** Returns whether the layer id refers to source or meta-data rather than a feature layer. */
function isSourceOrMetaData(mapLayerNameOrLayerId: string): boolean {
    return mapLayerNameOrLayerId.includes('/SourceData-') ||
        mapLayerNameOrLayerId.includes('/Metadata-');
}

/** Rounds persisted coordinates so URLs remain stable and reasonably short. */
function roundCoordinateStateValue(value: number): number {
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

/** Produces a detached clone suitable for app-state snapshots and comparisons. */
function cloneStateValue<T>(value: T): T {
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

function stableSerializeStateValue(value: unknown): string {
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

function hashStateValue(value: unknown): string {
    const serialized = stableSerializeStateValue(value);
    let hash = 0x811c9dc5;
    for (let i = 0; i < serialized.length; i++) {
        hash ^= serialized.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

@Injectable({providedIn: 'root'})
/**
 * Centralizes persisted viewer state, URL/storage hydration, dialog layout, selection state,
 * and cross-view synchronization.
 */
export class AppStateService implements OnDestroy {

    private readonly statePool = new Map<string, AppState<unknown>>();
    private readonly mapViewStates: Array<MapViewState<unknown>> = [];
    readonly ready = new BehaviorSubject<boolean>(false);

    private readonly stateSubscriptions: Subscription[] = [];

    private _replaceUrl = true;

    private isHydrating = false;
    private isSeedingConfigDefaults = false;
    private isSystemStateMutation = false;
    private isReady = false;
    private subscriptionsSetup = false;
    private pendingUrlSyncStates = new Set<AppState<any>>;
    private pendingStorageSyncStates = new Set<AppState<any>>;
    private pendingUserOwnershipStates = new Set<string>();
    private pendingPopstateHydration = false;
    private flushHandle: Promise<void> | null = null;
    private urlSyncHandle: ReturnType<typeof setTimeout> | null = null;
    private lastMergedUrlSyncAt = 0;
    // One-shot guard used to keep inbound v1 links stable during passive startup.
    private skipNextUrlSync = false;
    private readonly STYLE_OPTIONS_STORAGE_KEY = 'styleOptions';
    private readonly CONFIG_DEFAULT_STATE_META_KEY = "erdblickConfigDefaultStateMeta";
    private readonly SNAPSHOT_UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
    private static readonly URL_SYNC_MIN_INTERVAL_MS = 50;
    private configDefaultStateMeta: ConfigDefaultStateMeta = {
        version: 1,
        sourceHash: "",
        entries: Object.create(null)
    };
    private configDefaultValueHashes = new Map<string, string>();
    private currentConfigDefaultKeys = new Set<string>();

    // Base UI metrics
    get baseFontSize(): number {
        return parseFloat(window.getComputedStyle(document.documentElement).fontSize);
    }
    get defaultInspectionPanelSize(): [number, number] {
        return [DEFAULT_EM_WIDTH, DEFAULT_EM_HEIGHT];
    }

    readonly numViewsState = this.createState<number>({
        name: "numberOfViews",
        defaultValue: 1,
        schema: z.coerce.number().positive(),
        urlParamName: "n"
    });

    readonly searchState = this.createState<SearchStateValue>({
        name: 'search',
        defaultValue: [],
        schema: SearchStateSchema,
        toStorage: (value: SearchStateValue) => serializeSearchStateValue(value),
        fromStorage: (payload: any): SearchStateValue => normalizeSearchStateValue(payload),
        urlParamName: 's',
        urlIncludeInVisualizationOnly: false
    });

    readonly markerState = this.createState<boolean>({
        name: 'marker',
        defaultValue: false,
        schema: Boolish,
        urlParamName: 'm',
        urlIncludeInVisualizationOnly: false
    });

    readonly markedPositionState = this.createState<number[]>({
        name: 'markedPosition',
        defaultValue: [],
        schema: z.array(z.coerce.number()).max(2),
        toStorage: (value: number[]) => value.map(v => roundCoordinateStateValue(v)),
        fromStorage: (payload: any): number[] => (payload as number[]).map(v => roundCoordinateStateValue(v)),
        urlParamName: 'mp',
        urlIncludeInVisualizationOnly: false
    });

    // 2~0~features:map:layer:tile~featureid~layertype:map:layer:tile~featureid~layertype:map:layer:tile~featureid~245:56
    // 1~0~sourcedata:map:layer:tile~address~...features...~size
    // 0~1~...
    readonly selectionState = this.createState<InspectionPanelModel<TileFeatureId>[]>({
        name: 'selected',
        defaultValue: [],
        schema: z.array(z.string()),
        toStorage: (value: InspectionPanelModel<TileFeatureId>[])=> {
            return value.map(state => {
                let s = `${state.id}~${state.locked ? 1 : 0}~`;
                if (state.sourceData) {
                    s += `${state.sourceData.mapTileKey}~${state.sourceData.address ?? ''}~`
                }
                s += `${state.features.map(id => `${id.mapTileKey}~${id.featureId}`).join('~')}~`;
                // Remove # character from hex color
                const color = state.color.startsWith('#') ? state.color.slice(1) : state.color;
                s += `${state.size[0]}:${state.size[1]}~${color}~${state.undocked ? 1 : 0}`;
                return s;
            });
        },
        fromStorage: (payload: any): InspectionPanelModel<TileFeatureId>[] => {
            const result: InspectionPanelModel<TileFeatureId>[] = []
            if (!payload || !payload.length) {
                return result;
            }
            for (const panelStateStr of payload) {
                const parts: string[] = panelStateStr.split('~');
                if (parts.length < 7) {
                    continue;
                }
                const id = Number(parts.shift()!);
                const lockState = parts.shift() === "1";
                const undocked = parts.pop()! === "1";
                const colorToken = parts.pop()!;
                const color = colorToken.length > 0 && !colorToken.startsWith('#') ? `#${colorToken}` : colorToken;
                const sizeToken = parts.pop()!;
                const sizeParts = sizeToken.split(':');
                const size = sizeParts.length === 2 ? [Number(sizeParts[0]), Number(sizeParts[1])] : this.defaultInspectionPanelSize;

                const newPanelState: InspectionPanelModel<TileFeatureId> = {
                    id: id,
                    features: [],
                    locked: lockState || !undocked,
                    size: size as [number, number],
                    color: color,
                    undocked: undocked
                };

                // Check if the first MapTileKey is for SourceData.
                if (parts[0].startsWith("SourceData:")) {
                    const mapTileKey = parts.shift()!;
                    newPanelState.sourceData = {
                        mapTileKey: mapTileKey,
                        address: parts[0].length ? BigInt(parts[0]) : undefined
                    };
                    // Shift the address.
                    parts.shift();
                }

                // The remaining strings are MapTileKey-FeatureId-pairs.
                while (parts.length >= 2) {
                    newPanelState.features.push({
                        mapTileKey: parts.shift()!,
                        featureId: parts.shift()!
                    })
                }

                result.push(newPanelState);
            }
            return result;
        },
        urlParamName: 'sel',
        urlIncludeInVisualizationOnly: false
    });

    readonly focusedViewState = this.createState<number>({
        name: 'focus',
        defaultValue: 0,
        schema: z.coerce.number().nonnegative(),
        urlParamName: 'f',
        urlIncludeInVisualizationOnly: false
    });

    readonly viewSyncState = this.createState<string[]>({
        name: 'viewSync',
        defaultValue: [],
        schema: z.array(z.union([
            z.literal(VIEW_SYNC_PROJECTION),
            z.literal(VIEW_SYNC_POSITION),
            z.literal(VIEW_SYNC_MOVEMENT),
            z.literal(VIEW_SYNC_LAYERS)
        ])),
        urlParamName: 'sync',
        urlIncludeInVisualizationOnly: false
    });

    readonly cameraViewDataState = this.createMapViewState<CameraViewState>({
        name: 'cameraView',
        defaultValue: {
            destination: {lon: 22.837473, lat: 38.490817, alt: 16000000},
            orientation: {heading: 0, pitch: -Math.PI / 2, roll: 0}
        },
        schema: z.object({
            lon: z.coerce.number().optional(),
            lat: z.coerce.number().optional(),
            alt: z.coerce.number().optional(),
            h: z.coerce.number().optional(),
            p: z.coerce.number().optional(),
            r: z.coerce.number().optional()
        }),
        toStorage: (value: any) => ({
            lon: roundCoordinateStateValue(value.destination.lon),
            lat: roundCoordinateStateValue(value.destination.lat),
            alt: roundCoordinateStateValue(value.destination.alt),
            h: roundCoordinateStateValue(value.orientation.heading),
            p: roundCoordinateStateValue(value.orientation.pitch),
            r: roundCoordinateStateValue(value.orientation.roll)
        }),
        fromStorage: (payload: any, currentValue: CameraViewState) => ({
            destination: {
                lon: roundCoordinateStateValue(payload.lon ?? currentValue.destination.lon),
                lat: roundCoordinateStateValue(payload.lat ?? currentValue.destination.lat),
                alt: roundCoordinateStateValue(payload.alt ?? currentValue.destination.alt),
            },
            orientation: {
                heading: roundCoordinateStateValue(payload.h ?? currentValue.orientation.heading),
                pitch: roundCoordinateStateValue(payload.p ?? currentValue.orientation.pitch),
                roll: roundCoordinateStateValue(payload.r ?? currentValue.orientation.roll),
            }
        }),
        urlFormEncode: true
    });

    readonly mode2dState = this.createMapViewState<boolean>({
        name: 'mode2d',
        defaultValue: false,
        schema: Boolish,
        urlParamName: 'm2d',
        urlIncludeInVisualizationOnly: false
    });

    readonly deckStyleWorkersOverrideState = this.createState<boolean>({
        name: 'deckStyleWorkersOverride',
        defaultValue: false,
        schema: Boolish
    });

    readonly deckThreadedRenderingEnabledState = this.createState<boolean>({
        name: 'deckThreadedRenderingEnabled',
        defaultValue: true,
        schema: Boolish
    });

    readonly pinLowFiToMaxLodState = this.createState<boolean>({
        name: 'pinLowFiToMaxLod',
        defaultValue: false,
        schema: Boolish
    });

    readonly debugRenderFullGltfAttachmentState = this.createState<boolean>({
        name: 'debugRenderFullGltfAttachment',
        defaultValue: false,
        schema: Boolish
    });

    readonly debugGltfLoggingEnabledState = this.createState<boolean>({
        name: 'debugGltfLoggingEnabled',
        defaultValue: false,
        schema: Boolish
    });

    readonly deckStyleWorkersCountState = this.createState<number>({
        name: 'deckStyleWorkersCount',
        defaultValue: DEFAULT_DECK_STYLE_WORKER_COUNT,
        schema: z.coerce.number().int().min(1).max(MAX_DECK_STYLE_WORKERS)
    });

    readonly tilePullCompressionEnabledState = this.createState<boolean>({
        name: 'tilePullCompressionEnabled',
        defaultValue: false,
        schema: Boolish
    });

    readonly mapZoomStepState = this.createState<number>({
        name: 'mapZoomStep',
        defaultValue: DEFAULT_MAP_ZOOM_STEP,
        schema: z.coerce.number(),
        fromStorage: value => clampMapZoomStep(Number(value))
    });

    readonly layerSyncOptionsState = this.createMapViewState<boolean>({
        name: 'layerSyncOptions',
        defaultValue: false,
        schema: Boolish,
        urlIncludeInVisualizationOnly: false
    });

    readonly backgroundState = this.createMapViewState<BackgroundLayerViewState>({
        name: 'background',
        defaultValue: {
            layerId: DEFAULT_BACKGROUND_LAYER_ID,
            opacity: 100,
        },
        schema: z.string(),
        toStorage: (value: BackgroundLayerViewState) => `${encodeURIComponent(value.layerId ?? '')}~${clampBackgroundOpacity(value.opacity)}`,
        fromStorage: (payload: any, currentValue: BackgroundLayerViewState): BackgroundLayerViewState => {
            const parts = String(payload).split('~');
            const layerId = parts[0] ? decodeURIComponent(parts[0]) : null;
            const opacity = parts[1] === undefined ? currentValue.opacity : clampBackgroundOpacity(Number(parts[1]));
            return {layerId, opacity};
        },
        urlParamName: 'bg'
    });

    readonly layerNamesState = this.createState<Array<string>>({
        name: "layerNames",
        defaultValue: [],
        schema: z.array(z.string()),
        urlParamName: 'l'
    });

    readonly layerVisibilityState = this.createMapViewState<Array<boolean>>({
        name: "visibility",
        defaultValue: [],
        schema: z.array(Boolish),
        urlParamName: 'v'
    });

    readonly viewTileBordersState = this.createMapViewState<boolean>({
        name: "tileBorders",
        defaultValue: true,
        schema: Boolish,
        urlParamName: 'tb'
    });

    readonly viewTileGridModeState = this.createMapViewState<TileGridMode>({
        name: "tileGridMode",
        defaultValue: "nds",
        schema: z.enum(["xyz", "nds"]),
        urlParamName: 'tgm'
    });

    readonly layerZoomLevelState = this.createMapViewState<Array<number>>({
        name: "zoomLevel",
        defaultValue: [],
        schema: z.array(z.number().min(0).max(15)),
        urlParamName: 'z'
    });

    readonly layerAutoZoomLevelState = this.createMapViewState<Array<boolean>>({
        name: "autoZoomLevel",
        defaultValue: [],
        schema: z.array(Boolish),
        urlParamName: 'az'
    });

    readonly stylesState = new StyleState(this.statePool);

    readonly styleVisibilityState = this.createState<Record<string, boolean>>({
        name: 'styleVisiblity',
        schema: z.record(z.string(), z.coerce.boolean()),
        defaultValue: {}
    });

    readonly tilesLoadLimitState = this.createState<number>({
        name: 'tilesLoadLimit',
        defaultValue: MAX_NUM_TILES_TO_LOAD,
        schema: z.coerce.number().nonnegative(),
        urlParamName: 'tll'
    });

    readonly enabledCoordsTileIdsState = this.createState<string[]>({
        name: 'enabledCoordsTileIds',
        defaultValue: ["WGS84"],
        schema: z.array(z.string())
    });

    readonly diagnosticsLogFilterState = this.createState<DiagnosticsLogFilter>({
        name: 'diagnosticsLogFilter',
        defaultValue: {
            info: true,
            warn: true,
            error: true
        },
        schema: z.object({
            info: Boolish,
            warn: Boolish,
            error: Boolish
        })
    });

    readonly diagnosticsExportOptionsState = this.createState<DiagnosticsExportOptions>({
        name: 'diagnosticsExportOptions',
        defaultValue: {
            includeProgress: true,
            includePerformance: true,
            includeLogs: true,
            logFilter: {
                info: true,
                warn: true,
                error: true
            }
        },
        schema: z.object({
            includeProgress: Boolish,
            includePerformance: Boolish,
            includeLogs: Boolish,
            logFilter: z.object({
                info: Boolish,
                warn: Boolish,
                error: Boolish
            })
        })
    });

    readonly lastSearchHistoryEntryState = this.createState<SearchHistoryStateEntry | null>({
        name: 'lastSearchHistoryEntry',
        defaultValue: null,
        schema: z.union([
            z.null(),
            SearchHistoryStateEntrySchema,
        ]),
        fromStorage: (payload: any): SearchHistoryStateEntry | null => {
            if (payload === null) {
                return null;
            }
            return normalizeSearchHistoryEntry(payload);
        }
    });

    readonly mapsOpenState = this.createState<boolean>({
        name: 'mapsOpenState',
        defaultValue: false,
        schema: Boolish
    });

    readonly styleEditorTargetState = this.createState<string | null>({
        name: 'styleEditorTarget',
        defaultValue: null,
        schema: z.string().nullable()
    });

    readonly dockOpenState = this.createState<boolean>({
        name: 'dockOpenState',
        defaultValue: false,
        schema: Boolish
    });

    readonly dockAutoCollapse = this.createState<boolean>({
        name: 'dockAutoCollapse',
        defaultValue: true,
        schema: Boolish
    });

    readonly distributionVersions = this.createState<Versions[]>({
        name: 'distributionVersions',
        defaultValue: [],
        schema: z.array(z.record(z.string(), z.string()))
    });

    readonly erdblickVersion = this.createState<string>({
        name: 'erdblickVersion',
        defaultValue: "",
        schema: z.string()
    });

    readonly inspectionsLimitState = this.createState<number>({
        name: 'inspectionsLimitState',
        defaultValue: Math.floor(MAX_SIMULTANEOUS_INSPECTIONS / 2),
        schema: z.coerce.number().int().min(1).max(MAX_SIMULTANEOUS_INSPECTIONS)
    });

    readonly inspectionComparisonState = this.createState<InspectionComparisonModel | null>({
        name: 'inspectionComparisonState',
        defaultValue: null,
        schema: z.union([
            z.null(),
            z.object({
                base: z.object({
                    panelId: z.coerce.number(),
                    mapId: z.string().optional().default(''),
                    label: z.string(),
                    featureIds: z.array(z.object({
                        featureId: z.string(),
                        mapTileKey: z.string()
                    }))
                }),
                others: z.array(z.object({
                    panelId: z.coerce.number(),
                    mapId: z.string().optional().default(''),
                    label: z.string(),
                    featureIds: z.array(z.object({
                        featureId: z.string(),
                        mapTileKey: z.string()
                    }))
                }))
            })
        ])
    });

    readonly dialogLayoutsState = this.createState<Record<string, AppDialogLayout | InspectionDialogLayout>>({
        name: 'dialogLayouts',
        defaultValue: {},
        schema: z.record(z.string(), z.object({
            position: z.object({
                left: z.coerce.number(),
                top: z.coerce.number()
            }),
            size: z.object({
                width: z.coerce.number().positive(),
                height: z.coerce.number().positive()
            }),
            open: Boolish.optional(),
            panelId: z.coerce.number().optional(),
            slot: z.coerce.number().optional()
        }))
    });

    private readonly pendingOpenDialogs = new Set<string>();

    /** Immutable view-sync option descriptors consumed by the split-view UI. */
    readonly syncOptions: readonly ViewSyncOptionDescriptor[] = [
        {name: "Position", code: VIEW_SYNC_POSITION, icon: "location_on", tooltip: "Sync camera position/orientation across views"},
        {name: "Movement", code: VIEW_SYNC_MOVEMENT, icon: "drag_pan", tooltip: "Sync camera movement delta across views"},
        {name: "Projection", code: VIEW_SYNC_PROJECTION, icon: "3d_rotation", tooltip: "Sync projection mode across views"},
        {name: "Layers", code: VIEW_SYNC_LAYERS, icon: "layers", tooltip: "Sync layer activation/style/background settings across views"},
    ];

    /** Registers all persisted state slots and wires startup hydration/persistence flow. */
    constructor(private readonly router: Router,
                private readonly infoMessageService: InfoMessageService) {
        // Perform initial hydration after the initial NavigationEnd event arrives.
        this.router.events.pipe(filter(event => event instanceof NavigationEnd), take(1)).subscribe(() => {
            this.setupStateSubscriptions();
            this.hydrateFromStorage();
            this.hydrateFromUrl(this.router.routerState.snapshot.root?.queryParams ?? {});
            this.migrateLegacyOsmState(this.router.routerState.snapshot.root?.queryParams ?? {});
            this.isHydrating = false;
            // Keep inbound links stable during passive startup hydration.
            this.skipNextUrlSync = true;

            // Ensure that the merged app state after hydration is reflected in local storage and URL.
            this.syncAllStates();

            this.isReady = true;
            this.ready.next(true);
        });

        // Subsequently, Navigation events may come from usage of the browser back/forward-buttons.
        this.router.events.subscribe(event => {
            if (event instanceof NavigationStart) {
                const nav = this.router.getCurrentNavigation();
                this.pendingPopstateHydration = nav?.trigger === 'popstate';
                if (this.pendingPopstateHydration) {
                    this.cancelPendingStateSync();
                }
            } else if (event instanceof NavigationEnd) {
                if (!this.pendingPopstateHydration) {
                    return;
                }
                this.pendingPopstateHydration = false;
                if (!this.isReady) {
                    return;
                }
                this.cancelPendingStateSync();
                this.withHydration(() => {
                    this.hydrateFromUrl(this.router.routerState.snapshot.root?.queryParams ?? {});
                });
            }
        });

        this.selectionState.subscribe(panels => {
            this.pruneInspectionDialogLayout(panels.map(panel => panel.id));
        });
    }

    /** Flushes all state slots to storage and URL after a batch update. */
    private syncAllStates() {
        this.statePool.values().forEach(state => this.onStateChanged(state, true));
    }

    /** Copies synchronized view properties from the focused view to the others. */
    syncViews(): void {
        if (this.numViews < 2) {
            return;
        }
        if (this.viewSync.includes(VIEW_SYNC_POSITION)) {
            const camState = this.cameraViewDataState.getValue(this.focusedView);
            this.setView(this.focusedView,
                Cartographic.fromDegrees(camState.destination.lon, camState.destination.lat, camState.destination.alt));
        }
        if (this.viewSync.includes(VIEW_SYNC_PROJECTION)) {
            this.setProjectionMode(this.focusedView, this.mode2dState.getValue(this.focusedView));
        }
    }

    /** Cancels pending persistence work when the service is destroyed. */
    ngOnDestroy(): void {
        this.stateSubscriptions.forEach(subscription => subscription.unsubscribe());
        if (this.urlSyncHandle !== null) {
            clearTimeout(this.urlSyncHandle);
            this.urlSyncHandle = null;
        }
    }

    get replaceUrl() {
        const currentValue = this._replaceUrl;
        this._replaceUrl = true;
        return currentValue;
    }

    private createState<T>(options: AppStateOptions<T>): AppState<T> {
        return new AppState<T>(this.statePool, options);
    }

    private createMapViewState<T>(options: AppStateOptions<T>): MapViewState<T> {
        const state = new MapViewState<T>(this.statePool, options);
        this.mapViewStates.push(state as MapViewState<unknown>);
        return state;
    }

    /** Seeds newly created views with defaults copied from the first view. */
    private seedAdditionalViews(previousViewCount: number, nextViewCount: number): void {
        if (nextViewCount <= previousViewCount) {
            return;
        }

        for (let targetViewIndex = previousViewCount; targetViewIndex < nextViewCount; targetViewIndex++) {
            const sourceViewIndex = Math.max(0, targetViewIndex - 1);
            for (const state of this.mapViewStates) {
                state.next(targetViewIndex, cloneStateValue(state.getValue(sourceViewIndex)));
            }
        }

        if (this.styles.size === 0) {
            return;
        }

        const nextStyles = new Map<string, (string|number|boolean)[]>();
        for (const [key, values] of this.styles.entries()) {
            const nextValues = [...values];
            for (let targetViewIndex = previousViewCount; targetViewIndex < nextViewCount; targetViewIndex++) {
                const sourceViewIndex = Math.max(0, targetViewIndex - 1);
                const sourceValue = nextValues[sourceViewIndex];
                if (sourceValue === undefined) {
                    continue;
                }
                nextValues[targetViewIndex] = cloneStateValue(sourceValue);
            }
            nextStyles.set(key, nextValues);
        }
        this.stylesState.next(nextStyles);
    }

    /** Subscribes to all persisted state slots so storage and URL remain in sync. */
    private setupStateSubscriptions() {
        if (this.subscriptionsSetup) return;
        // NOTE: Is this the best way to implement the internal subscription mechanism?
        for (const state of this.statePool.values()) {
            const subscription = (state as AppState<unknown>).pipe(skip(1)).subscribe(value => {
                this.onStateChanged(state as AppState<unknown>);
            });
            this.stateSubscriptions.push(subscription);
        }
        this.subscriptionsSetup = true;
    }

    /** Handles one state-slot change and schedules the required persistence work. */
    private onStateChanged(state: AppState<any>, force: boolean = false): void {
        const markUserOwned = !force
            && this.isReady
            && !this.isHydrating
            && !this.isSeedingConfigDefaults
            && !this.isSystemStateMutation;
        if (markUserOwned) {
            this.pendingUserOwnershipStates.add(state.name);
        }

        if (!force && (this.isHydrating || !this.isReady || this.isSeedingConfigDefaults)) {
            return;
        }

        this.pendingStorageSyncStates.add(state);
        if (state.isUrlState()) {
            this.pendingUrlSyncStates.add(state);
        }

        this.scheduleFlush();
    }

    /** Schedules the batched storage flush used after state changes. */
    private scheduleFlush(): void {
        if (this.flushHandle) {
            return;
        }
        this.flushHandle = Promise.resolve().then(() => {
            this.flushHandle = null;
            if (this.isHydrating) {
                this.pendingStorageSyncStates.clear();
                this.pendingUrlSyncStates.clear();
                return;
            }
            this.syncStorage();
            this.scheduleUrlSync();
        });
    }

    /** Cancels any pending batched URL/storage synchronization timers. */
    private cancelPendingStateSync(): void {
        // Prevent stale, queued writes from a previous URL hydration cycle.
        this.pendingStorageSyncStates.clear();
        this.pendingUrlSyncStates.clear();
        if (this.urlSyncHandle !== null) {
            clearTimeout(this.urlSyncHandle);
            this.urlSyncHandle = null;
        }
    }

    /** Writes all storage-backed state slots to local storage. */
    private syncStorage(): void {
        for (const state of this.pendingStorageSyncStates) {
            const markUserOwned = this.pendingUserOwnershipStates.has(state.name);
            try {
                const serialized = state.serialize(false);
                if (serialized === undefined) {
                    continue;
                }
                if (state === this.stylesState) {
                    localStorage.removeItem(this.STYLE_OPTIONS_STORAGE_KEY);
                    this.clearStyleOptionStorageEntries();
                }
                for (const [k, v] of Object.entries(serialized)) {
                    localStorage.setItem(k, v);
                }

                const stateHash = this.stateValueHashForMeta(state);
                const expectedConfigHash = this.configDefaultValueHashes.get(state.name);
                if (expectedConfigHash && expectedConfigHash === stateHash) {
                    this.setMetaOwner(state.name, "config", stateHash);
                } else if (markUserOwned) {
                    this.setMetaOwner(state.name, "user", stateHash);
                } else if (this.configDefaultStateMeta.entries[state.name]) {
                    this.configDefaultStateMeta.entries[state.name].valueHash = stateHash;
                }

                if (state === this.stylesState) {
                    const serializedStyleEntries = this.stylesState.serialize(false) ?? {};
                    const serializedStyleKeys = new Set(
                        Object.keys(serializedStyleEntries).filter(key =>
                            this.stylesState.isStyleOptionUrlParamKey(key)));
                    for (const key of Object.keys(this.configDefaultStateMeta.entries)) {
                        if (this.stylesState.isStyleOptionUrlParamKey(key) && !serializedStyleKeys.has(key)) {
                            delete this.configDefaultStateMeta.entries[key];
                        }
                    }
                    for (const [key, value] of Object.entries(serializedStyleEntries)) {
                        if (!this.stylesState.isStyleOptionUrlParamKey(key)) {
                            continue;
                        }
                        const valueHash = hashStateValue(value);
                        const expectedStyleConfigHash = this.configDefaultValueHashes.get(key);
                        if (expectedStyleConfigHash && expectedStyleConfigHash === valueHash) {
                            this.setMetaOwner(key, "config", valueHash);
                        } else if (markUserOwned) {
                            this.setMetaOwner(key, "user", valueHash);
                        } else if (this.configDefaultStateMeta.entries[key]) {
                            this.configDefaultStateMeta.entries[key].valueHash = valueHash;
                        }
                    }
                }
            } catch (error) {
                console.error(`[AppStateService] Failed to persist state '${state.name}'`, error);
            }
            this.pendingUserOwnershipStates.delete(state.name);
        }
        this.persistConfigDefaultStateMeta();
        this.pendingStorageSyncStates.clear();
    }

    /** Schedules debounced URL synchronization after state changes. */
    private scheduleUrlSync(): void {
        if (!this.pendingUrlSyncStates.size) {
            return;
        }
        if (this.urlSyncHandle !== null) {
            return;
        }
        // Browsers can reject rapid History API updates; keep merge syncs below that threshold.
        const elapsed = Date.now() - this.lastMergedUrlSyncAt;
        const delay = Math.max(0, AppStateService.URL_SYNC_MIN_INTERVAL_MS - elapsed);
        if (delay === 0) {
            this.flushUrlSync();
            return;
        }
        this.urlSyncHandle = setTimeout(() => {
            this.urlSyncHandle = null;
            this.flushUrlSync();
        }, delay);
    }

    /** Executes the debounced URL synchronization immediately. */
    private flushUrlSync(): void {
        if (this.isHydrating) {
            this.pendingUrlSyncStates.clear();
            return;
        }
        if (!this.pendingUrlSyncStates.size) {
            return;
        }
        if (this.skipNextUrlSync) {
            this.skipNextUrlSync = false;
            this.pendingUrlSyncStates.clear();
            return;
        }
        const queryParamsHandling = this.syncUrl();
        if (queryParamsHandling === 'merge') {
            this.lastMergedUrlSyncAt = Date.now();
        }
        if (this.pendingUrlSyncStates.size) {
            this.scheduleUrlSync();
        }
    }

    /** Serializes URL-backed state and updates router query params accordingly. */
    private syncUrl(): 'replace' | 'merge' {
        // Incremental v1 sync: only changed URL states are merged unless this is a full-state flush.
        const params: Record<string, string> = {};
        for (const state of this.pendingUrlSyncStates) {
            const serialized = state.serialize(true);
            if (serialized === undefined) {
                continue;
            }
            for (const [k, v] of Object.entries(serialized)) {
                params[k] = v;
            }
        }
        // The first URL sync will update the URL fully, with pruned state removed.
        // Detect this case with the following collection equality check.
        // In this case, use the "replace" handling to get rid of style options
        // for removed styles.
        const queryParamsHandling = this.pendingUrlSyncStates.size === [...this.statePool.values().filter(
            state => state.isUrlState())].length ? "replace" : "merge";
        this.pendingUrlSyncStates.clear();
        this.router.navigate([], {
            queryParams: params,
            queryParamsHandling: queryParamsHandling,
            replaceUrl: this.replaceUrl
        }).catch(error => {
            console.error('[AppStateService] Failed to sync URL parameters', error);
        });
        return queryParamsHandling;
    }

    /** Restores storage-backed state slots from local storage during startup. */
    private hydrateFromStorage(): void {
        this.withHydration(() => {
            this.configDefaultStateMeta = this.loadConfigDefaultStateMeta();
            for (const state of this.statePool.values()) {
                if (state === this.stylesState) {
                    continue;
                }
                const raw = localStorage.getItem(state.name);
                if (raw === null) {
                    continue;
                }

                const metaEntry = this.configDefaultStateMeta.entries[state.name];
                if (metaEntry?.owner === "config") {
                    if (this.currentConfigDefaultKeys.has(state.name)) {
                        // Keep freshly seeded config default in-memory values.
                        continue;
                    }

                    // Config-owned storage without current config default should be dropped.
                    state.resetToDefault();
                    localStorage.removeItem(state.name);
                    delete this.configDefaultStateMeta.entries[state.name];
                    continue;
                }

                state.deserialize(raw);
            }

            const styleOptionEntries = this.collectStyleOptionStorageEntries();
            const filteredStyleOptionEntries: Record<string, string> = Object.create(null);
            for (const [key, value] of Object.entries(styleOptionEntries)) {
                const metaEntry = this.configDefaultStateMeta.entries[key];
                if (metaEntry?.owner === "config") {
                    if (this.currentConfigDefaultKeys.has(key)) {
                        continue;
                    }
                    localStorage.removeItem(key);
                    delete this.configDefaultStateMeta.entries[key];
                    continue;
                }
                filteredStyleOptionEntries[key] = value;
            }

            if (Object.keys(filteredStyleOptionEntries).length) {
                this.stylesState.deserialize(filteredStyleOptionEntries);
            }
            this.persistConfigDefaultStateMeta();
        });
    }

    /** Restores URL-backed state slots from the current route query params. */
    private hydrateFromUrl(params: Params): void {
        this.withHydration(() => {
            if (Object.keys(params).length === 0) {
                return;
            }

            for (const state of this.statePool.values()) {
                state.deserialize(params);
            }
        });
    }

    /** Runs a callback while suppressing persistence side effects during hydration. */
    private withHydration(callback: () => void): void {
        const previous = this.isHydrating;
        this.isHydrating = true;
        try {
            callback();
        } finally {
            this.isHydrating = previous;
        }
    }

    /** Returns the current limits applied when importing a snapshot. */
    getSnapshotImportLimits(): SnapshotImportLimits {
        const stateCount = this.statePool.size;
        const maxCollectionEntries = Math.max(1024, stateCount * 512);
        return {
            // Keep an upper bound aligned with practical browser localStorage budgets.
            maxFileSizeBytes: 5 * 1024 * 1024,
            // Snapshot top-level keys are AppState names plus compact style-option storage keys.
            maxTopLevelEntries: maxCollectionEntries,
            // AppState payloads are shallow-to-moderately nested; reject pathological depth.
            maxNestingDepth: 16,
            // Derive broad collection limits from the number of registered states.
            maxCollectionEntries,
            maxStringLength: 1024 * 1024
        };
    }

    /** Exports the current persisted state into a snapshot object. */
    exportSnapshot(): Record<string, unknown> {
        const snapshot: Record<string, unknown> = Object.create(null);
        for (const [name, state] of this.statePool.entries()) {
            if (!state.isSnapshotState()) {
                continue;
            }
            snapshot[name] = state.toSnapshotValue();
        }
        for (const [name, value] of Object.entries(this.stylesState.serialize(false) ?? {})) {
            snapshot[name] = value;
        }
        return snapshot;
    }

    /** Validates a snapshot without mutating the current application state. */
    validateSnapshot(snapshot: unknown): string[] {
        return this.normalizeSnapshot(snapshot).errors;
    }

    /** Seeds config-provided default snapshot values before storage and URL hydration. */
    seedConfigDefaultState(snapshot: unknown, sourceHash: string): string[] {
        if (snapshot === null || snapshot === undefined) {
            this.configDefaultStateMeta = this.loadConfigDefaultStateMeta();
            this.configDefaultStateMeta.sourceHash = sourceHash || "";
            this.configDefaultValueHashes.clear();
            this.currentConfigDefaultKeys.clear();
            this.persistConfigDefaultStateMeta();
            return [];
        }
        if (typeof snapshot === "object" && !Array.isArray(snapshot) && Object.keys(snapshot as Record<string, unknown>).length === 0) {
            this.configDefaultStateMeta = this.loadConfigDefaultStateMeta();
            this.configDefaultStateMeta.sourceHash = sourceHash || "";
            this.configDefaultValueHashes.clear();
            this.currentConfigDefaultKeys.clear();
            this.persistConfigDefaultStateMeta();
            return [];
        }

        const normalizedResult = this.normalizeSnapshot(snapshot);
        if (normalizedResult.errors.length) {
            normalizedResult.errors.forEach(error =>
                console.warn(`[AppStateService] Ignoring invalid config state: ${error}`));
            return normalizedResult.errors;
        }

        const normalized = normalizedResult.normalized ?? {};
        const styleOptionEntries = this.extractStyleOptionSnapshotEntries(normalized);
        const appliedStateKeys = new Set<string>();

        this.configDefaultStateMeta = this.loadConfigDefaultStateMeta();
        this.configDefaultStateMeta.sourceHash = sourceHash || "";
        this.configDefaultValueHashes.clear();
        this.currentConfigDefaultKeys.clear();

        this.isSeedingConfigDefaults = true;
        try {
            for (const [key, value] of Object.entries(normalized)) {
                const state = this.statePool.get(key);
                if (!state || !state.isSnapshotState()) {
                    continue;
                }
                state.applySnapshotValue(value);
                appliedStateKeys.add(key);
            }

            if (Object.keys(styleOptionEntries).length) {
                this.stylesState.deserialize(styleOptionEntries);
                this.stylesState.next(new Map(this.stylesState.getValue()));
            }
        } finally {
            this.isSeedingConfigDefaults = false;
        }

        for (const key of appliedStateKeys) {
            const state = this.statePool.get(key);
            if (!state) {
                continue;
            }
            const valueHash = this.stateValueHashForMeta(state);
            this.currentConfigDefaultKeys.add(key);
            this.configDefaultValueHashes.set(key, valueHash);
            if (this.configDefaultMayOwnStorageKey(key)) {
                this.setMetaOwner(key, "config", valueHash);
            }
        }

        const serializedStyleOptions = this.stylesState.serialize(false) ?? {};
        for (const [key, serializedValue] of Object.entries(serializedStyleOptions)) {
            if (!this.stylesState.isStyleOptionUrlParamKey(key)) {
                continue;
            }
            if (!Object.prototype.hasOwnProperty.call(styleOptionEntries, key)) {
                continue;
            }
            const valueHash = hashStateValue(serializedValue);
            this.currentConfigDefaultKeys.add(key);
            this.configDefaultValueHashes.set(key, valueHash);
            if (this.configDefaultMayOwnStorageKey(key)) {
                this.setMetaOwner(key, "config", valueHash);
            }
        }

        this.persistConfigDefaultStateMeta();
        return [];
    }

    /** Normalizes, validates, and applies a snapshot import. */
    importSnapshot(snapshot: unknown): string[] {
        const normalizedResult = this.normalizeSnapshot(snapshot);
        if (normalizedResult.errors.length) {
            return normalizedResult.errors;
        }
        const normalized = normalizedResult.normalized!;
        const keys = Object.keys(normalized);
        const errors: string[] = [];

        for (const key of keys) {
            const state = this.statePool.get(key);
            if (!state) {
                if (this.validateStyleOptionSnapshotEntry(key, normalized[key], errors)) {
                    continue;
                }
                errors.push(`Unknown snapshot state '${key}'.`);
                continue;
            }
            if (!state.isSnapshotState()) {
                continue;
            }
            try {
                state.validateSnapshotValue(normalized[key]);
            } catch (error: any) {
                errors.push(`Invalid value for '${key}': ${error?.message ?? 'schema validation failed'}`);
            }
        }
        if (errors.length) {
            return errors;
        }

        for (const key of keys) {
            const state = this.statePool.get(key);
            if (!state) {
                continue;
            }
            if (!state.isSnapshotState()) {
                continue;
            }
            state.applySnapshotValue(normalized[key]);
        }
        const styleOptionEntries = this.extractStyleOptionSnapshotEntries(normalized);
        if (Object.keys(styleOptionEntries).length) {
            this.stylesState.deserialize(styleOptionEntries);
            this.stylesState.next(new Map(this.stylesState.getValue()));
        }
        this.pendingOpenDialogs.clear();
        return [];
    }

    /** Normalizes legacy snapshot shapes before schema validation is applied. */
    private normalizeSnapshot(snapshot: unknown): SnapshotNormalizationResult {
        const limits = this.getSnapshotImportLimits();
        const errors: string[] = [];
        let serialized: string;
        try {
            serialized = JSON.stringify(snapshot);
        } catch {
            return { errors: ['Snapshot payload is not serializable JSON.'] };
        }
        if (serialized.length > limits.maxFileSizeBytes) {
            return { errors: [`Snapshot payload exceeds ${limits.maxFileSizeBytes} bytes.`] };
        }

        const normalizedRoot = this.normalizeSnapshotNode(snapshot, '$', 0, limits, errors);
        if (errors.length) {
            return {errors};
        }
        if (!normalizedRoot || Array.isArray(normalizedRoot) || typeof normalizedRoot !== 'object') {
            return {errors: ['Snapshot payload must be a JSON object.']};
        }
        const normalized = normalizedRoot as Record<string, unknown>;
        const keys = Object.keys(normalized);
        if (keys.length > limits.maxTopLevelEntries) {
            return {errors: ['Snapshot payload contains too many top-level entries.']};
        }

        for (const key of keys) {
            const state = this.statePool.get(key);
            if (!state) {
                if (this.validateStyleOptionSnapshotEntry(key, normalized[key], errors)) {
                    continue;
                }
                errors.push(`Unknown snapshot state '${key}'.`);
                continue;
            }
            if (!state.isSnapshotState()) {
                delete normalized[key];
            }
        }
        if (errors.length) {
            return {errors};
        }

        // Validate all present entries before import to keep mutation transactional.
        for (const key of Object.keys(normalized)) {
            const state = this.statePool.get(key);
            if (!state) {
                continue;
            }
            if (!state.isSnapshotState()) {
                continue;
            }
            try {
                state.validateSnapshotValue(normalized[key]);
            } catch (error: any) {
                errors.push(`Invalid value for '${key}': ${error?.message ?? 'schema validation failed'}`);
            }
        }
        return errors.length ? {errors} : {normalized, errors: []};
    }

    /** Returns whether a snapshot key is a compact style-option storage key. */
    private validateStyleOptionSnapshotEntry(key: string, value: unknown, errors: string[]): boolean {
        if (!this.stylesState.isStyleOptionUrlParamKey(key)) {
            return false;
        }
        if (typeof value !== 'string') {
            errors.push(`Invalid value for '${key}': expected string style option payload.`);
        }
        return true;
    }

    /** Extracts compact style-option entries from a normalized snapshot. */
    private extractStyleOptionSnapshotEntries(snapshot: Record<string, unknown>): Record<string, string> {
        const entries: Record<string, string> = Object.create(null);
        for (const [key, value] of Object.entries(snapshot)) {
            if (this.stylesState.isStyleOptionUrlParamKey(key) && typeof value === 'string') {
                entries[key] = value;
            }
        }
        return entries;
    }

    /** Reads compact style-option entries from browser local storage. */
    private collectStyleOptionStorageEntries(): Record<string, string> {
        const entries: Record<string, string> = Object.create(null);
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (!key || !this.stylesState.isStyleOptionUrlParamKey(key)) {
                continue;
            }
            const value = localStorage.getItem(key);
            if (value !== null) {
                entries[key] = value;
            }
        }
        return entries;
    }

    /** Removes compact style-option entries from browser local storage. */
    private clearStyleOptionStorageEntries(): void {
        const keys: string[] = [];
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (key && this.stylesState.isStyleOptionUrlParamKey(key)) {
                keys.push(key);
            }
        }
        for (const key of keys) {
            localStorage.removeItem(key);
        }
    }

    private loadConfigDefaultStateMeta(): ConfigDefaultStateMeta {
        const emptyMeta: ConfigDefaultStateMeta = {
            version: 1,
            sourceHash: "",
            entries: Object.create(null)
        };

        const raw = localStorage.getItem(this.CONFIG_DEFAULT_STATE_META_KEY);
        if (!raw) {
            return emptyMeta;
        }

        try {
            const parsed = JSON.parse(raw) as Partial<ConfigDefaultStateMeta>;
            if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
                return emptyMeta;
            }

            const entries: Record<string, ConfigDefaultStateMetaEntry> = Object.create(null);
            for (const [key, entry] of Object.entries(parsed.entries)) {
                if (!entry || typeof entry !== "object") {
                    continue;
                }
                const owner = (entry as ConfigDefaultStateMetaEntry).owner;
                const valueHash = (entry as ConfigDefaultStateMetaEntry).valueHash;
                if ((owner !== "config" && owner !== "user") || typeof valueHash !== "string") {
                    continue;
                }
                entries[key] = {owner, valueHash};
            }

            return {
                version: 1,
                sourceHash: typeof parsed.sourceHash === "string" ? parsed.sourceHash : "",
                entries
            };
        } catch {
            return emptyMeta;
        }
    }

    private persistConfigDefaultStateMeta(): void {
        localStorage.setItem(this.CONFIG_DEFAULT_STATE_META_KEY, JSON.stringify(this.configDefaultStateMeta));
    }

    private setMetaOwner(key: string, owner: "config" | "user", valueHash: string): void {
        this.configDefaultStateMeta.entries[key] = {owner, valueHash};
    }

    /**
     * Returns whether a freshly seeded config default may claim the persisted
     * slot instead of preserving an existing user or legacy local override.
     */
    private configDefaultMayOwnStorageKey(key: string): boolean {
        const metaEntry = this.configDefaultStateMeta.entries[key];
        return metaEntry?.owner === "config" || localStorage.getItem(key) === null;
    }

    private stateValueHashForMeta(state: AppState<unknown>): string {
        return hashStateValue(state.toSnapshotValue());
    }

    private withSystemStateMutation(action: () => void): void {
        const previous = this.isSystemStateMutation;
        this.isSystemStateMutation = true;
        try {
            action();
        } finally {
            this.isSystemStateMutation = previous;
        }
    }

    /** Recursively normalizes one snapshot subtree while collecting validation issues. */
    private normalizeSnapshotNode(
        value: unknown,
        path: string,
        depth: number,
        limits: SnapshotImportLimits,
        errors: string[]
    ): unknown {
        if (depth > limits.maxNestingDepth) {
            errors.push(`Snapshot payload exceeds max depth at '${path}'.`);
            return undefined;
        }

        if (Array.isArray(value)) {
            if (value.length > limits.maxCollectionEntries) {
                errors.push(`Snapshot array '${path}' exceeds max length.`);
                return undefined;
            }
            return value.map((entry, index) =>
                this.normalizeSnapshotNode(entry, `${path}[${index}]`, depth + 1, limits, errors)
            );
        }

        if (value && typeof value === 'object') {
            const proto = Object.getPrototypeOf(value);
            if (proto !== Object.prototype && proto !== null) {
                errors.push(`Snapshot object '${path}' has an unsupported prototype.`);
                return undefined;
            }
            const entries = Object.entries(value as Record<string, unknown>);
            if (entries.length > limits.maxCollectionEntries) {
                errors.push(`Snapshot object '${path}' exceeds max key count.`);
                return undefined;
            }
            const normalized: Record<string, unknown> = Object.create(null);
            for (const [key, entry] of entries) {
                if (this.SNAPSHOT_UNSAFE_KEYS.has(key)) {
                    errors.push(`Snapshot payload contains unsafe key '${key}' at '${path}'.`);
                    return undefined;
                }
                normalized[key] = this.normalizeSnapshotNode(entry, `${path}.${key}`, depth + 1, limits, errors);
            }
            return normalized;
        }

        if (typeof value === 'string' && value.length > limits.maxStringLength) {
            errors.push(`Snapshot string at '${path}' exceeds max length.`);
            return undefined;
        }
        return value;
    }

    // -----------------
    // Public API below
    // -----------------

    get numViews() {return this.numViewsState.getValue();}
    set numViews(val: number) {
        const previousViewCount = this.numViewsState.getValue();
        if (val === previousViewCount) {
            return;
        }
        this.seedAdditionalViews(previousViewCount, val);
        this.numViewsState.next(val);
    };
    get deckThreadedRenderingEnabled() {return this.deckThreadedRenderingEnabledState.getValue();}
    set deckThreadedRenderingEnabled(val: boolean) {this.deckThreadedRenderingEnabledState.next(val);}
    get pinLowFiToMaxLod() {return this.pinLowFiToMaxLodState.getValue();}
    set pinLowFiToMaxLod(val: boolean) {this.pinLowFiToMaxLodState.next(val);}
    get deckStyleWorkersOverride() {return this.deckStyleWorkersOverrideState.getValue();}
    set deckStyleWorkersOverride(val: boolean) {this.deckStyleWorkersOverrideState.next(val);};
    get deckStyleWorkersCount() {return this.deckStyleWorkersCountState.getValue();}
    set deckStyleWorkersCount(val: number) {this.deckStyleWorkersCountState.next(val);};
    get tilePullCompressionEnabled() {return this.tilePullCompressionEnabledState.getValue();}
    set tilePullCompressionEnabled(val: boolean) {this.tilePullCompressionEnabledState.next(val);};
    get mapZoomStep() {return this.mapZoomStepState.getValue();}
    set mapZoomStep(val: number) {this.mapZoomStepState.next(clampMapZoomStep(Number(val)));};
    get search() {return this.searchState.getValue();}
    set search(val: SearchStateValue) {this.searchState.next(val);};
    get marker() {return this.markerState.getValue();}
    set marker(val: boolean) {this.markerState.next(val);};
    get markedPosition() {return this.markedPositionState.getValue();}
    set markedPosition(val: number[]) {this.markedPositionState.next(val.map(v => roundCoordinateStateValue(v)));};
    get selection() {return this.selectionState.getValue();}
    set selection(val: InspectionPanelModel<TileFeatureId>[]) {this.selectionState.next(val);};
    get focusedView() {return this.focusedViewState.getValue();}
    set focusedView(val: number) {this.focusedViewState.next(val);};
    get layerNames() {return this.layerNamesState.getValue();}
    set layerNames(val: Array<string>) {this.layerNamesState.next(val);};
    get styles() {return this.stylesState.getValue();}
    get styleVisibility() {return this.styleVisibilityState.getValue();}
    set styleVisibility(val: Record<string, boolean>) {this.styleVisibilityState.next(val);};
    get tilesLoadLimit() {return this.tilesLoadLimitState.getValue();}
    set tilesLoadLimit(val: number) {this.tilesLoadLimitState.next(val);};
    get inspectionsLimit() {return this.inspectionsLimitState.getValue();}
    set inspectionsLimit(val: number) {
        const numeric = Number(val);
        if (!Number.isFinite(numeric)) {
            return;
        }
        const normalized = Math.min(MAX_SIMULTANEOUS_INSPECTIONS, Math.max(1, Math.trunc(numeric)));
        this.inspectionsLimitState.next(normalized);
    };
    get inspectionComparison() {return this.inspectionComparisonState.getValue();}
    set inspectionComparison(val: InspectionComparisonModel | null) {this.inspectionComparisonState.next(val);}
    get isDockOpen() {return this.dockOpenState.getValue();}
    set isDockOpen(val: boolean) {this.dockOpenState.next(val);};
    get isDockAutoCollapsible() {return this.dockAutoCollapse.getValue();}
    set isDockAutoCollapsible(val: boolean) {this.dockAutoCollapse.next(val);};
    get enabledCoordsTileIds() {return this.enabledCoordsTileIdsState.getValue();}
    set enabledCoordsTileIds(val: string[]) {this.enabledCoordsTileIdsState.next(val);};
    get styleEditorTargetId() {return this.styleEditorTargetState.getValue();}
    set styleEditorTargetId(val: string | null) {this.styleEditorTargetState.next(val);};
    get diagnosticsLogFilter() {return this.diagnosticsLogFilterState.getValue();}
    set diagnosticsLogFilter(val: DiagnosticsLogFilter) {
        this.diagnosticsLogFilterState.next({...val});
    };
    get diagnosticsExportOptions() {return this.diagnosticsExportOptionsState.getValue();}
    set diagnosticsExportOptions(val: DiagnosticsExportOptions) {
        this.diagnosticsExportOptionsState.next({
            ...val,
            logFilter: {...val.logFilter}
        });
    };
    get debugRenderFullGltfAttachment() {return this.debugRenderFullGltfAttachmentState.getValue();}
    set debugRenderFullGltfAttachment(val: boolean) {this.debugRenderFullGltfAttachmentState.next(val);}
    get debugGltfLoggingEnabled() {return this.debugGltfLoggingEnabledState.getValue();}
    set debugGltfLoggingEnabled(val: boolean) {this.debugGltfLoggingEnabledState.next(val);}
    get lastSearchHistoryEntry() {return this.lastSearchHistoryEntryState.getValue();}
    set lastSearchHistoryEntry(val: SearchHistoryStateEntry | null) {this.lastSearchHistoryEntryState.next(val);};
    get viewSync() {return this.viewSyncState.getValue();}
    set viewSync(val: string[]) {
        const previous = new Set(this.viewSyncState.getValue());
        const uniqueValues = Array.from(new Set(val));
        const hasMovement = uniqueValues.includes(VIEW_SYNC_MOVEMENT);
        const hasPosition = uniqueValues.includes(VIEW_SYNC_POSITION);
        let sanitized = uniqueValues;

        if (hasMovement && hasPosition) {
            if (!previous.has(VIEW_SYNC_MOVEMENT)) {
                sanitized = uniqueValues.filter(value => value !== VIEW_SYNC_POSITION);
            } else if (!previous.has(VIEW_SYNC_POSITION)) {
                sanitized = uniqueValues.filter(value => value !== VIEW_SYNC_MOVEMENT);
            } else {
                sanitized = uniqueValues.filter(value => value !== VIEW_SYNC_POSITION);
            }
        }

        this.viewSyncState.next(sanitized);
    };

    /** Returns whether layer visibility/options sync is enabled for the given view. */
    getLayerSyncOption(viewIndex: number): boolean {
        return this.layerSyncOptionsState.getValue(viewIndex);
    }

    /** Sets whether layer visibility/options sync is enabled for the given view. */
    setLayerSyncOption(viewIndex: number, enabled: boolean): void {
        this.layerSyncOptionsState.next(viewIndex, enabled);
    }

    /** Returns the persisted background-layer state for the given view. */
    getBackgroundState(viewIndex: number): BackgroundLayerViewState {
        const value = this.backgroundState.getValue(viewIndex);
        return {
            layerId: value.layerId,
            opacity: clampBackgroundOpacity(value.opacity),
        };
    }

    /** Returns the effective background-layer state after missing ids are mapped to the configured default. */
    resolveBackgroundState(viewIndex: number,
                           availableLayers: readonly BackgroundLayerConfig[],
                           defaultBackgroundLayerId: string | null): BackgroundLayerViewState {
        const rawState = this.getBackgroundState(viewIndex);
        if (rawState.layerId === null) {
            return rawState;
        }

        const availableLayerIds = new Set(availableLayers.map(layer => layer.id));
        if (availableLayerIds.has(rawState.layerId)) {
            return rawState;
        }

        if (defaultBackgroundLayerId && availableLayerIds.has(defaultBackgroundLayerId)) {
            return {
                layerId: defaultBackgroundLayerId,
                opacity: rawState.opacity
            };
        }

        return {
            layerId: null,
            opacity: rawState.opacity
        };
    }

    /** Writes the selected background-layer id and opacity for one view. */
    setBackgroundState(viewIndex: number, layerId: string | null, opacity: number): void {
        this.backgroundState.next(viewIndex, {
            layerId,
            opacity: clampBackgroundOpacity(opacity),
        });
    }

    /** Returns the configured background opacity for the given view. */
    getBackgroundOpacity(viewIndex: number): number {
        return this.getBackgroundState(viewIndex).opacity;
    }

    /** Returns the persisted orientation for the given view. */
    getCameraOrientation(viewIndex: number) {
        return this.cameraViewDataState.getValue(viewIndex).orientation;
    }

    /** Returns the persisted camera destination for the given view. */
    getCameraPosition(viewIndex: number) {
        const destination = this.cameraViewDataState.getValue(viewIndex).destination;
        return Cartographic.fromDegrees(destination.lon, destination.lat, destination.alt);
    }

    /** Internal helper that writes camera destination and orientation without extra policy. */
    private _setView(viewIndex: number, destination: Cartographic, orientation?: { heading: number, pitch: number, roll: number }) {
        // Fall back to the current orientation if none was passed.
        orientation = orientation ?? this.cameraViewDataState.getValue(viewIndex).orientation;
        const view: CameraViewState = {
            destination: {
                lon: roundCoordinateStateValue(GeoMath.toDegrees(destination.longitude)),
                lat: roundCoordinateStateValue(GeoMath.toDegrees(destination.latitude)),
                alt: roundCoordinateStateValue(destination.height),
            },
            orientation: {
                heading: roundCoordinateStateValue(orientation.heading),
                pitch: roundCoordinateStateValue(orientation.pitch),
                roll: roundCoordinateStateValue(orientation.roll),
            }
        };
        this.cameraViewDataState.next(viewIndex, view);
    }

    /** Persists camera destination/orientation and updates the focused view marker. */
    setView(viewIndex: number, destination: Cartographic, orientation?: { heading: number, pitch: number, roll: number }) {
        const syncPosition = this.viewSync.includes(VIEW_SYNC_POSITION);
        const syncMovement = this.viewSync.includes(VIEW_SYNC_MOVEMENT);

        if (syncPosition || syncMovement) {
            // Unfocused view is trying to update itself when the views are synchronized
            if (viewIndex !== this.focusedView) {
                return;
            }

            if (syncPosition) {
                for (let i = 0; i < this.numViews; i++) {
                    this._setView(i, destination, orientation);
                }
                return;
            }

            if (syncMovement) {
                const previous = this.cameraViewDataState.getValue(viewIndex).destination;
                const destLon = GeoMath.toDegrees(destination.longitude);
                const destLat = GeoMath.toDegrees(destination.latitude);
                const deltaLon = destLon - previous.lon;
                const deltaLat = destLat - previous.lat;

                this._setView(viewIndex, destination, orientation);

                for (let i = 0; i < this.numViews; i++) {
                    if (i === viewIndex) {
                        continue;
                    }
                    const target = this.cameraViewDataState.getValue(i);
                    const newDestination = Cartographic.fromDegrees(
                        target.destination.lon + deltaLon,
                        target.destination.lat + deltaLat,
                        target.destination.alt
                    );
                    this._setView(i, newDestination);
                }
                return;
            }
        }

        this._setView(viewIndex, destination, orientation);
    }

    /** Switches one view between 2D and 3D projection mode. */
    setProjectionMode(viewIndex: number, is2DMode: boolean) {
        if (this.viewSync.includes(VIEW_SYNC_PROJECTION)) {
            // Unfocused view is trying to update itself when the views are synchronized
            if (viewIndex !== this.focusedView) {
                return;
            }

            for (let i = 0; i < this.numViews; i++) {
                this.mode2dState.next(i, is2DMode);
            }
            return;
        }
        this.mode2dState.next(viewIndex, is2DMode);
    }

    /*
    ## Current State

      View Click Event -> MapDataService -> InspectionService -> InspectionPanel
                                                              -> AppStateService

      (Hydration) AppStateService -> MapDataService -> InspectionService -> InspectionPanel
                                                                         -> AppStateService

    ## New Goal State

    // View Click Event -> AppStateService -> MapDataService -> InspectionService -> InspectionPanel
    //         (Hydration) AppStateService -> MapDataService -> InspectionService -> InspectionPanel
    //  InspectionPanel -> AppStateService -> MapDataService -> InspectionService -> InspectionPanel

     */
    /** Updates the current selection, reusing or creating inspection panels as needed. */
    setSelection(newSelection: TileFeatureId[] | SelectedSourceData, id?: number, forceNewPanel: boolean = false) {
        this._replaceUrl = false;
        let allPanels = this.selectionState.getValue();
        const originPanel = id !== undefined ? allPanels.find(panel => panel.id === id) : undefined;
        const sourceDataSelection = !Array.isArray(newSelection) ? newSelection as SelectedSourceData : undefined;
        const isSourceDataSelection = sourceDataSelection !== undefined;
        let featureSelection = Array.isArray(newSelection) ? newSelection as TileFeatureId[] : [];
        if (!isSourceDataSelection && id === undefined && featureSelection.length > 0) {
            this.isDockOpen = true;
        }
        const isFeaturePanel = (panel: InspectionPanelModel<TileFeatureId>) => panel.sourceData === undefined;
        const isSourceDataPanel = (panel: InspectionPanelModel<TileFeatureId>) => panel.sourceData !== undefined;
        const isClearSourceDataRequest =
            originPanel !== undefined &&
            sourceDataSelection === undefined &&
            originPanel.sourceData !== undefined;

        // Filter out features which are already selected. If there are none left, we don't need to do anything
        // unless we are explicitly clearing a source data selection.
        if (featureSelection.length) {
            featureSelection = featureSelection.filter(feature =>
                !allPanels.some(panel =>
                    isFeaturePanel(panel) &&
                    panel.features.some(otherFeature =>
                        feature.featureId === otherFeature.featureId && feature.mapTileKey === otherFeature.mapTileKey)));
            if (!featureSelection.length && !isClearSourceDataRequest) {
                this._replaceUrl = true;
                return;
            }
        }

        // Decide whether to reuse an existing panel or create a new one.
        let targetPanelId: number | undefined = undefined;
        let mustCreateNewPanel = forceNewPanel;

        // Explicit SourceData updates from a SourceData panel stay in that panel, even when locked.
        if (!forceNewPanel && originPanel && isSourceDataSelection && isSourceDataPanel(originPanel)) {
            targetPanelId = originPanel.id;
        }

        // Explicit feature updates from an unlocked feature panel stay in that panel.
        if (!forceNewPanel &&
            targetPanelId === undefined &&
            originPanel &&
            !isSourceDataSelection &&
            isFeaturePanel(originPanel) &&
            (isClearSourceDataRequest || !originPanel.locked)) {
            targetPanelId = originPanel.id;
        }

        // Inspection strategy:
        // Feature selection (default path): reuse the last unlocked feature panel and close all other unlocked feature panels.
        // Otherwise: reuse unlocked docked panel of the same inspection type, then unlocked undocked dialog, else create new.
        if (!mustCreateNewPanel && targetPanelId === undefined) {
            const isDefaultFeatureSelectionRequest = !isSourceDataSelection && id === undefined;
            if (isDefaultFeatureSelectionRequest) {
                let lastUnlockedFeaturePanelId: number | undefined;
                for (let index = allPanels.length - 1; index >= 0; index--) {
                    const panel = allPanels[index];
                    if (isFeaturePanel(panel) && !panel.locked) {
                        lastUnlockedFeaturePanelId = panel.id;
                        break;
                    }
                }
                if (lastUnlockedFeaturePanelId !== undefined) {
                    allPanels = allPanels.filter(panel =>
                        !isFeaturePanel(panel) ||
                        panel.locked ||
                        panel.id === lastUnlockedFeaturePanelId
                    );
                    targetPanelId = lastUnlockedFeaturePanelId;
                } else {
                    mustCreateNewPanel = true;
                }
            } else {
                const firstUnlockedDockedPanel = allPanels.find(panel =>
                    !panel.undocked &&
                    !panel.locked &&
                    (isSourceDataSelection ? isSourceDataPanel(panel) : isFeaturePanel(panel))
                );
                if (firstUnlockedDockedPanel) {
                    targetPanelId = firstUnlockedDockedPanel.id;
                } else {
                    const firstUnlockedUndockedPanel = allPanels.find(panel =>
                        panel.undocked &&
                        !panel.locked &&
                        (isSourceDataSelection ? isSourceDataPanel(panel) : isFeaturePanel(panel))
                    );
                    if (firstUnlockedUndockedPanel) {
                        targetPanelId = firstUnlockedUndockedPanel.id;
                    } else {
                        mustCreateNewPanel = true;
                    }
                }
            }
        }

        if (mustCreateNewPanel) {
            const limit = this.inspectionsLimit;
            if (allPanels.length >= limit) {
                this.infoMessageService.showWarning(`Maximum of ${limit} inspections reached. Close an existing inspection to add more.`);
                this._replaceUrl = true;
                return;
            }
            const newId = 1 + Math.max(-1, ...allPanels.map(panel => panel.id));
            allPanels.push({
                id: newId,
                features: isSourceDataSelection ? [] : featureSelection,
                sourceData: sourceDataSelection,
                locked: false,
                size: [DEFAULT_EM_WIDTH, isSourceDataSelection ? DEFAULT_EM_HEIGHT : DEFAULT_DOCKED_EM_HEIGHT],
                color: DEFAULT_HIGHLIGHT_COLORS[newId % DEFAULT_HIGHLIGHT_COLORS.length],
                undocked: isSourceDataSelection
            });
            this.selectionState.next(allPanels);
            this.sanitizeInspectionComparisonForSelection(allPanels);
            return newId;
        }

        if (targetPanelId !== undefined) {
            const panelIndex = allPanels.findIndex(panel => panel.id === targetPanelId);
            if (panelIndex === -1) {
                this._replaceUrl = true;
                return;
            }
            if (sourceDataSelection !== undefined) {
                allPanels[panelIndex].features = [];
                allPanels[panelIndex].sourceData = sourceDataSelection;
            } else {
                if (featureSelection.length) {
                    allPanels[panelIndex].features = featureSelection;
                }
                allPanels[panelIndex].sourceData = undefined;
            }
            this.selectionState.next(allPanels);
            this.sanitizeInspectionComparisonForSelection(allPanels);
            return targetPanelId;
        }

        return;
    }

    /** Persists the size of one inspection panel. */
    setInspectionPanelSize(id: number, size: [number, number]) {
        const allPanels = this.selectionState.getValue();
        const index = allPanels.findIndex(panel => panel.id === id);
        if (index === -1) {
            return;
        }
        allPanels[index].size = size;
        this.onStateChanged(this.selectionState, true); // Do not retrigger the subscription - we only need to reflect the size in the url
    }

    /** Updates the locked state of one inspection panel. */
    setInspectionPanelLockedState(id: number, isLocked: boolean) {
        const allPanels = this.selectionState.getValue();
        const index = allPanels.findIndex(panel => panel.id === id);
        if (index === -1) {
            return;
        }
        allPanels[index].locked = isLocked;
        this.selectionState.next(allPanels);
    }

    /** Persists whether one inspection panel is undocked. */
    setInspectionPanelUndockedState(id: number, undocked: boolean) {
        const allPanels = this.selectionState.getValue();
        const index = allPanels.findIndex(panel => panel.id === id);
        if (index === -1) {
            return;
        }
        allPanels[index].undocked = undocked;
        allPanels[index].size = [
            allPanels[index].size[0],
            undocked ? DEFAULT_EM_HEIGHT : DEFAULT_DOCKED_EM_HEIGHT
        ];
        if (!undocked) {
            allPanels[index].locked = true;
        }
        this.selectionState.next(allPanels);
    }

    /** Returns the persisted layout for a dialog if one exists. */
    getDialogLayout(id: string): AppDialogLayout | InspectionDialogLayout | undefined {
        return this.dialogLayoutsState.getValue()[id];
    }

    /** Returns whether the persisted layout marks the dialog as open. */
    getDialogLayoutOpen(id: string): boolean {
        return this.getDialogLayout(id)?.open ?? false;
    }

    /** Returns whether a persisted dialog should currently be mounted and visible. */
    isDialogOpen(id: string): boolean {
        const layout = this.getDialogLayout(id);
        if (layout) {
            return layout.open ?? false;
        }
        return this.pendingOpenDialogs.has(id);
    }

    /** Marks a persisted dialog as open or closed, even before its first measured layout exists. */
    setDialogOpen(id: string, open: boolean): void {
        const current = this.getDialogLayout(id);
        if (current) {
            this.pendingOpenDialogs.delete(id);
            this.setDialogLayoutOpen(id, open);
            return;
        }
        if (open) {
            this.pendingOpenDialogs.add(id);
            return;
        }
        this.pendingOpenDialogs.delete(id);
    }

    /** Convenience helper that opens one persisted dialog. */
    openDialog(id: string): void {
        this.setDialogOpen(id, true);
    }

    /** Convenience helper that closes one persisted dialog. */
    closeDialog(id: string): void {
        this.setDialogOpen(id, false);
    }

    /** Returns or creates the persisted layout record for a dialog. */
    ensureDialogLayout(id: string, fallbackFactory: () => AppDialogLayout): AppDialogLayout | InspectionDialogLayout {
        const existing = this.getDialogLayout(id);
        if (existing) {
            return existing;
        }
        const layout = fallbackFactory();
        this.upsertDialogLayout(id, layout);
        return layout;
    }

    /** Inserts or updates one persisted dialog layout record. */
    upsertDialogLayout(id: string, layout: AppDialogLayout | InspectionDialogLayout): void {
        const currentLayouts = this.dialogLayoutsState.getValue();
        const existing = currentLayouts[id];
        const nextLayout: AppDialogLayout | InspectionDialogLayout = existing ? {
            ...existing,
            ...layout,
            position: {
                ...existing.position,
                ...layout.position
            },
            size: {
                ...existing.size,
                ...layout.size
            }
        } : {
            ...layout,
            position: {...layout.position},
            size: {...layout.size}
        };
        this.dialogLayoutsState.next({
            ...currentLayouts,
            [id]: nextLayout
        });
        this.pendingOpenDialogs.delete(id);
    }

    /** Persists the open/closed state for an existing dialog layout. */
    setDialogLayoutOpen(id: string, open: boolean): void {
        const current = this.getDialogLayout(id);
        if (!current) {
            return;
        }
        if ((current.open ?? false) === open) {
            return;
        }
        this.upsertDialogLayout(id, {
            ...current,
            open
        });
    }

    /** Returns the floating layout record for one inspection panel, if present. */
    getInspectionDialogLayout(panelId: number): InspectionDialogLayout | undefined {
        const layout = this.getDialogLayout(this.inspectionLayoutId(panelId));
        if (layout && 'panelId' in layout && 'slot' in layout) {
            return layout as InspectionDialogLayout;
        }
        return undefined;
    }

    /** Returns or creates the floating layout record for one inspection panel. */
    ensureInspectionDialogLayout(
        panelId: number,
        preferredSlot: number,
        fallbackFactory: () => AppDialogLayout
    ): InspectionDialogLayout {
        const layoutId = this.inspectionLayoutId(panelId);
        const existing = this.getInspectionDialogLayout(panelId);
        if (existing) {
            return existing;
        }
        const fallback = fallbackFactory();
        const created: InspectionDialogLayout = {
            panelId,
            slot: preferredSlot,
            position: {...fallback.position},
            size: {...fallback.size}
        };
        this.upsertDialogLayout(layoutId, created);
        return created;
    }

    /** Updates the stored floating position for one inspection panel. */
    setInspectionDialogPosition(panelId: number, position: AppDialogPosition, preferredIndex?: number): void {
        if (!this.selectionState.getValue().some(panel => panel.id === panelId)) {
            return;
        }
        const current = this.getInspectionDialogLayout(panelId);
        if (current) {
            this.upsertDialogLayout(this.inspectionLayoutId(panelId), {
                ...current,
                position: {left: position.left, top: position.top}
            });
            return;
        }
        const slot = preferredIndex ?? panelId;
        const existing = this.getDialogLayout(this.inspectionLayoutId(panelId));
        this.upsertDialogLayout(this.inspectionLayoutId(panelId), {
            panelId,
            slot,
            position: {left: position.left, top: position.top},
            size: existing?.size ?? {
                width: Math.round(this.defaultInspectionPanelSize[0] * this.baseFontSize),
                height: Math.round(this.defaultInspectionPanelSize[1] * this.baseFontSize)
            }
        });
    }

    /** Removes persisted inspection-dialog layouts for panels that no longer exist. */
    pruneInspectionDialogLayout(activePanelIds: number[]) {
        const activeIds = new Set(activePanelIds.map(panelId => this.inspectionLayoutId(panelId)));
        const currentLayouts = this.dialogLayoutsState.getValue();
        const nextLayouts: Record<string, AppDialogLayout | InspectionDialogLayout> = {};
        let changed = false;
        for (const [id, layout] of Object.entries(currentLayouts)) {
            if (id.startsWith('inspection:') && !activeIds.has(id)) {
                changed = true;
                continue;
            }
            nextLayouts[id] = layout;
        }
        if (changed) {
            this.dialogLayoutsState.next(nextLayouts);
        }
        for (const id of Object.keys(currentLayouts)) {
            if (!(id in nextLayouts)) {
                this.pendingOpenDialogs.delete(id);
            }
        }
    }

    /** Opens the inspection comparison dialog with the supplied model. */
    openInspectionComparison(model: InspectionComparisonModel): void {
        this.inspectionComparisonState.next(model);
    }

    /** Closes the inspection comparison dialog. */
    closeInspectionComparison(): void {
        this.inspectionComparisonState.next(null);
    }

    /** Reorders docked inspection panels according to the supplied display order. */
    reorderInspectionPanels(dockedDisplayOrder: number[]) {
        const allPanels = this.selectionState.getValue();
        const dockedPanels = allPanels.filter(panel => !panel.undocked);
        if (dockedPanels.length < 2) {
            return;
        }
        const dockedById = new Map(dockedPanels.map(panel => [panel.id, panel]));
        const normalizedDisplayOrder = dockedDisplayOrder.filter(id => dockedById.has(id));
        if (normalizedDisplayOrder.length !== dockedPanels.length) {
            dockedPanels.forEach(panel => {
                if (!normalizedDisplayOrder.includes(panel.id)) {
                    normalizedDisplayOrder.push(panel.id);
                }
            });
        }
        const rawOrder = normalizedDisplayOrder.toReversed();
        let dockedIndex = 0;
        const nextPanels = allPanels.map(panel => {
            if (panel.undocked) {
                return panel;
            }
            const nextId = rawOrder[dockedIndex++];
            return dockedById.get(nextId)!;
        });
        if (!this.panelOrderEquals(allPanels, nextPanels)) {
            this.selectionState.next(nextPanels);
        }
    }

    /** Sets the accent color stored for one inspection panel. */
    setInspectionPanelColor(id: number, color: string) {
        const allPanels = this.selectionState.getValue();
        const index = allPanels.findIndex(panel => panel.id === id);
        if (index === -1) {
            return;
        }
        allPanels[index].color = color;
        this.selectionState.next(allPanels);
    }

    /** Drops all unlocked inspection panels, preserving only pinned selections. */
    unsetUnlockedSelections() {
        const nextSelection = this.selectionState.getValue().filter(panel =>
            panel.locked || panel.sourceData !== undefined
        );
        this.selectionState.next(nextSelection);
        this.sanitizeInspectionComparisonForSelection(nextSelection);
    }

    /** Removes one inspection panel and any associated persisted layout state. */
    unsetPanel(id: number) {
        const allPanels = this.selectionState.getValue();
        const index = allPanels.findIndex(panel => panel.id === id);
        if (index === -1) {
            return;
        }
        allPanels.splice(index, 1);
        this.selectionState.next(allPanels);
        this.sanitizeInspectionComparisonForSelection(allPanels);
    }

    /** Returns whether two inspection-panel orderings are identical by panel id. */
    private panelOrderEquals(a: InspectionPanelModel<TileFeatureId>[], b: InspectionPanelModel<TileFeatureId>[]): boolean {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (a[i].id !== b[i].id) {
                return false;
            }
        }
        return true;
    }

    /** Builds the persisted layout id used for one floating inspection dialog. */
    private inspectionLayoutId(panelId: number): string {
        return `inspection:${panelId}`;
    }

    /** Enables or disables the explicit location marker overlay. */
    setMarkerState(enabled: boolean) {
        this.markerState.next(enabled);
        if (!enabled) {
            this.setMarkerPosition(null, false);
        }
    }

    /** Updates the explicit location marker position, optionally delaying URL sync. */
    setMarkerPosition(position: Cartographic | null, delayUpdate: boolean = false) {
        if (position) {
            const longitude = GeoMath.toDegrees(position.longitude);
            const latitude = GeoMath.toDegrees(position.latitude);
            this.markedPosition = [longitude, latitude];
        } else {
            this.markedPosition = [];
        }
        if (!delayUpdate) {
            this._replaceUrl = false;
        }
    }

    /** Returns per-view visibility and level configuration for one map/layer pair. */
    mapLayerConfig(mapId: string, layerId: string, fallbackVisibility: boolean = true, fallbackLevel: number = 13): LayerViewConfig[] {
        if (isSourceOrMetaData(layerId)) {
            return [];
        }
        const mapLayerId = `${mapId}/${layerId}`;
        const names = this.layerNames;
        let layerIndex = names.findIndex(ml => ml === mapLayerId);
        if (layerIndex === -1) {
            layerIndex = names.length;
            this.layerNamesState.next([...names, mapLayerId]);
        }
        const result = new Array<LayerViewConfig>();
        const layerStateValue = <T>(state: MapViewState<Array<T>>, viewIndex: number, defaultValue: T) => {
            const resultForView = state.getValue(viewIndex);
            while (resultForView.length <= layerIndex) {
                resultForView.push(defaultValue);
            }
            state.next(viewIndex, resultForView);
            return resultForView[layerIndex];
        }

        for (let viewIndex = 0; viewIndex < this.numViewsState.getValue(); viewIndex++) {
            result.push({
                autoLevel: layerStateValue(this.layerAutoZoomLevelState, viewIndex, true),
                visible: layerStateValue(this.layerVisibilityState, viewIndex, fallbackVisibility),
                level: layerStateValue(this.layerZoomLevelState, viewIndex, fallbackLevel),
            });
        }
        return result;
    }

    /** Writes per-view visibility and level configuration for one map/layer pair. */
    setMapLayerConfig(mapId: string, layerId: string, viewConfig: LayerViewConfig[], fallbackLevel: number = 13) {
        if (isSourceOrMetaData(layerId) || viewConfig.length < this.numViewsState.getValue()) {
            return;
        }
        const mapLayerId = `${mapId}/${layerId}`;
        const names = this.layerNames;
        let layerIndex = names.findIndex(ml => ml === mapLayerId);
        if (layerIndex === -1) {
            layerIndex = names.length;
            this.layerNamesState.next([...names, mapLayerId]);
        }

        const insertLayerState = <T>(state: MapViewState<T[]>, viewIndex: number, value: T, defaultValue: T) => {
            const values = state.getValue(viewIndex);
            while (values.length <= layerIndex) {
                values.push(defaultValue);
            }
            values[layerIndex] = value;
            state.next(viewIndex, values);
        };

        for (let viewIndex = 0; viewIndex < viewConfig.length; viewIndex++) {
            insertLayerState(this.layerAutoZoomLevelState, viewIndex, viewConfig[viewIndex].autoLevel, true);
            insertLayerState(this.layerVisibilityState, viewIndex, viewConfig[viewIndex].visible, false);
            insertLayerState(this.layerZoomLevelState, viewIndex, viewConfig[viewIndex].level, fallbackLevel);
        }
    }

    /** Returns or seeds the stored values for one style option across all views. */
    styleOptionValues(
        mapId: string,
        layerId: string,
        shortStyleId: string,
        optionId: string,
        optionType: string,
        defaultValue: string|number|boolean
    ): (string|number|boolean)[] {
        const mapLayerId = `${mapId}/${layerId}`;
        const layerIndex = this.layerNames.indexOf(mapLayerId);
        if (layerIndex === -1) {
            throw new Error(`[AppStateService] Unknown map layer '${mapLayerId}' when reading style option values`);
        }

        const key = this.stylesState.styleOptionKey(mapId, layerId, shortStyleId, optionId);
        const views = this.numViewsState.getValue();

        let values = this.styles.get(key);
        if (!values) {
            values = Array.from({length: views}, () => defaultValue);
            this.styles.set(key, values);
            return values.slice();
        }

        // Ensure array length matches the number of views
        if (values.length < views) {
            const pad = Array.from({length: views - values.length}, () => defaultValue);
            values = values.concat(pad);
            this.styles.set(key, values);
        } else if (values.length > views) {
            values = values.slice(0, views);
            this.styles.set(key, values);
        }

        // Trigger a URL update, as we might have added style option values for some view(s).
        this.stylesState.next(this.styles);
        return values.map(v => this.stylesState.coerceOptionValue(v, optionType));
    }

    /**
     * Set style option values for a specific map layer style combination.
     * Note: This will NOT change the layerConfig array. Instead, if the
     *  map layer does not exist in layerNames, an exception will be thrown.
     */
    setStyleOptionValues(mapId: string, layerId: string, shortStyleId: string, optionId: string, value: (string|number|boolean)[]) {
        const mapLayerId = `${mapId}/${layerId}`;
        const layerIndex = this.layerNames.indexOf(mapLayerId);
        if (layerIndex === -1) {
            throw new Error(`[AppStateService] Unknown map layer '${mapLayerId}' when writing style option values`);
        }
        const key = this.stylesState.styleOptionKey(mapId, layerId, shortStyleId, optionId);
        const views = this.numViewsState.getValue();

        let nextValues: (string|number|boolean)[] = Array.isArray(value) ? [...value] : [];
        if (nextValues.length < views) {
            const last = nextValues.length ? nextValues[nextValues.length - 1] : false;
            nextValues = nextValues.concat(Array.from({length: views - nextValues.length}, () => last));
        } else if (nextValues.length > views) {
            nextValues = nextValues.slice(0, views);
        }

        this.styles.set(key, nextValues);
        this.stylesState.next(this.styles);
    }

    /** Returns whether the style is visible in the persisted style tree. */
    getStyleVisibility(styleId: string, fallback: boolean = true): boolean {
        if (this.styleVisibility.hasOwnProperty(styleId)) {
            return this.styleVisibility[styleId];
        }
        return fallback;
    }

    /** Updates the persisted visibility flag for one style. */
    setStyleVisibility(styleId: string, val: boolean) {
        this.styleVisibility[styleId] = val;
        this.styleVisibilityState.next(this.styleVisibility);
    }

    /** Updates the active search-history selection and optionally persists the query. */
    setSearchHistoryState(value: SearchHistoryEntry | null, saveHistory: boolean = true) {
        const trimmed = value ? normalizeResolvedSearchHistoryEntry(value) : null;
        if (trimmed && saveHistory) {
            this.saveHistoryStateValue(trimmed);
        }
        this.lastSearchHistoryEntryState.next(trimmed);
        this.searchState.next(trimmed ? trimmed : []);
        this._replaceUrl = false;
    }

    /** Rewrites search state during legacy migration without saving another history row. */
    migrateSearchStateValue(value: SearchHistoryEntry | null) {
        const trimmed = value ? normalizeResolvedSearchHistoryEntry(value) : null;
        this.searchState.next(trimmed ? trimmed : []);
        this._replaceUrl = false;
    }

    /** Rewrites the last search entry during legacy migration. Callers decide whether to suppress replay. */
    migrateLastSearchHistoryEntry(value: SearchHistoryEntry | null) {
        const trimmed = value ? normalizeResolvedSearchHistoryEntry(value) : null;
        this.lastSearchHistoryEntryState.next(trimmed);
    }

    /** Persists one search-history entry into the bounded stored history list. */
    private saveHistoryStateValue(value: SearchHistoryEntry) {
        const searchHistoryString = localStorage.getItem("searchHistory");
        let searchHistory: Array<SearchHistoryEntry> = [];
        if (searchHistoryString) {
            const parsed = JSON.parse(searchHistoryString) as unknown;
            const rawEntries = Array.isArray(parsed) && !(parsed.length === 2 && typeof parsed[1] === "string")
                ? parsed
                : [parsed];
            const seen = new Set<string>();
            for (const rawEntry of rawEntries) {
                const entry = normalizeResolvedSearchHistoryEntry(rawEntry);
                if (!entry) {
                    continue;
                }
                const key = historyEntryDedupeKey(entry);
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                searchHistory.push(entry);
            }
        }
        searchHistory = searchHistory.filter(entry => historyEntryDedupeKey(entry) !== historyEntryDedupeKey(value));
        searchHistory.unshift(value);
        while (searchHistory.length > 100) {
            searchHistory.pop();
        }
        localStorage.setItem("searchHistory", JSON.stringify(searchHistory));
    }

    /** Clears persisted app state from local storage and resets URL-backed state. */
    resetStorage() {
        for (const state of this.statePool.values()) {
            state.resetToDefault();
            localStorage.removeItem(state.name);
        }
        this.clearStyleOptionStorageEntries();
        localStorage.removeItem('searchHistory');
        localStorage.removeItem(this.STYLE_OPTIONS_STORAGE_KEY);
        localStorage.removeItem(this.CONFIG_DEFAULT_STATE_META_KEY);
        const {origin, pathname} = window.location;
        window.location.href = origin + pathname;
    }

    /** Removes persisted map/layer/style references that no longer exist in the loaded data. */
    prune(presentMaps: Map<string, MapTreeNode>, presentStyles: Map<string, ErdblickStyle>) {
        this.withSystemStateMutation(() => {
            // 1) Build sets of present maps, layers and styles
            const presentLayerIds = new Set<string>(); // entries of form `${mapId}/${layerId}`
            const presentSelectionLayerIds = new Set<string>(); // includes SourceData layers
            for (const [mapId, mapNode] of presentMaps.entries()) {
                // Use feature layers (exclude SourceData) via children
                for (const layer of mapNode.children) {
                    presentLayerIds.add(`${mapId}/${layer.id}`);
                }
                // Selection pruning must keep SourceData inspections too.
                for (const layerId of mapNode.layers.keys()) {
                    presentSelectionLayerIds.add(`${mapId}/${layerId}`);
                }
            }

            const presentStyleIds = new Set<string>([...presentStyles.keys()]); // full style ids
            const presentShortStyleIds = new Set<string>([...presentStyles.values()].map(s => s.shortId));

        // 2) Prune layerNames and per-view layer arrays (visibility, zoom levels)
        const oldLayerNames = this.layerNames;
        if (oldLayerNames.length) {
            const keepIndices: number[] = [];
            const nextLayerNames: string[] = [];
            for (let i = 0; i < oldLayerNames.length; i++) {
                const name = oldLayerNames[i];
                if (presentLayerIds.has(name)) {
                    keepIndices.push(i);
                    nextLayerNames.push(name);
                }
            }

            if (keepIndices.length !== oldLayerNames.length) {
                // Update layer names
                this.layerNames = nextLayerNames;

                // Helper to filter layer-indexed arrays by keepIndices with fallback
                const filterLayerArray = <T>(arr: T[], fallback: T): T[] =>
                    keepIndices.map(idx => (idx < arr.length ? arr[idx] : fallback));

                const views = this.numViews;
                for (let v = 0; v < views; v++) {
                    const vis = this.layerVisibilityState.getValue(v);
                    const levels = this.layerZoomLevelState.getValue(v);
                    const autoLevels = this.layerAutoZoomLevelState.getValue(v);
                    this.layerVisibilityState.next(v, filterLayerArray<boolean>(vis ?? [], false));
                    this.layerZoomLevelState.next(v, filterLayerArray<number>(levels ?? [], 13));
                    this.layerAutoZoomLevelState.next(v, filterLayerArray<boolean>(autoLevels ?? [], true));
                }
            }
        }

        // 3) Prune style option values that reference pruned layers or non-present styles
        //    and 4) prune style visibility for non-present styles
        // Prune style visibility
        const styleVis = {...this.styleVisibility};
        let styleVisChanged = false;
        for (const key of Object.keys(styleVis)) {
            if (!presentStyleIds.has(key)) {
                delete styleVis[key];
                styleVisChanged = true;
            }
        }
        if (styleVisChanged) {
            this.styleVisibility = styleVis;
        }

        // Prune style option values
        const stylesMap = this.styles; // Map<string, (string|number|boolean)[]>
        let stylesChanged = false;
        for (const key of Array.from(stylesMap.keys())) {
            // Key format: `${mapId}/${layerId}/${shortStyleId}/${optionId}`
            const parts = key.split('/');
            if (parts.length < 4) {
                stylesMap.delete(key);
                stylesChanged = true;
                continue;
            }
            const shortStyleId = parts[parts.length - 2];
            const mapLayerId = parts.slice(0, -2).join('/');
            if (!presentLayerIds.has(mapLayerId) || !presentShortStyleIds.has(shortStyleId)) {
                stylesMap.delete(key);
                stylesChanged = true;
            }
        }

        // 5) Prune extra views in MapViewStates and in StyleState values
        const views = this.numViews;
        const pruneViews = <T>(state: MapViewState<T>) => {
            const arr = state.appState.getValue();
            if (arr.length > views) {
                state.appState.next(arr.slice(0, views));
            }
        };
        pruneViews(this.mode2dState);
        pruneViews(this.backgroundState);
        pruneViews(this.viewTileBordersState);
        pruneViews(this.viewTileGridModeState);
        pruneViews(this.cameraViewDataState);
        pruneViews(this.layerVisibilityState);
        pruneViews(this.layerZoomLevelState);
        pruneViews(this.layerAutoZoomLevelState);

        // Also prune view-dimension from style option arrays
        for (const [k, vals] of stylesMap.entries()) {
            if (vals.length > views) {
                stylesMap.set(k, vals.slice(0, views));
                stylesChanged = true;
            }
        }
        if (stylesChanged) {
            this.stylesState.next(stylesMap);
        }

        // 6) Prune selections that reference maps/layers that are not present anymore
        const panels = this.selectionState.getValue();
        const nextPanels: InspectionPanelModel<TileFeatureId>[] = [];

        const parseKey = (tileKey: string): string | undefined => {
            try {
                const [mapId, layerId, _] = coreLib.parseMapTileKey(tileKey);
                // res is expected to be [mapId, layerId, tileId]
                return `${mapId}/${layerId}`
            } catch (_) {
                return;
            }
        };

        for (const panel of panels) {
            const updated: InspectionPanelModel<TileFeatureId> = {
                id: panel.id,
                features: [],
                locked: panel.locked,
                size: panel.size,
                sourceData: panel.sourceData ? { ...panel.sourceData } : undefined,
                color: panel.color,
                undocked: panel.undocked
            };

            // Filter features
            for (const feat of panel.features) {
                const mapLayerId = parseKey(feat.mapTileKey);
                if (mapLayerId && presentLayerIds.has(mapLayerId)) {
                    updated.features.push(feat);
                }
            }

            // Validate sourceData if present
            if (updated.sourceData) {
                const mapLayerId = parseKey(updated.sourceData.mapTileKey);
                if (!mapLayerId || !presentSelectionLayerIds.has(mapLayerId)) {
                    delete updated.sourceData;
                }
            }

            if (updated.features.length || updated.sourceData) {
                nextPanels.push(updated);
            }
        }

        if (nextPanels.length !== panels.length) {
            this.selectionState.next(nextPanels);
        }
            this.sanitizeInspectionComparisonForSelection(nextPanels);

            // Sync all states, so the URL is replaced.
            this.syncAllStates();
        });
    }

    /** Migrates legacy `osm` URL/storage payloads into the generic background-layer state once on startup. */
    private migrateLegacyOsmState(params: Params): void {
        const hasBackgroundStorage = localStorage.getItem(this.backgroundState.appState.name) !== null;
        const hasBackgroundUrl = params[this.backgroundState.appState.urlParamName ?? this.backgroundState.appState.name] !== undefined;
        if (hasBackgroundStorage || hasBackgroundUrl) {
            return;
        }

        const legacyStorage = localStorage.getItem('osm');
        const legacyUrl = params['osm'];
        const legacyPayload = legacyUrl ?? legacyStorage;
        if (legacyPayload === undefined || legacyPayload === null) {
            return;
        }

        const serializedStates = typeof legacyPayload === 'string' && legacyPayload.trim().startsWith('[')
            ? this.parseLegacyOsmStorage(legacyPayload)
            : this.parseLegacyOsmUrl(String(legacyPayload));
        if (!serializedStates.length) {
            return;
        }

        serializedStates.forEach((state, viewIndex) => {
            this.setBackgroundState(viewIndex, state.layerId, state.opacity);
        });
    }

    /** Parses the JSON-encoded local-storage payload used by the removed `osm` state slot. */
    private parseLegacyOsmStorage(rawPayload: string): BackgroundLayerViewState[] {
        try {
            const parsed = JSON.parse(rawPayload);
            if (!Array.isArray(parsed)) {
                return [];
            }
            return parsed.map(token => this.parseLegacyOsmToken(String(token)));
        } catch {
            return [];
        }
    }

    /** Parses the compact CSV URL form used by the removed `osm` query parameter. */
    private parseLegacyOsmUrl(rawPayload: string): BackgroundLayerViewState[] {
        if (!rawPayload.length) {
            return [];
        }
        return rawPayload.split(',').map(token => this.parseLegacyOsmToken(token));
    }

    /** Converts one legacy `enabled~opacity` token into the new background-layer state shape. */
    private parseLegacyOsmToken(rawToken: string): BackgroundLayerViewState {
        const parts = rawToken.split('~');
        const enabled = parts[0] === '1' || parts[0].toLowerCase() === 'true';
        const opacity = parts[1] === undefined ? 6 : clampBackgroundOpacity(Number(parts[1]));
        return {
            layerId: enabled ? 'osm' : null,
            opacity
        };
    }

    /** Drops stale comparison state when the current selection no longer supports it. */
    private sanitizeInspectionComparisonForSelection(panels: InspectionPanelModel<TileFeatureId>[]): void {
        const model = this.inspectionComparisonState.getValue();
        if (!model) {
            return;
        }
        const eligiblePanelIds = new Set(
            panels
                .filter(panel => panel.sourceData === undefined && panel.features.length > 0)
                .map(panel => panel.id)
        );
        const nextModel = this.sanitizeInspectionComparisonModel(model, eligiblePanelIds);
        if (nextModel === model) {
            return;
        }
        this.inspectionComparisonState.next(nextModel);
    }

    /** Removes ineligible panels from a comparison model and drops empty results. */
    private sanitizeInspectionComparisonModel(model: InspectionComparisonModel, eligiblePanelIds: Set<number>): InspectionComparisonModel | null {
        const entries = [model.base, ...model.others];
        const remainingEntries = entries.filter(entry => eligiblePanelIds.has(entry.panelId));
        if (remainingEntries.length === entries.length) {
            return model;
        }
        if (remainingEntries.length === 0) {
            return null;
        }
        return {
            base: remainingEntries[0],
            others: remainingEntries.slice(1)
        };
    }

    /** Builds comparison candidates from the currently selected feature panels. */
    buildCompareOptions(panels: InspectionPanelModel<FeatureWrapper>[], excludePanelId?: number): InspectionComparisonOption[] {
        return panels
            .filter(panel => excludePanelId === undefined || panel.id !== excludePanelId)
            .filter(panel => this.isFeaturePanel(panel))
            .map(panel => ({
                label: this.formatFeatureLabel(panel.features),
                value: panel.id
            }));
    }

    /** Narrows inspection panels to those that represent actual feature selections. */
    private isFeaturePanel(panel: InspectionPanelModel<FeatureWrapper> | undefined): panel is InspectionPanelModel<FeatureWrapper> {
        return !!panel && panel.features.length > 0 && panel.sourceData === undefined;
    }

    /** Formats the user-facing label used for comparison entries. */
    private formatFeatureLabel(features: FeatureWrapper[]): string {
        return features.map(feature => `${feature.featureTile.mapName}.${feature.featureId}`).join(', ');
    }

    /** Builds one comparison entry from an existing feature inspection panel. */
    private createComparisonEntryFromPanel(panel: InspectionPanelModel<FeatureWrapper>): InspectionComparisonEntry {
        return {
            panelId: panel.id,
            mapId: panel.features[0]?.featureTile.mapName ?? '',
            label: this.formatFeatureLabel(panel.features),
            featureIds: panel.features.map(feature => ({
                mapTileKey: feature.mapTileKey,
                featureId: feature.featureId
            }))
        };
    }

    /** Creates the comparison-dialog model for the selected set of feature panels. */
    createComparisonModel(basePanelId: number, otherPanelIds: number[], panels: InspectionPanelModel<FeatureWrapper>[]): InspectionComparisonModel | null {
        const panelsById = new Map(
            panels
                .filter(this.isFeaturePanel)
                .map(panel => [panel.id, panel] as const)
        );
        const basePanel = panelsById.get(basePanelId);
        if (!basePanel) {
            return null;
        }
        const others = Array.from(new Set(otherPanelIds))
            .filter(panelId => panelId !== basePanelId)
            .slice(0, MAX_COMPARE_PANELS - 1)
            .map(panelId => panelsById.get(panelId))
            .filter((panel): panel is InspectionPanelModel<FeatureWrapper> => !!panel)
            .map(panel => this.createComparisonEntryFromPanel(panel));

        return {
            base: this.createComparisonEntryFromPanel(basePanel),
            others
        };
    }

    /** Applies the selection emitted by the view-sync toggle UI and mirrors it into state. */
    updateSelectedSyncOptions(selectedCodes: string[]) {
        const previousSelection = new Set(this.viewSync);
        let nextSelection = Array.from(new Set(selectedCodes));
        const hasMovement = nextSelection.includes(VIEW_SYNC_MOVEMENT);
        const hasPosition = nextSelection.includes(VIEW_SYNC_POSITION);

        if (hasMovement && hasPosition) {
            let valueToRemove = VIEW_SYNC_POSITION;
            if (!previousSelection.has(VIEW_SYNC_POSITION) && previousSelection.has(VIEW_SYNC_MOVEMENT)) {
                valueToRemove = VIEW_SYNC_MOVEMENT;
            } else if (!previousSelection.has(VIEW_SYNC_MOVEMENT) && previousSelection.has(VIEW_SYNC_POSITION)) {
                valueToRemove = VIEW_SYNC_POSITION;
            } else if (!previousSelection.has(VIEW_SYNC_MOVEMENT)) {
                valueToRemove = VIEW_SYNC_POSITION;
            } else if (!previousSelection.has(VIEW_SYNC_POSITION)) {
                valueToRemove = VIEW_SYNC_MOVEMENT;
            }
            nextSelection = nextSelection.filter(code => code !== valueToRemove);
        }

        this.viewSync = nextSelection;
        this.syncViews();
    }
}
