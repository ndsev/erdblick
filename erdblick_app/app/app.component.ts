import {Component, OnInit, ViewChild} from '@angular/core';
import {ErdblickView} from "./erdblick.view";
import {ErdblickModel} from "./erdblick.model";
import {DebugWindow, ErdblickDebugApi} from "./debugapi.component";
import {HttpClient} from "@angular/common/http";
import libErdblickCore, {Feature} from '../../build/libs/core/erdblick-core';
import {MenuItem, TreeNode, TreeTableNode} from "primeng/api";
import {TreeTable, TreeTableLazyLoadEvent} from "primeng/treetable";

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

        <!--        <div [hidden]="!isSelectionPanelVisible" id="selectionPanel" class="panel">-->
        <!--            <span class="toggle-indicator"></span>-->
        <!--            <span>Selected Feature: </span><span id="selectedFeatureId">{{selectedFeatureIdText}}</span>-->
        <!--            <pre id="selectedFeatureGeoJson">{{selectedFeatureGeoJsonText}}</pre> &lt;!&ndash; Use <pre> for preserving whitespace &ndash;&gt;-->
        <!--        </div>-->
        <p-dialog class="map-layer-dialog" header="Maps Layers Selection" [(visible)]="layerDialogVisible"
                  [position]="'topleft'" [style]="{ width: '30em', padding: '0' }">
            <p-panelMenu [model]="items" [style]="{width:'100%', margin: '0'}" [multiple]="true"></p-panelMenu>
        </p-dialog>
        <p-button (click)="showLayerDialog()" icon="pi pi-images" label=""
                  [style]="{position: 'absolute', top: '1.5em', left: '0.5em', width: '3.25em', height: '3.25em'}"></p-button>
        <div id="info">
            {{title}} {{version}} //
            <p-button (click)="reloadStyle()" label="Reload Style"></p-button>
        </div>
        <p-overlayPanel #searchoverlay>
            <p>Tile ID<br>Jump to NDS Tile by its Packed ID</p>
            <p-divider></p-divider>
            <p>New View Filter<br>Constant Expression matches all visible features</p>
            <p-divider></p-divider>
            <p>WGS84 Lat-Lon Coordinates<br>Jump to WGS84 Coordinates</p>
            <p-divider></p-divider>
            <p>Open in Google Maps<br>Open Location in External Map Service</p>
            <p-divider></p-divider>
            <p>Find Feature by Generic ID<br>Find all features which are identified by number</p>
        </p-overlayPanel>
        <span class="p-input-icon-left search-input">
            <i class="pi pi-search"></i>
            <input type="text" pInputText [(ngModel)]="searchValue" (click)="searchoverlay.toggle($event)"/>
        </span>
        <p-speedDial [model]="leftTooltipItems" className="speeddial-left" direction="up"></p-speedDial>
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

        <p-accordion *ngIf="featureTree.length" class="w-full inspect-panel">
            <p-accordionTab>
                <ng-template pTemplate="header">
                    <div class="flex align-items-center">
                        <i class="pi pi-sitemap mr-2"></i>&nbsp;
                        <span class="vertical-align-middle">Inspect</span>
                    </div>
                </ng-template>
                <ng-template pTemplate="content" style="height: 90%">
                    <!--                    <p *ngIf="!featureTree.length">No feature selected!</p>-->
                    <!--                    <p-tree *ngIf="featureTree.length" [value]="featureTree" class="w-full panel-tree" [filter]="true" filterMode="strict" filterPlaceholder="Filter"></p-tree>-->
                    <p-treeTable #tt [value]="featureTree"
                                 [columns]="cols" [scrollable]="true" [scrollHeight]="'calc(100vh - 11em)'"
                                 class="panel-tree" filterMode="strict" [tableStyle]="{'min-width':'100%'}">
                        <ng-template pTemplate="caption">
                            <div class="flex justify-content-end align-items-center">
                                <div class="p-input-icon-left">
                                    <i class="pi pi-search"></i>
                                    <input class="filter-input" type="text" pInputText placeholder="Filter"
                                           (input)="tt.filterGlobal(getFilterValue($event), 'contains')"/>
                                </div>
                            </div>
                        </ng-template>
                        <ng-template pTemplate="body" let-rowNode let-rowData="rowData">
                            <tr [ttRow]="rowNode">
                                <td *ngFor="let col of cols; let i = index">
                                    <p-treeTableToggler [rowNode]="rowNode" *ngIf="i === 0"></p-treeTableToggler>
                                    <span>{{ rowData[col.field] }}</span>
                                </td>
                            </tr>
                        </ng-template>
                        <ng-template pTemplate="emptymessage">
                            <tr>
                                <td [attr.colspan]="cols.length">No data found.</td>
                            </tr>
                        </ng-template>
                    </p-treeTable>
                </ng-template>
            </p-accordionTab>
        </p-accordion>
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
    isSelectionPanelVisible: boolean = false;
    layers: Array<[string, string, any]> = new Array<[string, string, any]>();
    coreLib: any
    searchValue: string = ""

    leftTooltipItems: MenuItem[] | null = null;
    items: MenuItem[] = [];
    cols: Column[] = [];

    constructor(private httpClient: HttpClient) {
        httpClient.get('./bundle/VERSION', {responseType: 'text'}).subscribe(
            data => {
                this.version = data.toString();
            });

        // this.files = this.getMockUpTreeData();

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

                selectedFeatureWrapper.peek((feature: Feature) => {
                    this.selectedFeatureGeoJsonText = feature.geojson() as string;
                    this.selectedFeatureIdText = feature.id() as string;
                    this.isSelectionPanelVisible = true;
                    this.loadFeatureData();
                })
            })

            this.mapModel.mapInfoTopic.subscribe((mapInfo: Object) => {
                this.items = [];
                Object.entries(mapInfo).forEach(([mapName, mapInfoItem]) => {
                    Object.entries((mapInfoItem as MapInfoItem).layers).forEach(([layerName, layer]) => {
                        let coverage = (layer as MapItemLayer).coverage;
                        if (coverage !== undefined && coverage[0] !== undefined) {
                            this.items.push(
                                {
                                    label: mapName + ' / ' + layerName,
                                    icon: '',
                                    items: [
                                        {
                                            label: 'Focus',
                                            icon: 'pi pi-fw pi-eye',
                                            command: () => {
                                                if (this.mapModel !== undefined && this.coreLib !== undefined) {
                                                    this.mapModel.zoomToWgs84PositionTopic.next(this.coreLib.getTilePosition(BigInt(coverage[0])));
                                                }
                                            }
                                        }
                                    ]
                                }
                            )
                        }
                    })
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
                    tooltipLabel: 'Tile Loading Limits',
                    tooltipPosition: 'left'
                },
                icon: 'pi pi-pencil',
                command: () => {
                    this.showDialog()
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

    getFeatureTreeData() {
        let jsonData: Object = JSON.parse(this.selectedFeatureGeoJsonText);

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

        return [{
            data: {k: this.selectedFeatureIdText, v: "", t: ""},
            children: convertToTreeTableNodes(jsonData)
        }];
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
}
