import {coreLib, uint8ArrayFromWasm, ErdblickCore_} from "./wasm";
import {MapService} from "./map.service";
import {ErdblickViewComponent} from "./view.component";
import {ParametersService} from "./parameters.service";
import {Cartesian3} from "./cesium";

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
    private view: any;

    /**
     * Initialize a new ErdblickDebugApi instance.
     * @param mapView Reference to a ErdblickView instance
     */
    constructor(public mapService: MapService,
                public parametersService: ParametersService,
                mapView: ErdblickViewComponent) {
        this.view = mapView;
    }

    /**
     * Update the camera position and orientation in the map view.
     *
     * @param cameraInfoStr A JSON-formatted string containing camera information.
     */
    setCamera(cameraInfoStr: string) {
        const cameraInfo = JSON.parse(cameraInfoStr);
        this.parametersService.cameraViewData.next({
            destination: Cartesian3.fromArray(cameraInfo.position),
            orientation: {
                heading: cameraInfo.orientation.heading,
                pitch: cameraInfo.orientation.pitch,
                roll: cameraInfo.orientation.roll
            }
        });
    }

    /**
     * Retrieve the current camera position and orientation.
     *
     * @return A JSON-formatted string containing the current camera's position and orientation.
     */
    getCamera() {
        const position = [
            this.parametersService.cameraViewData.getValue().destination.x,
            this.parametersService.cameraViewData.getValue().destination.y,
            this.parametersService.cameraViewData.getValue().destination.z,
        ];
        const orientation = this.parametersService.cameraViewData.getValue().orientation;
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
            modified: false,
            imported: false,
            params: {visible: true, options: {}, showOptions: true},
            source: "",
            featureLayerStyle: style,
            options: []
        }, "_builtin", true);
    }

    /**
     * Check for memory leaks.
     */
    coreLib(): ErdblickCore_ {
        return coreLib;
    }
}
