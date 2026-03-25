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

const COORDINATE_STATE_DECIMAL_PLACES = 8;
const COORDINATE_STATE_PRECISION = 10 ** COORDINATE_STATE_DECIMAL_PLACES;

export const MAX_SIMULTANEOUS_INSPECTIONS = 50;
export const MAX_COMPARE_PANELS = 4;
export const MAX_NUM_TILES_TO_LOAD = 512;
export const VIEW_SYNC_PROJECTION = "proj";
export const VIEW_SYNC_POSITION = "pos";
export const VIEW_SYNC_MOVEMENT = "mov";
export const VIEW_SYNC_LAYERS = "lay";
export const DEFAULT_EM_WIDTH = 30;
export const DEFAULT_EM_HEIGHT = 40;
export const DEFAULT_DOCKED_EM_HEIGHT = 20;
export const MAX_DECK_STYLE_WORKERS = 32;
export const DEFAULT_DECK_STYLE_WORKER_COUNT = 2;
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

export interface Versions {
    name: string;
    tag: string;
    whatsnew?: string;
}

export interface TileFeatureId {
    featureId: string;
    mapTileKey: string;
}

export interface SelectedSourceData {
    mapTileKey: string;
    address?: bigint;
}

export interface InspectionPanelModel<FeatureRepresentation> {
    id: number;
    features: FeatureRepresentation[];
    locked: boolean;
    size: [number, number];
    sourceData?: SelectedSourceData;
    color: string;
    undocked: boolean;
    inspectionDialogLayoutEntry?: InspectionDialogLayoutEntry;
}

export interface InspectionDialogPosition {
    left: number;
    top: number;
}

export interface InspectionDialogLayoutEntry {
    panelId: number;
    slot: number;
    position: InspectionDialogPosition;
}

export interface InspectionComparisonEntry {
    panelId: number;
    mapId: string;
    label: string;
    featureIds: TileFeatureId[];
}

export interface InspectionComparisonModel {
    base: InspectionComparisonEntry;
    others: InspectionComparisonEntry[];
}

export interface InspectionComparisonOption {
    label: string;
    value: number;
}

export interface CameraViewState {
    destination: { lon: number, lat: number, alt: number };
    orientation: { heading: number, pitch: number, roll: number };
}

export interface OsmViewState {
    enabled: boolean;
    opacity: number;
}

export interface LayerViewConfig {
    autoLevel: boolean;
    level: number;
    visible: boolean;
}

export interface ViewSyncOption {
    name: string;
    code: string;
    value: boolean;
    icon: string;
    tooltip: string;
}

export type TileGridMode = "xyz" | "nds";

function isSourceOrMetaData(mapLayerNameOrLayerId: string): boolean {
    return mapLayerNameOrLayerId.includes('/SourceData-') ||
        mapLayerNameOrLayerId.includes('/Metadata-');
}

function roundCoordinateStateValue(value: number): number {
    if (!Number.isFinite(value)) {
        return value;
    }
    return Math.round(value * COORDINATE_STATE_PRECISION) / COORDINATE_STATE_PRECISION;
}

function clampOsmOpacity(value: number): number {
    if (!Number.isFinite(value)) {
        return 30;
    }
    const rounded = Math.round(value);
    return Math.max(0, Math.min(100, rounded));
}

@Injectable({providedIn: 'root'})
/**
 * Central application state coordinator.
 *
 * Responsibilities:
 * - hydrate from local storage + URL,
 * - serialize state changes back to storage/URL.
 */
export class AppStateService implements OnDestroy {

    private readonly statePool = new Map<string, AppState<unknown>>();
    readonly ready = new BehaviorSubject<boolean>(false);

    private readonly stateSubscriptions: Subscription[] = [];

    private _replaceUrl = true;

    private isHydrating = false;
    private isReady = false;
    private subscriptionsSetup = false;
    private pendingUrlSyncStates = new Set<AppState<any>>;
    private pendingStorageSyncStates = new Set<AppState<any>>;
    private pendingPopstateHydration = false;
    private flushHandle: Promise<void> | null = null;
    private urlSyncHandle: ReturnType<typeof setTimeout> | null = null;
    private lastMergedUrlSyncAt = 0;
    // One-shot guard used to keep inbound v1 links stable during passive startup.
    private skipNextUrlSync = false;
    private readonly STYLE_OPTIONS_STORAGE_KEY = 'styleOptions';
    private static readonly URL_SYNC_MIN_INTERVAL_MS = 50;

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

