import {Component, OnInit, QueryList, ViewChildren} from '@angular/core';
import {ErdblickView} from "./erdblick.view";
import {ErdblickModel} from "./erdblick.model";
import {DebugWindow, ErdblickDebugApi} from "./debugapi.component";
import {HttpClient} from "@angular/common/http";
import libErdblickCore, {Feature} from '../../build/libs/core/erdblick-core';
import {MenuItem, TreeNode, TreeTableNode} from "primeng/api";
import {InfoMessageService} from "./info.service";
import {JumpTargetService} from "./jump.service";
import {ErdblickLayer, ErdblickMap, MapService} from "./map.service";
import {ActivatedRoute, Params, Router} from "@angular/router";
import {Cartesian3} from "cesium";
import {StyleService} from "./style.service";
import {InspectionService} from "./inspection.service";
import {ParametersService} from "./parameters.service";

// Redeclare window with extended interface
declare let window: DebugWindow;

export interface MapItemLayer extends Object {
    canRead: boolean;
    canWrite: boolean;
    coverage: number[];
    featureTypes: Object[];
    layerId: string;
    type: string;
    version: Object;
    zoomLevels: number[];
}

export interface MapInfoItem extends Object {
    extraJsonAttachment: Object;
    layers: Map<string, MapItemLayer>;
    mapId: string;
    maxParallelJobs: number;
    nodeId: string;
    protocolVersion: Map<string, number>;
}

@Component({
    selector: 'app-root',
    template: `
        <div id="mapViewContainer" class="mapviewer-renderlayer" style="z-index: 0"></div>
        <map-panel></map-panel>
        <p-toast position="bottom-center" key="tc"></p-toast>
        <p-overlayPanel #searchoverlay>
            <search-menu-items></search-menu-items>
        </p-overlayPanel>
        <span class="p-input-icon-left search-input">
            <i class="pi pi-search"></i>
            <input type="text" pInputText [(ngModel)]="searchValue" (click)="searchoverlay.toggle($event)"
                   (ngModelChange)="setSubjectValue(searchValue)"/>
        </span>
        <div class="bttn-container" [ngClass]="{'elevated': inspectionService.isInspectionPanelVisible }">
            <p-button (click)="openHelp()" icon="pi pi-question" label="" class="help-button" pTooltip="Help"
                      tooltipPosition="right"></p-button>
            <p-button (click)="showPreferencesDialog()" icon="pi pi-cog" label="" class="pref-button"
                      pTooltip="Preferences" tooltipPosition="right"></p-button>
        </div>
        <p-dialog header="Preferences" [(visible)]="dialogVisible" [position]="'center'"
                  [resizable]="false" [modal]="true" #pref class="pref-dialog">
            <!-- Label and input field for MAX_NUM_TILES_TO_LOAD -->
            <label [for]="tilesToLoadInput">Max Tiles to Load:</label>
            <input type="number" pInputText [id]="tilesToLoadInput" placeholder="Enter max tiles to load" min="1"
                   [(ngModel)]="tilesToLoadInput"/><br>
            <!-- Label and input field for MAX_NUM_TILES_TO_VISUALIZE -->
            <label [for]="tilesToVisualizeInput">Max Tiles to Visualize:</label>
            <input type="number" pInputText [id]="tilesToVisualizeInput" placeholder="Enter max tiles to load" min="1"
                   [(ngModel)]="tilesToVisualizeInput"/><br>
            <!-- Apply button -->
            <p-button (click)="applyTileLimits()" label="Apply" icon="pi pi-check"></p-button>
            <p-button (click)="pref.close($event)" label="Cancel" icon="pi pi-times"></p-button>
        </p-dialog>
        <inspection-panel></inspection-panel>
        <div id="info">
            {{title}} {{version}}
        </div>
        <router-outlet></router-outlet>
    `,
    styles: [`
        @media only screen and (max-width: 56em) {
            .elevated {
                bottom: 3.5em;
                padding-bottom: 0;
            }
        }
    `]
})
export class AppComponent {

    title: string = 'erdblick';
    version: string = "v0.3.0";
    tilesToLoadInput: number = 0;
    tilesToVisualizeInput: number = 0;
    layers: Array<[string, string, any]> = new Array<[string, string, any]>();
    searchValue: string = ""

    leftTooltipItems: MenuItem[] | null = null;

