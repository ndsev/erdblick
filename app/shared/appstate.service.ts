import {Injectable, OnDestroy} from "@angular/core";
import {NavigationEnd, Params, Router} from "@angular/router";
import {ReplaySubject, skip, Subscription} from "rxjs";
import {filter} from "rxjs/operators";
import {Camera, Cartesian3, Cartographic, CesiumMath} from "../integrations/cesium";
import {SelectedSourceData} from "../inspection/inspection.service";
import {AppModeService} from "./app-mode.service";
import {MapInfoItem} from "../mapdata/map.service";
import {AppState, AppStateOptions} from "./app-state";

export const MAX_NUM_TILES_TO_LOAD = 2048;
export const MAX_NUM_TILES_TO_VISUALIZE = 512;

export interface TileFeatureId {
    featureId: string,
    mapTileKey: string,
}

export interface StyleParameters {
    visible: boolean,
    options: Record<string, boolean|number>
}

export interface StyleURLParameters {
    v: boolean,
    o: Record<string, boolean|number>
}

export interface CameraViewState {
    destination: { lon: number, lat: number, alt: number };
    orientation: { heading: number, pitch: number, roll: number };
}

export type PanelSizeState = [] | [number, number];

/**
 * !!! THE RETURNED FUNCTION MAY MUTATE THE VALIDATED VALUES !!!
 *
 * Function to create an object or array types validator given a key-typeof-value
 * dictionary or a types array.
 *
 * Note: For boolean values, this function contains an extra mechanism to
 * turn compact (0/1) boolean representations into true/false inside the validated objects.
 */
function validateObjectsAndTypes(fields: Record<string, string> | Array<string>) {
    return (o: object | Array<any>) => {
        if (!Array.isArray(fields)) {
            if (typeof o !== "object" || o === null) {
                return false;
            }
            for (const [key, value] of Object.entries(o)) {
                const valueType = typeof value;
                if (valueType === "number" && fields[key] === "boolean" && (value === 0 || value === 1)) {
                    (o as Record<string, any>)[key] = !!value;  // Turn the compact boolean into a primitive boolean.
                    continue;
                }
                if (fields.hasOwnProperty(key) && valueType !== fields[key]) {
                    return false;
                }
            }
            return true;
        }
        if (Array.isArray(o) && o.length === fields.length) {
            for (let i = 0; i < fields.length; i++) {
                const valueType = typeof o[i];
                if (valueType === "number" && fields[i] === "boolean" && (o[i] === 0 || o[i] === 1)) {
                    o[i] = !!o[i];  // Turn the compact boolean into a primitive boolean.
                    continue;
                }
                if (valueType !== fields[i]) {
                    return false;
                }
            }
            return true;
        }
        return false;
    };
}

const CAMERA_PARAM_NAMES = ["lon", "lat", "alt", "h", "p", "r"] as const;

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && !isNaN(value) && isFinite(value);
}

function toNumber(value: string): number | undefined {
    const parsed = Number(value);
    return isFinite(parsed) ? parsed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
    if (typeof value === 'number') {
        return isFiniteNumber(value) ? value : undefined;
    }
    if (typeof value === 'string') {
        return toNumber(value);
    }
    return undefined;
}

function canonicaliseForComparison(value: unknown): unknown {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
}

function valuesEqual(left: unknown, right: unknown): boolean {
    if (left === right) {
        return true;
    }
    if (typeof left !== typeof right) {
        return false;
    }
    try {
        return JSON.stringify(left, (_key, val) => canonicaliseForComparison(val)) ===
            JSON.stringify(right, (_key, val) => canonicaliseForComparison(val));
    } catch (_error) {
        return false;
    }
}

function serializeCameraView(view: CameraViewState): string {
    return JSON.stringify({
        lon: view.destination.lon,
        lat: view.destination.lat,
        alt: view.destination.alt,
        h: view.orientation.heading,
        p: view.orientation.pitch,
        r: view.orientation.roll,
    });
}

function deserializeCameraView(raw: string, current: CameraViewState): CameraViewState | undefined {
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== 'object') {
        return undefined;
    }

    const next: CameraViewState = {
        destination: {...current.destination},
        orientation: {...current.orientation},
    };
    let updated = false;

    const apply = (value: unknown, setter: (val: number) => void): boolean => {
        if (value === undefined) {
            return true;
        }
        const numeric = asFiniteNumber(value);
        if (numeric === undefined) {
            return false;
        }
        setter(numeric);
        updated = true;
        return true;
    };

    const flat = parsed as Record<string, unknown>;
    if (!apply(flat['lon'], value => next.destination.lon = value)) {
        return undefined;
    }
    if (!apply(flat['lat'], value => next.destination.lat = value)) {
        return undefined;
    }
    if (!apply(flat['alt'], value => next.destination.alt = value)) {
        return undefined;
    }
    if (!apply(flat['h'], value => next.orientation.heading = value)) {
        return undefined;
    }
    if (!apply(flat['p'], value => next.orientation.pitch = value)) {
        return undefined;
    }
    if (!apply(flat['r'], value => next.orientation.roll = value)) {
        return undefined;
    }

    return updated ? next : undefined;
}

