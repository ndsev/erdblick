import {Injectable} from "@angular/core";
import {ParametersService} from "./parameters.service";
import {BehaviorSubject} from "rxjs";
import {Cartographic} from "./cesium";
import {HttpClient} from "@angular/common/http";


@Injectable({providedIn: 'root'})
export class CoordinatesService {
    mouseMoveCoordinates: BehaviorSubject<Cartographic | null> = new BehaviorSubject<Cartographic | null>(null);
    mouseClickCoordinates: BehaviorSubject<Cartographic | null> = new BehaviorSubject<Cartographic | null>(null);
    auxiliaryCoordinatesFun: Function | null = null;
    auxilaryTileIdsFun: Function | null = null;

    constructor(private httpClient: HttpClient,
                public parametersService: ParametersService) {
        this.mouseClickCoordinates.subscribe(position => {
            this.parametersService.setMarkerPosition(position);
        });
    }

    initialize() {
        this.httpClient.get("/config.json", {responseType: 'json'}).subscribe({
            next: (data: any) => {
                try {
                    if (data && data["extensionModules"] && data["extensionModules"]["jumpTargets"]) {
                        let jumpTargetsConfig = data["extensionModules"]["jumpTargets"];
                        if (jumpTargetsConfig !== undefined) {
                            // Using string interpolation so webpack can trace imports from the location
                            import(`../../config/${jumpTargetsConfig}.js`).then((plugin) => {
                                const { getAuxCoordinates, getAuxTileIds } = plugin;
                                if (getAuxCoordinates) {
                                    this.auxiliaryCoordinatesFun = getAuxCoordinates;
                                } else {
                                    console.error('Function getAuxCoordinates not found in the plugin.');
                                }
                                if (getAuxTileIds) {
                                    this.auxilaryTileIdsFun = getAuxTileIds;
                                } else {
                                    console.error('Function getAuxTileIds not found in the plugin.');
                                }
                            }).catch((error) => {
                                console.error(error);
                            });
                        }
                    }
                } catch (error) {
                    console.error(error);
                }
            },
            error: error => {
                console.error(error);
            }
        });
    }
}