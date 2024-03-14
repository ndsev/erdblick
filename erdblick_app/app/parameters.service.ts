import {Injectable} from "@angular/core";
import {MapService} from "./map.service";
import {StyleService} from "./style.service";
import {BehaviorSubject} from "rxjs";
import {Cartesian3, Cartographic, Math} from "cesium";

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

@Injectable({providedIn: 'root'})
export class ParametersService {

     parameters: BehaviorSubject<ErdblickParameters>;

     constructor(public mapService: MapService,
                 public styleService: StyleService) {
          let parameters = this.loadSavedParameters();
          if (!parameters) {
               const currentOrientation = this.mapService.collectCameraOrientation();
               const currentCameraPosition = this.mapService.collectCameraPosition();
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
               const currentStyles = [...this.styleService.availableStyles.keys()].filter(key => this.styleService.availableStyles.get(key));
               let currentLayers = new Array<Array<string>>;
               const mapModel = this.mapService.mapModel.getValue();
               if (mapModel) {
                    mapModel.layerIdToLevel.forEach((level, mapLayerName) => {
                        const [encMapName, encLayerName] = mapLayerName.split('/');
                        const visible = mapService.mapModel.getValue()?.availableMapItems.getValue().get(encMapName)?.layers.get(encLayerName)?.visible;
                        if (visible !== undefined && visible) {
                           currentLayers.push([mapLayerName, level.toString()]);
                        }
                    });
               }
               this.parameters = new BehaviorSubject<ErdblickParameters>({
                    heading: currentOrientation ? currentOrientation.heading : 6.0,
                    pitch: currentOrientation ? currentOrientation.pitch : -1.55,
                    roll: currentOrientation ? currentOrientation.roll : 0.25,
                    lon: currentPosition ? currentPosition.lon : 22.837473,
                    lat: currentPosition ? currentPosition.lat : 38.490817,
                    alt: currentPosition ? currentPosition.alt : 16000000,
                    osmOpacity: 30,
                    osmEnabled: true,
                    layers: currentLayers,
                    styles: currentStyles
               });
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

     clearStorage() {
         localStorage.removeItem('erdblickParameters');
         this.parameters.next({
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
         });
     }

     private saveParameters() {
          localStorage.setItem('erdblickParameters', JSON.stringify(this.parameters.getValue()));
     }
}