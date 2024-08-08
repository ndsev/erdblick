import {Component, OnInit, ViewChild} from "@angular/core";
import {MenuItem, TreeNode, TreeTableNode} from "primeng/api";
import {InspectionService} from "./inspection.service";
import {JumpTargetService} from "./jump.service";
import {Menu} from "primeng/menu";
import {MapService} from "./map.service";
import {distinctUntilChanged, filter} from "rxjs";
import {coreLib} from "./wasm";
import {ClipboardService} from "./clipboard.service";
import {Fetch} from "./fetch.model";
import {uint8ArrayToWasm} from "./wasm";
import {SourceDataPanelComponent} from "./sourcedata.panel.component"

interface Column {
    field: string;
    header: string;
}

@Component({
    selector: 'inspection-panel',
    template: `
        <p-accordion *ngIf="inspectionService.featureTree.value.length && inspectionService.isInspectionPanelVisible"
                     class="w-full inspect-panel" [activeIndex]="0">
            <p-accordionTab>
                <ng-template pTemplate="header">
                    <div class="flex align-items-center">
                        <i class="pi pi-sitemap mr-2"></i>&nbsp;
                        <span class="vertical-align-middle">{{ inspectionService.selectedFeatureIdName }}</span>
                    </div>
                </ng-template>
                <ng-template pTemplate="content">
                    <div class="flex justify-content-end align-items-center"
                         style="display: flex; align-content: center; justify-content: center; width: 100%; padding: 0.5em;">
                        <div [hidden]="!sourceDataVisible">
                            <p-button (click)="hideSourceData()"
                                      icon="pi pi-arrow-left"
                                      label="" pTooltip="Go back"
                                      tooltipPosition="bottom"
                                      [style]="{'padding-left': '0', 'padding-right': '0', 'margin-right': '0.5em', width: '2em', height: '2em'}">
                            </p-button>
                        </div>
                        <div class="p-input-icon-left filter-container">
                            <i (click)="filterPanel.toggle($event)" class="pi pi-filter" style="cursor: pointer"></i>
                            <input class="filter-input" type="text" pInputText placeholder="Filter data for selected feature"
                                   [(ngModel)]="inspectionService.featureTreeFilterValue" (ngModelChange)="filterTree()"
                                   (keydown)="onKeydown($event)"
                            />
                            <i *ngIf="inspectionService.featureTreeFilterValue" (click)="clearFilter()" 
                               class="pi pi-times clear-icon" style="cursor: pointer"></i>
                        </div>
                        <div>
                            <p-button (click)="mapService.focusOnFeature(inspectionService.selectedFeature!)"
                                      label="" pTooltip="Focus on feature" tooltipPosition="bottom"
                                      [style]="{'padding-left': '0', 'padding-right': '0', 'margin-left': '0.5em', width: '2em', height: '2em'}">
                                <span class="material-icons" style="font-size: 1.2em; margin: 0 auto;">loupe</span>
                            </p-button>
                        </div>
                        <div>
                            <p-button (click)="copyToClipboard(inspectionService.selectedFeatureGeoJsonText)"
                                      icon="pi pi-fw pi-copy" label=""
                                      [style]="{'margin-left': '0.5em', width: '2em', height: '2em'}"
                                      pTooltip="Copy GeoJSON" tooltipPosition="bottom">
                            </p-button>
                        </div>
                    </div>
                    <div class="flex resizable-container" [ngClass]="{'resizable-container-expanded': isExpanded }" [hidden]="!sourceDataVisible">
                        <div class="resize-handle" (click)="isExpanded = !isExpanded">
                            <i *ngIf="!isExpanded" class="pi pi-chevron-up"></i>
                            <i *ngIf="isExpanded" class="pi pi-chevron-down"></i>
                        </div>
                        <sourcedata-panel />
                    </div>
                    <div class="flex resizable-container" [ngClass]="{'resizable-container-expanded': isExpanded }" [hidden]="sourceDataVisible">
                        <div class="resize-handle" (click)="isExpanded = !isExpanded">
                            <i *ngIf="!isExpanded" class="pi pi-chevron-up"></i>
                            <i *ngIf="isExpanded" class="pi pi-chevron-down"></i>
                        </div>
                        <p-treeTable #tt
                            filterMode="strict"
                            scrollHeight="flex"
                            [value]="filteredTree"
                            [columns]="cols"
                            [scrollable]="true"
                            [virtualScroll]="true"
                            [virtualScrollItemSize]="26"
                            [tableStyle]="{'min-width': '1px', 'min-height': '1px'}"
                        >
                            <ng-template pTemplate="body" let-rowNode let-rowData="rowData">
                                <tr [ttRow]="rowNode"
                                    [ngClass]="{'section-style': rowData['type']==InspectionValueType.SECTION.value}"
                                    (click)="onRowClick(rowNode)">
                                    <td>
                                        <div style="white-space: nowrap; overflow-x: auto; scrollbar-width: thin;"
                                             [pTooltip]="rowData['key'].toString()" tooltipPosition="left"
                                             [tooltipOptions]="tooltipOptions">
                                            <p-treeTableToggler [rowNode]="rowNode" (click)="$event.stopPropagation()">
                                            </p-treeTableToggler>
                                            <span (click)="onKeyClick($event, rowData)"
                                                  style="cursor: pointer">{{ rowData['key'] }}</span>
                                        </div>
                                    </td>
                                    <td [class]="getStyleClassByType(rowData['type'])">
                                        <div style="white-space: nowrap; overflow-x: auto; scrollbar-width: thin;"
                                             [pTooltip]="rowData['value'].toString()" tooltipPosition="left"
                                             [tooltipOptions]="tooltipOptions">
                                            <div (click)="onValueClick($event, rowData)"
                                                  (mouseover)="highlightFeature(rowData)"
                                                  (mouseout)="stopHighlight(rowData)">
                                                {{ rowData['value'] }}
                                                <span *ngIf="rowData.hasOwnProperty('info')">
                                                    <i class="pi pi-info-circle"
                                                       [pTooltip]="rowData['info'].toString()"
                                                       tooltipPosition="left">
                                                    </i>
                                                </span>
                                            </div>
                                        </div>
                                    </td>
                                </tr>
                            </ng-template>
                            <ng-template pTemplate="emptymessage">
                                <tr>
                                    <td [attr.colspan]="cols.length">No entries found.</td>
                                </tr>
                            </ng-template>
                        </p-treeTable>
                    </div>
                </ng-template>
            </p-accordionTab>
        </p-accordion>
        <p-menu #inspectionMenu [model]="inspectionMenuItems" [popup]="true" [baseZIndex]="1000"
                [style]="{'font-size': '0.9em'}"></p-menu>
        <p-overlayPanel #filterPanel class="filter-panel">
            <div class="font-bold white-space-nowrap"
                 style="display: flex; justify-items: flex-start; gap: 0.5em; flex-direction: column">
                <span>
                    <p-checkbox [(ngModel)]="filterByKeys" (ngModelChange)="filterTree()"
                                label="Filter by Keys" [binary]="true"/>
                </span>
                <span>
                    <p-checkbox [(ngModel)]="filterByValues" (ngModelChange)="filterTree()"
                                label="Filter by Values" [binary]="true"/>
                </span>
                <span>
                    <p-checkbox [(ngModel)]="filterOnlyFeatureIds" (ngModelChange)="filterTree()"
                                label="Filter only FeatureIDs" [binary]="true"/>
                </span>
                <span>
                    <p-checkbox [(ngModel)]="filterGeometryEntries" (ngModelChange)="filterTree()"
                                label="Include Geometry Entries" [binary]="true"/>
                </span>
            </div>
        </p-overlayPanel>
    `,
    styles: [`
        .section-style {
            background-color: gainsboro;
            margin-top: 1em;
        }
        
        .feature-id-style {
            cursor: pointer;
            text-decoration: underline dotted;
            font-style: italic;
        }
        
        @media only screen and (max-width: 56em) {
            .resizable-container-expanded {
                height: calc(100vh - 3em);;
            }
        }
    `]
})
export class InspectionPanelComponent implements OnInit  {