function isSourceOrMetaData(mapLayerNameOrLayerId: string): boolean {
    return mapLayerNameOrLayerId.includes('/SourceData-') ||
        mapLayerNameOrLayerId.includes('/Metadata-');
}

function parseBigInt(value: any): bigint | undefined {
    if (value === undefined || value === null || value === "") {
        return BigInt(0);
    }
    try {
        return typeof value === 'bigint' ? value : BigInt(value);
    } catch (_error) {
        return undefined;
    }
}

function normaliseSelectedSourceData(value: any): SelectedSourceData | null | undefined {
    if (!value) {
        return null;
    }
    if (Array.isArray(value) && value.length >= 3) {
        const tileId = Number(value[0]);
        if (!Number.isFinite(tileId)) {
            return undefined;
        }
        const address = parseBigInt(value[3]);
        return {
            tileId,
            layerId: String(value[1]),
            mapId: String(value[2]),
            address,
            featureIds: value[4] !== undefined ? String(value[4]) : undefined,
        };
    }
    return undefined;
}

function encodeSelectedSourceData(value: SelectedSourceData | null): string {
    if (!value) {
        return JSON.stringify([]);
    }
    return JSON.stringify([
        value.tileId,
        value.layerId,
        value.mapId,
        value.address !== undefined ? value.address.toString() : "",
        value.featureIds ?? "",
    ]);
}

function decodeSelectedSourceData(raw: string): SelectedSourceData | null | undefined {
    try {
        const parsed = JSON.parse(raw);
        return normaliseSelectedSourceData(parsed);
    } catch (_error) {
        return undefined;
    }
}

function safeJsonParse(raw: string): unknown | undefined {
    try {
        return JSON.parse(raw);
    } catch (_error) {
        return undefined;
    }
}

function coerceBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
        return value;
    }
    if (value === 1 || value === '1' || value === 'true') {
        return true;
    }
    if (value === 0 || value === '0' || value === 'false') {
        return false;
    }
    return undefined;
}

function deserializeSearch(raw: string): [number, string] | [] | undefined {
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed)) {
        return undefined;
    }
    if (parsed.length === 0) {
        return [];
    }
    if (parsed.length === 2 && typeof parsed[0] === 'number' && typeof parsed[1] === 'string') {
        return [parsed[0], parsed[1]];
    }
    return undefined;
}

function deserializeNumberArray(raw: string): number[] | undefined {
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'number')) {
        return undefined;
    }
    return parsed as number[];
}

function deserializeTileFeatureIds(raw: string): TileFeatureId[] | undefined {
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed)) {
        return undefined;
    }
    const validator = validateObjectsAndTypes({mapTileKey: "string", featureId: "string"});
    if (!parsed.every(item => validator(item))) {
        return undefined;
    }
    return parsed as TileFeatureId[];
}

function deserializeViewRectangle(raw: string): [number, number, number, number] | null | undefined {
    if (raw === 'null') {
        return null;
    }
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 4 || !parsed.every(item => typeof item === 'number')) {
        return undefined;
    }
    return parsed as [number, number, number, number];
}

function deserializeLayers(raw: string): Array<[string, number, boolean, boolean]> | undefined {
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed)) {
        return undefined;
    }
    const result: Array<[string, number, boolean, boolean]> = [];
    for (const entry of parsed) {
        if (!Array.isArray(entry) || entry.length !== 4) {
            return undefined;
        }
        const [layerId, level, visibleRaw, tileBordersRaw] = entry;
        if (typeof layerId !== 'string' || typeof level !== 'number') {
            return undefined;
        }
        const visible = coerceBoolean(visibleRaw);
        const tileBorders = coerceBoolean(tileBordersRaw);
        if (visible === undefined || tileBorders === undefined) {
            return undefined;
        }
        result.push([layerId, level, visible, tileBorders]);
    }
    return result;
}

