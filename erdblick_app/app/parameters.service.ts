import {Injectable} from "@angular/core";
import {BehaviorSubject} from "rxjs";
import {Cartesian3, Cartographic, Math, Camera} from "./cesium";
import {Params} from "@angular/router";

const MAX_NUM_TILES_TO_LOAD = 2048;
const MAX_NUM_TILES_TO_VISUALIZE = 512;

export interface ErdblickParameters {
    heading: number,
    pitch: number,
    roll: number,
    lon: number,
    lat: number,
    alt: number,
    osmOpacity: number,
    osmEnabled: boolean,
    layers: Array<[string, number]>,
    styles: Array<string>,
    tilesLoadLimit: number,
    tilesVisualizeLimit: number
}

const defaultParameters: ErdblickParameters = {
    heading: 6.0,
    pitch: -1.55,
    roll: 0.25,
    lon: 22.837473,
    lat: 38.490817,
    alt: 16000000,
    osmOpacity: 30,
    osmEnabled: true,
    layers: [],
    styles: [],
    tilesLoadLimit: MAX_NUM_TILES_TO_LOAD,
    tilesVisualizeLimit: MAX_NUM_TILES_TO_VISUALIZE
}

@Injectable({providedIn: 'root'})
export class ParametersService {

    parameters: BehaviorSubject<ErdblickParameters>;
    initialQueryParamsSet: boolean = false;

    osmEnabled: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(true);
    osmOpacityValue: BehaviorSubject<number> = new BehaviorSubject<number>(30);
    cameraViewData: BehaviorSubject<{destination: Cartesian3, orientation: {heading: number, pitch: number, roll: number}}> =
        new BehaviorSubject<{destination: Cartesian3, orientation: {heading: number, pitch: number, roll: number}}>({
            destination: Cartesian3.fromDegrees(22.837473, 38.490817, 16000000),
            orientation: {
                heading: 6.0,
                pitch: -1.55,
                roll: 0.25,
            }
        });

    constructor() {
        let parameters = this.loadSavedParameters();
        if (!parameters) {
            const currentOrientation = this.getCameraOrientation();
            const currentCameraPosition = this.getCameraPosition();
            let currentPosition = null;
            if (currentCameraPosition) {
                const currentPositionCartographic = Cartographic.fromCartesian(
                    Cartesian3.fromElements(currentCameraPosition.x, currentCameraPosition.y, currentCameraPosition.z)
                );
                currentPosition = {
                    lon: Math.toDegrees(currentPositionCartographic.longitude),
                    lat: Math.toDegrees(currentPositionCartographic.latitude),
                    alt: currentPositionCartographic.height
                }
            }
            this.parameters = new BehaviorSubject<ErdblickParameters>({
                heading: currentOrientation ? currentOrientation.heading : defaultParameters.heading,
                pitch: currentOrientation ? currentOrientation.pitch : defaultParameters.pitch,
                roll: currentOrientation ? currentOrientation.roll : defaultParameters.roll,
                lon: currentPosition ? currentPosition.lon : defaultParameters.lon,
                lat: currentPosition ? currentPosition.lat : defaultParameters.lat,
                alt: currentPosition ? currentPosition.alt : defaultParameters.alt,
                osmOpacity: defaultParameters.osmOpacity,
                osmEnabled: defaultParameters.osmEnabled,
                layers: [],
                styles: [],
                tilesLoadLimit: defaultParameters.tilesLoadLimit,
                tilesVisualizeLimit: defaultParameters.tilesVisualizeLimit
            });
            console.log(this.parameters.getValue())
        } else {
            this.parameters = new BehaviorSubject<ErdblickParameters>(parameters);
        }
        this.saveParameters();
        this.parameters.subscribe(parameters => {
            if (parameters) {
                this.saveParameters();
            }
        });
    }

    p() {
        return this.parameters.getValue();
    }

    setInitialMapLayers(layers: Array<[string, number]>) {
        // Only set map layers, if there are no configured values yet.
        if (this.p().layers.length) {
            return;
        }
        this.p().layers = layers;
        this.parameters.next(this.p());
    }

    setInitialStyles(styles: Array<string>) {
        // Only set styles, if there are no configured values yet.
        if (this.p().styles.length) {
            return;
        }
        this.p().styles = styles;
        this.parameters.next(this.p());
    }

    mapLayerConfig(mapId: string, layerId: string, fallbackLevel: number): [boolean, number] {
        const conf = this.p().layers.find(ml => ml[0] == mapId+"/"+layerId);
        if (conf) {
            return [true, conf[1]];
        }
        return [!this.p().layers.length, fallbackLevel];
    }

