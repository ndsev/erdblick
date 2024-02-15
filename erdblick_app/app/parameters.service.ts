import {Injectable} from "@angular/core";
import {MapService} from "./map.service";
import {StyleService} from "./style.service";
import {BehaviorSubject} from "rxjs";

export interface ErdblickParameters {
     heading: number,
     pitch: number,
     roll: number,
     x: number,
     y: number,
     z: number,
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
               const currentPosition = this.mapService.collectCameraPosition();
               const currentStyles = [...this.styleService.activatedStyles.keys()].filter(key => this.styleService.activatedStyles.get(key));
               let currentLayers = new Array<Array<string>>;
               const mapModel = this.mapService.mapModel.getValue();
               if (mapModel) {
                    mapModel.availableMapItems.getValue().forEach((mapItem, mapName) => {
                         mapItem.mapLayers.forEach(mapLayer => {
                              if (mapLayer.visible) {
                                   currentLayers.push([`${mapName}/${mapLayer.name}`, mapLayer.level.toString()]);
                              }
                         });
                    });
               }
               this.parameters = new BehaviorSubject<ErdblickParameters>({
                    heading: currentOrientation ? currentOrientation.heading : 6.0,
                    pitch: currentOrientation ? currentOrientation.pitch : -1.55,
                    roll: currentOrientation ? currentOrientation.roll : 0.25,
                    x: currentPosition ? currentPosition.x : 19032026.0,
                    y: currentPosition ? currentPosition.y : 8364456.0,
                    z: currentPosition ? currentPosition.z : 16224903.0,
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

     private saveParameters() {
          localStorage.setItem('erdblickParameters', JSON.stringify(this.parameters.getValue()));
     }
}