    constructor(private httpClient: HttpClient,
                private router: Router,
                private activatedRoute: ActivatedRoute,
                public mapService: MapService,
                public jumpToTargetService: JumpTargetService,
                public styleService: StyleService,
                public inspectionService: InspectionService,
                public parametersService: ParametersService) {
        httpClient.get('./bundle/VERSION', {responseType: 'text'}).subscribe(
            data => {
                this.version = data.toString();
            });

        // this.parametersService.parameters.subscribe(parameters => {
        //     const entries = [...Object.entries(parameters)];
        //     entries.forEach(entry => entry[1] = JSON.stringify(entry[1]));
        //     this.updateQueryParams(Object.fromEntries(entries));
        // });

        libErdblickCore().then((coreLib: any) => {
            console.log("  ...done.")
            this.mapService.coreLib = coreLib;

            let erdblickModel = new ErdblickModel(coreLib, styleService);
            this.mapService.mapModel.next(erdblickModel);
            this.mapService.mapView = new ErdblickView(erdblickModel, 'mapViewContainer');

            this.mapService.reloadStyle();

            this.tilesToLoadInput = erdblickModel.maxLoadTiles;
            this.tilesToVisualizeInput = erdblickModel.maxVisuTiles;

            this.applyTileLimits();

            // Add debug API that can be easily called from browser's debug console
            window.ebDebug = new ErdblickDebugApi(this.mapService.mapView);

            this.mapService.mapView.selectionTopic.subscribe(selectedFeatureWrapper => {
                if (!selectedFeatureWrapper) {
                    this.inspectionService.isInspectionPanelVisible = false;
                    return;
                }

                selectedFeatureWrapper.peek((feature: Feature) => {
                    this.inspectionService.selectedFeatureGeoJsonText = feature.geojson() as string;
                    this.inspectionService.selectedFeatureIdText = feature.id() as string;
                    this.inspectionService.isInspectionPanelVisible = true;
                    this.inspectionService.loadFeatureData();
                })
            });

            this.mapService.mapModel.getValue()!.mapInfoTopic.subscribe((mapInfo: Object) => {
                let mapItems = new Map<string, ErdblickMap>();
                Object.entries(mapInfo).forEach(([mapName, mapInfoItem]) => {
                    let mapLayers: Array<ErdblickLayer> = new Array<ErdblickLayer>();
                    let firstCoverage = 0n;
                    Object.entries((mapInfoItem as MapInfoItem).layers).forEach(([layerName, layer]) => {
                        let layerCoverage = (layer as MapItemLayer).coverage;
                        if (layerCoverage.length > 0) {
                            firstCoverage = BigInt(layerCoverage[0]);
                        }
                        mapLayers.push({
                            name: layerName,
                            coverage: firstCoverage,
                            level: 13,
                            visible: true
                        });
                        this.mapService.mapModel.getValue()!.layerIdToLevel.set(mapName + '/' + layerName, 13);
                    })
                    mapItems.set(mapName, {
                        coverage: firstCoverage,
                        level: 13,
                        mapLayers: mapLayers,
                        visible: true
                    });
                });
                let mapLayers = [
                    {
                        name: "layerName1",
                        coverage: 1n,
                        level: 13,
                        visible: true
                    },
                    {
                        name: "layerName2",
                        coverage: 1n,
                        level: 13,
                        visible: true
                    }
                ]
                mapItems.set("mapName1", {
                    coverage: 1n,
                    level: 13,
                    mapLayers: mapLayers,
                    visible: true
                });
                mapItems.set("mapName2", {
                    coverage: 1n,
                    level: 13,
                    mapLayers: mapLayers,
                    visible: true
                });
                mapItems.set("mapName3", {
                    coverage: 1n,
                    level: 13,
                    mapLayers: mapLayers,
                    visible: true
                });
                this.mapService.mapModel.getValue()!.availableMapItems.next(mapItems);
                console.log(this.mapService.mapModel.getValue()!.availableMapItems.getValue());
            });

            // this.activatedRoute.queryParams.subscribe((params: Params) => {
            //     let currentParameters = this.parametersService.parameters.getValue();
            //     let newPosition = {
            //         x: params["x"] ? Number(params["x"]) : currentParameters.x,
            //         y: params["y"] ? Number(params["y"]) : currentParameters.y,
            //         z: params["z"] ? Number(params["z"]) : currentParameters.z
            //     }
            //     let newOrientation = {
            //         heading: params["heading"] ? Number(params["heading"]) : currentParameters.heading,
            //         pitch: params["pitch"] ? Number(params["pitch"]) : currentParameters.pitch,
            //         roll: params["roll"] ? Number(params["roll"]) : currentParameters.roll
            //     }
            //     if (this.mapService.mapView !== undefined) {
            //         this.mapService.mapView.viewer.camera.setView({
            //             destination: Cartesian3.fromElements(newPosition.x, newPosition.y, newPosition.z),
            //             orientation: newOrientation
            //         });
            //     }
            //     currentParameters.x = newPosition.x;
            //     currentParameters.y = newPosition.y;
            //     currentParameters.z = newPosition.z;
            //     currentParameters.heading = newOrientation.heading;
            //     currentParameters.roll = newOrientation.roll;
            //     currentParameters.pitch = newOrientation.pitch;
            //
            //     let osmOpacity = currentParameters.osmOpacity;
            //     if (params["osm"]) {
            //         osmOpacity = Number(params["osm"]);
            //     }
            //     this.mapService.osmEnabled = currentParameters.osmEnabled;
            //     this.mapService.osmOpacityValue = osmOpacity;
            //     this.mapService.mapView?.updateOpenStreetMapLayer(osmOpacity / 100);
            //     currentParameters.osmOpacity = osmOpacity;
            //
            //     let layerNamesLevels = currentParameters.layers;
            //     let currentLayers = new Array<Array<string>>;
            //     if (params["layers"]) {
            //         layerNamesLevels = JSON.parse(params["layers"]);
            //     }
            //     layerNamesLevels.forEach((nameLevel: Array<string>) => {
            //         const name = nameLevel[0];
            //         const level = Number(nameLevel[1]);
            //         if (mapService.mapModel.getValue()) {
            //             if (this.mapService.mapModel.getValue()!.layerIdToLevel.has(name)) {
            //                 this.mapService.mapModel.getValue()!.layerIdToLevel.set(name, level);
            //             }
            //             const [mapName, layerName] = name.split('/');
            //             this.mapService.mapModel.getValue()!.availableMapItems.getValue().forEach(
            //                 (mapItem: ErdblickMap, name: string) => {
            //                 if (name == mapName) {
            //                     mapItem.visible = true;
            //                     mapItem.mapLayers.forEach((mapLayer: ErdblickLayer) => {
            //                         if (mapLayer.name == layerName) {
            //                             mapLayer.visible = true;
            //                             currentLayers.push([`${mapName}/${layerName}`, level.toString()])
            //                         }
            //                     });
            //                 }
            //             });
            //         }
            //     });
            //     if (currentLayers) {
            //         currentParameters.layers = currentLayers;
            //     }
            //
            //     let styles = currentParameters.styles;
            //     if (params["styles"]) {
            //         styles = JSON.parse(params["styles"]);
            //     }
            //     let currentStyles = new Array<string>();
            //     [...this.styleService.activatedStyles.keys()].forEach(id => {
            //         const toActivate = styles.includes(id);
            //         this.styleService.activatedStyles.set(id, toActivate);
            //         if (toActivate) {
            //             currentStyles.push(id);
            //         }
            //     })
            //     if (currentStyles) {
            //         currentParameters.styles = currentStyles;
            //     }
            //     this.parametersService.parameters.next(currentParameters);
            // });
        });
    }