    readonly searchState = this.createState<[number, string] | []>({
        name: 'search',
        defaultValue: [],
        schema: z.union([
            z.tuple([]),
            z.tuple([z.coerce.number(), z.string()]),
        ]),
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
                // size ~ [optional layout slot:left:top] ~ color ~ undockedFlag
                if (state.inspectionDialogLayoutEntry) {
                    const entry = state.inspectionDialogLayoutEntry;
                    s += `${state.size[0]}:${state.size[1]}~${entry.slot}:${entry.position.left}:${entry.position.top}~${color}~${state.undocked ? 1 : 0}`;
                } else {
                    s += `${state.size[0]}:${state.size[1]}~${color}~${state.undocked ? 1 : 0}`;
                }
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
                let sizeToken = parts.pop()!;
                let inspectionDialogLayoutEntry: InspectionDialogLayoutEntry | undefined;
                if (sizeToken.split(':').length === 3) {
                    const [slot, left, top] = sizeToken.split(':').map(Number);
                    inspectionDialogLayoutEntry = {
                        panelId: id,
                        slot,
                        position: {left, top}
                    };
                    sizeToken = parts.pop() ?? '';
                }
                const sizeParts = sizeToken.split(':');
                const size = sizeParts.length === 2 ? [Number(sizeParts[0]), Number(sizeParts[1])] : this.defaultInspectionPanelSize;

                const newPanelState: InspectionPanelModel<TileFeatureId> = {
                    id: id,
                    features: [],
                    locked: lockState || !undocked,
                    size: size as [number, number],
                    color: color,
                    undocked: undocked,
                    inspectionDialogLayoutEntry
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

    readonly layerSyncOptionsState = this.createMapViewState<boolean>({
        name: 'layerSyncOptions',
        defaultValue: false,
        schema: Boolish,
        urlIncludeInVisualizationOnly: false
    });

    readonly osmState = this.createMapViewState<OsmViewState>({
        name: 'osm',
        defaultValue: {
            enabled: true,
            opacity: 6,
        },
        schema: z.string(),
        toStorage: (value: OsmViewState) => `${value.enabled ? 1 : 0}~${clampOsmOpacity(value.opacity)}`,
        fromStorage: (payload: any, currentValue: OsmViewState): OsmViewState => {
            const parts = String(payload).split('~');
            const enabled = parts[0] === '1' || parts[0].toLowerCase() === 'true';
            const opacity = parts[1] === undefined ? currentValue.opacity : clampOsmOpacity(Number(parts[1]));
            return {enabled, opacity};
        },
        urlParamName: 'osm'
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

    readonly legalInfoDialogVisibleState = this.createState<boolean>({
        name: 'legalInfoDialogVisible',
        defaultValue: false,
        schema: Boolish
    });

    readonly aboutDialogVisibleState = this.createState<boolean>({
        name: 'aboutDialogVisible',
        defaultValue: false,
        schema: Boolish
    });

    readonly preferencesDialogVisibleState = this.createState<boolean>({
        name: 'preferencesDialogVisible',
        defaultValue: false,
        schema: Boolish
    });

    readonly controlsDialogVisibleState = this.createState<boolean>({
        name: 'controlsDialogVisible',
        defaultValue: false,
        schema: Boolish
    });

    readonly diagnosticsPerformanceDialogVisibleState = this.createState<boolean>({
        name: 'diagnosticsPerformanceDialogVisible',
        defaultValue: false,
        schema: Boolish
    });

    readonly diagnosticsLogDialogVisibleState = this.createState<boolean>({
        name: 'diagnosticsLogDialogVisible',
        defaultValue: false,
        schema: Boolish
    });

    readonly diagnosticsExportDialogVisibleState = this.createState<boolean>({
        name: 'diagnosticsExportDialogVisible',
        defaultValue: false,
        schema: Boolish
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

    readonly lastSearchHistoryEntryState = this.createState<[number, string] | null>({
        name: 'lastSearchHistoryEntry',
        defaultValue: null,
        schema: z.union([
            z.null(),
            z.tuple([z.coerce.number(), z.string()]),
        ])
    });

    readonly mapsOpenState = this.createState<boolean>({
        name: 'mapsOpenState',
        defaultValue: false,
        schema: Boolish
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

    // TODO: merge this functionality with the state?
    readonly syncOptions: ViewSyncOption[] = [
        {name: "Position", code: VIEW_SYNC_POSITION, value: false, icon: "location_on", tooltip: "Sync camera position/orientation across views"},
        {name: "Movement", code: VIEW_SYNC_MOVEMENT, value: false, icon: "drag_pan", tooltip: "Sync camera movement delta across views"},
        {name: "Projection", code: VIEW_SYNC_PROJECTION, value: false, icon: "3d_rotation", tooltip: "Sync projection mode across views"},
        {name: "Layers", code: VIEW_SYNC_LAYERS, value: false, icon: "layers", tooltip: "Sync layer activation/style/OSM settings across views"},
    ];

    constructor(private readonly router: Router,
                private readonly infoMessageService: InfoMessageService) {
        // Perform initial hydration after the initial NavigationEnd event arrives.
        this.router.events.pipe(filter(event => event instanceof NavigationEnd), take(1)).subscribe(() => {
            this.setupStateSubscriptions();
            this.hydrateFromStorage();
            this.hydrateFromUrl(this.router.routerState.snapshot.root?.queryParams ?? {});
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
    }

    private syncAllStates() {
        this.statePool.values().forEach(state => this.onStateChanged(state, true));
    }

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
        return new MapViewState<T>(this.statePool, options);
    }

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

    private onStateChanged(state: AppState<any>, force: boolean = false): void {
        if (!force && (this.isHydrating || !this.isReady)) {
            return;
        }

        this.pendingStorageSyncStates.add(state);
        if (state.isUrlState()) {
            this.pendingUrlSyncStates.add(state);
        }

        this.scheduleFlush();
    }

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

    private cancelPendingStateSync(): void {
        // Prevent stale, queued writes from a previous URL hydration cycle.
        this.pendingStorageSyncStates.clear();
        this.pendingUrlSyncStates.clear();
        if (this.urlSyncHandle !== null) {
            clearTimeout(this.urlSyncHandle);
            this.urlSyncHandle = null;
        }
    }

    private syncStorage(): void {
        for (const state of this.pendingStorageSyncStates) {
            try {
                const serialized = state.serialize(false);
                if (serialized === undefined) {
                    continue;
                }
                for (const [k, v] of Object.entries(serialized)) {
                    localStorage.setItem(k, v);
                }
            } catch (error) {
                console.error(`[AppStateService] Failed to persist state '${state.name}'`, error);
            }
        }
        this.pendingStorageSyncStates.clear();
    }

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

    private hydrateFromStorage(): void {
        this.withHydration(() => {
            for (const state of this.statePool.values()) {
                const raw = localStorage.getItem(state.name);
                if (raw) {
                    state.deserialize(raw);
                }
            }
        });
    }

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

    private withHydration(callback: () => void): void {
        const previous = this.isHydrating;
        this.isHydrating = true;
        try {
            callback();
        } finally {
            this.isHydrating = previous;
        }
    }

    // -----------------
    // Public API below
    // -----------------

    get numViews() {return this.numViewsState.getValue();}
    set numViews(val: number) {this.numViewsState.next(val);};
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
    get search() {return this.searchState.getValue();}
    set search(val: [number, string] | []) {this.searchState.next(val);};
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
    get mapsDialogVisible() {return this.mapsOpenState.getValue();};
    set mapsDialogVisible(val: boolean) {this.mapsOpenState.next(val);};
    get legalInfoDialogVisible() {return this.legalInfoDialogVisibleState.getValue();}
    set legalInfoDialogVisible(val: boolean) {this.legalInfoDialogVisibleState.next(val);};
    get aboutDialogVisible() {return this.aboutDialogVisibleState.getValue();}
    set aboutDialogVisible(val: boolean) {this.aboutDialogVisibleState.next(val);};
    get preferencesDialogVisible() {return this.preferencesDialogVisibleState.getValue();}
    set preferencesDialogVisible(val: boolean) {this.preferencesDialogVisibleState.next(val);};
    get controlsDialogVisible() {return this.controlsDialogVisibleState.getValue();}
    set controlsDialogVisible(val: boolean) {this.controlsDialogVisibleState.next(val);};
    get diagnosticsPerformanceDialogVisible() {return this.diagnosticsPerformanceDialogVisibleState.getValue();}
    set diagnosticsPerformanceDialogVisible(val: boolean) {this.diagnosticsPerformanceDialogVisibleState.next(val);};
    get diagnosticsLogDialogVisible() {return this.diagnosticsLogDialogVisibleState.getValue();}
    set diagnosticsLogDialogVisible(val: boolean) {this.diagnosticsLogDialogVisibleState.next(val);};
    get diagnosticsExportDialogVisible() {return this.diagnosticsExportDialogVisibleState.getValue();}
    set diagnosticsExportDialogVisible(val: boolean) {this.diagnosticsExportDialogVisibleState.next(val);};
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
    get lastSearchHistoryEntry() {return this.lastSearchHistoryEntryState.getValue();}
    set lastSearchHistoryEntry(val: [number, string] | null) {this.lastSearchHistoryEntryState.next(val);};
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

    getLayerSyncOption(viewIndex: number): boolean {
        return this.layerSyncOptionsState.getValue(viewIndex);
    }

    setLayerSyncOption(viewIndex: number, enabled: boolean): void {
        this.layerSyncOptionsState.next(viewIndex, enabled);
    }

    getOsmState(viewIndex: number): OsmViewState {
        const value = this.osmState.getValue(viewIndex);
        return {
            enabled: value.enabled,
            opacity: clampOsmOpacity(value.opacity),
        };
    }

    setOsmState(viewIndex: number, enabled: boolean, opacity: number): void {
        this.osmState.next(viewIndex, {
            enabled,
            opacity: clampOsmOpacity(opacity),
        });
    }

    getOsmEnabled(viewIndex: number): boolean {
        return this.getOsmState(viewIndex).enabled;
    }

    setOsmEnabled(viewIndex: number, enabled: boolean): void {
        const current = this.getOsmState(viewIndex);
        this.setOsmState(viewIndex, enabled, current.opacity);
    }

    getOsmOpacity(viewIndex: number): number {
        return this.getOsmState(viewIndex).opacity;
    }

    setOsmOpacity(viewIndex: number, opacity: number): void {
        const current = this.getOsmState(viewIndex);
        this.setOsmState(viewIndex, current.enabled, opacity);
    }

    getCameraOrientation(viewIndex: number) {
        return this.cameraViewDataState.getValue(viewIndex).orientation;
    }

    getCameraPosition(viewIndex: number) {
        const destination = this.cameraViewDataState.getValue(viewIndex).destination;
        return Cartographic.fromDegrees(destination.lon, destination.lat, destination.alt);
    }

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

    setInspectionPanelSize(id: number, size: [number, number]) {
        const allPanels = this.selectionState.getValue();
        const index = allPanels.findIndex(panel => panel.id === id);
        if (index === -1) {
            return;
        }
        allPanels[index].size = size;
        this.onStateChanged(this.selectionState, true); // Do not retrigger the subscription - we only need to reflect the size in the url
    }

    setInspectionPanelLockedState(id: number, isLocked: boolean) {
        const allPanels = this.selectionState.getValue();
        const index = allPanels.findIndex(panel => panel.id === id);
        if (index === -1) {
            return;
        }
        allPanels[index].locked = isLocked;
        this.selectionState.next(allPanels);
    }

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

    getInspectionDialogLayoutEntry(panelId: number): InspectionDialogLayoutEntry | undefined {
        return this.selectionState.getValue().find(panel => panel.id === panelId)?.inspectionDialogLayoutEntry;
    }

    ensureInspectionDialogSlot(panelId: number, preferredIndex: number): number {
        return this.getInspectionDialogLayoutEntry(panelId)?.slot ?? preferredIndex;
    }

    setInspectionDialogPosition(panelId: number, position: InspectionDialogPosition, preferredIndex?: number): void {
        const allPanels = this.selectionState.getValue();
        const panelIndex = allPanels.findIndex(panel => panel.id === panelId);
        if (panelIndex === -1) {
            return;
        }
        const existing = allPanels[panelIndex].inspectionDialogLayoutEntry;
        const slot = existing === undefined
            ? this.ensureInspectionDialogSlot(panelId, preferredIndex ?? panelId)
            : existing.slot;
        allPanels[panelIndex].inspectionDialogLayoutEntry = {
            panelId,
            slot,
            position: {left: position.left, top: position.top}
        };
        this.onStateChanged(this.selectionState, true);
    }

    pruneInspectionDialogLayout(_activePanelIds: number[]) {
        // Layout is stored directly on the corresponding selection panel.
    }

    openInspectionComparison(model: InspectionComparisonModel): void {
        this.inspectionComparisonState.next(model);
    }

    closeInspectionComparison(): void {
        this.inspectionComparisonState.next(null);
    }

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

    setInspectionPanelColor(id: number, color: string) {
        const allPanels = this.selectionState.getValue();
        const index = allPanels.findIndex(panel => panel.id === id);
        if (index === -1) {
            return;
        }
        allPanels[index].color = color;
        this.selectionState.next(allPanels);
    }

    unsetUnlockedSelections() {
        const nextSelection = this.selectionState.getValue().filter(panel =>
            panel.locked || panel.sourceData !== undefined
        );
        this.selectionState.next(nextSelection);
        this.sanitizeInspectionComparisonForSelection(nextSelection);
    }

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

    setMarkerState(enabled: boolean) {
        this.markerState.next(enabled);
        if (!enabled) {
            this.setMarkerPosition(null, false);
        }
    }

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

    getStyleVisibility(styleId: string, fallback: boolean = true): boolean {
        if (this.styleVisibility.hasOwnProperty(styleId)) {
            return this.styleVisibility[styleId];
        }
        return fallback;
    }

    setStyleVisibility(styleId: string, val: boolean) {
        this.styleVisibility[styleId] = val;
        this.styleVisibilityState.next(this.styleVisibility);
    }

    setSearchHistoryState(value: [number, string] | null, saveHistory: boolean = true) {
        const trimmed = value ? [value[0], value[1].trim()] as [number, string] : null;
        if (trimmed && saveHistory) {
            this.saveHistoryStateValue(trimmed);
        }
        this.searchState.next(trimmed ? trimmed : []);
        this._replaceUrl = false;
        this.lastSearchHistoryEntryState.next(trimmed);
    }

    private saveHistoryStateValue(value: [number, string]) {
        const searchHistoryString = localStorage.getItem("searchHistory");
        if (searchHistoryString) {
            let parsed = JSON.parse(searchHistoryString) as any;
            let searchHistory: Array<[number, string]>;
            if (Array.isArray(parsed) && parsed.length && Array.isArray(parsed[0])) {
                searchHistory = parsed as Array<[number, string]>;
            } else if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'number' && typeof parsed[1] === 'string') {
                searchHistory = [parsed as [number, string]];
            } else {
                searchHistory = [];
            }
            searchHistory = searchHistory.filter((entry: [number, string]) => !(entry[0] === value[0] && entry[1] === value[1]));
            searchHistory.unshift(value);
            while (searchHistory.length > 100) {
                searchHistory.pop();
            }
            localStorage.setItem("searchHistory", JSON.stringify(searchHistory));
        } else {
            localStorage.setItem("searchHistory", JSON.stringify([value]));
        }
    }

    resetStorage() {
        for (const state of this.statePool.values()) {
            state.resetToDefault();
            localStorage.removeItem(state.name);
        }
        localStorage.removeItem('searchHistory');
        localStorage.removeItem(this.STYLE_OPTIONS_STORAGE_KEY);
        const {origin, pathname} = window.location;
        window.location.href = origin + pathname;
    }

    prune(presentMaps: Map<string, MapTreeNode>, presentStyles: Map<string, ErdblickStyle>) {
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
        pruneViews(this.osmState);
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
                undocked: panel.undocked,
                inspectionDialogLayoutEntry: panel.inspectionDialogLayoutEntry
                    ? {
                        panelId: panel.id,
                        slot: panel.inspectionDialogLayoutEntry.slot,
                        position: {
                            left: panel.inspectionDialogLayoutEntry.position.left,
                            top: panel.inspectionDialogLayoutEntry.position.top
                        }
                    }
                    : undefined
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
    }

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

    buildCompareOptions(panels: InspectionPanelModel<FeatureWrapper>[], excludePanelId?: number): InspectionComparisonOption[] {
        return panels
            .filter(panel => excludePanelId === undefined || panel.id !== excludePanelId)
            .filter(panel => this.isFeaturePanel(panel))
            .map(panel => ({
                label: this.formatFeatureLabel(panel.features),
                value: panel.id
            }));
    }

    private isFeaturePanel(panel: InspectionPanelModel<FeatureWrapper> | undefined): panel is InspectionPanelModel<FeatureWrapper> {
        return !!panel && panel.features.length > 0 && panel.sourceData === undefined;
    }

    private formatFeatureLabel(features: FeatureWrapper[]): string {
        return features.map(feature => `${feature.featureTile.mapName}.${feature.featureId}`).join(', ');
    }

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

    updateSelectedSyncOptions() {
        const previousSelection = new Set(this.viewSync);
        const hasMovement = this.syncOptions.some(option =>
            option.code === VIEW_SYNC_MOVEMENT && option.value);
        const hasPosition = this.syncOptions.some(option =>
            option.code === VIEW_SYNC_POSITION && option.value);

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
            for (const option of this.syncOptions) {
                if (option.code === valueToRemove) {
                    option.value = false;
                }
            }
        }

        this.viewSync = this.syncOptions.filter(option =>
            option.value).map(option=> option.code);
        this.syncViews();
    }
}