function deserializeStyles(raw: string): Record<string, StyleURLParameters> | undefined {
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== 'object') {
        return undefined;
    }
    const result: Record<string, StyleURLParameters> = {};
    for (const [styleId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') {
            return undefined;
        }
        const v = coerceBoolean((value as Record<string, unknown>)['v']);
        const optionsRaw = (value as Record<string, unknown>)['o'];
        if (v === undefined || !optionsRaw || typeof optionsRaw !== 'object') {
            return undefined;
        }
        const options: Record<string, boolean | number> = {};
        for (const [optionKey, optionValue] of Object.entries(optionsRaw as Record<string, unknown>)) {
            if (typeof optionValue === 'number') {
                options[optionKey] = optionValue;
                continue;
            }
            const optionBoolean = coerceBoolean(optionValue);
            if (optionBoolean === undefined) {
                return undefined;
            }
            options[optionKey] = optionBoolean;
        }
        result[styleId] = {v, o: options};
    }
    return result;
}

function deserializeTilesLimit(raw: string): number | undefined {
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function deserializePanel(raw: string): PanelSizeState | undefined {
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed)) {
        return undefined;
    }
    if (parsed.length === 0) {
        return [];
    }
    if (parsed.length === 2 && parsed.every(item => typeof item === 'number')) {
        return [parsed[0], parsed[1]] as PanelSizeState;
    }
    return undefined;
}

function deserializeSearchHistory(raw: string): [number, string] | null | undefined {
    if (raw === 'null') {
        return null;
    }
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 2) {
        return undefined;
    }
    if (typeof parsed[0] === 'number' && typeof parsed[1] === 'string') {
        return [parsed[0], parsed[1]];
    }
    return undefined;
}

function validateCameraView(value: CameraViewState): boolean {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const destination = value.destination;
    const orientation = value.orientation;
    return destination !== undefined && orientation !== undefined &&
        isFiniteNumber(destination?.lon) &&
        isFiniteNumber(destination?.lat) &&
        isFiniteNumber(destination?.alt) &&
        isFiniteNumber(orientation?.heading) &&
        isFiniteNumber(orientation?.pitch) &&
        isFiniteNumber(orientation?.roll);
}

@Injectable({providedIn: 'root'})
export class AppStateService {

    private readonly statePool = new Map<string, AppState<unknown>>();
    private readonly readySubject = new ReplaySubject<void>(1);
    public readonly ready$ = this.readySubject.asObservable();

    private readonly stateSubscriptions: Subscription[] = [];

    private _replaceUrl = true;

    private isHydrating = false;
    private isReady = false;
    private pendingUrlSync = false;
    private pendingStorageSync = false;
    private flushHandle: Promise<void> | null = null;

    // Base UI metrics
    baseFontSize: number = 16;
    inspectionContainerWidth: number = 40;
    inspectionContainerHeight: number = (window.innerHeight - 10.5 * this.baseFontSize);

    private baseCameraMoveM = 100.0;
    private baseCameraZoomM = 100.0;
    private scalingFactor = 1;

    readonly searchState = this.createState<[number, string] | []>({
        name: 'search',
        defaultValue: [],
        deserialize: (raw) => deserializeSearch(raw),
        validate: val => Array.isArray(val) && (val.length === 0 || (val.length === 2 && typeof val[0] === 'number' && typeof val[1] === 'string')),
        urlParamName: 'search',
        urlIncludeInVisualizationOnly: false,
    });

    readonly markerState = this.createState<boolean>({
        name: 'marker',
        defaultValue: false,
        serialize: value => value ? '1' : '0',
        deserialize: raw => coerceBoolean(raw),
        validate: val => typeof val === 'boolean',
        urlParamName: 'marker',
        urlIncludeInVisualizationOnly: false,
    });

    readonly markedPositionState = this.createState<number[]>({
        name: 'markedPosition',
        defaultValue: [],
        deserialize: (raw) => deserializeNumberArray(raw),
        validate: val => Array.isArray(val) && val.every(item => typeof item === 'number'),
        urlParamName: 'markedPosition',
        urlIncludeInVisualizationOnly: false,
    });

    readonly selectedFeaturesState = this.createState<TileFeatureId[]>({
        name: 'selected',
        defaultValue: [],
        deserialize: (raw) => deserializeTileFeatureIds(raw),
        validate: val => Array.isArray(val) && val.every(validateObjectsAndTypes({mapTileKey: "string", featureId: "string"})),
        urlParamName: 'selected',
        urlIncludeInVisualizationOnly: false,
    });

    readonly cameraViewData = this.createState<CameraViewState>({
        name: 'cameraView',
        defaultValue: {
            destination: {lon: 22.837473, lat: 38.490817, alt: 16000000},
            orientation: {heading: 6.0, pitch: -1.55, roll: 0.25},
        },
        serialize: serializeCameraView,
        deserialize: (raw, current) => deserializeCameraView(raw, current),
        validate: value => validateCameraView(value),
        urlParamName: 'cameraView',
        urlFormEncode: true,
        urlFormParamNames: [...CAMERA_PARAM_NAMES],
    });

