import {Injectable, OnDestroy} from "@angular/core";
import {BehaviorSubject, Subject, Subscription, combineLatest, merge} from "rxjs";
import {debounceTime, distinctUntilChanged, map} from "rxjs/operators";
import {Cartesian3, Cartographic, CesiumMath, Camera} from "../integrations/cesium";
import {Params, Router} from "@angular/router";
import {Location} from "@angular/common";
import {SelectedSourceData} from "../inspection/inspection.service";
import {AppModeService} from "./app-mode.service";
import {MapInfoItem} from "../mapdata/map.service";
import {ErdblickStyle} from "../styledata/style.service";
import {AppState, CameraViewData} from "./appstate.model";

export const MAX_NUM_TILES_TO_LOAD = 2048;
export const MAX_NUM_TILES_TO_VISUALIZE = 512;

/**
 * Combination of a tile id and a feature id, which may be resolved
 * to a feature object.
 */
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
            if (typeof o !== "object") {
                return false;
            }
            for (let [key, value] of Object.entries(o)) {
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
        if (Array.isArray(fields) && Array.isArray(o) && o.length == fields.length) {
            for (let i = 0; i < fields.length; i++) {
                const valueType = typeof o[i] ;
                if (valueType  === "number" && fields[i] === "boolean" && (o[i] === 0 || o[i] === 1)) {
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

/** Set of parameter keys allowed in visualization-only mode */
const VISUALIZATION_ONLY_ALLOWED = new Set([
    'heading',
    'pitch',
    'roll',
    'lon',
    'lat',
    'alt',
    'osm',
    'osmOpacity',
    'tilesLoadLimit',
    'tilesVisualizeLimit',
    'styles',
    'layers'
]);

@Injectable({providedIn: 'root'})
export class AppStateService implements OnDestroy {

    private _replaceUrl: boolean = true;
    private appStatePool = new Map<string, AppState<any>>();
    private urlUpdateSubscription?: Subscription;
    private stateSubscriptions: Subscription[] = [];
    private _initialQueryParamsSet: boolean = false;
    
    // Atomized state members
    public readonly search: AppState<[number, string] | []>;
    public readonly marker: AppState<boolean>;
    public readonly markedPosition: AppState<number[]>;
    public readonly selected: AppState<TileFeatureId[]>;
    public readonly cameraView: AppState<CameraViewData>;
    public readonly mode2d: AppState<boolean>;
    public readonly viewRectangle: AppState<[number, number, number, number] | null>;
    public readonly osm: AppState<boolean>;
    public readonly osmOpacity: AppState<number>;
    public readonly layers: AppState<Array<[string, number, boolean, boolean]>>;
    public readonly styles: AppState<Record<string, StyleURLParameters>>;
    public readonly tilesLoadLimit: AppState<number>;
    public readonly tilesVisualizeLimit: AppState<number>;
    public readonly enabledCoordsTileIds: AppState<string[]>;
    public readonly selectedSourceData: AppState<any[]>;
    public readonly panel: AppState<number[]>;
    
    // Observable that emits when initialization is complete
    private ready = new Subject<void>();
    public ready$ = this.ready.asObservable();


    // Keep for compatibility
    cameraViewData: BehaviorSubject<{
        destination: Cartesian3,
        orientation: { heading: number, pitch: number, roll: number }
    }> =
        new BehaviorSubject<{
            destination: Cartesian3,
            orientation: { heading: number, pitch: number, roll: number }
        }>({
            destination: Cartesian3.fromDegrees(22.837473, 38.490817, 16000000),
            orientation: {
                heading: 6.0,
                pitch: -1.55,
                roll: 0.25,
            }
        });

    lastSearchHistoryEntry: BehaviorSubject<[number, string] | null> = new BehaviorSubject<[number, string] | null>(null);
    

    baseFontSize: number = 16;
    inspectionContainerWidth: number = 40;
    inspectionContainerHeight: number = (window.innerHeight - 10.5 * this.baseFontSize);

    private baseCameraMoveM = 100.0;
    private baseCameraZoomM = 100.0;
    private scalingFactor = 1;

    legalInfoDialogVisible: boolean = false;

    constructor(
        public appModeService: AppModeService,
        private router?: Router,
        private location?: Location
    ) {

        this.baseFontSize = parseFloat(window.getComputedStyle(document.documentElement).fontSize);

        // Initialize atomized states
        this.search = this.createState<[number, string] | []>(
            'search',
            val => JSON.parse(val),
            val => Array.isArray(val) && (val.length === 0 || (val.length === 2 && typeof val[0] === 'number' && typeof val[1] === 'string')),
            [],
            this.shouldIncludeInUrl('search') ? 'search' : ''
        );
        
        this.marker = this.createState<boolean>(
            'marker',
            val => val === 'true' || val === '1',
            val => typeof val === 'boolean',
            false,
            this.shouldIncludeInUrl('marker') ? 'marker' : ''
        );
        
        this.markedPosition = this.createState<number[]>(
            'markedPosition',
            val => JSON.parse(val),
            val => Array.isArray(val) && val.every(item => typeof item === 'number'),
            [],
            this.shouldIncludeInUrl('markedPosition') ? 'markedPosition' : ''
        );
        
        this.selected = this.createState<TileFeatureId[]>(
            'selected',
            val => JSON.parse(val),
            val => Array.isArray(val) && val.every(validateObjectsAndTypes({mapTileKey: "string", featureId: "string"})),
            [],
            this.shouldIncludeInUrl('selected') ? 'selected' : ''
        );
        
        this.cameraView = this.createState<CameraViewData>(
            'cameraView',
            val => this.parseCameraFromUrl(val),
            val => this.validateCameraData(val),
            {
                lon: 22.837473,
                lat: 38.490817,
                alt: 16000000,
                heading: 6.0,
                pitch: -1.55,
                roll: 0.25
            },
            '',  // Special handling for camera URL params
            true  // Form encoded
        );
        
        this.mode2d = this.createState<boolean>(
            'mode2d',
            val => val === 'true' || val === '1',
            val => typeof val === 'boolean',
            false,
            this.shouldIncludeInUrl('mode2d') ? 'mode2d' : ''
        );
        
        this.viewRectangle = this.createState<[number, number, number, number] | null>(
            'viewRectangle',
            val => val === 'null' ? null : JSON.parse(val),
            val => val === null || (Array.isArray(val) && val.length === 4 && val.every(v => typeof v === 'number')),
            null,
            this.shouldIncludeInUrl('viewRectangle') ? 'viewRectangle' : ''
        );
        
        this.osm = this.createState<boolean>(
            'osm',
            val => val === 'true' || val === '1',
            val => typeof val === 'boolean',
            true,
            this.shouldIncludeInUrl('osm') ? 'osm' : ''
        );
        
        this.osmOpacity = this.createState<number>(
            'osmOpacity',
            Number,
            val => typeof val === 'number' && !isNaN(val) && val >= 0 && val <= 100,
            30,
            this.shouldIncludeInUrl('osmOpacity') ? 'osmOpacity' : ''
        );
        
        this.layers = this.createState<Array<[string, number, boolean, boolean]>>(
            'layers',
            val => JSON.parse(val),
            val => Array.isArray(val) && val.every(validateObjectsAndTypes(["string", "number", "boolean", "boolean"])),
            [],
            this.shouldIncludeInUrl('layers') ? 'layers' : ''
        );
        
        this.styles = this.createState<Record<string, StyleURLParameters>>(
            'styles',
            val => JSON.parse(val),
            val => {
                return typeof val === "object" && Object.entries(val as Record<string, StyleURLParameters>).every(
                    ([_, v]) => validateObjectsAndTypes({v: "boolean", o: "object"})(v));
            },
            {},
            this.shouldIncludeInUrl('styles') ? 'styles' : ''
        );
        
        this.tilesLoadLimit = this.createState<number>(
            'tilesLoadLimit',
            Number,
            val => typeof val === 'number' && !isNaN(val) && val >= 0,
            MAX_NUM_TILES_TO_LOAD,
            this.shouldIncludeInUrl('tilesLoadLimit') ? 'tilesLoadLimit' : ''
        );
        
        this.tilesVisualizeLimit = this.createState<number>(
            'tilesVisualizeLimit',
            Number,
            val => typeof val === 'number' && !isNaN(val) && val >= 0,
            MAX_NUM_TILES_TO_VISUALIZE,
            this.shouldIncludeInUrl('tilesVisualizeLimit') ? 'tilesVisualizeLimit' : ''
        );
        
        this.enabledCoordsTileIds = this.createState<string[]>(
            'enabledCoordsTileIds',
            val => JSON.parse(val),
            val => Array.isArray(val) && val.every(item => typeof item === 'string'),
            ["WGS84"],
            ''  // Not a URL parameter
        );
        
        this.selectedSourceData = this.createState<any[]>(
            'selectedSourceData',
            val => JSON.parse(val),
            Array.isArray,
            [],
            this.shouldIncludeInUrl('selectedSourceData') ? 'selectedSourceData' : ''
        );
        
        this.panel = this.createState<number[]>(
            'panel',
            val => JSON.parse(val),
            val => Array.isArray(val) && (!val.length || val.length == 2 && val.every(item => typeof item === 'number')),
            [],
            this.shouldIncludeInUrl('panel') ? 'panel' : ''
        );

        
        // Setup URL synchronization if router is available
        if (this.router) {
            this.setupUrlSync();
        }
        
        // Load from local storage
        this.loadFromLocalStorage();

        // Subscribe to camera changes for scaling factor
        this.cameraView.subscribe(camera => {
            if (camera) {
                this.scalingFactor = Math.pow(camera.alt / 1000, 1.1) / 2;
                this.saveParameters();
            }
        });
    }

    // Helper method to create AppState instances
    private createState<T>(
        name: string,
        converter: (val: string) => T,
        validator: (val: T) => boolean,
        defaultValue: T,
        urlParamName: string = '',
        urlFormEncoded: boolean = false
    ): AppState<T> {
        return new AppState<T>(
            this.appStatePool,
            converter,
            validator,
            defaultValue,
            name,
            urlParamName,
            urlFormEncoded
        );
    }

    // Check if parameter should be included in URL based on mode
    private shouldIncludeInUrl(key: string): boolean {
        // In visualization-only mode, only allow specific parameters
        if (this.appModeService.isVisualizationOnly) {
            return VISUALIZATION_ONLY_ALLOWED.has(key);
        }
        // In normal mode, allow all parameters except enabledCoordsTileIds
        return key !== 'enabledCoordsTileIds';
    }

    // Parse camera data from URL parameters  
    private parseCameraFromUrl(val: string): CameraViewData {
        const parsed = JSON.parse(val);
        return {
            lon: parsed.lon || 22.837473,
            lat: parsed.lat || 38.490817,
            alt: parsed.alt || 16000000,
            heading: parsed.heading || 6.0,
            pitch: parsed.pitch || -1.55,
            roll: parsed.roll || 0.25
        };
    }

    // Validate camera data
    private validateCameraData(val: any): boolean {
        return val && 
            typeof val.lon === 'number' && !isNaN(val.lon) &&
            typeof val.lat === 'number' && !isNaN(val.lat) &&
            typeof val.alt === 'number' && !isNaN(val.alt) &&
            typeof val.heading === 'number' && !isNaN(val.heading) &&
            typeof val.pitch === 'number' && !isNaN(val.pitch) &&
            typeof val.roll === 'number' && !isNaN(val.roll);
    }


    // Setup URL synchronization
    private setupUrlSync() {
        if (!this.router) return;
        
        // Subscribe to state changes that should update URL
        const urlStates = Array.from(this.appStatePool.values())
            .filter(state => state.urlParamName || state.urlFormEncoded);
        
        this.urlUpdateSubscription = merge(...urlStates.map(state => 
            state.pipe(
                debounceTime(100),
                distinctUntilChanged()
            )
        )).subscribe(() => {
            if (this._initialQueryParamsSet) {
                this.updateUrl();
            }
        });
    }

    // Update URL with current state
    private updateUrl() {
        if (!this.router) return;
        
        const params: Record<string, string> = {};
        
        // Handle camera parameters specially - form encode them
        const camera = this.cameraView.getValue();
        if (this.shouldIncludeInUrl('heading')) params['heading'] = String(camera.heading);
        if (this.shouldIncludeInUrl('pitch')) params['pitch'] = String(camera.pitch);
        if (this.shouldIncludeInUrl('roll')) params['roll'] = String(camera.roll);
        if (this.shouldIncludeInUrl('lon')) params['lon'] = String(camera.lon);
        if (this.shouldIncludeInUrl('lat')) params['lat'] = String(camera.lat);
        if (this.shouldIncludeInUrl('alt')) params['alt'] = String(camera.alt);
        
        // Handle all other states
        for (const [name, state] of this.appStatePool.entries()) {
            if (name === 'cameraView') continue; // Already handled above
            
            if (state.urlParamName) {
                const urlValue = state.toUrlValue();
                if (urlValue !== null) {
                    params[state.urlParamName] = urlValue;
                }
            }
        }
        
        this.router.navigate([], {
            queryParams: params,
            queryParamsHandling: 'merge',
            replaceUrl: this._replaceUrl
        });
        this._replaceUrl = true;
    }


    // Load state from local storage
    private loadFromLocalStorage() {
        const stored = localStorage.getItem('erdblickParameters');
        if (stored) {
            try {
                const parsed = JSON.parse(stored);
                
                // Load camera state
                if (parsed.lon !== undefined && parsed.lat !== undefined) {
                    const cameraData = {
                        lon: parsed.lon,
                        lat: parsed.lat,
                        alt: parsed.alt || 16000000,
                        heading: parsed.heading || 6.0,
                        pitch: parsed.pitch || -1.55,
                        roll: parsed.roll || 0.25
                    };
                    if (this.validateCameraData(cameraData)) {
                        this.cameraView.next(cameraData);
                    }
                }
                
                // Load other states
                for (const [key, state] of this.appStatePool.entries()) {
                    if (key === 'cameraView') continue;
                    
                    if (parsed.hasOwnProperty(key)) {
                        // Use the state's own validator
                        try {
                            state.next(parsed[key]);
                        } catch (e) {
                            console.warn(`Failed to load state ${key} from localStorage:`, e);
                        }
                    }
                }
            } catch (e) {
                console.warn('Failed to load parameters from local storage:', e);
            }
        }
    }

    ngOnDestroy() {
        // Clean up subscriptions
        if (this.urlUpdateSubscription) {
            this.urlUpdateSubscription.unsubscribe();
        }
        this.stateSubscriptions.forEach(sub => sub.unsubscribe());
    }

    get cameraMoveUnits() {
        return this.baseCameraMoveM * this.scalingFactor / 75000;
    }

    get cameraZoomUnits() {
        return this.baseCameraZoomM * this.scalingFactor;
    }

    get replaceUrl() {
        const currentValue = this._replaceUrl;
        this._replaceUrl = true;
        return currentValue;
    }


    private isSourceOrMetaData(mapLayerNameOrLayerId: string): boolean {
        return mapLayerNameOrLayerId.includes('/SourceData-') ||
            mapLayerNameOrLayerId.includes('/Metadata-');
    }

    public setSelectedSourceData(selection: SelectedSourceData) {
        this.selectedSourceData.next([
            selection.tileId,
            selection.layerId,
            selection.mapId,
            selection.address ? selection.address.toString() : "",
            selection.featureIds ? selection.featureIds : "",
        ]);
    }

    public unsetSelectedSourceData() {
        this.selectedSourceData.next([]);
    }

    public getSelectedSourceData(): SelectedSourceData | null {
        const sd = this.selectedSourceData.getValue();
        if (!sd || !sd.length)
            return null;

        return {
            tileId: sd[0],
            layerId: sd[1],
            mapId: sd[2],
            address: BigInt(sd[3] || '0'),
            featureIds: sd[4],
        };
    }

    setInitialMapLayers(layers: Array<[string, number, boolean, boolean]>) {
        // Only set map layers, if there are no configured values yet.
        if (this.layers.getValue().length) {
            return;
        }
        this.layers.next(layers.filter(l => !this.isSourceOrMetaData(l[0])));
    }

    setInitialStyles(styles: Map<string, ErdblickStyle>) {
        // In visualization-only mode, ignore style updates
        if (this.appModeService.isVisualizationOnly) {
            return;
        }

        this.styles.next(Object.fromEntries([...styles.entries()].map(([k, v]) =>
            [k, this.styleParamsToURLParams(v.params)])));
    }

    setSelectedFeatures(newSelection: TileFeatureId[]) {
        const currentSelection = this.selected.getValue();
        if (currentSelection.length == newSelection.length) {
            let selectedFeaturesAreSame = true;
            for (let i = 0; i < currentSelection.length; ++i) {
                const a = currentSelection[i];
                const b = newSelection[i];
                if (a.featureId != b.featureId || a.mapTileKey != b.mapTileKey) {
                    selectedFeaturesAreSame = false;
                    break;
                }
            }

            if (selectedFeaturesAreSame) {
                return false;
            }
        }

        this._replaceUrl = false;
        this.selected.next(newSelection);
        return true;
    }

    setMarkerState(enabled: boolean) {
        this.marker.next(enabled);
        if (!enabled) {
            this.setMarkerPosition(null);
        }
    }

    setMarkerPosition(position: Cartographic | null, delayUpdate: boolean = false) {
        if (position) {
            const longitude = CesiumMath.toDegrees(position.longitude);
            const latitude = CesiumMath.toDegrees(position.latitude);
            this.markedPosition.next([longitude, latitude]);
        } else {
            this.markedPosition.next([]);
        }
        if (!delayUpdate) {
            this._replaceUrl = false;
        }
    }

    mapLayerConfig(mapId: string, layerId: string, fallbackLevel: number): [boolean, number, boolean] {
        const layers = this.layers.getValue();
        const conf = layers.find(ml => ml[0] == mapId + "/" + layerId);
        if (conf !== undefined && conf[2]) {
            return [true, conf[1], conf[3]];
        }
        return [!layers.length, fallbackLevel, false];
    }

    setMapLayerConfig(mapId: string, layerId: string, level: number, visible: boolean, tileBorders: boolean) {
        if (this.isSourceOrMetaData(layerId)) {
            return;
        }
        const mapLayerName = mapId + "/" + layerId;
        const currentLayers = [...this.layers.getValue()];  // Create a copy
        let conf = currentLayers.find(val => val[0] == mapLayerName);
        if (conf !== undefined) {
            conf[1] = level;
            conf[2] = visible;
            conf[3] = tileBorders;
        } else if (visible) {
            currentLayers.push([mapLayerName, level, visible, tileBorders]);
        }
        this.layers.next(currentLayers);
    }

    setMapConfig(layerParams: {
        mapId: string,
        layerId: string,
        level: number,
        visible: boolean,
        tileBorders: boolean
    }[]) {
        const currentLayers = [...this.layers.getValue()];
        layerParams.forEach(params => {
            if (!this.isSourceOrMetaData(params.layerId)) {
                const mapLayerName = params.mapId + "/" + params.layerId;
                let conf = currentLayers.find(
                    val => val[0] == mapLayerName
                );
                if (conf !== undefined) {
                    conf[1] = params.level;
                    conf[2] = params.visible;
                    conf[3] = params.tileBorders;
                } else if (params.visible) {
                    currentLayers.push([mapLayerName, params.level, params.visible, params.tileBorders]);
                }
            }
        });
        this.layers.next(currentLayers);
    }

    styleConfig(styleId: string): StyleParameters {
        const styles = this.styles.getValue();
        if (styles.hasOwnProperty(styleId)) {
            return this.styleURLParamsToParams(styles[styleId]);
        }
        return {
            visible: true,
            options: {}
        };
    }

    setStyleConfig(styleId: string, params: StyleParameters) {
        const currentStyles = {...this.styles.getValue()};
        currentStyles[styleId] = this.styleParamsToURLParams(params);
        this.styles.next(currentStyles);
    }

    setCameraState(camera: Camera) {
        const currentPositionCartographic = Cartographic.fromCartesian(camera.position);
        const cameraData: CameraViewData = {
            lon: CesiumMath.toDegrees(currentPositionCartographic.longitude),
            lat: CesiumMath.toDegrees(currentPositionCartographic.latitude),
            alt: currentPositionCartographic.height,
            heading: camera.heading,
            pitch: camera.pitch,
            roll: camera.roll
        };
        this.cameraView.next(cameraData);
        this.setView(
            Cartesian3.fromDegrees(cameraData.lon, cameraData.lat, cameraData.alt),
            {
                heading: cameraData.heading,
                pitch: cameraData.pitch,
                roll: cameraData.roll
            }
        );
    }

    set2DCameraState(camera: Camera) {
        // In 2D mode, store the view rectangle AND altitude for proper mode switching
        const viewRect = camera.computeViewRectangle();
        const currentPositionCartographic = Cartographic.fromCartesian(camera.position);
        
        let cameraData = this.cameraView.getValue();

        if (viewRect) {
            this.viewRectangle.next([
                CesiumMath.toDegrees(viewRect.west),
                CesiumMath.toDegrees(viewRect.south),
                CesiumMath.toDegrees(viewRect.east),
                CesiumMath.toDegrees(viewRect.north)
            ]);
            // Update center position for compatibility
            const center = Cartographic.fromRadians(
                (viewRect.west + viewRect.east) / 2,
                (viewRect.north + viewRect.south) / 2
            );
            cameraData = {
                ...cameraData,
                lon: CesiumMath.toDegrees(center.longitude),
                lat: CesiumMath.toDegrees(center.latitude),
                alt: currentPositionCartographic.height,
                heading: camera.heading,
                pitch: camera.pitch,
                roll: camera.roll
            };
        } else {
            // Fallback if view rectangle can't be computed
            cameraData = {
                ...cameraData,
                lon: CesiumMath.toDegrees(currentPositionCartographic.longitude),
                lat: CesiumMath.toDegrees(currentPositionCartographic.latitude),
                alt: currentPositionCartographic.height,
                heading: camera.heading,
                pitch: camera.pitch,
                roll: camera.roll
            };
        }

        this.cameraView.next(cameraData);
    }

    setCameraMode(isEnabled: boolean) {
        this.mode2d.next(isEnabled);
    }


    parseAndApplyQueryParams(params: Params) {
        // Handle camera parameters specially - they are form-encoded
        if (this.hasCameraParams(params)) {
            const cameraData: CameraViewData = {
                lon: params['lon'] ? Number(params['lon']) : 22.837473,
                lat: params['lat'] ? Number(params['lat']) : 38.490817,
                alt: params['alt'] ? Number(params['alt']) : 16000000,
                heading: params['heading'] ? Number(params['heading']) : 6.0,
                pitch: params['pitch'] ? Number(params['pitch']) : -1.55,
                roll: params['roll'] ? Number(params['roll']) : 0.25
            };
            if (this.validateCameraData(cameraData)) {
                this.cameraView.next(cameraData);
                
                if (!this._initialQueryParamsSet) {
                    this.setView(
                        Cartesian3.fromDegrees(cameraData.lon, cameraData.lat, cameraData.alt),
                        {
                            heading: cameraData.heading,
                            pitch: cameraData.pitch,
                            roll: cameraData.roll
                        }
                    );
                }
            }
        }

        // Handle all other parameters using the atomized states
        for (const [key, value] of Object.entries(params)) {
            // Skip camera-related individual params as we handle them as a group
            if (['lon', 'lat', 'alt', 'heading', 'pitch', 'roll'].includes(key)) {
                continue;
            }
            
            const stateName = this.getStateNameForParam(key);
            const state = this.appStatePool.get(stateName);
            
            if (state) {
                // Handle special case for styles (object merge)
                if (key === 'styles' && typeof value === 'string') {
                    try {
                        const parsedStyles = JSON.parse(value);
                        if (typeof parsedStyles === 'object' && !Array.isArray(parsedStyles)) {
                            const currentStyles = this.styles.getValue();
                            const mergedStyles = {...currentStyles};
                            for (const [entryKey, entryValue] of Object.entries(parsedStyles)) {
                                mergedStyles[entryKey] = entryValue as StyleURLParameters;
                            }
                            this.styles.next(mergedStyles);
                        }
                    } catch (e) {
                        console.warn(`Failed to parse styles parameter:`, e);
                        }
                    } else {
                    state.parseFromUrl(value);
                }
            }
        }

        // Filter layers to remove source/metadata layers
        const currentLayers = this.layers.getValue();
        if (Array.isArray(currentLayers)) {
            const filtered = currentLayers.filter(l => 
                Array.isArray(l) && typeof l[0] === 'string' && !this.isSourceOrMetaData(l[0])
            );
            if (filtered.length !== currentLayers.length) {
                this.layers.next(filtered);
            }
        }

        this._initialQueryParamsSet = true;
        
        // Emit ready signal for subscribers waiting for initialization
        this.ready.next();
    }

    // Helper to check if camera parameters exist in query params
    private hasCameraParams(params: Params): boolean {
        return params['lon'] || params['lat'] || params['alt'] || 
               params['heading'] || params['pitch'] || params['roll'];
    }

    // Map parameter names to state names
    private getStateNameForParam(paramName: string): string {
        const mapping: Record<string, string> = {
            'search': 'search',
            'marker': 'marker',
            'markedPosition': 'markedPosition',
            'selected': 'selected',
            'mode2d': 'mode2d',
            'viewRectangle': 'viewRectangle',
            'osm': 'osm',
            'osmOpacity': 'osmOpacity',
            'layers': 'layers',
            'styles': 'styles',
            'tilesLoadLimit': 'tilesLoadLimit',
            'tilesVisualizeLimit': 'tilesVisualizeLimit',
            'enabledCoordsTileIds': 'enabledCoordsTileIds',
            'selectedSourceData': 'selectedSourceData',
            'panel': 'panel'
        };
        return mapping[paramName] || paramName;
    }

    resetStorage() {
        localStorage.removeItem('erdblickParameters');
        localStorage.removeItem('searchHistory');
        const {origin, pathname} = window.location;
        window.location.href = origin + pathname;
    }

    private saveParameters() {
        // Save all state values to localStorage
        const camera = this.cameraView.getValue();
        const params = {
            search: this.search.getValue(),
            marker: this.marker.getValue(),
            markedPosition: this.markedPosition.getValue(),
            selected: this.selected.getValue(),
            heading: camera.heading,
            pitch: camera.pitch,
            roll: camera.roll,
            lon: camera.lon,
            lat: camera.lat,
            alt: camera.alt,
            mode2d: this.mode2d.getValue(),
            viewRectangle: this.viewRectangle.getValue(),
            osm: this.osm.getValue(),
            osmOpacity: this.osmOpacity.getValue(),
            layers: this.layers.getValue(),
            styles: this.styles.getValue(),
            tilesLoadLimit: this.tilesLoadLimit.getValue(),
            tilesVisualizeLimit: this.tilesVisualizeLimit.getValue(),
            enabledCoordsTileIds: this.enabledCoordsTileIds.getValue(),
            selectedSourceData: this.selectedSourceData.getValue(),
            panel: this.panel.getValue()
        };
        localStorage.setItem('erdblickParameters', JSON.stringify(params));
    }

    setView(destination: Cartesian3, orientation: { heading: number, pitch: number, roll: number }) {
        // Update both the legacy cameraViewData and the new atomized state
        this.cameraViewData.next({
            destination: destination,
            orientation: orientation
        });
        
        // Also update the atomized camera state if destination changed
        const cartographic = Cartographic.fromCartesian(destination);
        const currentCamera = this.cameraView.getValue();
        const newCameraData: CameraViewData = {
            lon: CesiumMath.toDegrees(cartographic.longitude),
            lat: CesiumMath.toDegrees(cartographic.latitude),
            alt: cartographic.height,
            heading: orientation.heading,
            pitch: orientation.pitch,
            roll: orientation.roll
        };
        
        // Only update if values actually changed to avoid unnecessary emissions
        if (JSON.stringify(currentCamera) !== JSON.stringify(newCameraData)) {
            this.cameraView.next(newCameraData);
        }
    }

    getCameraOrientation() {
        return this.cameraViewData.getValue().orientation;
    }

    getCameraPosition() {
        return this.cameraViewData.getValue().destination;
    }

    setCoordinatesAndTileIds(selectedOptions: Array<string>) {
        this.enabledCoordsTileIds.next(selectedOptions);
    }

    getCoordinatesAndTileIds() {
        return this.enabledCoordsTileIds.getValue();
    }


    resetSearchHistoryState() {
        this.search.next([]);
    }

    setSearchHistoryState(value: [number, string] | null, saveHistory: boolean = true) {
        if (value) {
            value[1] = value[1].trim();
            if (saveHistory) {
                this.saveHistoryStateValue(value);
            }
        }
        this._replaceUrl = false;
        this.search.next(value ? value : []);
        this.lastSearchHistoryEntry.next(value);
    }

    private saveHistoryStateValue(value: [number, string]) {
        const searchHistoryString = localStorage.getItem("searchHistory");
        if (searchHistoryString) {
            let searchHistory = JSON.parse(searchHistoryString) as Array<[number, string]>;
            searchHistory = searchHistory.filter((entry: [number, string]) => !(entry[0] == value[0] && entry[1] == value[1]));
            searchHistory.unshift(value);
            let ldiff = searchHistory.length - 100;
            while (ldiff > 0) {
                searchHistory.pop();
                ldiff -= 1;
            }
            localStorage.setItem("searchHistory", JSON.stringify(searchHistory));
        } else {
            localStorage.setItem("searchHistory", JSON.stringify(value));
        }
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

        this.panel.next([
            this.inspectionContainerWidth / this.baseFontSize,
            this.inspectionContainerHeight / this.baseFontSize
        ]);
    }

    pruneMapLayerConfig(mapItems: Array<MapInfoItem>): boolean {
        const mapLayerIds = new Set<string>();
        mapItems.forEach(mapItem => {
            mapItem.layers.keys().forEach(layerId => {
                mapLayerIds.add(`${mapItem.mapId}/${layerId}`);
            });
        });

        const currentLayers = this.layers.getValue();
        const filteredLayers = currentLayers.filter(layer => {
            return mapLayerIds.has(layer[0]) && !this.isSourceOrMetaData(layer[0]);
        });
        
        if (filteredLayers.length !== currentLayers.length) {
            this.layers.next(filteredLayers);
        }
        
        const hasLayersAfterPruning = filteredLayers.length > 0;
        return !hasLayersAfterPruning; // Need to reinitialise the layers if none configured anymore
    }

    private styleParamsToURLParams(params: StyleParameters): StyleURLParameters {
        return { v: params.visible, o: params.options };
    }

    private styleURLParamsToParams(params: StyleURLParameters): StyleParameters{
        return { visible: params.v, options: params.o };
    }
}
