import {coreLib, uint8ArrayFromWasm, ErdblickCore_} from "./integrations/wasm";
import {MapService} from "./mapdata/map.service";
import {AppStateService} from "./shared/appstate.service";
import {SceneMode, CesiumMath} from "./integrations/cesium";
import {MapView} from "./mapview/view";

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
    constructor(private mapService: MapService,
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
            modified: false,
            imported: false,
            params: {visible: true, options: {}},
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

    /**
     * Diagnostic method to show WebMercator distortion factors at different latitudes
     * Useful for debugging altitude compensation issues
     */
    showMercatorDistortion(mapView: MapView) {
        // Show current camera position distortion first
        if (mapView.isAvailable()) {
            const currentPos = mapView.viewer.camera.positionCartographic;
            const currentLatDeg = CesiumMath.toDegrees(currentPos.latitude);
            const currentFactor = mapView.calculateMercatorDistortionFactor(currentPos.latitude);
            const currentHeight = currentPos.height;

            console.log('🎯 CURRENT POSITION:');
            console.log(`  Latitude: ${currentLatDeg.toFixed(3)}°`);
            console.log(`  Altitude: ${Math.round(currentHeight)}m`);
            console.log(`  Distortion Factor: ${currentFactor.toFixed(3)}x`);
            console.log(`  Mode: ${mapView.getSceneMode().valueOf() === SceneMode.SCENE2D ? '2D' : '3D'}`);

            if (mapView.getSceneMode().valueOf() === SceneMode.SCENE2D) {
                const equivalent3D = currentHeight / currentFactor;
                console.log(`  Equivalent 3D altitude: ${Math.round(equivalent3D)}m`);
            } else {
                const equivalent2D = currentHeight * currentFactor;
                console.log(`  Equivalent 2D altitude: ${Math.round(equivalent2D)}m`);
            }
        }

        console.log('📊 WebMercator Distortion Factors by Latitude:');
        const testLatitudes = [0, 30, 45, 60, 70, 80, 85];
        testLatitudes.forEach(latDeg => {
            const latRad = CesiumMath.toRadians(latDeg);
            const factor = mapView.calculateMercatorDistortionFactor(latRad);
            console.log(`  ${latDeg}°: ${factor.toFixed(3)}x distortion`);
        });

        console.log('\n🔄 Altitude Compensation Examples (10km baseline):');
        testLatitudes.forEach(latDeg => {
            const latRad = CesiumMath.toRadians(latDeg);
            const factor = mapView.calculateMercatorDistortionFactor(latRad);
            const altitude3D = 10000; // 10km
            const altitude2D = altitude3D * factor;
            console.log(`  ${latDeg}°: 3D=${altitude3D}m → 2D=${Math.round(altitude2D)}m (${factor.toFixed(3)}x)`);
        });
    }
}