    readonly viewRectangleState = this.createState<[number, number, number, number] | null>({
        name: 'viewRectangle',
        defaultValue: null,
        deserialize: (raw) => deserializeViewRectangle(raw),
        validate: val => val === null || (Array.isArray(val) && val.length === 4 && val.every(item => typeof item === 'number')),
        urlParamName: 'viewRectangle',
        urlIncludeInVisualizationOnly: false,
    });

    readonly mode2dState = this.createState<boolean>({
        name: 'mode2d',
        defaultValue: false,
        serialize: value => value ? '1' : '0',
        deserialize: raw => coerceBoolean(raw),
        validate: val => typeof val === 'boolean',
        urlParamName: 'mode2d',
        urlIncludeInVisualizationOnly: false,
    });

    readonly osmEnabledState = this.createState<boolean>({
        name: 'osm',
        defaultValue: true,
        serialize: value => value ? '1' : '0',
        deserialize: raw => coerceBoolean(raw),
        validate: val => typeof val === 'boolean',
        urlParamName: 'osm',
    });

    readonly osmOpacityState = this.createState<number>({
        name: 'osmOpacity',
        defaultValue: 30,
        serialize: value => value.toString(),
        deserialize: raw => {
            const parsed = Number(raw);
            return Number.isFinite(parsed) ? parsed : undefined;
        },
        validate: val => typeof val === 'number' && !isNaN(val) && val >= 0 && val <= 100,
        urlParamName: 'osmOpacity',
    });

    readonly layersState = this.createState<Array<[string, number, boolean, boolean]>>({
        name: 'layers',
        defaultValue: [],
        deserialize: (raw) => deserializeLayers(raw),
        validate: val => Array.isArray(val) && val.every(validateObjectsAndTypes(["string", "number", "boolean", "boolean"])),
        urlParamName: 'layers',
    });

    readonly stylesState = this.createState<Record<string, StyleURLParameters>>({
        name: 'styles',
        defaultValue: {},
        deserialize: raw => deserializeStyles(raw),
        validate: val => typeof val === 'object' && Object.entries(val as Record<string, StyleURLParameters>)
            .every(([_, v]) => validateObjectsAndTypes({v: "boolean", o: "object"})(v)),
        urlParamName: 'styles',
    });

    readonly tilesLoadLimitState = this.createState<number>({
        name: 'tilesLoadLimit',
        defaultValue: MAX_NUM_TILES_TO_LOAD,
        serialize: value => value.toString(),
        deserialize: raw => deserializeTilesLimit(raw),
        validate: val => typeof val === 'number' && !isNaN(val) && val >= 0,
        urlParamName: 'tilesLoadLimit',
    });

    readonly tilesVisualizeLimitState = this.createState<number>({
        name: 'tilesVisualizeLimit',
        defaultValue: MAX_NUM_TILES_TO_VISUALIZE,
        serialize: value => value.toString(),
        deserialize: raw => deserializeTilesLimit(raw),
        validate: val => typeof val === 'number' && !isNaN(val) && val >= 0,
        urlParamName: 'tilesVisualizeLimit',
    });

