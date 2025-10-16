import {coreLib, uint8ArrayFromWasm, ErdblickCore_} from "./integrations/wasm";
import {MapDataService} from "./mapdata/map.service";
import {AppStateService} from "./shared/appstate.service";
import {SceneMode, CesiumMath} from "./integrations/cesium";
import {MapView} from "./mapview/view";
import {MapView2D} from "./mapview/view2d";

/**
 * Extend Window interface to allow custom ErdblickDebugApi property
 */
export interface DebugWindow extends Window {
    ebDebug: ErdblickDebugApi;
}

/**
 * Debugging utility class designed for usage with the browser's debug console.
 *
 * Extends the actual application with debugging/dev functionality without
 * contaminating the application's primary codebase or an addition of a dedicated
 * GUI.
 */
export class ErdblickDebugApi {
    /**
     * Initialize a new ErdblickDebugApi instance.
     */
    constructor(private mapService: MapDataService,
                private stateService: AppStateService) {
    }

    /**
     * Update the camera position and orientation in the map view.
     *
     * @param cameraInfoStr A JSON-formatted string containing camera information.
     */
    setCamera(cameraInfoStr: string) {
        const cameraInfo = JSON.parse(cameraInfoStr);
        this.stateService.setView(
            0,
            cameraInfo.position,
            {
                heading: cameraInfo.orientation.heading,
                pitch: cameraInfo.orientation.pitch,
                roll: cameraInfo.orientation.roll
            }
        );
    }

    /**
     * Retrieve the current camera position and orientation.
     *
     * @return A JSON-formatted string containing the current camera's position and orientation.
     */
    getCamera() {
        const destination = this.stateService.getCameraPosition(0);
        const position = [
            destination.longitude,
            destination.latitude,
            destination.height,
        ];
        const orientation = this.stateService.getCameraOrientation(0);
        return JSON.stringify({position, orientation});
    }

    /**
     * Generate a test TileFeatureLayer, and show it.
     */
    showTestTile() {
        let tile = uint8ArrayFromWasm((sharedArr: any) => {
            coreLib.generateTestTile(sharedArr, this.mapService.tileParser!);
        });
        let style = coreLib.generateTestStyle();
        this.mapService.addTileFeatureLayer(tile, {
            id: "_builtin",
            shortId: "TEST",
            modified: false,
            imported: false,
            source: "",
            featureLayerStyle: style,
            options: [],
            visible: true,
            url: ""
        }, "_builtin", true);
    }

    /**
     * Check for memory leaks.
     */
    coreLib(): ErdblickCore_ {
        return coreLib;
    }

    /** Run some simfil query to reproduce problems with search. */
    runSimfilQuery(query: string = "**.transition") {
        for (const [_, tile] of this.mapService.loadedTileLayers) {
            tile.peek(parsedTile => {
                let search = new coreLib.FeatureLayerSearch(parsedTile);
                const matchingFeatures = search.filter(query);
                search.delete();
            })
        }
    }
}
