import {Injectable} from "@angular/core";
import {AppStateService} from "../shared/appstate.service";
import {BehaviorSubject, skip} from "rxjs";
import {Cartographic} from "../integrations/geo";
import {HttpClient} from "@angular/common/http";

@Injectable({providedIn: 'root'})
/**
 * Shared coordinate event service for hover/click coordinates and optional
 * plugin-provided auxiliary coordinate systems.
 */
export class CoordinatesService {
    mouseMoveCoordinates: BehaviorSubject<Cartographic | null> = new BehaviorSubject<Cartographic | null>(null);
    mouseClickCoordinates: BehaviorSubject<Cartographic | null> = new BehaviorSubject<Cartographic | null>(null);
    auxiliaryCoordinatesFun: ((x: number, y: number)=>any) | null = null;
    auxiliaryTileIdsFun: ((x: number, y: number, level: number)=>any) | null = null;

    constructor(private httpClient: HttpClient,
                public stateService: AppStateService) {
        this.mouseClickCoordinates.pipe(
            skip(1)  // Skip the first (null) value from mouseClickCoordinates BehaviorSubject
        ).subscribe(position => {
            this.stateService.setMarkerPosition(position);
        });
    }

    /** Loads the configured jump-target module via dynamic import. */
    protected loadJumpTargetsModule(path: string): Promise<any> {
        return import(/* @vite-ignore */ path);
    }

    /** Initializes optional jump-target helpers from the configured extension module. */
    initialize() {
        this.httpClient.get("config.json", {responseType: 'json'}).subscribe({
            next: (data: any) => {
                try {
                    if (data && data["extensionModules"] && data["extensionModules"]["jumpTargets"]) {
                        let jumpTargetsConfig = data["extensionModules"]["jumpTargets"];
                        if (jumpTargetsConfig !== undefined) {
                            const jumpTargetsPath = `/config/${jumpTargetsConfig}.js`;
                            // Using string interpolation so webpack can trace imports, and tell Vite to leave the absolute path untouched
                            this.loadJumpTargetsModule(jumpTargetsPath).then((plugin) => {
                                const { getAuxCoordinates, getAuxTileIds } = plugin;
                                if (getAuxCoordinates) {
                                    this.auxiliaryCoordinatesFun = getAuxCoordinates;
                                } else {
                                    console.error('Function getAuxCoordinates not found in the plugin.');
                                }
                                if (getAuxTileIds) {
                                    this.auxiliaryTileIdsFun = getAuxTileIds;
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