    setMapLayerConfig(mapId: string, layerId: string, level: number, visible: boolean) {
        let mapLayer = mapId+"/"+layerId;
        let conf = this.p().layers.find(val => val[0] == mapLayer);
        if (conf && visible) {
            conf[1] = level;
        }
        else if (conf) {
            this.p().layers = this.p().layers.filter(val => val[0] !== mapLayer);
        }
        else if (visible) {
            this.p().layers.push([mapLayer, level]);
        }
        this.parameters.next(this.p());
    }

    styleConfig(styleId: string): boolean {
        return !this.p().styles.length || this.p().styles.includes(styleId);
    }

    setStyleConfig(styleId: string, visible: boolean) {
        let newStyles = this.p().styles.filter(val => val !== styleId);
        if (visible) {
            newStyles.push(styleId);
        }
        this.p().styles = newStyles;
        this.parameters.next(this.p());
    }

    setCameraState(camera: Camera) {
        const currentPositionCartographic = Cartographic.fromCartesian(
            Cartesian3.fromElements(
                camera.position.x, camera.position.y, camera.position.z
            )
        );
        this.p().lon = Math.toDegrees(currentPositionCartographic.longitude);
        this.p().lat = Math.toDegrees(currentPositionCartographic.latitude);
        this.p().alt = currentPositionCartographic.height;
        this.p().heading = camera.heading;
        this.p().pitch = camera.pitch;
        this.p().roll = camera.roll;
        this.parameters.next(this.p());
    }

    loadSavedParameters(): ErdblickParameters | null {
        const parameters = localStorage.getItem('erdblickParameters');
        if (parameters) {
            return JSON.parse(parameters);
        }
        return null;
    }

    parseAndApplyQueryParams(params: Params) {
        let currentParameters = this.p();
        const newPosition = {
            lon: params["lon"] ? Number(params["lon"]) : currentParameters.lon,
            lat: params["lat"] ? Number(params["lat"]) : currentParameters.lat,
            alt: params["alt"] ? Number(params["alt"]) : currentParameters.alt
        }
        const newOrientation = {
            heading: params["heading"] ? Number(params["heading"]) : currentParameters.heading,
            pitch: params["pitch"] ? Number(params["pitch"]) : currentParameters.pitch,
            roll: params["roll"] ? Number(params["roll"]) : currentParameters.roll
        }

        if (!this.initialQueryParamsSet ||
            newPosition.lon != currentParameters.lon ||
            newPosition.lat != currentParameters.lat ||
            newPosition.alt != currentParameters.alt ||
            newOrientation.heading != currentParameters.heading ||
            newOrientation.pitch != currentParameters.pitch ||
            newOrientation.roll != currentParameters.roll)
        {
            this.setView(Cartesian3.fromDegrees(newPosition.lon, newPosition.lat, newPosition.alt), newOrientation);
            currentParameters.lon = newPosition.lon;
            currentParameters.lat = newPosition.lat;
            currentParameters.alt = newPosition.alt;
            currentParameters.heading = newOrientation.heading;
            currentParameters.roll = newOrientation.roll;
            currentParameters.pitch = newOrientation.pitch;
        }

        const osmEnabled = params["osmEnabled"] ? params["osmEnabled"] == "true" : currentParameters.osmEnabled;
        const osmOpacity = params["osmOpacity"] ? Number(params["osmOpacity"]) : currentParameters.osmOpacity;
        this.osmEnabled.next(osmEnabled);
        this.osmOpacityValue.next(osmOpacity);
        currentParameters.osmEnabled = osmEnabled;
        currentParameters.osmOpacity = osmOpacity;

        if (params["layers"]) {
            let newLayers = JSON.parse(params["layers"]);
            if (newLayers.length)
                currentParameters.layers = newLayers;
        }
        if (params["styles"]) {
            let newStyles = JSON.parse(params["styles"]);
            if (newStyles.length)
                currentParameters.styles = newStyles;
        }
        if (params["tilesLoadLimit"]) {
            currentParameters.tilesLoadLimit = JSON.parse(params["tilesLoadLimit"]);
        }
        if (params["tilesVisualizeLimit"]) {
            currentParameters.tilesVisualizeLimit = JSON.parse(params["tilesVisualizeLimit"]);
        }

        this.parameters.next(currentParameters);
        this.initialQueryParamsSet = true;
    }

    clearStorage() {
        localStorage.removeItem('erdblickParameters');
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
}