    jsonTree: string = "";
    filteredTree: TreeTableNode[] = [];
    cols: Column[] = [];
    isExpanded: boolean = false;
    tooltipOptions = {
        showDelay: 1000,
        autoHide: false
    };
    filterByKeys = true;
    filterByValues = true;
    filterOnlyFeatureIds = false;
    filterGeometryEntries = false;
    sourceDataVisible = false;

    @ViewChild('inspectionMenu') inspectionMenu!: Menu;
    inspectionMenuItems: MenuItem[] | undefined;
    inspectionMenuVisible: boolean = false;

    constructor(private clipboardService: ClipboardService,
                public inspectionService: InspectionService,
                public jumpService: JumpTargetService,
                public mapService: MapService) {
        this.inspectionService.featureTree.pipe(distinctUntilChanged()).subscribe((tree: string) => {
            this.jsonTree = tree;
            this.filteredTree = tree ? JSON.parse(tree) : [];
            this.expandTreeNodes(this.filteredTree);
            if (this.inspectionService.featureTreeFilterValue) {
                this.filterTree();
            }
        });
    }

    ngOnInit(): void {
        this.cols = [
            { field: 'key', header: 'Key' },
            { field: 'value', header: 'Value' }
        ];
    }

    copyToClipboard(text: string) {
        this.clipboardService.copyToClipboard(text);
    }

    expandTreeNodes(nodes: TreeTableNode[], parent: any = null): void {
        nodes.forEach(node => {
            const isTopLevelNode = parent === null;
            const hasSingleChild = node.children && node.children.length === 1;
            node.expanded = isTopLevelNode || hasSingleChild;

            if (node.children) {
                this.expandTreeNodes(node.children, node);
            }
        });
    }

