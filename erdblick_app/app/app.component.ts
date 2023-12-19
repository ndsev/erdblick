import {Component, OnInit} from '@angular/core';
import {ErdblickView} from "./erdblick.view";
import {ErdblickModel} from "./erdblick.model";
import {DebugWindow, ErdblickDebugApi} from "./debugapi.component";
import {HttpClient} from "@angular/common/http";
import libErdblickCore, {Feature} from '../../build/libs/core/erdblick-core';
import {MenuItem, MessageService, TreeNode, TreeTableNode} from "primeng/api";
import {Cartesian3} from "cesium";

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

interface Column {
    field: string;
    header: string;
}

interface ErdblickMap {
    coverage: BigInt;
    level: number;
    mapLayers: Array<ErdblickLayer>;
}

interface ErdblickLayer {
    name: string;
    coverage: BigInt;
    level: number;
}

@Component({
    selector: 'app-root',
    template: `
        <div id="mapViewContainer" class="mapviewer-renderlayer" style="z-index: 0"></div>
        <p-dialog class="map-layer-dialog" header="Maps Layers Selection" [(visible)]="layerDialogVisible" [position]="'topleft'" [style]="{ width: '30em', padding: '0' }">
            <p-accordion>
                <p-accordionTab class="map-tab" *ngFor="let mapItem of mapItems | keyvalue">
                    <ng-template pTemplate="header">
                        <span class="flex align-items-center gap-2 w-full">
                            <span class="font-bold white-space-nowrap" class="ml-auto">{{ mapItem.key }}</span>
                        </span>
                    </ng-template>
                    <p-accordion>
                        <p-accordionTab class="layer-tab" *ngFor="let mapLayer of mapItem.value.mapLayers" >
                            <ng-template pTemplate="header">
                                <span class="flex align-items-center gap-2 w-full">
                                    <span class="font-bold white-space-nowrap" class="ml-auto">{{ mapLayer.name }}</span>
                                </span>
                            </ng-template>
                            <div class="flex align-items-center gap-2 w-full" style="padding: 0.5rem 1.25rem;">
                                <p-button (click)="focus(mapLayer.coverage, $event)" icon="pi pi-fw pi-eye" label=""
                                          [style]="{'margin-right': '1rem'}" pTooltip="Focus" tooltipPosition="bottom">
                                </p-button>
                                <p-inputNumber [(ngModel)]="mapLayer.level" (ngModelChange)="onLayerLevelChanged($event, mapLayer.name)" 
                                               [style]="{'width': '2rem'}" [showButtons]="true"
                                               buttonLayout="horizontal" spinnerMode="horizontal" inputId="horizontal"
                                               decrementButtonClass="p-button-secondary" incrementButtonClass="p-button-secondary"
                                               incrementButtonIcon="pi pi-plus" decrementButtonIcon="pi pi-minus" [min]="0" [max]="15" 
                                               pTooltip="Change zoom level" tooltipPosition="bottom">
                                </p-inputNumber>
                            </div>
                        </p-accordionTab>
                    </p-accordion>
                </p-accordionTab>
            </p-accordion>
        </p-dialog>
        <p-button (click)="showLayerDialog()" icon="pi pi-images" label="" pTooltip="Show map layers" tooltipPosition="right"
                  class="layers-button"></p-button>
        <p-toast position="bottom-center" key="tc"></p-toast>
        <p-overlayPanel #searchoverlay>
            <div *ngFor="let item of searchItems">
                <p-divider></p-divider>
                <p (click)="item.fun()" class="search-option"><span>{{item.name}}</span><br>{{item.label}}</p>
            </div>
        </p-overlayPanel>
        <span class="p-input-icon-left search-input">
            <i class="pi pi-search"></i>
            <input type="text" pInputText [(ngModel)]="searchValue" (click)="searchoverlay.toggle($event)"/>
        </span>
        <p-speedDial [model]="leftTooltipItems" className="speeddial-left" direction="up"></p-speedDial>
        <p-button (click)="openHelp()" icon="pi pi-question" label="" class="help-button" pTooltip="Help" tooltipPosition="right"></p-button>
        <p-dialog header="Tile Loading Limits" [(visible)]="dialogVisible" [position]="'bottomleft'"
                  [style]="{ width: '25em' }">
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
        </p-dialog>
        <p-accordion *ngIf="featureTree.length && isInspectionPanelVisible" class="w-full inspect-panel" [activeIndex]="0">
            <p-accordionTab>
                <ng-template pTemplate="header">
                    <div class="flex align-items-center">
                        <i class="pi pi-sitemap mr-2"></i>&nbsp;
                        <span class="vertical-align-middle">{{selectedFeatureIdText}}</span>
                    </div>
                </ng-template>
                <ng-template pTemplate="content" style="height: 90%">
                    <div class="resizable-container">
                    <p-treeTable #tt [value]="featureTree" [columns]="cols"
                                 class="panel-tree" filterMode="strict" [tableStyle]="{'min-width':'100%'}">
                        <ng-template pTemplate="caption">
                            <div class="flex justify-content-end align-items-center"
                                 style="display: flex; align-content: center; justify-content: center">
                                <div class="p-input-icon-left filter-container">
                                    <i class="pi pi-filter"></i>
                                    <input class="filter-input" type="text" pInputText placeholder="Filter data for selected feature"
                                           (input)="tt.filterGlobal(getFilterValue($event), 'contains')"/>
                                </div>
                                <div>
                                    <p-button (click)="copyGeoJsonToClipboard()" icon="pi pi-fw pi-copy" label=""
                                              [style]="{'margin-left': '0.8rem', width: '2rem', height: '2rem'}"
                                              pTooltip="Copy GeoJSON" tooltipPosition="bottom">
                                    </p-button>
                                </div>
                            </div>
                        </ng-template>
                        <ng-template pTemplate="body" let-rowNode let-rowData="rowData">
                            <tr [ttRow]="rowNode">
                                <td *ngFor="let col of cols; let i = index">
                                    <div style="white-space: nowrap; overflow-x: auto; scrollbar-width: thin;" [pTooltip]="rowData[col.field].toString()" tooltipPosition="left" [tooltipOptions]="tooltipOptions">
                                        <p-treeTableToggler [rowNode]="rowNode" *ngIf="i === 0"></p-treeTableToggler>
                                        <span>{{ rowData[col.field] }}</span>
                                    </div>
                                </td>
                            </tr>
                        </ng-template>
                        <ng-template pTemplate="emptymessage">
                            <tr>
                                <td [attr.colspan]="cols.length">No data found.</td>
                            </tr>
                        </ng-template>
                    </p-treeTable>
                    </div>
                </ng-template>
            </p-accordionTab>
        </p-accordion>
        <div id="info">
            {{title}} {{version}}
        </div>
        <router-outlet></router-outlet>
    `,
    styles: []
})
export class AppComponent implements OnInit {
    featureTree: TreeNode[] = [];
    title: string = 'erdblick';
    version: string = "v0.3.0";
    mapModel: ErdblickModel | undefined;
    mapView: ErdblickView | undefined;
    tilesToLoadInput: number = 0;
    tilesToVisualizeInput: number = 0;
    selectedFeatureGeoJsonText: string = "";
    selectedFeatureIdText: string = "";
    isInspectionPanelVisible: boolean = false;
    layers: Array<[string, string, any]> = new Array<[string, string, any]>();
    coreLib: any
    searchValue: string = ""

