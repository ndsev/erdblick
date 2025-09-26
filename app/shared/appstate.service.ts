import {Injectable} from "@angular/core";
import {NavigationEnd, Params, Router} from "@angular/router";
import {Subject, Subscription, skip, ReplaySubject} from "rxjs";
import {filter} from "rxjs/operators";
import {Cartesian3, Cartographic, CesiumMath, Camera} from "../integrations/cesium";
import {SelectedSourceData} from "../inspection/inspection.service";
import {AppModeService} from "./app-mode.service";
import {MapInfoItem} from "../mapdata/map.service";
import {AppState, AppStateOptions, AppStateUrlCodec, createSimpleUrlCodec, simpleStringify} from "./app-state";

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

interface LegacyParametersPayload extends Record<string, any> {
    lon?: number;
    lat?: number;
    alt?: number;
    heading?: number;
    pitch?: number;
    roll?: number;
}

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

const CAMERA_PARAM_NAMES = ["lon", "lat", "alt", "heading", "pitch", "roll"] as const;

function parseBoolean(value: string): boolean {
    return value === "true" || value === "1";
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && !isNaN(value) && isFinite(value);
}

function toNumber(value: string): number | undefined {
    const parsed = Number(value);
    return isFinite(parsed) ? parsed : undefined;
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

function encodeCameraToQuery(view: CameraViewState): Record<string, string> {
    return {
        lon: view.destination.lon.toString(),
        lat: view.destination.lat.toString(),
        alt: view.destination.alt.toString(),
        heading: view.orientation.heading.toString(),
        pitch: view.orientation.pitch.toString(),
        roll: view.orientation.roll.toString(),
    };
}

function decodeCameraFromParams(params: Params): CameraViewState | undefined {
    const values: Partial<Record<typeof CAMERA_PARAM_NAMES[number], number>> = {};
    for (const key of CAMERA_PARAM_NAMES) {
        if (!params.hasOwnProperty(key)) {
            return undefined;
        }
        const rawValue = params[key];
        if (Array.isArray(rawValue)) {
            return undefined;
        }
        const parsed = toNumber(rawValue);
        if (parsed === undefined) {
            return undefined;
        }
        values[key] = parsed;
    }
    return {
        destination: {
            lon: values.lon!,
            lat: values.lat!,
            alt: values.alt!,
        },
        orientation: {
            heading: values.heading!,
            pitch: values.pitch!,
            roll: values.roll!,
        }
    };
}

const cameraUrlCodec: AppStateUrlCodec<CameraViewState> = {
    paramNames: [...CAMERA_PARAM_NAMES],
    formEncoding: true,
    encoder: encodeCameraToQuery,
    decoder: decodeCameraFromParams,
};

function isSourceOrMetaData(mapLayerNameOrLayerId: string): boolean {
    return mapLayerNameOrLayerId.includes('/SourceData-') ||
        mapLayerNameOrLayerId.includes('/Metadata-');
}

function parseBigInt(value: unknown): bigint | undefined {
    if (value === undefined || value === null || value === "") {
        return BigInt(0);
    }
    if (typeof value === 'bigint') {
        return value;
    }
    if (typeof value === 'boolean') {
        return value ? BigInt(1) : BigInt(0);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return undefined;
        }
        try {
            return BigInt(value);
        } catch (_error) {
            return undefined;
        }
    }
    if (typeof value === 'string') {
        if (value.trim() === "") {
            return BigInt(0);
        }
        try {
            return BigInt(value);
        } catch (_error) {
            return undefined;
        }
    }
    return undefined;
}