    filterTree() {
        const query = this.inspectionService.featureTreeFilterValue.toLowerCase();
        if (!query) {
            this.filteredTree = JSON.parse(this.jsonTree);
            this.expandTreeNodes(this.filteredTree);
            return;
        }

        if (this.filterOnlyFeatureIds) {
            this.filterByKeys = false;
            this.filterByValues = false;
            this.filterGeometryEntries = false;
        }

        const filterNodes = (nodes: TreeTableNode[]): TreeTableNode[] => {
            return nodes.reduce<TreeTableNode[]>((filtered, node) => {
                let matches = false;
                if (!this.filterGeometryEntries && node.data.key == "Geometry") {
                    return filtered;
                }

                if (this.filterOnlyFeatureIds) {
                    if (node.data.type == this.InspectionValueType.FEATUREID.value) {
                        matches = String(node.data.value).toLowerCase().includes(query) || String(node.data.hoverId).toLowerCase().includes(query);
                    }
                } else {
                    if (this.filterByKeys && this.filterByValues) {
                        matches = String(node.data.key).toLowerCase().includes(query) || String(node.data.value).toLowerCase().includes(query);
                    } else if (this.filterByKeys) {
                        matches = String(node.data.key).toLowerCase().includes(query);
                    } else if (this.filterByValues) {
                        matches = String(node.data.value).toLowerCase().includes(query);
                    }
                }

                if (node.children) {
                    let filteredChildren = filterNodes(node.children);
                    // node.children = filterNodes(node.children);
                    matches = matches || filteredChildren.length > 0;
                    if (matches) {
                        node.expanded = true;
                    }
                }

                if (matches) {
                    filtered.push(node);
                }

                return filtered;
            }, []);
        };

        this.filteredTree = filterNodes(JSON.parse(this.jsonTree));
    }

    onRowClick(rowNode: any) {
        const node: TreeNode = rowNode.node;
        node.expanded = !node.expanded;
        this.filteredTree = [...this.filteredTree];
    }

    onKeyClick(event: MouseEvent, rowData: any) {
        this.inspectionMenu.toggle(event);
        event.stopPropagation();
        const key = rowData["key"];
        const value = rowData["value"];
        this.inspectionMenuItems = [
            // {
            //     label: 'Find Features with this Value',
            //     command: () => {
            //
            //     }
            // },
            {
                label: 'Copy Key/Value',
                command: () => {
                    this.copyToClipboard(`{${key}: ${value}}`);
                }
            },
            // {
            //     label: 'Show in NDS.Live Blob',
            //     command: () => {
            //     }
            // },
            {
                label: 'Open NDS.Live Docs',
                command: () => {
                    window.open(`https://doc.nds.live/search?q=${key}`, "_blank");
                }
            }
        ];
        if (rowData.hasOwnProperty("geoJsonPath")) {
            const path = rowData["geoJsonPath"];
            this.inspectionMenuItems.push({
                label: 'Copy GeoJson Path',
                command: () => {
                    this.copyToClipboard(path);
                }
            });
        }
        if (rowData.hasOwnProperty("sourceDataReferences")) {
            const ref = rowData.sourceDataReferences;
            ref.forEach((item: any) => {
                const qualifier = item.qualifier || "";
                const layerId = item.layerId;
                const tileId = item.tileId;

                this.inspectionMenuItems!.push({
                    label: `Show ${qualifier} Source-Data`,
                    command: () => {
                        this.showSourceData(layerId, Number(tileId))
                    }
                });
            })
        }
    }

    hideSourceData()
    {
        this.sourceDataVisible = false;
    }

    async showSourceData(layerId: string, tileId: number)
    {
        this.sourceDataVisible = true;

        const mapId = this.inspectionService.selectedMapIdName;

        this.inspectionService.showSourceDataEvent.emit({
            tileId: tileId,
            layerId: layerId,
            mapId: mapId,
        })
    }

    onValueClick(event: any, rowData: any) {
        event.stopPropagation();
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) {
            return;
        }

        if (rowData["type"] == this.InspectionValueType.FEATUREID.value) {
            this.jumpService.highlightFeature(this.inspectionService.selectedMapIdName, rowData["value"]).then();
        }
        this.copyToClipboard(rowData["value"]);
    }

    highlightFeature(rowData: any) {
        return;
    }

    stopHighlight(rowData: any) {
        return;
    }

    getStyleClassByType(valueType: number): string {
        switch (valueType) {
            case this.InspectionValueType.SECTION.value:
                return "section-style"
            case this.InspectionValueType.FEATUREID.value:
                return "feature-id-style"
            default:
                return "standard-style"
        }
    }

    protected readonly InspectionValueType = coreLib.ValueType;

    clearFilter() {
        this.inspectionService.featureTreeFilterValue = "";
        this.filterTree();
    }

    onKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            this.clearFilter();
        }
    }
}
