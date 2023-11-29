import { Component } from '@angular/core';
import { ErdblickView } from "./erdblick.view";
import { ErdblickModel } from "./erdblick.model";
import { DebugWindow, ErdblickDebugApi } from "./debugapi.component";
import { HttpClient } from "@angular/common/http";
import libErdblickCore from '../../build/libs/core/erdblick-core';

// Redeclare window with extended interface
declare let window: DebugWindow;

@Component({
    selector: 'app-root',
    template: `
        <div id="mapViewContainer" class="mapviewer-renderlayer"></div>

        <div id="info" class="panel">
            <span class="toggle-indicator"></span>
            {{title}} {{version}} //
            <button (click)="reloadStyle()">Reload Style</button><br>
            <div id="controls">
                <!-- Label and input field for MAX_NUM_TILES_TO_LOAD -->
                <label [for]="tilesToLoadInput">Max Tiles to Load:</label>
                <input type="number" [id]="tilesToLoadInput" placeholder="Enter max tiles to load" min="1" (click)="tilesInputOnClick($event)"><br>

                <!-- Label and input field for MAX_NUM_TILES_TO_VISUALIZE -->
                <label [for]="tilesToVisualizeInput">Max Tiles to Visualize:</label>
                <input type="number" [id]="tilesToVisualizeInput" placeholder="Enter max tiles to visualize" min="1" (click)="tilesInputOnClick($event)"><br>

                <!-- Apply button -->
                <button onclick="applyTileLimits()">Apply Tile Limits</button>
            </div>
            <div id="maps">
                <div *ngFor="let layer of layers"><span>{{layer[0]}} / {{layer[1]}}</span>&nbsp;<button (click)="focus(layer[2])">Focus</button></div>
            </div>
        </div>

        <div [hidden]="!isSelectionPanelVisible" id="selectionPanel" class="panel">
            <span class="toggle-indicator"></span>
            <span>Selected Feature: </span><span id="selectedFeatureId">{{selectedFeatureIdText}}</span>
            <pre id="selectedFeatureGeoJson">{{selectedFeatureGeoJsonText}}</pre> <!-- Use <pre> for preserving whitespace -->
        </div>

        <router-outlet></router-outlet>
    `,
    styleUrls: []
})
export class AppComponent {
    title: string = 'erdblick';
    version: string = "v0.3.0";
    mapModel: ErdblickModel | undefined;
    mapView: ErdblickView | undefined;
    tilesToLoadInput: number = 0;
    tilesToVisualizeInput: number = 0;
    selectedFeatureGeoJsonText: string = "";
    selectedFeatureIdText: string = "";
    isSelectionPanelVisible: boolean = false;
    layers: Array<[string, string, any]> = new Array<[string, string, any]>();
    coreLib: any

    constructor(private httpClient: HttpClient) {
        httpClient.get('./bundle/VERSION', {responseType: 'text'}).subscribe(
            data => {
                this.version = data.toString();
            });

        libErdblickCore().then((coreLib: any) => {
            console.log("  ...done.")
            this.coreLib = coreLib;

            this.mapModel = new ErdblickModel(coreLib);
            this.mapView = new ErdblickView(this.mapModel, 'mapViewContainer');

            this.reloadStyle();

            this.tilesToLoadInput = this.mapModel.maxLoadTiles;
            this.tilesToVisualizeInput = this.mapModel.maxVisuTiles;

            this.applyTileLimits();

            // Add debug API that can be easily called from browser's debug console
            window.ebDebug = new ErdblickDebugApi(this.mapView);

            this.mapView.selectionTopic.subscribe(selectedFeatureWrapper => {
                if (!selectedFeatureWrapper) {
                    this.isSelectionPanelVisible = false;
                    return;
                }

                selectedFeatureWrapper.peek((feature: any) => {
                    this.selectedFeatureGeoJsonText = feature.geojson();
                    this.selectedFeatureIdText = feature.id();
                    this.isSelectionPanelVisible = true;
                })
            })

            this.mapModel.mapInfoTopic.subscribe((mapInfo: Object) => {
                // Object.entries(mapInfo).map((mapName, map) => {
                //     return Object.entries(map.layers).map((layerName, layer) => {
                //         return [mapName, layerName, layer];
                //     });
                // });
                //
                // Object.keys(mapInfo).map((mapName: string) => {
                //     return Object.keys(mapInfo[mapName].layers).map((layerName: string) => {
                //         return [mapName, layerName, mapInfo[mapName].layers[layerName]];
                //     });
                // });
                console.log(mapInfo);
            });
        })
    }

    applyTileLimits() {
        const tilesToLoad = this.tilesToLoadInput;
        const tilesToVisualize = this.tilesToVisualizeInput;

        if (isNaN(tilesToLoad) || isNaN(tilesToVisualize)) {
            alert("Please enter valid tile limits!");
            return;
        }

        if (this.mapModel !== undefined) {
            this.mapModel.maxLoadTiles = tilesToLoad;
            this.mapModel.maxVisuTiles = tilesToVisualize;
            this.mapModel.update();
        }

        console.log(`Max tiles to load set to ${tilesToLoad}`);
        console.log(`Max tiles to visualize set to ${tilesToVisualize}`);
    }

    reloadStyle() {
        if (this.mapModel !== undefined) this.mapModel.reloadStyle();
    }

    tilesInputOnClick(event: Event) {
        // Prevent event propagation for input fields
        event.stopPropagation()
    }

    focus(layer: any) {
        if (layer.coverage[0] !== undefined && this.mapModel !== undefined && this.coreLib !== undefined) {
            this.mapModel.zoomToWgs84PositionTopic.next(this.coreLib.getTilePosition(BigInt(layer.coverage[0])));
        }
    }
}