function normaliseSelectedSourceData(value: any): SelectedSourceData | null | undefined {
    if (value === null) {
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
    if (typeof value === "object" && value !== null) {
        const candidate = value as Partial<Record<'tileId' | 'layerId' | 'mapId' | 'address' | 'featureIds', unknown>>;
        const {tileId, layerId, mapId, address, featureIds} = candidate;
        if (typeof tileId === "number" && Number.isFinite(tileId) && typeof layerId === "string" && typeof mapId === "string") {
            return {
                tileId,
                layerId,
                mapId,
                address: parseBigInt(address),
                featureIds: featureIds !== undefined ? String(featureIds) : undefined,
            };
        }
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
        converter: raw => JSON.parse(raw),
        validator: val => Array.isArray(val) && (val.length === 0 || (val.length === 2 && typeof val[0] === 'number' && typeof val[1] === 'string')),
        url: {...createSimpleUrlCodec('search', undefined, raw => JSON.parse(raw)), includeInVisualizationOnly: false},
    });

    readonly markerState = this.createState<boolean>({
        name: 'marker',
        defaultValue: false,
        converter: parseBoolean,
        validator: val => typeof val === 'boolean',
        url: {...createSimpleUrlCodec('marker', value => value ? '1' : '0', parseBoolean), includeInVisualizationOnly: false},
    });

    readonly markedPositionState = this.createState<number[]>({
        name: 'markedPosition',
        defaultValue: [],
        converter: raw => JSON.parse(raw),
        validator: val => Array.isArray(val) && val.every(item => typeof item === 'number'),
        url: {...createSimpleUrlCodec('markedPosition', undefined, raw => JSON.parse(raw)), includeInVisualizationOnly: false},
    });

    readonly selectedFeaturesState = this.createState<TileFeatureId[]>({
        name: 'selected',
        defaultValue: [],
        converter: raw => JSON.parse(raw),
        validator: val => Array.isArray(val) && val.every(validateObjectsAndTypes({mapTileKey: "string", featureId: "string"})),
        url: {...createSimpleUrlCodec('selected', undefined, raw => JSON.parse(raw)), includeInVisualizationOnly: false},
    });

    readonly cameraViewData = this.createState<CameraViewState>({
        name: 'cameraView',
        defaultValue: {
            destination: {lon: 22.837473, lat: 38.490817, alt: 16000000},
            orientation: {heading: 6.0, pitch: -1.55, roll: 0.25},
        },
        validator: val => val !== null && typeof val === 'object',
        url: cameraUrlCodec,
    });

    readonly viewRectangleState = this.createState<[number, number, number, number] | null>({
        name: 'viewRectangle',
        defaultValue: null,
        converter: raw => raw === 'null' ? null : JSON.parse(raw),
        validator: val => val === null || (Array.isArray(val) && val.length === 4 && val.every(item => typeof item === 'number')),
        url: {...createSimpleUrlCodec('viewRectangle', undefined, raw => raw === 'null' ? null : JSON.parse(raw)), includeInVisualizationOnly: false},
    });

    readonly mode2dState = this.createState<boolean>({
        name: 'mode2d',
        defaultValue: false,
        converter: parseBoolean,
        validator: val => typeof val === 'boolean',
        url: {...createSimpleUrlCodec('mode2d', value => value ? '1' : '0', parseBoolean), includeInVisualizationOnly: false},
    });

    readonly osmEnabledState = this.createState<boolean>({
        name: 'osm',
        defaultValue: true,
        converter: parseBoolean,
        validator: val => typeof val === 'boolean',
        url: createSimpleUrlCodec('osm', value => value ? '1' : '0', parseBoolean),
    });

    readonly osmOpacityState = this.createState<number>({
        name: 'osmOpacity',
        defaultValue: 30,
        converter: value => Number(value),
        validator: val => typeof val === 'number' && !isNaN(val) && val >= 0 && val <= 100,
        url: createSimpleUrlCodec('osmOpacity', value => value.toString(), value => Number(value)),
    });

    readonly layersState = this.createState<Array<[string, number, boolean, boolean]>>({
        name: 'layers',
        defaultValue: [],
        converter: raw => JSON.parse(raw),
        validator: val => Array.isArray(val) && val.every(validateObjectsAndTypes(["string", "number", "boolean", "boolean"])),
        url: createSimpleUrlCodec('layers', undefined, raw => JSON.parse(raw)),
    });

    readonly stylesState = this.createState<Record<string, StyleURLParameters>>({
        name: 'styles',
        defaultValue: {},
        converter: raw => JSON.parse(raw),
        validator: val => typeof val === "object" && Object.entries(val as Record<string, StyleURLParameters>)
            .every(([_, v]) => validateObjectsAndTypes({v: "boolean", o: "object"})(v)),
        url: createSimpleUrlCodec('styles', undefined, raw => JSON.parse(raw)),
    });

    readonly tilesLoadLimitState = this.createState<number>({
        name: 'tilesLoadLimit',
        defaultValue: MAX_NUM_TILES_TO_LOAD,
        converter: value => Number(value),
        validator: val => typeof val === 'number' && !isNaN(val) && val >= 0,
        url: createSimpleUrlCodec('tilesLoadLimit', value => value.toString(), value => Number(value)),
    });

    readonly tilesVisualizeLimitState = this.createState<number>({
        name: 'tilesVisualizeLimit',
        defaultValue: MAX_NUM_TILES_TO_VISUALIZE,
        converter: value => Number(value),
        validator: val => typeof val === 'number' && !isNaN(val) && val >= 0,
        url: createSimpleUrlCodec('tilesVisualizeLimit', value => value.toString(), value => Number(value)),
    });

    readonly enabledCoordsTileIdsState = this.createState<string[]>({
        name: 'enabledCoordsTileIds',
        defaultValue: ["WGS84"],
        converter: raw => JSON.parse(raw),
        validator: val => Array.isArray(val) && val.every(item => typeof item === 'string'),
        persist: true,
        url: undefined,
    });

    readonly selectedSourceDataState = this.createState<SelectedSourceData | null>({
        name: 'selectedSourceData',
        defaultValue: null,
        validator: val => val === null || (typeof val.tileId === 'number' && typeof val.layerId === 'string' && typeof val.mapId === 'string'),
        storage: {
            serialize: value => encodeSelectedSourceData(value),
            deserialize: raw => decodeSelectedSourceData(raw),
        },
        url: {
            paramName: 'selectedSourceData',
            encoder: value => ({selectedSourceData: encodeSelectedSourceData(value)}),
            decoder: (params: Params) => {
                const raw = params['selectedSourceData'];
                if (typeof raw !== 'string') {
                    return undefined;
                }
                return decodeSelectedSourceData(raw);
            },
            includeInVisualizationOnly: false,
        },
    });

    readonly panelState = this.createState<PanelSizeState>({
        name: 'panel',
        defaultValue: [] as PanelSizeState,
        converter: raw => JSON.parse(raw) as PanelSizeState,
        validator: val => Array.isArray(val) && (val.length === 0 || (val.length === 2 && val.every(item => typeof item === 'number'))),
        url: {...createSimpleUrlCodec('panel', undefined, raw => JSON.parse(raw)), includeInVisualizationOnly: false},
    });

    readonly legalInfoDialogVisibleState = this.createState<boolean>({
        name: 'legalInfoDialogVisible',
        defaultValue: false,
        converter: parseBoolean,
        validator: val => typeof val === 'boolean',
        persist: false,
    });

    readonly lastSearchHistoryEntry = this.createState<[number, string] | null>({
        name: 'lastSearchHistoryEntry',
        defaultValue: null,
        converter: raw => raw === 'null' ? null : JSON.parse(raw),
        validator: val => val === null || (Array.isArray(val) && val.length === 2 && typeof val[0] === 'number' && typeof val[1] === 'string'),
        persist: false,
    });

    constructor(private readonly router: Router,
                private readonly appModeService: AppModeService) {
        this.baseFontSize = parseFloat(window.getComputedStyle(document.documentElement).fontSize);
        this.inspectionContainerWidth = 40 * this.baseFontSize;
        this.inspectionContainerHeight = window.innerHeight - 10.5 * this.baseFontSize;

        this.setupStateSubscriptions();
        this.hydrateFromLegacyStorage();
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
        const state = new AppState<T>(this.statePool, options);
        return state;
    }

    private setupStateSubscriptions() {
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

        if (state.storage) {
            this.pendingStorageSync = true;
        }

        if (state.url && state.url.encoder && (!this.appModeService.isVisualizationOnly || state.url.includeInVisualizationOnly !== false)) {
            this.pendingUrlSync = true;
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
            if (!state.storage) {
                continue;
            }
            const serialized = state.serialize();
            if (serialized === undefined) {
                continue;
            }
            try {
                localStorage.setItem(state.storage.key!, serialized);
            } catch (error) {
                console.error(`[AppStateService] Failed to persist state '${state.name}'`, error);
            }
        }
    }

    private syncUrl(): void {
        const params: Record<string, string> = {};
        for (const state of this.statePool.values()) {
            const url = state.url;
            if (!url || !url.encoder) {
                continue;
            }
            if (this.appModeService.isVisualizationOnly && url.includeInVisualizationOnly === false) {
                continue;
            }
            const encoded = url.encoder(state.getValue() as any);
            Object.assign(params, encoded);
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

    private hydrateFromStorage(): void {
        this.withHydration(() => {
            for (const state of this.statePool.values()) {
                if (!state.storage) {
                    continue;
                }
                const raw = localStorage.getItem(state.storage.key!);
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

    private hydrateFromLegacyStorage(): void {
        const legacyRaw = localStorage.getItem('erdblickParameters');
        if (!legacyRaw) {
            return;
        }
        let legacy: LegacyParametersPayload | null = null;
        try {
            legacy = JSON.parse(legacyRaw) as LegacyParametersPayload;
        } catch (error) {
            console.warn('[AppStateService] Failed to parse legacy parameter payload', error);
        }
        if (!legacy || typeof legacy !== 'object') {
            localStorage.removeItem('erdblickParameters');
            return;
        }
        this.withHydration(() => {
            for (const state of this.statePool.values()) {
                if (state === this.cameraViewData) {
                    continue;
                }
                if (!legacy!.hasOwnProperty(state.name)) {
                    continue;
                }
                const rawValue = legacy![state.name];
                let value: any = rawValue;
                if (state === this.selectedSourceDataState) {
                    value = normaliseSelectedSourceData(rawValue);
                }
                if (value === undefined) {
                    this.logRejectedValue(state.name, 'legacy', rawValue);
                    continue;
                }
                if (!state.validate(value)) {
                    this.logRejectedValue(state.name, 'legacy', value);
                    continue;
                }
                this.applyStateValue(state, value);
            }
            const camera = this.buildCameraFromLegacy(legacy);
            if (camera) {
                this.applyStateValue(this.cameraViewData, camera);
            }
        });
        localStorage.removeItem('erdblickParameters');
    }

    private hydrateFromUrl(params: Params): void {
        for (const state of this.statePool.values()) {
            if (state === this.cameraViewData) {
                const cameraValue = this.readCameraViewFromParams(params);
                if (cameraValue) {
                    this.applyStateValue(this.cameraViewData, cameraValue);
                }
                continue;
            }
            const url = state.url;
            if (!url || (!url.paramName && !url.decoder)) {
                continue;
            }
            if (this.appModeService.isVisualizationOnly && url.includeInVisualizationOnly === false) {
                continue;
            }
            let value: any;
            if (url.decoder) {
                value = url.decoder(params);
            } else if (url.paramName && params.hasOwnProperty(url.paramName)) {
                const raw = params[url.paramName];
                if (typeof raw === 'string') {
                    value = state.convert(raw);
                }
            }
            if (value === undefined) {
                continue;
            }
            if (!state.validate(value)) {
                this.logRejectedValue(state.name, 'url', value);
                continue;
            }
            this.applyStateValue(state, value);
        }
    }

    private applyStateValue<T>(state: AppState<T>, value: T): void {
        if (valuesEqual(state.getValue(), value)) {
            return;
        }
        state.next(value);
    }

    private buildCameraFromLegacy(legacy: LegacyParametersPayload): CameraViewState | null {
        const lon = legacy.lon;
        const lat = legacy.lat;
        const alt = legacy.alt;
        const heading = legacy.heading;
        const pitch = legacy.pitch;
        const roll = legacy.roll;
        if ([lon, lat, alt, heading, pitch, roll].every(isFiniteNumber)) {
            return {
                destination: {lon: lon!, lat: lat!, alt: alt!},
                orientation: {heading: heading!, pitch: pitch!, roll: roll!},
            };
        }
        return null;
    }

    private readCameraViewFromParams(params: Params): CameraViewState | undefined {
        let hasValue = false;
        let invalid = false;
        const current = this.cameraViewData.getValue();
        const destination = {...current.destination};
        const orientation = {...current.orientation};

        const update = (key: typeof CAMERA_PARAM_NAMES[number], setter: (value: number) => void) => {
            const raw = params[key];
            if (raw === undefined) {
                return;
            }
            if (Array.isArray(raw)) {
                this.logRejectedValue('cameraView', 'url', raw);
                invalid = true;
                return;
            }
            const parsed = toNumber(raw);
            if (parsed === undefined) {
                this.logRejectedValue('cameraView', 'url', raw);
                invalid = true;
                return;
            }
            setter(parsed);
            hasValue = true;
        };

        update('lon', value => destination.lon = value);
        update('lat', value => destination.lat = value);
        update('alt', value => destination.alt = value);
        update('heading', value => orientation.heading = value);
        update('pitch', value => orientation.pitch = value);
        update('roll', value => orientation.roll = value);

        if (!hasValue || invalid) {
            return undefined;
        }

        return {destination, orientation};
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

    private logRejectedValue(stateName: string, source: 'url' | 'storage' | 'legacy' | 'runtime', raw: unknown): void {
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
            if (state.storage) {
                localStorage.removeItem(state.storage.key!);
            }
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