    dialogVisible: boolean = false;
    showPreferencesDialog() {
        this.dialogVisible = true;
    }

    applyTileLimits() {
        const tilesToLoad = this.tilesToLoadInput;
        const tilesToVisualize = this.tilesToVisualizeInput;

        if (isNaN(tilesToLoad) || isNaN(tilesToVisualize)) {
            alert("Please enter valid tile limits!");
            return;
        }

        if (this.mapService.mapModel.getValue()) {
            this.mapService.mapModel.getValue()!.maxLoadTiles = tilesToLoad;
            this.mapService.mapModel.getValue()!.maxVisuTiles = tilesToVisualize;
            this.mapService.mapModel.getValue()!.update();
        }

        console.log(`Max tiles to load set to ${tilesToLoad}`);
        console.log(`Max tiles to visualize set to ${tilesToVisualize}`);
    }

    tilesInputOnClick(event: Event) {
        // Prevent event propagation for input fields
        event.stopPropagation()
    }

    openHelp() {
        window.open("https://developer.nds.live/tools/the-new-mapviewer/user-guide", "_blank");
    }

    setSubjectValue(value: string) {
        this.jumpToTargetService.targetValueSubject.next(value);
    }

    // updateQueryParams(params: Params): void {
    //     this.router.navigate([], {
    //         queryParams: params,
    //         queryParamsHandling: 'merge',
    //         replaceUrl: true
    //     });
    // }
}
