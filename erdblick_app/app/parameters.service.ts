import {Injectable} from "@angular/core";
import {BehaviorSubject, Subject} from "rxjs";
import {Cartesian3, Cartographic, CesiumMath, Camera} from "./cesium";
import {Params} from "@angular/router";
import {SelectedSourceData} from "./inspection.service";
import {AppModeService} from "./app-mode.service";
import {MapInfoItem} from "./map.service";
import {ErdblickStyle} from "./style.service";

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
    options: Record<string, boolean>,
    showOptions: boolean,
}

export interface StyleURLParameters {
    v: boolean,
    optOn: boolean,
    o: Record<string, boolean>
}

interface ErdblickParameters extends Record<string, any> {
    search: [number, string] | [],
    marker: boolean,
    markedPosition: Array<number>,
    selected: TileFeatureId[],
    heading: number,
    pitch: number,
    roll: number,
    lon: number,
    lat: number,
    alt: number,
    mode2d: boolean,
    viewRectangle: [number, number, number, number] | null,  // [west, south, east, north] in degrees
    osm: boolean,
    osmOpacity: number,
    layers: Array<[string, number, boolean, boolean]>,
    styles: Record<string, StyleURLParameters>,
    tilesLoadLimit: number,
    tilesVisualizeLimit: number,
    enabledCoordsTileIds: Array<string>,
    selectedSourceData: Array<any>,
    panel: Array<number>
}

interface ParameterDescriptor {
    // Convert the setting to the correct type, e.g. Number.
    converter: (val: any) => any,
    // Check if the converted value is good, or the default must be used.
    validator: (val: any) => boolean,
    // Default value.
    default: any,
    // Include in the url
    urlParam: boolean
}

