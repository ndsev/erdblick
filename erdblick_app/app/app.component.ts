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
import {ActivatedRoute, Params} from "@angular/router";
import {Cartesian3} from "cesium";
import {StyleService} from "./style.service";

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
        <!--        <p-speedDial [model]="leftTooltipItems" className="speeddial-left" direction="up"></p-speedDial>-->
        <div class="bttn-container" [ngClass]="{'elevated': isInspectionPanelVisible }">
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
        <p-accordion *ngIf="featureTree.length && isInspectionPanelVisible" class="w-full inspect-panel"
                     [activeIndex]="0">
            <p-accordionTab>
                <ng-template pTemplate="header">
                    <div class="flex align-items-center">
                        <i class="pi pi-sitemap mr-2"></i>&nbsp;
                        <span class="vertical-align-middle">{{selectedFeatureIdText}}</span>
                    </div>
                </ng-template>
                <ng-template pTemplate="content">
                    <div class="resizable-container" [ngClass]="{'resizable-container-expanded': isExpanded }">
                        <div class="resize-handle" (click)="isExpanded = !isExpanded">
                            <i *ngIf="!isExpanded" class="pi pi-chevron-up"></i>
                            <i *ngIf="isExpanded" class="pi pi-chevron-down"></i>
                        </div>
                        <p-treeTable #tt [value]="featureTree" [columns]="cols"
                                     class="panel-tree" filterMode="strict" [tableStyle]="{'min-width':'100%'}">
                            <ng-template pTemplate="caption">
                                <div class="flex justify-content-end align-items-center"
                                     style="display: flex; align-content: center; justify-content: center">
                                    <div class="p-input-icon-left filter-container">
                                        <i class="pi pi-filter"></i>
                                        <input class="filter-input" type="text" pInputText
                                               placeholder="Filter data for selected feature"
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
                                        <div style="white-space: nowrap; overflow-x: auto; scrollbar-width: thin;"
                                             [pTooltip]="rowData[col.field].toString()" tooltipPosition="left"
                                             [tooltipOptions]="tooltipOptions">
                                            <p-treeTableToggler [rowNode]="rowNode"
                                                                *ngIf="i === 0"></p-treeTableToggler>
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
    styles: [`
        @media only screen and (max-width: 56em) {
            .elevated {
                bottom: 3.5em;
                padding-bottom: 0;
            }
            
            .resizable-container-expanded {
                height: calc(100vh - 3em);;
            }
        }
    `]
})
export class AppComponent implements OnInit {
    featureTree: TreeNode[] = [];
    title: string = 'erdblick';
    version: string = "v0.3.0";
    tilesToLoadInput: number = 0;
    tilesToVisualizeInput: number = 0;
    selectedFeatureGeoJsonText: string = "";
    selectedFeatureIdText: string = "";
    isInspectionPanelVisible: boolean = false;
    layers: Array<[string, string, any]> = new Array<[string, string, any]>();
    searchValue: string = ""

    leftTooltipItems: MenuItem[] | null = null;

    cols: Column[] = [];

    tooltipOptions = {
        showDelay: 1500,
        autoHide: false
    };

    isExpanded: boolean = false;

