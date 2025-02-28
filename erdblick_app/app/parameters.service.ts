import {Injectable} from "@angular/core";
import {BehaviorSubject} from "rxjs";
import {Cartesian3, Cartographic, CesiumMath, Camera} from "./cesium";
import {Params} from "@angular/router";
import {SelectedSourceData} from "./inspection.service";

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
    osm: boolean,
    osmOpacity: number,
    layers: Array<[string, number, boolean, boolean]>,
    styles: Record<string, StyleParameters>,
    tilesLoadLimit: number,
    tilesVisualizeLimit: number,
    enabledCoordsTileIds: Array<string>,
    selectedSourceData: Array<any>,
    panel: Array<number>
}

interface ParameterDescriptor {
    // Convert the setting to the correct type, e.g. Number.
    converter: (val: any)=>any,
    // Check if the converted value is good, or the default must be used.
    validator: (val: any)=>boolean,
    // Default value.
    default: any,
    // Include in the url
    urlParam: boolean
}

/** Function to create an object validator given a key-typeof-value dictionary. */
function validateObject(fields: Record<string, string>) {
    return (o: object) => {
        if (typeof o !== "object") {
            return false;
        }
        for (let [key, value] of Object.entries(o)) {
            let valueType = typeof value;
            if (valueType !== fields[key]) {
                return false;
            }
        }
        return true;
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
        converter: val => val === 'true',
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
        validator: val => Array.isArray(val) && val.every(validateObject({mapTileKey: "string", featureId: "string"})),
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
    osmOpacity: {
        converter: Number,
        validator: val => typeof val === 'number' && !isNaN(val) && val >= 0 && val <= 100,
        default: 30,
        urlParam: true
    },
    osm: {
        converter: val => val === 'true',
        validator: val => typeof val === 'boolean',
        default: true,
        urlParam: true
    },
    layers: {
        converter: val => JSON.parse(val),
        validator: val => Array.isArray(val) && val.every(item => Array.isArray(item) && item.length === 4 && typeof item[0] === 'string' && typeof item[1] === 'number' && typeof item[2] === 'boolean' && typeof item[3] === 'boolean'),
        default: [],
        urlParam: true
    },
    styles: {
        converter: val => JSON.parse(val),
        validator: val => {
            return typeof val === "object" && Object.entries(val as Record<string, ErdblickParameters>).every(
                ([_, v]) => validateObject({visible: "boolean", showOptions: "boolean", options: "object"})(v));
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
        converter: JSON.parse,
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

@Injectable({providedIn: 'root'})
export class ParametersService {

    private _replaceUrl: boolean = true;
    parameters: BehaviorSubject<ErdblickParameters>;
    initialQueryParamsSet: boolean = false;

    cameraViewData: BehaviorSubject<{destination: Cartesian3, orientation: {heading: number, pitch: number, roll: number}}> =
        new BehaviorSubject<{destination: Cartesian3, orientation: {heading: number, pitch: number, roll: number}}>({
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

    constructor() {
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
        this.p().layers = layers;
        this.parameters.next(this.p());
    }

    setInitialStyles(styles: Record<string, StyleParameters>) {
        // Only set styles, if there are no configured values yet.
        if (!Object.entries(this.p().styles).length) {
            return;
        }
        this.p().styles = styles;
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

    setMarkerPosition(position: Cartographic | null, delayUpdate: boolean=false) {
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
        const conf = this.p().layers.find(ml => ml[0] == mapId+"/"+layerId);
        if (conf !== undefined && conf[2]) {
            return [true, conf[1], conf[3]];
        }
        return [!this.p().layers.length, fallbackLevel, false];
    }

    setMapLayerConfig(mapId: string, layerId: string, level: number, visible: boolean, tileBorders: boolean) {
        let mapLayerName = mapId+"/"+layerId;
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

    styleConfig(styleId: string): StyleParameters {
        if (this.p().styles.hasOwnProperty(styleId)) {
            return this.p().styles[styleId];
        }
        return {
            visible: !Object.entries(this.p().styles).length,
            options: {},
            showOptions: true,
        };
    }

    setStyleConfig(styleId: string, params: StyleParameters) {
        this.p().styles[styleId] = params;
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

    loadSavedParameters(): ErdblickParameters | null {
        let parsedParameters: Record<string, any> = {};
        const parameters = localStorage.getItem('erdblickParameters');
        if (parameters) {
            parsedParameters = JSON.parse(parameters);
        }
        return Object.keys(erdblickParameters).reduce((acc, key: string) => {
            const descriptor = erdblickParameters[key];
            let value = parsedParameters!.hasOwnProperty(key) ? parsedParameters[key] : descriptor.default;
            acc[key] = descriptor.validator(value) ? value : descriptor.default;
            return acc;
        }, {} as any);
    }

    parseAndApplyQueryParams(params: Params) {
        let currentParameters = this.p();
        let updatedParameters: ErdblickParameters = { ...currentParameters };

        Object.keys(erdblickParameters).forEach(key => {
            const descriptor = erdblickParameters[key];
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

        if (!this.initialQueryParamsSet) {
            this.setView(Cartesian3.fromDegrees(updatedParameters.lon, updatedParameters.lat, updatedParameters.alt), {
                heading: updatedParameters.heading,
                pitch: updatedParameters.pitch,
                roll: updatedParameters.roll
            });
        }

        // Update BehaviorSubject with the new parameters
        this.parameters.next(updatedParameters);
        this.initialQueryParamsSet = true;
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

    setView(destination: Cartesian3, orientation: {heading: number, pitch: number, roll: number}) {
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
        if (erdblickParameters.hasOwnProperty(name)) {
            return erdblickParameters[name].urlParam;
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
}