    readonly enabledCoordsTileIdsState = this.createState<string[]>({
        name: 'enabledCoordsTileIds',
        defaultValue: ["WGS84"],
        deserialize: raw => {
            const parsed = safeJsonParse(raw);
            if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
                return undefined;
            }
            return parsed as string[];
        },
        validate: val => Array.isArray(val) && val.every(item => typeof item === 'string')
    });

    readonly selectedSourceDataState = this.createState<SelectedSourceData | null>({
        name: 'selectedSourceData',
        defaultValue: null,
        serialize: value => encodeSelectedSourceData(value),
        deserialize: raw => decodeSelectedSourceData(raw),
        validate: val => val === null || (typeof val.tileId === 'number' && typeof val.layerId === 'string' && typeof val.mapId === 'string'),
        urlParamName: 'selectedSourceData',
        urlIncludeInVisualizationOnly: false,
    });

    readonly panelState = this.createState<PanelSizeState>({
        name: 'panel',
        defaultValue: [] as PanelSizeState,
        deserialize: raw => deserializePanel(raw),
        validate: val => Array.isArray(val) && (val.length === 0 || (val.length === 2 && val.every(item => typeof item === 'number'))),
        urlParamName: 'panel',
        urlIncludeInVisualizationOnly: false,
    });

    readonly legalInfoDialogVisibleState = this.createState<boolean>({
        name: 'legalInfoDialogVisible',
        defaultValue: false,
        serialize: value => value ? '1' : '0',
        deserialize: raw => coerceBoolean(raw),
        validate: val => typeof val === 'boolean'
    });

    readonly lastSearchHistoryEntry = this.createState<[number, string] | null>({
        name: 'lastSearchHistoryEntry',
        defaultValue: null,
        deserialize: raw => deserializeSearchHistory(raw),
        validate: val => val === null || (Array.isArray(val) && val.length === 2 && typeof val[0] === 'number' && typeof val[1] === 'string')
    });

    constructor(private readonly router: Router,
                private readonly appModeService: AppModeService) {
        this.baseFontSize = parseFloat(window.getComputedStyle(document.documentElement).fontSize);
        this.inspectionContainerWidth = 40 * this.baseFontSize;
        this.inspectionContainerHeight = window.innerHeight - 10.5 * this.baseFontSize;

        this.setupStateSubscriptions();
        this.hydrateFromStorage();
        this.hydrateFromUrl(this.router.routerState.snapshot.root?.queryParams ?? {});
        this.isHydrating = false;
        this.isReady = true;
        this.updateScalingFactor(this.cameraViewData.getValue().destination.alt);
        this.persistStates();
        this.readySubject.next();

        this.router.events.pipe(filter(event => event instanceof NavigationEnd)).subscribe(() => {
            this.withHydration(() => this.hydrateFromUrl(this.router.routerState.snapshot.root?.queryParams ?? {}));
        });
    }

    get cameraMoveUnits() {
        return this.baseCameraMoveM * this.scalingFactor / 75000;
    }

    get cameraZoomUnits() {
        return this.baseCameraZoomM * this.scalingFactor;
    }

    get legalInfoDialogVisible(): boolean {
        return this.legalInfoDialogVisibleState.getValue();
    }

    set legalInfoDialogVisible(value: boolean) {
        this.legalInfoDialogVisibleState.next(value);
    }

    get replaceUrl() {
        const currentValue = this._replaceUrl;
        this._replaceUrl = true;
        return currentValue;
    }

    private createState<T>(options: AppStateOptions<T>): AppState<T> {
        return new AppState<T>(this.statePool, options);
    }

    private setupStateSubscriptions() {
        // NOTE: Is this the best way to implement the internal subscription mechanism?
        for (const state of this.statePool.values()) {
            const subscription = (state as AppState<unknown>).pipe(skip(1)).subscribe(value => {
                this.onStateChanged(state as AppState<unknown>, value);
            });
            this.stateSubscriptions.push(subscription);
        }
    }

    private onStateChanged(state: AppState<unknown>, value: unknown): void {
        if (state === this.cameraViewData && value) {
            const camera = value as CameraViewState;
            this.updateScalingFactor(camera.destination.alt);
        }

        if (this.isHydrating || !this.isReady) {
            return;
        }

        this.pendingStorageSync = true;
        if (this.shouldSyncUrlForState(state)) {
            this.pendingUrlSync = true;
        }

        this.scheduleFlush();
    }

    private hasUrlBinding(state: AppState<unknown>): boolean {
        if (state.urlFormEncode) {
            return state.urlFormParamNames.length > 0 || !!state.urlParamName;
        }
        return !!state.urlParamName;
    }

    private shouldSyncUrlForState(state: AppState<unknown>): boolean {
        if (!this.hasUrlBinding(state)) {
            return false;
        }
        if (this.appModeService.isVisualizationOnly && state.urlIncludeInVisualizationOnly === false) {
            return false;
        }
        return true;
    }

    private scheduleFlush(): void {
        if (this.flushHandle) {
            return;
        }
        this.flushHandle = Promise.resolve().then(() => {
            this.flushHandle = null;
            if (this.isHydrating) {
                this.pendingStorageSync = false;
                this.pendingUrlSync = false;
                return;
            }
            if (this.pendingStorageSync) {
                this.persistStates();
            }
            if (this.pendingUrlSync) {
                this.syncUrl();
            }
            this.pendingStorageSync = false;
            this.pendingUrlSync = false;
        });
    }

    private persistStates(): void {
        for (const state of this.statePool.values()) {
            const serialized = state.serialize();
            if (serialized === undefined) {
                continue;
            }
            try {
                localStorage.setItem(state.name, serialized);
            } catch (error) {
                console.error(`[AppStateService] Failed to persist state '${state.name}'`, error);
            }
        }
    }

    private syncUrl(): void {
        const params: Record<string, string> = {};
        for (const state of this.statePool.values()) {
            if (!this.shouldSyncUrlForState(state)) {
                continue;
            }
            const serialized = state.serialize();
            if (serialized === undefined) {
                continue;
            }
            if (state.urlFormEncode) {
                const encoded = this.encodeFormParams(state, serialized);
                if (!encoded) {
                    continue;
                }
                Object.assign(params, encoded);
            } else if (state.urlParamName) {
                params[state.urlParamName] = serialized;
            }
        }
        const replaceUrl = this.replaceUrl;
        this.router.navigate([], {
            queryParams: params,
            queryParamsHandling: 'merge',
            replaceUrl
        }).catch(error => {
            console.error('[AppStateService] Failed to sync URL parameters', error);
        });
    }

    private encodeFormParams(state: AppState<unknown>, serialized: string): Record<string, string> | null {
        if (!state.urlFormEncode) {
            return null;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(serialized);
        } catch (error) {
            console.warn(`[AppStateService] Failed to encode URL params for state '${state.name}'`, error);
            return null;
        }

        const result: Record<string, string> = {};
        const names = state.urlFormParamNames;

        if (Array.isArray(parsed)) {
            for (let index = 0; index < names.length; index++) {
                if (index >= parsed.length) {
                    break;
                }
                const value = parsed[index];
                if (value === undefined) {
                    continue;
                }
                result[names[index]] = String(value);
            }
            return result;
        }

        if (parsed && typeof parsed === 'object') {
            for (const name of names) {
                if (!Object.prototype.hasOwnProperty.call(parsed, name)) {
                    continue;
                }
                const value = (parsed as Record<string, unknown>)[name];
                if (value === undefined) {
                    continue;
                }
                result[name] = String(value);
            }
            if (names.length === 0 && state.urlParamName) {
                result[state.urlParamName] = serialized;
            }
            return result;
        }

        console.warn(`[AppStateService] Unsupported URL form payload for state '${state.name}'`);
        return null;
    }

    private extractUrlSerializedValue(state: AppState<unknown>, params: Params): string | undefined {
        if (state.urlFormEncode) {
            const collected: Record<string, string> = {};
            let hasValue = false;

            for (const name of state.urlFormParamNames) {
                const raw = params[name];
                if (raw === undefined) {
                    continue;
                }
                if (Array.isArray(raw)) {
                    this.logRejectedValue(state.name, 'url', raw);
                    return undefined;
                }
                collected[name] = raw;
                hasValue = true;
            }

            if (!hasValue) {
                const fallback = this.extractFallbackSerializedValue(state, params);
                if (fallback !== undefined) {
                    return fallback;
                }
                return undefined;
            }
            return JSON.stringify(collected);
        }

        return this.extractFallbackSerializedValue(state, params);
    }

    private extractFallbackSerializedValue(state: AppState<unknown>, params: Params): string | undefined {
        if (!state.urlParamName) {
            return undefined;
        }
        const raw = params[state.urlParamName];
        if (raw === undefined) {
            return undefined;
        }
        if (Array.isArray(raw)) {
            this.logRejectedValue(state.name, 'url', raw);
            return undefined;
        }
        return typeof raw === 'string' ? raw : undefined;
    }

    private hydrateFromStorage(): void {
        this.withHydration(() => {
            for (const state of this.statePool.values()) {
                const raw = localStorage.getItem(state.name);
                if (raw === null) {
                    continue;
                }
                const value = state.deserialize(raw);
                if (value === undefined) {
                    continue;
                }
                if (!state.validate(value)) {
                    this.logRejectedValue(state.name, 'storage', value);
                    continue;
                }
                this.applyStateValue(state, value);
            }
        });
    }

    private hydrateFromUrl(params: Params): void {
        for (const state of this.statePool.values()) {
            if (!this.shouldSyncUrlForState(state)) {
                continue;
            }
            const raw = this.extractUrlSerializedValue(state, params);
            if (raw === undefined) {
                continue;
            }
            const value = state.deserialize(raw);
            if (value === undefined) {
                continue;
            }
            if (!state.validate(value)) {
                this.logRejectedValue(state.name, 'url', value);
                continue;
            }
            this.applyStateValue(state as AppState<unknown>, value as unknown);
        }
    }

    private applyStateValue<T>(state: AppState<T>, value: T): void {
        if (valuesEqual(state.getValue(), value)) {
            return;
        }
        state.next(value);
    }

    private updateScalingFactor(altitude: number): void {
        if (!isFiniteNumber(altitude) || altitude <= 0) {
            this.scalingFactor = 1;
            return;
        }
        this.scalingFactor = Math.pow(altitude / 1000, 1.1) / 2;
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

    private logRejectedValue(stateName: string, source: 'url' | 'storage' | 'runtime', raw: unknown): void {
        console.warn(`[AppStateService] Rejected ${source} value for state '${stateName}'`, raw);
    }

    // -----------------
    // Public API below
    // -----------------

    getCameraOrientation() {
        return this.cameraViewData.getValue().orientation;
    }

    getCameraPosition() {
        const destination = this.cameraViewData.getValue().destination;
        return Cartesian3.fromDegrees(destination.lon, destination.lat, destination.alt);
    }

    setView(destination: Cartesian3, orientation: { heading: number, pitch: number, roll: number }) {
        const cartographic = Cartographic.fromCartesian(destination);
        const view: CameraViewState = {
            destination: {
                lon: CesiumMath.toDegrees(cartographic.longitude),
                lat: CesiumMath.toDegrees(cartographic.latitude),
                alt: cartographic.height,
            },
            orientation: {
                heading: orientation.heading,
                pitch: orientation.pitch,
                roll: orientation.roll,
            }
        };
        this.cameraViewData.next(view);
    }

    setCameraState(camera: Camera) {
        const currentPositionCartographic = Cartographic.fromCartesian(camera.position);
        const nextView: CameraViewState = {
            destination: {
                lon: CesiumMath.toDegrees(currentPositionCartographic.longitude),
                lat: CesiumMath.toDegrees(currentPositionCartographic.latitude),
                alt: currentPositionCartographic.height,
            },
            orientation: {
                heading: camera.heading,
                pitch: camera.pitch,
                roll: camera.roll,
            }
        };
        this.cameraViewData.next(nextView);
    }

    set2DCameraState(camera: Camera) {
        const viewRect = camera.computeViewRectangle();
        const currentPositionCartographic = Cartographic.fromCartesian(camera.position);

        if (viewRect) {
            this.viewRectangleState.next([
                CesiumMath.toDegrees(viewRect.west),
                CesiumMath.toDegrees(viewRect.south),
                CesiumMath.toDegrees(viewRect.east),
                CesiumMath.toDegrees(viewRect.north)
            ]);
            const center = Cartographic.fromRadians(
                (viewRect.west + viewRect.east) / 2,
                (viewRect.north + viewRect.south) / 2
            );
            this.cameraViewData.next({
                destination: {
                    lon: CesiumMath.toDegrees(center.longitude),
                    lat: CesiumMath.toDegrees(center.latitude),
                    alt: currentPositionCartographic.height,
                },
                orientation: {
                    heading: camera.heading,
                    pitch: camera.pitch,
                    roll: camera.roll,
                }
            });
        } else {
            this.cameraViewData.next({
                destination: {
                    lon: CesiumMath.toDegrees(currentPositionCartographic.longitude),
                    lat: CesiumMath.toDegrees(currentPositionCartographic.latitude),
                    alt: currentPositionCartographic.height,
                },
                orientation: {
                    heading: camera.heading,
                    pitch: camera.pitch,
                    roll: camera.roll,
                }
            });
        }
    }

    setCameraMode(isEnabled: boolean) {
        this.mode2dState.next(isEnabled);
    }

    setSelectedSourceData(selection: SelectedSourceData) {
        const normalized = normaliseSelectedSourceData(selection);
        if (normalized === undefined) {
            this.logRejectedValue('selectedSourceData', 'runtime', selection);
            return;
        }
        this.selectedSourceDataState.next(normalized);
    }

    unsetSelectedSourceData() {
        this.selectedSourceDataState.next(null);
    }

    getSelectedSourceData(): SelectedSourceData | null {
        return this.selectedSourceDataState.getValue();
    }

    setSelectedFeatures(newSelection: TileFeatureId[]) {
        const currentSelection = this.selectedFeaturesState.getValue();
        if (valuesEqual(currentSelection, newSelection)) {
            return false;
        }
        this.selectedFeaturesState.next(newSelection.map(feature => ({...feature})));
        this._replaceUrl = false;
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
            const longitude = CesiumMath.toDegrees(position.longitude);
            const latitude = CesiumMath.toDegrees(position.latitude);
            this.markedPositionState.next([longitude, latitude]);
        } else {
            this.markedPositionState.next([]);
        }
        if (!delayUpdate) {
            this._replaceUrl = false;
        }
    }

    mapLayerConfig(mapId: string, layerId: string, fallbackLevel: number): [boolean, number, boolean] {
        const conf = this.layersState.getValue().find(ml => ml[0] === `${mapId}/${layerId}`);
        if (conf !== undefined && conf[2]) {
            return [true, conf[1], conf[3]];
        }
        return [this.layersState.getValue().length === 0, fallbackLevel, false];
    }

    setMapLayerConfig(mapId: string, layerId: string, level: number, visible: boolean, tileBorders: boolean) {
        if (isSourceOrMetaData(layerId)) {
            return;
        }
        const mapLayerName = `${mapId}/${layerId}`;
        const layers = [...this.layersState.getValue()];
        const index = layers.findIndex(val => val[0] === mapLayerName);
        if (index !== -1) {
            layers[index] = [mapLayerName, level, visible, tileBorders];
        } else if (visible) {
            layers.push([mapLayerName, level, visible, tileBorders]);
        }
        this.layersState.next(layers);
    }

    setMapConfig(layerParams: {
        mapId: string,
        layerId: string,
        level: number,
        visible: boolean,
        tileBorders: boolean
    }[]) {
        const layers = [...this.layersState.getValue()];
        layerParams.forEach(params => {
            if (!isSourceOrMetaData(params.layerId)) {
                const mapLayerName = `${params.mapId}/${params.layerId}`;
                const index = layers.findIndex(val => val[0] === mapLayerName);
                if (index !== -1) {
                    layers[index] = [mapLayerName, params.level, params.visible, params.tileBorders];
                } else if (params.visible) {
                    layers.push([mapLayerName, params.level, params.visible, params.tileBorders]);
                }
            }
        });
        this.layersState.next(layers);
    }

    setInitialMapLayers(layers: Array<[string, number, boolean, boolean]>) {
        if (this.layersState.getValue().length) {
            return;
        }
        const filtered = layers.filter(layer => !isSourceOrMetaData(layer[0]));
        if (!filtered.length) {
            return;
        }
        this.layersState.next(filtered);
    }

    setInitialStyles(styles: Map<string, { params: StyleParameters }>) {
        if (Object.keys(this.stylesState.getValue()).length) {
            return;
        }
        const initial: Record<string, StyleURLParameters> = {};
        styles.forEach((style, styleId) => {
            const params = style?.params;
            if (params) {
                initial[styleId] = this.styleParamsToURLParams(params);
            }
        });
        if (Object.keys(initial).length) {
            this.stylesState.next(initial);
        }
    }

    styleConfig(styleId: string): StyleParameters {
        const styles = this.stylesState.getValue();
        if (styles.hasOwnProperty(styleId)) {
            return this.styleURLParamsToParams(styles[styleId]);
        }
        return {
            visible: true,
            options: {}
        };
    }

    setStyleConfig(styleId: string, params: StyleParameters) {
        const styles = {...this.stylesState.getValue()};
        styles[styleId] = this.styleParamsToURLParams(params);
        this.stylesState.next(styles);
    }

    setCoordinatesAndTileIds(selectedOptions: Array<string>) {
        this.enabledCoordsTileIdsState.next([...selectedOptions]);
    }

    getCoordinatesAndTileIds() {
        return this.enabledCoordsTileIdsState.getValue();
    }

    resetSearchHistoryState() {
        this.searchState.next([]);
    }

    setSearchHistoryState(value: [number, string] | null, saveHistory: boolean = true) {
        const trimmed = value ? [value[0], value[1].trim()] as [number, string] : null;
        if (trimmed && saveHistory) {
            this.saveHistoryStateValue(trimmed);
        }
        this.searchState.next(trimmed ? trimmed : []);
        this._replaceUrl = false;
        this.lastSearchHistoryEntry.next(trimmed);
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
        const {origin, pathname} = window.location;
        window.location.href = origin + pathname;
    }

    setViewRectangle(rectangle: [number, number, number, number] | null) {
        this.viewRectangleState.next(rectangle);
    }

    onInspectionContainerResize(event: MouseEvent): void {
        const element = event.target as HTMLElement;
        if (!element.classList.contains("resizable-container")) {
            return;
        }
        if (!element.offsetWidth || !element.offsetHeight) {
            return;
        }
        this.baseFontSize = parseFloat(window.getComputedStyle(document.documentElement).fontSize);
        const currentEmWidth = element.offsetWidth / this.baseFontSize;
        if (currentEmWidth < 40.0) {
            this.inspectionContainerWidth = 40 * this.baseFontSize;
        } else {
            this.inspectionContainerWidth = element.offsetWidth;
        }
        this.inspectionContainerHeight = element.offsetHeight;

        const panel: PanelSizeState = [
            this.inspectionContainerWidth / this.baseFontSize,
            this.inspectionContainerHeight / this.baseFontSize
        ];
        this.panelState.next(panel);
    }

    pruneMapLayerConfig(mapItems: Array<MapInfoItem>): boolean {
        const mapLayerIds = new Set<string>();
        mapItems.forEach(mapItem => {
            mapItem.layers.keys().forEach(layerId => {
                mapLayerIds.add(`${mapItem.mapId}/${layerId}`);
            });
        });

        const filteredLayers = this.layersState.getValue().filter(layer => {
            return mapLayerIds.has(layer[0]) && !isSourceOrMetaData(layer[0]);
        });
        this.layersState.next(filteredLayers);
        return filteredLayers.length === 0;
    }

    private styleParamsToURLParams(params: StyleParameters): StyleURLParameters {
        return { v: params.visible, o: params.options };
    }

    private styleURLParamsToParams(params: StyleURLParameters): StyleParameters {
        return { visible: params.v, options: params.o };
    }
}