    constructor(private httpClient: HttpClient,
                private activatedRoute: ActivatedRoute,
                private mapService: MapService,
                private messageService: InfoMessageService,
                private jumpToTargetService: JumpTargetService,
                public styleService: StyleService) {
        httpClient.get('./bundle/VERSION', {responseType: 'text'}).subscribe(
            data => {
                this.version = data.toString();
            });

        libErdblickCore().then((coreLib: any) => {
            console.log("  ...done.")
            this.mapService.coreLib = coreLib;

            this.mapService.mapModel = new ErdblickModel(coreLib, styleService);
            this.mapService.mapView = new ErdblickView(this.mapService.mapModel, 'mapViewContainer');

            this.mapService.reloadStyle();

            this.tilesToLoadInput = this.mapService.mapModel.maxLoadTiles;
            this.tilesToVisualizeInput = this.mapService.mapModel.maxVisuTiles;

            this.applyTileLimits();

            // Add debug API that can be easily called from browser's debug console
            window.ebDebug = new ErdblickDebugApi(this.mapService.mapView);

            this.mapService.mapView.selectionTopic.subscribe(selectedFeatureWrapper => {
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

            this.mapService.mapModel.mapInfoTopic.subscribe((mapInfo: Object) => {
                this.mapService.mapModel!.availableMapItems = new Map<string, ErdblickMap>();
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
                                name: layerName,
                                coverage: firstCoverage,
                                level: 13,
                                visible: true
                            }
                        );
                        this.mapService.mapModel!.layerIdToLevel.set(mapName + '/' + layerName, 13);
                    })
                    this.mapService.mapModel!.availableMapItems.set(
                        mapName,
                        {
                            coverage: firstCoverage,
                            level: 13,
                            mapLayers: mapLayers,
                            visible: true
                        }
                    );
                });
            });

            this.activatedRoute.queryParams.subscribe((params: Params) => {
                let currentOrientation = this.mapService.collectCameraOrientation();
                let currentPosition = this.mapService.collectCameraPosition();

                if (currentOrientation && currentPosition) {
                    let newPosition = {
                        x: params["x"] ? params["x"] : currentPosition.x,
                        y: params["y"] ? params["y"] : currentPosition.y,
                        z: params["z"] ? params["z"] : currentPosition.z
                    }
                    let newOrientation = {
                        heading: params["heading"] ? params["heading"] : currentOrientation.heading,
                        pitch: params["pitch"] ? params["pitch"] : currentOrientation.pitch,
                        roll: params["roll"] ? params["roll"] : currentOrientation.roll
                    }
                    if (this.mapService.mapView !== undefined) {
                        this.mapService.mapView.viewer.camera.setView({
                            destination: Cartesian3.fromElements(newPosition.x, newPosition.y, newPosition.z),
                            orientation: newOrientation
                        });
                    }
                }

                if (params["osm"]) {
                    let osmOpacity = Number(params["osm"]);
                    this.mapService.osmEnabled = !!osmOpacity;
                    this.mapService.osmOpacityValue = osmOpacity;
                    this.mapService.mapView?.updateOpenStreetMapLayer(osmOpacity / 100);
                }

                if (params["layers"]) {
                    let mapLayerNamesLevels: Array<Array<string>> = JSON.parse(params["layers"]);
                    mapLayerNamesLevels.forEach((nameLevel: Array<string>) => {
                        if (this.mapService.mapModel !== undefined) {
                            const name = nameLevel[0];
                            const level = Number(nameLevel[1]);
                            this.mapService.mapModel.layerIdToLevel.set(name, level);
                            const [mapName, layerName] = name.split('/');
                            this.mapService.mapModel.availableMapItems.forEach((mapItem: ErdblickMap, name: string) => {
                                if (name == mapName) {
                                    mapItem.visible = true;
                                    mapItem.mapLayers.forEach((mapLayer: ErdblickLayer) => {
                                        if (mapLayer.name == layerName) {
                                            mapLayer.visible = true;
                                        }
                                    });
                                }
                            })
                        }
                    });
                }

                if (params["styles"]) {
                    let styles: Array<Array<string>> = JSON.parse(params["styles"]);
                    styles.forEach((style: Array<string>) => {
                        const name = style[0];
                        const activated = style[1] == "true";
                        if (this.styleService.activatedStyles.has(name)) {
                            this.styleService.activatedStyles.set(name, activated);
                        }
                        this.mapService.reloadStyle();
                    });
                }
            });
        })
    }

    dialogVisible: boolean = false;
    showPreferencesDialog() {
        this.dialogVisible = true;
    }

    ngOnInit(): void {
        this.cols = [
            { field: 'k', header: 'Key' },
            { field: 'v', header: 'Value' }
        ];
    }

    applyTileLimits() {
        const tilesToLoad = this.tilesToLoadInput;
        const tilesToVisualize = this.tilesToVisualizeInput;

        if (isNaN(tilesToLoad) || isNaN(tilesToVisualize)) {
            alert("Please enter valid tile limits!");
            return;
        }

        if (this.mapService.mapModel !== undefined) {
            this.mapService.mapModel.maxLoadTiles = tilesToLoad;
            this.mapService.mapModel.maxVisuTiles = tilesToVisualize;
            this.mapService.mapModel.update();
        }

        console.log(`Max tiles to load set to ${tilesToLoad}`);
        console.log(`Max tiles to visualize set to ${tilesToVisualize}`);
    }

    tilesInputOnClick(event: Event) {
        // Prevent event propagation for input fields
        event.stopPropagation()
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

    copyGeoJsonToClipboard() {
        navigator.clipboard.writeText(this.selectedFeatureGeoJsonText).then(
            () => {
                this.messageService.showSuccess("Copied GeoJSON content to clipboard!");
            },
            () => {
                this.messageService.showError("Could not copy GeoJSON content to clipboard.");
            },
        );
    }

    openHelp() {
        window.open("https://developer.nds.live/tools/the-new-mapviewer/user-guide", "_blank");
    }

    setSubjectValue(value: string) {
        this.jumpToTargetService.targetValueSubject.next(value);
    }
}