/** Function to create an object or array types validator given a key-typeof-value dictionary or a types array. */
function validateObjectsAndTypes(fields: Record<string, string> | Array<string>) {
    return (o: object | Array<any>) => {
        if (!Array.isArray(fields)) {
            if (typeof o !== "object") {
                return false;
            }
            for (let [key, value] of Object.entries(o)) {
                const valueType = typeof value;
                if (valueType === "number" && fields[key] === "boolean" && (value === 0 || value === 1)) {
                    continue;
                }
                if (valueType !== fields[key]) {
                    return false;
                }
            }
            return true;
        }
        if (Array.isArray(fields) && Array.isArray(o) && o.length == fields.length) {
            for (let i = 0; i < fields.length; i++) {
                const valueType = typeof o[i] ;
                if (valueType  === "number" && fields[i] === "boolean" && (o[i] === 0 || o[i] === 1)) {
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

const erdblickParameters: Record<string, ParameterDescriptor> = {
    search: {
        converter: val => JSON.parse(val),
        validator: val => Array.isArray(val) && (val.length === 0 || (val.length === 2 && typeof val[0] === 'number' && typeof val[1] === 'string')),
        default: [],
        urlParam: true
    },
    marker: {
        converter: val => val === 'true' || val === '1',
        validator: val => typeof val === 'boolean',
        default: false,
        urlParam: true
    },
    markedPosition: {
        converter: val => JSON.parse(val),
        validator: val => Array.isArray(val) && val.every(item => typeof item === 'number'),
        default: [],
        urlParam: true
    },
    selected: {
        converter: val => JSON.parse(val),
        validator: val => Array.isArray(val) && val.every(validateObjectsAndTypes({mapTileKey: "string", featureId: "string"})),
        default: [],
        urlParam: true
    },
    heading: {
        converter: Number,
        validator: val => typeof val === 'number' && !isNaN(val),
        default: 6.0,
        urlParam: true
    },
    pitch: {
        converter: Number,
        validator: val => typeof val === 'number' && !isNaN(val),
        default: -1.55,
        urlParam: true
    },
    roll: {
        converter: Number,
        validator: val => typeof val === 'number' && !isNaN(val),
        default: 0.25,
        urlParam: true
    },
    lon: {
        converter: Number,
        validator: val => typeof val === 'number' && !isNaN(val),
        default: 22.837473,
        urlParam: true
    },
    lat: {
        converter: Number,
        validator: val => typeof val === 'number' && !isNaN(val),
        default: 38.490817,
        urlParam: true
    },
    alt: {
        converter: Number,
        validator: val => typeof val === 'number' && !isNaN(val),
        default: 16000000,
        urlParam: true
    },
    mode2d: {
        converter: val => val === 'true' || val === '1',
        validator: val => typeof val === 'boolean',
        default: false,
        urlParam: true
    },
    viewRectangle: {
        converter: val => val === 'null' ? null : JSON.parse(val),
        validator: val => val === null || (Array.isArray(val) && val.length === 4 && val.every(v => typeof v === 'number')),
        default: null,
        urlParam: true
    },
    osmOpacity: {
        converter: Number,
        validator: val => typeof val === 'number' && !isNaN(val) && val >= 0 && val <= 100,
        default: 30,
        urlParam: true
    },
    osm: {
        converter: val => val === 'true' || val === '1',
        validator: val => typeof val === 'boolean',
        default: true,
        urlParam: true
    },
    layers: {
        converter: val => JSON.parse(val),
        validator: val => Array.isArray(val) && val.every(validateObjectsAndTypes(["string", "number", "boolean", "boolean"])),
        default: [],
        urlParam: true
    },
    styles: {
        converter: val => JSON.parse(val),
        validator: val => {
            return typeof val === "object" && Object.entries(val as Record<string, ErdblickParameters>).every(
                ([_, v]) => validateObjectsAndTypes({v: "boolean", optOn: "boolean", o: "object"})(v));
        },
        default: {},
        urlParam: true
    },
    tilesLoadLimit: {
        converter: Number,
        validator: val => typeof val === 'number' && !isNaN(val) && val >= 0,
        default: MAX_NUM_TILES_TO_LOAD,
        urlParam: true
    },
    tilesVisualizeLimit: {
        converter: Number,
        validator: val => typeof val === 'number' && !isNaN(val) && val >= 0,
        default: MAX_NUM_TILES_TO_VISUALIZE,
        urlParam: true
    },
    enabledCoordsTileIds: {
        converter: val => JSON.parse(val),
        validator: val => Array.isArray(val) && val.every(item => typeof item === 'string'),
        default: ["WGS84"],
        urlParam: false
    },
    selectedSourceData: {
        converter: val => JSON.parse(val),
        validator: Array.isArray,
        default: [],
        urlParam: true
    },
    panel: {
        converter: val => JSON.parse(val),
        validator: val => Array.isArray(val) && (!val.length || val.length == 2 && val.every(item => typeof item === 'number')),
        default: [],
        urlParam: true
    }
};

/** Set of parameter keys allowed in visualization-only mode */
// TODO: Reflect this in the parameter descriptors, instead
// of having a separate set.
// NOTE: Currently parameter access restrictions for visualization-only mode are maintained
// in this hardcoded set. Should be integrated into the parameter descriptor system for
// better maintainability and to avoid duplication.
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
export class ParametersService {

    private _replaceUrl: boolean = true;
    parameters: BehaviorSubject<ErdblickParameters>;
    initialQueryParamsSet: boolean = false;
    
    // Observable that emits when initialization is complete
    private ready = new Subject<void>();
    public ready$ = this.ready.asObservable();

    // Store filtered parameter descriptors based on mode
    private parameterDescriptors: Record<string, ParameterDescriptor>;

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

    constructor(appModeService: AppModeService) {
        // Filter parameter descriptors based on mode
        this.parameterDescriptors = appModeService.isVisualizationOnly
            ? Object.fromEntries(
                Object.entries(erdblickParameters)
                    .filter(([key]) => VISUALIZATION_ONLY_ALLOWED.has(key))
            )
            : erdblickParameters;

        this.baseFontSize = parseFloat(window.getComputedStyle(document.documentElement).fontSize);

        let parameters = this.loadSavedParameters();
        this.parameters = new BehaviorSubject<ErdblickParameters>(parameters!);
        this.saveParameters();
        this.parameters.subscribe(parameters => {
            if (parameters) {
                this.scalingFactor = Math.pow(parameters.alt / 1000, 1.1) / 2;
                this.saveParameters();
            }
        });
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

    p() {
        return this.parameters.getValue();
    }

    private isSourceOrMetaData(mapLayerNameOrLayerId: string): boolean {
        return mapLayerNameOrLayerId.includes('/SourceData-') ||
            mapLayerNameOrLayerId.includes('/Metadata-');
    }

    public setSelectedSourceData(selection: SelectedSourceData) {
        this.p().selectedSourceData = [
            selection.tileId,
            selection.layerId,
            selection.mapId,
            selection.address ? selection.address.toString() : "",
            selection.featureIds ? selection.featureIds : "",
        ];
        this.parameters.next(this.p());
    }

    public unsetSelectedSourceData() {
        this.p().selectedSourceData = [];
        this.parameters.next(this.p());
    }

    public getSelectedSourceData(): SelectedSourceData | null {
        const sd = this.p().selectedSourceData;
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
        if (this.p().layers.length) {
            return;
        }
        this.p().layers = layers.filter(l => !this.isSourceOrMetaData(l[0]));
        this.parameters.next(this.p());
    }

    setInitialStyles(styles: Map<string, ErdblickStyle>) {
        // In visualization-only mode, ignore style updates
        if (Object.keys(this.parameterDescriptors).length !== Object.keys(erdblickParameters).length) {
            return;
        }

        // Only set styles, if there are no configured values yet.
        if (!Object.entries(this.p().styles).length) {
            return;
        }
        this.p().styles = Object.fromEntries([...styles.entries()].map(([k, v]) =>
            [k, this.styleParamsToURLParams(v.params)]));
        this.parameters.next(this.p());
    }

    setSelectedFeatures(newSelection: TileFeatureId[]) {
        const currentSelection = this.p().selected;
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

        this.p().selected = newSelection;
        this._replaceUrl = false;
        this.parameters.next(this.p());
        return true;
    }

    setMarkerState(enabled: boolean) {
        this.p().marker = enabled;
        if (enabled) {
            this.parameters.next(this.p());
        } else {
            this.setMarkerPosition(null);
        }
    }

    setMarkerPosition(position: Cartographic | null, delayUpdate: boolean = false) {
        if (position) {
            const longitude = CesiumMath.toDegrees(position.longitude);
            const latitude = CesiumMath.toDegrees(position.latitude);
            this.p().markedPosition = [longitude, latitude];
        } else {
            this.p().markedPosition = [];
        }
        if (!delayUpdate) {
            this._replaceUrl = false;
            this.parameters.next(this.p());
        }
    }

    mapLayerConfig(mapId: string, layerId: string, fallbackLevel: number): [boolean, number, boolean] {
        const conf = this.p().layers.find(ml => ml[0] == mapId + "/" + layerId);
        if (conf !== undefined && conf[2]) {
            return [true, conf[1], conf[3]];
        }
        return [!this.p().layers.length, fallbackLevel, false];
    }

    setMapLayerConfig(mapId: string, layerId: string, level: number, visible: boolean, tileBorders: boolean) {
        if (this.isSourceOrMetaData(layerId)) {
            return;
        }
        const mapLayerName = mapId + "/" + layerId;
        let conf = this.p().layers.find(val => val[0] == mapLayerName);
        if (conf !== undefined) {
            conf[1] = level;
            conf[2] = visible;
            conf[3] = tileBorders;
        } else if (visible) {
            this.p().layers.push([mapLayerName, level, visible, tileBorders]);
        }
        this.parameters.next(this.p());
    }

    setMapConfig(layerParams: {
        mapId: string,
        layerId: string,
        level: number,
        visible: boolean,
        tileBorders: boolean
    }[]) {
        layerParams.forEach(params => {
            if (!this.isSourceOrMetaData(params.layerId)) {
                const mapLayerName = params.mapId + "/" + params.layerId;
                let conf = this.p().layers.find(
                    val => val[0] == mapLayerName
                );
                if (conf !== undefined) {
                    conf[1] = params.level;
                    conf[2] = params.visible;
                    conf[3] = params.tileBorders;
                } else if (params.visible) {
                    this.p().layers.push([mapLayerName, params.level, params.visible, params.tileBorders]);
                }
            }
        });
        this.parameters.next(this.p());
    }

    styleConfig(styleId: string): StyleParameters {
        if (this.p().styles.hasOwnProperty(styleId)) {
            return this.styleURLParamsToParams(this.p().styles[styleId]);
        }
        return {
            visible: !Object.entries(this.p().styles).length,
            options: {},
            showOptions: true,
        };
    }

    setStyleConfig(styleId: string, params: StyleParameters) {
        this.p().styles[styleId] = this.styleParamsToURLParams(params);
        this.parameters.next(this.p());
    }

    setCameraState(camera: Camera) {
        const currentPositionCartographic = Cartographic.fromCartesian(camera.position);
        this.p().lon = CesiumMath.toDegrees(currentPositionCartographic.longitude);
        this.p().lat = CesiumMath.toDegrees(currentPositionCartographic.latitude);
        this.p().alt = currentPositionCartographic.height;
        this.p().heading = camera.heading;
        this.p().pitch = camera.pitch;
        this.p().roll = camera.roll;
        this.parameters.next(this.p());
        this.setView(Cartesian3.fromDegrees(this.p().lon, this.p().lat, this.p().alt), {
            heading: this.p().heading,
            pitch: this.p().pitch,
            roll: this.p().roll
        });
    }

    set2DCameraState(camera: Camera) {
        // In 2D mode, store the view rectangle AND altitude for proper mode switching
        const viewRect = camera.computeViewRectangle();
        const currentPositionCartographic = Cartographic.fromCartesian(camera.position);

        if (viewRect) {
            this.p().viewRectangle = [
                CesiumMath.toDegrees(viewRect.west),
                CesiumMath.toDegrees(viewRect.south),
                CesiumMath.toDegrees(viewRect.east),
                CesiumMath.toDegrees(viewRect.north)
            ];
            // Update center position for compatibility
            const center = Cartographic.fromRadians(
                (viewRect.west + viewRect.east) / 2,
                (viewRect.north + viewRect.south) / 2
            );
            this.p().lon = CesiumMath.toDegrees(center.longitude);
            this.p().lat = CesiumMath.toDegrees(center.latitude);
        } else {
            // Fallback if view rectangle can't be computed
            this.p().lon = CesiumMath.toDegrees(currentPositionCartographic.longitude);
            this.p().lat = CesiumMath.toDegrees(currentPositionCartographic.latitude);
        }

        // CRITICAL: Store altitude in 2D mode for consistent mode switching
        this.p().alt = currentPositionCartographic.height;

        // Store 2D-specific camera orientation (always top-down view)
        this.p().heading = camera.heading;
        this.p().pitch = camera.pitch;
        this.p().roll = camera.roll;

        this.parameters.next(this.p());
    }

    setCameraMode(isEnabled: boolean) {
        this.p().mode2d = isEnabled;
        this.parameters.next(this.p());
    }

    loadSavedParameters(): ErdblickParameters | null {
        let parsedParameters: Record<string, any> = {};
        const parameters = localStorage.getItem('erdblickParameters');
        if (parameters) {
            parsedParameters = JSON.parse(parameters);
        }

        // First create an object with all default values from the full parameter set
        let defaultParameters = Object.keys(erdblickParameters).reduce((acc, key: string) => {
            acc[key] = erdblickParameters[key].default;
            return acc;
        }, {} as any);

        // Then override with valid values from the filtered parameter descriptors
        Object.keys(this.parameterDescriptors).forEach(key => {
            const descriptor = this.parameterDescriptors[key];
            if (parsedParameters.hasOwnProperty(key)) {
                const value = parsedParameters[key];
                if (descriptor.validator(value)) {
                    defaultParameters[key] = value;
                }
            }
        });

        return defaultParameters;
    }

    parseAndApplyQueryParams(params: Params) {
        let currentParameters = this.p();
        let updatedParameters: ErdblickParameters = {...currentParameters};

        Object.keys(this.parameterDescriptors).forEach(key => {
            const descriptor = this.parameterDescriptors[key];
            if (params.hasOwnProperty(key)) {
                try {
                    const value = descriptor.converter(params[key]);
                    if (descriptor.validator(value)) {
                        updatedParameters[key] = value;
                    } else {
                        console.warn(`Invalid query param ${params[key]} for ${key}, using default.`);
                        updatedParameters[key] = descriptor.default;
                    }
                } catch (e) {
                    console.warn(`Invalid query param  ${params[key]} for ${key}, using default.`);
                    updatedParameters[key] = descriptor.default;
                }
            }
        });

        if (Array.isArray(updatedParameters.layers)) {
            updatedParameters.layers = updatedParameters.layers.filter(l => Array.isArray(l) && typeof l[0] === 'string' && !this.isSourceOrMetaData(l[0]));
        }

        if (!this.initialQueryParamsSet) {
            this.setView(Cartesian3.fromDegrees(updatedParameters.lon, updatedParameters.lat, updatedParameters.alt), {
                heading: updatedParameters.heading,
                pitch: updatedParameters.pitch,
                roll: updatedParameters.roll
            });
        }

        this.parameters.next(updatedParameters);
        this.initialQueryParamsSet = true;
        
        // Emit ready signal for subscribers waiting for initialization
        this.ready.next();
    }

    resetStorage() {
        localStorage.removeItem('erdblickParameters');
        localStorage.removeItem('searchHistory');
        const {origin, pathname} = window.location;
        window.location.href = origin + pathname;
    }

    private saveParameters() {
        localStorage.setItem('erdblickParameters', JSON.stringify(this.p()));
    }

    setView(destination: Cartesian3, orientation: { heading: number, pitch: number, roll: number }) {
        this.cameraViewData.next({
            destination: destination,
            orientation: orientation
        });
    }

    getCameraOrientation() {
        return this.cameraViewData.getValue().orientation;
    }

    getCameraPosition() {
        return this.cameraViewData.getValue().destination;
    }

    setCoordinatesAndTileIds(selectedOptions: Array<string>) {
        this.p().enabledCoordsTileIds = selectedOptions;
        this.parameters.next(this.p());
    }

    getCoordinatesAndTileIds() {
        return this.p().enabledCoordsTileIds;
    }

    isUrlParameter(name: string) {
        if (this.parameterDescriptors.hasOwnProperty(name)) {
            return this.parameterDescriptors[name].urlParam;
        }
        return false;
    }

    resetSearchHistoryState() {
        this.p().search = [];
        this.parameters.next(this.p());
    }

    setSearchHistoryState(value: [number, string] | null, saveHistory: boolean = true) {
        if (value) {
            value[1] = value[1].trim();
            if (saveHistory) {
                this.saveHistoryStateValue(value);
            }
        }
        this.p().search = value ? value : [];
        this._replaceUrl = false;
        this.lastSearchHistoryEntry.next(value);
        this.parameters.next(this.p())
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

        this.p().panel = [
            this.inspectionContainerWidth / this.baseFontSize,
            this.inspectionContainerHeight / this.baseFontSize
        ];
        this.parameters.next(this.p());
    }

    pruneMapLayerConfig(mapItems: Array<MapInfoItem>): boolean {
        const mapLayerIds = new Set<string>();
        mapItems.forEach(mapItem => {
            mapItem.layers.keys().forEach(layerId => {
                mapLayerIds.add(`${mapItem.mapId}/${layerId}`);
            });
        });

        this.p().layers = this.p().layers.filter(layer => {
            return mapLayerIds.has(layer[0]) && !this.isSourceOrMetaData(layer[0]);
        });
        const hasLayersAfterPruning = this.p().layers.length > 0;
        this.parameters.next(this.p());
        return !hasLayersAfterPruning; // Need to reinitialise the layers if none configured anymore
    }

    private styleParamsToURLParams(params: StyleParameters): StyleURLParameters {
        return { v: params.visible, optOn: params.showOptions, o: params.options };
    }

    private styleURLParamsToParams(params: StyleURLParameters): StyleParameters{
        return { visible: params.v, showOptions: params.optOn, options: params.o };
    }
}