    leftTooltipItems: MenuItem[] | null = null;
    mapItems: Map<string, ErdblickMap> = new Map<string, ErdblickMap>();
    cols: Column[] = [];

    searchItems: Array<any> = [];

    tooltipOptions = {
        showDelay: 1500,
        autoHide: false
    };

    constructor(private httpClient: HttpClient,
                private messageService: MessageService) {
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
                    this.isInspectionPanelVisible = false;
                    return;
                }

                selectedFeatureWrapper.peek((feature: Feature) => {
                    this.selectedFeatureGeoJsonText = feature.geojson() as string;
                    this.selectedFeatureIdText = feature.id() as string;
                    this.isInspectionPanelVisible = true;
                    this.loadFeatureData();
                })
            })

            this.mapModel.mapInfoTopic.subscribe((mapInfo: Object) => {
                this.mapItems = new Map<string, ErdblickMap>();
                Object.entries(mapInfo).forEach(([mapName, mapInfoItem]) => {
                    let mapLayers: Array<ErdblickLayer> = new Array<ErdblickLayer>();
                    let firstCoverage = 0n;
                    Object.entries((mapInfoItem as MapInfoItem).layers).forEach(([layerName, layer]) => {
                        let layerCoverage = (layer as MapItemLayer).coverage;
                        if (layerCoverage.length > 0) {
                            firstCoverage = BigInt(layerCoverage[0]);
                        }
                        mapLayers.push(
                            {
                                name: mapName + '/' + layerName,
                                coverage: firstCoverage,
                                level: 13
                            }
                        );
                        this.mapModel?.layerIdToLevel.set(mapName + '/' + layerName, 13);
                    })
                    this.mapItems.set(
                        mapName,
                        {
                            coverage: firstCoverage,
                            level: 13,
                            mapLayers: mapLayers
                        }
                    );
                });
                console.log("MapInfo", mapInfo);
            });
        })
    }

    dialogVisible: boolean = false;
    showDialog() {
        this.dialogVisible = true;
    }

    layerDialogVisible: boolean = false;
    showLayerDialog() {
        this.layerDialogVisible = true;
    }

    ngOnInit(): void {
        this.leftTooltipItems = [
            {
                tooltipOptions: {
                    tooltipLabel: 'Reload Style',
                    tooltipPosition: 'left'
                },
                icon: 'pi pi-replay',
                command: () => {
                    this.reloadStyle();
                }
            },
            {
                tooltipOptions: {
                    tooltipLabel: 'Tile Loading Limits',
                    tooltipPosition: 'left'
                },
                icon: 'pi pi-pencil',
                command: () => {
                    this.showDialog();
                }
            }
        ];

        this.cols = [
            { field: 'k', header: 'Key' },
            { field: 'v', header: 'Value' }
        ];

        this.searchItems = [
            {
                name: "Tile ID",
                label: "Jump to WGS84 Tile by its ID",
                fun: () => { this.jumpToWGS84Tile() }
            },
            {
                name: "WGS84 Lat-Lon Coordinates",
                label: "Jump to WGS84 Coordinates",
                fun: () => { this.jumpToWGS84() }
            },
            {
                name: "WGS84 Lon-Lat Coordinates",
                label: "Jump to WGS84 Coordinates",
                fun: () => { this.jumpToWGS84(true) }
            },
            {
                name: "Open Lat-Lon in Google Maps",
                label: "Open Location in External Map Service",
                fun: () => { this.openInGM() }
            },
            {
                name: "Open Lat-Lon in Open Street Maps",
                label: "Open Location in External Map Service",
                fun: () => { this.openInOSM() }
            }
        ]
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

    focus(tileId: BigInt, event: any) {
        event.stopPropagation();
        if (this.mapModel !== undefined && this.coreLib !== undefined) {
            this.mapModel.zoomToWgs84PositionTopic.next(this.coreLib.getTilePosition(tileId));
        }
    }

    onLayerLevelChanged(event: Event, layerName: string) {
        let level = Number(event.toString());
        if (this.mapModel !== undefined) {
            this.mapModel.layerIdToLevel.set(layerName, level);
            this.mapModel.update();
        } else {
            this.showError("Cannot access the map model. The model is not available.");
        }
    }

    getFeatureTreeData() {
        let jsonData = JSON.parse(this.selectedFeatureGeoJsonText);
        if (jsonData.hasOwnProperty("id")) {
            delete jsonData["id"];
        }
        if (jsonData.hasOwnProperty("properties")) {
            jsonData["attributes"] = jsonData["properties"];
            delete jsonData["properties"];
        }
        // Push leaf values up
        const sortedJson: Record<string, any> = {};
        for (const key in jsonData) {
            if (typeof jsonData[key] === "string" || typeof jsonData[key] === "number") {
                sortedJson[key] = jsonData[key];
            }
        }
        for (const key in jsonData) {
            if (typeof jsonData[key] !== "string" && typeof jsonData[key] !== "number") {
                sortedJson[key] = jsonData[key];
            }
        }


        let convertToTreeTableNodes = (json: any): TreeTableNode[] => {
            const treeTableNodes: TreeTableNode[] = [];

            for (const key in json) {
                if (json.hasOwnProperty(key)) {
                    const value = json[key];
                    const node: TreeTableNode = {};

                    if (typeof value === 'object' && value !== null) {
                        if (Array.isArray(value)) {
                            // If it's an array, iterate through its elements and convert them to TreeTableNodes
                            node.data = {k: key, v: "", t: ""};
                            node.children = value.map((item: any, index: number) => {
                                if (typeof item === 'object') {
                                    return {data: {k: index, v: "", t: typeof item}, children: convertToTreeTableNodes(item)};
                                } else {
                                    return {data: {k: index, v: item.toString(), t: typeof item}};
                                }
                            });
                        } else {
                            // If it's an object, recursively call the function to convert it to TreeTableNodes
                            node.data = {k: key, v: "", t: ""}
                            node.children = convertToTreeTableNodes(value);
                        }
                    } else {
                        // If it's a primitive value, set it as the node's data
                        node.data = {k: key, v: value, t: typeof value};
                    }

                    treeTableNodes.push(node);
                }
            }

            return treeTableNodes;
        }

        return convertToTreeTableNodes(sortedJson);
    }

    typeToBackground(type: string) {
        if (type == "string") {
            return "#4а4";
        } else {
            return "#ad8";
        }
    }

    getFilterValue(event: Event) {
        return (event.target as HTMLInputElement).value;
    }

    loadFeatureData() {
        this.featureTree = this.getFeatureTreeData();
    }

    jumpToWGS84Tile() {
        if (!this.searchValue) {
            this.showError("No value provided!");
            return;
        }
        if (this.mapModel !== undefined) {
            try {
                let wgs84TileId = BigInt(this.searchValue);
                this.mapModel.zoomToWgs84PositionTopic.next(this.coreLib.getTilePosition(wgs84TileId));
            } catch (e) {
                this.showError("Possibly malformed TileId: " + (e as Error).message.toString());
            }
        } else {
            this.showError("Cannot access the map model. The model is not available.");
        }
    }

    parseWgs84Coordinates(coordinateString: string, isLonLat: boolean)
    {
        let lon = 0;
        let lat = 0;
        let level = 0;
        let isMatched = false;
        coordinateString = coordinateString.trim();

        // WGS (decimal)
        let exp = /^[^\d-]*(-?\d+(?:\.\d*)?)[^\d-]+(-?\d+(?:\.\d*)?)[^\d\.]*(\d+)?[^\d]*$/g;
        let matches = [...coordinateString.matchAll(exp)];
        if (matches.length > 0) {
            let matchResults = matches[0];
            if (matchResults.length >= 3) {
                if (isLonLat) {
                    lon = Number(matchResults[1]);
                    lat = Number(matchResults[2]);
                } else {
                    lon = Number(matchResults[2]);
                    lat = Number(matchResults[1]);
                }

                if (matchResults.length >= 4 && matchResults[3] !== undefined) {
                    // Zoom level provided.
                    level = Math.max(1, Math.min(Number(matchResults[3].toString()), 14));
                }
                isMatched = true;
            }
        }

        // WGS (degree)
        if (isLonLat) {
            exp = /([1-9][0-9]{0,2}|0)°([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([WE])\s*([1-9][0-9]{0,2}|0)°([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([NS])[^\d\.]*(\d+)?[^\d]*$/g;
        } else {
            exp = /([1-9][0-9]{0,2}|0)°([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([NS])\s*([1-9][0-9]{0,2}|0)°([0-5]{0,1}[0-9])'((?:[0-5]{0,1}[0-9])(?:.{1}[0-9][0-9]{0,3})?)["]([WE])[^\d\.]*(\d+)?[^\d]*$/g;
        }
        matches = [...coordinateString.matchAll(exp)];
        if (!isMatched && matches.length > 0) {
            let matchResults = matches[0];
            if (matchResults.length >= 9) {
                let degreeLon = isLonLat ? Number(matchResults[1]) : Number(matchResults[5]);
                let minutesLon = isLonLat ? Number(matchResults[2]) : Number(matchResults[6]);
                let secondsLon = isLonLat ? Number(matchResults[3]) : Number(matchResults[7]);
                let degreeLat = isLonLat ? Number(matchResults[5]) : Number(matchResults[1]);
                let minutesLat = isLonLat ? Number(matchResults[6]) : Number(matchResults[2]);
                let secondsLat = isLonLat ? Number(matchResults[7]) : Number(matchResults[3]);

                lat = degreeLat + (minutesLat * 60.0 + secondsLat) / 3600.0;
                if (matchResults[4][0] == 'S') {
                    lat = -lat;
                }

                lon = degreeLon + (minutesLon * 60.0 + secondsLon) / 3600.0;
                if (matchResults[8][0] == 'W') {
                    lon = -lon;
                }

                if (matchResults.length >= 10 && matchResults[9] !== undefined) {
                    // Zoom level provided.
                    level = Math.max(1, Math.min(Number(matchResults[9].toString()), 14));
                }

                isMatched = true;
            }
        }

        if (isMatched) {
            return [lat, lon, level];
        }
        this.showError("Could not parse coordinates from the input.");
        return undefined;
    }

    jumpToWGS84(isLonLat: boolean = false) {
        if (!this.searchValue) {
            this.showError("No value provided!");
            return;
        }
        let result = this.parseWgs84Coordinates(this.searchValue, isLonLat);
        if (result !== undefined) {
            let lat = result[0];
            let lon = result[1];
            let position = Cartesian3.fromDegrees(lon, lat, 15000);
            let orientation = this.collectCameraInfo();
            if (orientation) {
                if (this.mapView !== undefined) {
                    this.mapView.viewer.camera.setView({
                        destination: position,
                        orientation: orientation
                    });
                } else {
                    this.showError("Cannot set camera information. The view is not available.");
                }
            }
        }
    }

    openInGM() {
        if (!this.searchValue) {
            this.showError("No value provided!");
            return;
        }
        let result = this.parseWgs84Coordinates(this.searchValue, false);
        if (result !== undefined) {
            let lat = result[0];
            let lon = result[1];
            window.open(`https://www.google.com/maps/search/?api=1&query=${lat},${lon}`, "_blank");
        }
    }

    openInOSM() {
        if (!this.searchValue) {
            this.showError("No value provided!");
            return;
        }
        let result = this.parseWgs84Coordinates(this.searchValue, false);
        if (result !== undefined) {
            let lat = result[0];
            let lon = result[1];
            window.open(`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}&zoom=16`, "_blank");
        }
    }

    showError(content: string) {
        this.messageService.add({ key: 'tc', severity: 'error', summary: 'Error', detail: content });
        return;
    }

    showSuccess(content: string) {
        this.messageService.add({ key: 'tc', severity: 'success', summary: 'Success', detail: content });
        return;
    }

    collectCameraInfo() {
        if (this.mapView !== undefined) {
            return {
                heading: this.mapView.viewer.camera.heading,
                pitch: this.mapView.viewer.camera.pitch,
                roll: this.mapView.viewer.camera.roll
            };
        } else {
            this.showError("Cannot get camera information. The view is not available.");
        }
        return null;
    }

    copyGeoJsonToClipboard() {
        navigator.clipboard.writeText(this.selectedFeatureGeoJsonText).then(
            () => {
                this.showSuccess("Copied GeoJSON content to clipboard!");
            },
            () => {
                this.showError("Could not copy GeoJSON content to clipboard.");
            },
        );
    }

    openHelp() {
        window.open("https://developer.nds.live/tools/mapviewer-user-guide", "_blank");
    }
}
