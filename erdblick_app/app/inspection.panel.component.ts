import {Component, OnInit, ViewChild} from "@angular/core";
import {InfoMessageService} from "./info.service";
import {MenuItem, TreeNode, TreeTableNode} from "primeng/api";
import {InspectionService, InspectionValueType} from "./inspection.service";
import {DomSanitizer, SafeHtml} from "@angular/platform-browser";
import {JumpTargetService} from "./jump.service";
import {Menu} from "primeng/menu";
import {ParametersService} from "./parameters.service";

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
                        <div class="p-input-icon-left filter-container">
                            <i (click)="filterPanel.toggle($event)" class="pi pi-filter" style="cursor: pointer"></i>
                            <input class="filter-input" type="text" pInputText
                                   placeholder="Filter data for selected feature"
                                   (input)="filter($event)"/>
                        </div>
                        <div>
                            <p-button (click)="jumpToFeature(inspectionService.selectedFeatureIdName)"
                                      label="" pTooltip="Focus on layer" tooltipPosition="bottom"
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
                    <div class="resizable-container" [ngClass]="{'resizable-container-expanded': isExpanded }">
                        <div class="resize-handle" (click)="isExpanded = !isExpanded">
                            <i *ngIf="!isExpanded" class="pi pi-chevron-up"></i>
                            <i *ngIf="isExpanded" class="pi pi-chevron-down"></i>
                        </div>
                        <p-treeTable #tt [value]="filteredTree" [columns]="cols"
                                     class="panel-tree" filterMode="strict" [tableStyle]="{'min-width':'100%'}">
                            <ng-template pTemplate="body" let-rowNode let-rowData="rowData">
                                <tr [ttRow]="rowNode"
                                    [ngClass]="{'section-style': rowData['type']==InspectionValueType.Section}"
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
                                            <span (click)="onValueClick(rowData)"
                                                  (mouseover)="highlightFeature(rowData)"
                                                  (mouseout)="stopHighlight(rowData)">{{ rowData['value'] }}</span>
                                            <span *ngIf="rowData.hasOwnProperty('info')">
                                                <i class="pi pi-info-circle"
                                                   [pTooltip]="rowData['info'].toString()"
                                                   tooltipPosition="left">
                                                </i>
                                            </span>
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
        <p-menu #inspectionMenu [model]="inspectionMenuItems" [popup]="true" [baseZIndex]="1000"
                [style]="{'font-size': '0.9em'}"></p-menu>
        <p-overlayPanel #filterPanel class="filter-panel">
            <div class="font-bold white-space-nowrap" style="display: flex; justify-items: flex-start; gap: 0.5em; flex-direction: column">
                <span>
                    <p-checkbox [(ngModel)]="filterByKeys" (ngModelChange)="filterTree(filterQuery)" label="Filter by Keys" [binary]="true"/>
                </span>
                <span>
                    <p-checkbox [(ngModel)]="filterByValues" (ngModelChange)="filterTree(filterQuery)" label="Filter by Values" [binary]="true"/>
                </span>
                <span>
                    <p-checkbox [(ngModel)]="filterOnlyRelations" (ngModelChange)="filterTree(filterQuery)" label="Filter by Features" [binary]="true"/>
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
    filterQuery = "";
    filterByKeys = true;
    filterByValues = true;
    filterOnlyRelations = false;

    @ViewChild('inspectionMenu') inspectionMenu!: Menu;
    inspectionMenuItems: MenuItem[] | undefined;
    inspectionMenuVisible: boolean = false;

    constructor(private sanitizer: DomSanitizer,
                private messageService: InfoMessageService,
                public inspectionService: InspectionService,
                public jumpService: JumpTargetService) {
        this.inspectionService.featureTree.subscribe((tree: string) => {
            this.jsonTree = tree;
            this.filteredTree = tree ? JSON.parse(tree) : [];
            this.expandTreeNodes(this.filteredTree);
        });
    }

    ngOnInit(): void {
        this.cols = [
            { field: 'key', header: 'Key' },
            { field: 'value', header: 'Value' }
        ];
    }

    copyToClipboard(text: string) {
        navigator.clipboard.writeText(text).then(
            () => {
                this.messageService.showSuccess("Copied content to clipboard!");
            },
            () => {
                this.messageService.showError("Could not copy content to clipboard.");
            },
        );
    }

    getFilterValue(event: Event) {
        return (event.target as HTMLInputElement).value;
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

    typeToBackground(type: string) {
        if (type == "string") {
            return "#4а4";
        } else {
            return "#ad8";
        }
    }

    filter(event: any) {
        this.filterQuery = event.target.value.toLowerCase();
        this.filterTree(this.filterQuery);
    }

    filterTree(query: string) {
        if (!query) {
            this.filteredTree = JSON.parse(this.jsonTree);
            this.expandTreeNodes(this.filteredTree);
            return;
        }

        const filterNodes = (nodes: TreeTableNode[]): TreeTableNode[] => {
            return nodes.reduce<TreeTableNode[]>((filtered, node) => {
                let matches = false;
                if (this.filterByKeys && this.filterByValues) {
                    matches = String(node.data.key).toLowerCase().includes(query) || String(node.data.value).toLowerCase().includes(query);
                } else if (this.filterByKeys) {
                    matches = String(node.data.key).toLowerCase().includes(query);
                } else if (this.filterByValues) {
                    matches = String(node.data.value).toLowerCase().includes(query);
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
        event.stopPropagation()
        this.inspectionMenuItems = [
            {
                label: 'Find Features with this Value',
                command: () => {
                }
            },
            {
                label: 'Copy Path to this Node',
                command: () => {
                }
            },
            {
                label: 'Copy Key/Value',
                command: () => {
                }
            },
            {
                label: 'Show in NDS.Live Blob',
                command: () => {
                }
            },
            {
                label: 'Open NDS.Live Docs',
                command: () => {
                }
            }
        ];
    }

    onValueClick(rowData: any) {
        this.copyToClipboard(rowData["value"]);
        if (rowData["type"] == InspectionValueType.FeatureId) {
            this.jumpToFeature(rowData["hoverId"]);
        }
    }

    jumpToFeature(featureId: string) {
        console.log(`Jumping to ${featureId}!`)
    }

    highlightFeature(rowData: any) {
        if (rowData["type"] == InspectionValueType.FeatureId) {
            console.log(rowData)
            if (rowData.hasOwnProperty("hoverId")) {
                this.jumpService.highlightFeature(this.inspectionService.selectedMapIdName, rowData["hoverId"]).then();
            }
        }
    }

    stopHighlight(rowData: any) {
        if (rowData.type == InspectionValueType.FeatureId) {
            console.log("Stop")
        }
    }

    // getInnerInspectionHtml(rowData: any): SafeHtml {
    //     let htmlString = '<div style="white-space: nowrap; overflow-x: auto; scrollbar-width: thin;" class="css-tooltip"';
    //     htmlString += `<span (click)="$event.stopPropagation()">${rowData['value']}</span>`;
    //     htmlString += `<span class="tooltiptext">${rowData['value'].toString()}</span>`;
    //     if (rowData["type"] == InspectionValueType.Section && rowData.hasOwnProperty("info")) {
    //         htmlString += `<span><i class="pi pi-info-circle css-tooltip"><span class="tooltiptext">${rowData["info"].toString()}</span></i></span>`;
    //     }
    //     htmlString += "</div>"
    //     return this.sanitizer.bypassSecurityTrustHtml(htmlString);
    // }

    getStyleClassByType(valueType: InspectionValueType): string {
        switch (valueType) {
            case InspectionValueType.Section:
                return "section-style"
            case InspectionValueType.FeatureId:
                return "feature-id-style"
            default:
                return "standard-style"
        }
    }

    protected readonly InspectionValueType = InspectionValueType;
}