import {Component, OnInit, QueryList, ViewChildren} from '@angular/core';
import {ErdblickView} from "./erdblick.view";
import {ErdblickModel} from "./erdblick.model";
import {DebugWindow, ErdblickDebugApi} from "./debugapi.component";
import {HttpClient} from "@angular/common/http";
import libErdblickCore, {Feature} from '../../build/libs/core/erdblick-core';
import {MenuItem, MessageService, TreeNode, TreeTableNode} from "primeng/api";
import {Cartesian3} from "cesium";
import {Accordion, AccordionTab} from "primeng/accordion";
import {InfoMessageService} from "./info.service";
import {JumpTargetService} from "./jump.service";
import {MapService} from "./map.service";

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
        <p-dialog class="map-layer-dialog" header="Maps Layers Selection" [(visible)]="layerDialogVisible" [position]="'topleft'" [style]="{ width: '25rem', 'min-width': '25rem', margin: '0' }">
            <div class="tabs-container">
            <p-fieldset class="map-tab" *ngFor="let mapItem of mapItems | keyvalue" [legend]="mapItem.key">
                <p-accordion [multiple]="true" #accordions>
                    <p-accordionTab class="layer-tab" *ngFor="let mapLayer of mapItem.value.mapLayers">
                        <ng-template pTemplate="header">
                            <span class="flex align-items-center gap-2 w-full">
                                <span class="font-bold white-space-nowrap" class="ml-auto">{{ mapLayer.name }}</span>
                            </span>
                        </ng-template>
                        <div class="flex-container" style="padding: 0.5rem 1.25rem;">
                            <p-button *ngIf="mapLayer.coverage" (click)="focus(mapLayer.coverage, $event)" icon="pi pi-fw pi-eye" 
                                      label="" [style]="{'margin-right': '1rem'}" pTooltip="Focus" tooltipPosition="bottom">
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
            </p-fieldset>
            </div>
        </p-dialog>
        <p-button (click)="showLayerDialog()" icon="pi pi-images" label="" pTooltip="Show map layers" tooltipPosition="right"
                  class="layers-button"></p-button>
        <p-toast position="bottom-center" key="tc"></p-toast>
        <p-overlayPanel #searchoverlay>
            <search-menu-items></search-menu-items>
        </p-overlayPanel>
        <span class="p-input-icon-left search-input">
            <i class="pi pi-search"></i>
            <input type="text" pInputText [(ngModel)]="searchValue" (click)="searchoverlay.toggle($event)" (ngModelChange)="setSubjectValue(searchValue)"/>
        </span>
        <p-speedDial [model]="leftTooltipItems" className="speeddial-left" direction="up"></p-speedDial>
        <p-button (click)="openHelp()" icon="pi pi-question" label="" class="help-button" pTooltip="Help" tooltipPosition="right"></p-button>
        <p-dialog header="Tile Loading Limits" [(visible)]="dialogVisible" [position]="'bottomleft'"
                  [style]="{ width: '25em', margin: '0' }">
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
    tilesToLoadInput: number = 0;
    tilesToVisualizeInput: number = 0;
    selectedFeatureGeoJsonText: string = "";
    selectedFeatureIdText: string = "";
    isInspectionPanelVisible: boolean = false;
    layers: Array<[string, string, any]> = new Array<[string, string, any]>();
    searchValue: string = ""

    leftTooltipItems: MenuItem[] | null = null;
    mapItems: Map<string, ErdblickMap> = new Map<string, ErdblickMap>();
    cols: Column[] = [];

    tooltipOptions = {
        showDelay: 1500,
        autoHide: false
    };

    @ViewChildren('accordions') accordions!: QueryList<Accordion>;

    constructor(private httpClient: HttpClient,
                private mapService: MapService,
                private messageService: InfoMessageService,
                private jumpToTargetService: JumpTargetService) {
        httpClient.get('./bundle/VERSION', {responseType: 'text'}).subscribe(
            data => {
                this.version = data.toString();
            });

        libErdblickCore().then((coreLib: any) => {
            console.log("  ...done.")
            this.mapService.coreLib = coreLib;

            this.mapService.mapModel = new ErdblickModel(coreLib);
            this.mapService.mapView = new ErdblickView(this.mapService.mapModel, 'mapViewContainer');

            this.reloadStyle();

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
                        this.mapService.mapModel?.layerIdToLevel.set(mapName + '/' + layerName, 13);
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
        this.expandAccordions();
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

    reloadStyle() {
        if (this.mapService.mapModel !== undefined) this.mapService.mapModel.reloadStyle();
    }

    tilesInputOnClick(event: Event) {
        // Prevent event propagation for input fields
        event.stopPropagation()
    }

    focus(tileId: BigInt, event: any) {
        event.stopPropagation();
        if (this.mapService.mapModel !== undefined && this.mapService.coreLib !== undefined) {
            this.mapService.mapModel.zoomToWgs84PositionTopic.next(this.mapService.coreLib.getTilePosition(tileId));
        }
    }

    onLayerLevelChanged(event: Event, layerName: string) {
        let level = Number(event.toString());
        if (this.mapService.mapModel !== undefined) {
            this.mapService.mapModel.layerIdToLevel.set(layerName, level);
            this.mapService.mapModel.update();
        } else {
            this.messageService.showError("Cannot access the map model. The model is not available.");
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

    expandAccordions() {
        if (this.accordions) {
            this.accordions.forEach(accordion => {
                accordion.tabs.forEach((tab: AccordionTab) => {
                    tab.selected = true;
                });
            });
        }
    }

    setSubjectValue(value: string) {
        this.jumpToTargetService.targetValueSubject.next(value);
    }
}
