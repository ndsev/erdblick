import {Injectable} from "@angular/core";
import {MapInfoItem, MapService} from "./map.service";
import {StyleService} from "./style.service";
import {BehaviorSubject} from "rxjs";
import {Cartesian3, Cartographic, Math} from "cesium";
import {Params} from "@angular/router";
import {ViewService} from "./view.service";

export interface ErdblickParameters {
     heading: number,
     pitch: number,
     roll: number,
     lon: number,
     lat: number,
     alt: number,
     osmOpacity: number,
     osmEnabled: boolean,
     layers: Array<Array<string>>,
     styles: Array<string>
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
    styles: []
}

@Injectable({providedIn: 'root'})
export class ParametersService {

     parameters: BehaviorSubject<ErdblickParameters>;

     constructor(public mapService: MapService,
                 public viewService: ViewService,
                 public styleService: StyleService) {
          let parameters = this.loadSavedParameters();
          if (!parameters) {
               const currentOrientation = this.viewService.collectCameraOrientation();
               const currentCameraPosition = this.viewService.collectCameraPosition();
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
               const currentStyles = [...this.styleService.availableStylesActivations.keys()].filter(key => this.styleService.availableStylesActivations.get(key));
               let currentLayers = new Array<Array<string>>;
               const mapModel = this.mapService.mapModel;
               if (mapModel) {
                    mapModel.layerIdToLevel.forEach((level, mapLayerName) => {
                        const [encMapName, encLayerName] = mapLayerName.split('/');
                        const visible = mapService.mapModel.availableMapItems.getValue().get(encMapName)?.layers.get(encLayerName)?.visible;
                        if (visible !== undefined && visible) {
                           currentLayers.push([mapLayerName, level.toString()]);
                        }
                    });
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
                    layers: currentLayers,
                    styles: currentStyles.length ? currentStyles : defaultParameters.styles
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

     loadSavedParameters(): ErdblickParameters | null {
          const parameters = localStorage.getItem('erdblickParameters');
          if (parameters) {
               return JSON.parse(parameters);
          }
          return null;
     }

    parseAndApplyParams(params: Params, firstParamUpdate: boolean = false) {
        let currentParameters = this.parameters.getValue();
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

        if (firstParamUpdate ||
            newPosition.lon != currentParameters.lon ||
            newPosition.lat != currentParameters.lat ||
            newPosition.alt != currentParameters.alt ||
            newOrientation.heading != currentParameters.heading ||
            newOrientation.pitch != currentParameters.pitch ||
            newOrientation.roll != currentParameters.roll) {
            this.viewService.setView(Cartesian3.fromDegrees(newPosition.lon, newPosition.lat, newPosition.alt), newOrientation);
            currentParameters.lon = newPosition.lon;
            currentParameters.lat = newPosition.lat;
            currentParameters.alt = newPosition.alt;
            currentParameters.heading = newOrientation.heading;
            currentParameters.roll = newOrientation.roll;
            currentParameters.pitch = newOrientation.pitch;
        }

        const osmEnabled = params["osmEnabled"] ? params["osmEnabled"] == "true" : currentParameters.osmEnabled;
        const osmOpacity = params["osmOpacity"] ? Number(params["osmOpacity"]) : currentParameters.osmOpacity;
        this.viewService.osmEnabled.next(osmEnabled);
        this.viewService.osmOpacityValue.next(osmOpacity);
        currentParameters.osmEnabled = osmEnabled;
        currentParameters.osmOpacity = osmOpacity;

        let layerNamesLevels = currentParameters.layers;
        let currentLayers = new Array<Array<string>>;
        if (params["layers"]) {
            layerNamesLevels = JSON.parse(params["layers"]);
        }
        layerNamesLevels.forEach((nameLevel: Array<string>) => {
            const name = nameLevel[0];
            const level = Number(nameLevel[1]);
            if (this.mapService.mapModel) {
                if (this.mapService.mapModel.layerIdToLevel.has(name)) {
                    this.mapService.mapModel.layerIdToLevel.set(name, level);
                }
                const [encMapName, encLayerName] = name.split('/');
                this.mapService.mapModel.availableMapItems.getValue().forEach(
                    (mapItem: MapInfoItem, mapName: string) => {
                        if (mapName == encMapName) {
                            mapItem.visible = true;
                            mapItem.layers.forEach((mapLayer, layerName) => {
                                if (layerName == encLayerName) {
                                    mapLayer.visible = true;
                                    currentLayers.push([`${mapName}/${layerName}`, level.toString()])
                                }
                            });
                        }
                    });
            }
        });
        if (currentLayers) {
            currentParameters.layers = currentLayers;
        }

        let styles = currentParameters.styles;
        let activateAll = false;
        if (params["styles"] && JSON.parse(params["styles"])) {
            styles = JSON.parse(params["styles"]);
        } else if (firstParamUpdate) {
            activateAll = true;
        }
        let currentStyles = new Array<string>();
        if (firstParamUpdate) {
            for (let styleId of this.styleService.availableStylesActivations.keys()) {
                this.styleService.availableStylesActivations.set(styleId, activateAll);
            }
        }
        styles.forEach(styleId => {
            if (this.styleService.availableStylesActivations.has(styleId)) {
                this.styleService.availableStylesActivations.set(styleId, true);
                currentStyles.push(styleId);
            }
        })
        if (currentStyles) {
            currentParameters.styles = currentStyles;
        }

        this.parameters.next(currentParameters);
    }

     clearStorage() {
         localStorage.removeItem('erdblickParameters');
         this.parameters.next(defaultParameters);
     }

     private saveParameters() {
          localStorage.setItem('erdblickParameters', JSON.stringify(this.parameters.getValue()));
     }
}