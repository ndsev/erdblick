import {Component, OnInit} from "@angular/core";
import {InfoMessageService} from "./info.service";
import {TreeNode, TreeTableNode} from "primeng/api";
import {InspectionService} from "./inspection.service";
import {OverlayPanel} from "primeng/overlaypanel";
import {HighlightService} from "./highlight.service";
import {MapService} from "./map.service";
import {Color} from "cesium";

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
                        <span class="vertical-align-middle">{{ inspectionService.selectedFeatureIdText }}</span>
                    </div>
                </ng-template>
                <ng-template pTemplate="content">
                    <div class="resizable-container" [ngClass]="{'resizable-container-expanded': isExpanded }">
                        <div class="resize-handle" (click)="isExpanded = !isExpanded">
                            <i *ngIf="!isExpanded" class="pi pi-chevron-up"></i>
                            <i *ngIf="isExpanded" class="pi pi-chevron-down"></i>
                        </div>
                        <p-treeTable #tt [value]="filteredTree" [columns]="cols"
                                     class="panel-tree" filterMode="strict" [tableStyle]="{'min-width':'100%'}">
                            <ng-template pTemplate="caption">
                                <div class="flex justify-content-end align-items-center"
                                     style="display: flex; align-content: center; justify-content: space-between">
                                    <div class="p-input-icon-left filter-container">
                                        <i class="pi pi-filter"></i>
                                        <input class="filter-input" type="text" pInputText
                                               placeholder="Filter data for selected feature"
                                               (input)="filterTree($event)"/>
                                    </div>
                                    <div style="margin-right: 0.5em; width: 4.5em; display: flex; flex-direction: row; gap: 0.5em">
                                        <p-overlayPanel #paletteoverlay>
                                            <div style="display: flex; flex-direction: row; gap: 0.5em">
                                                <p-button *ngFor="let color of highlightService.getHighlightPalette()"
                                                          (click)="updateHighlightColor(color)"
                                                          icon="" label=""
                                                          [style]="{width: '2em', height: '2em', 'background-color': color.toCssHexString()}"
                                                          [pTooltip]="color.toCssColorString()"
                                                          tooltipPosition="bottom">
                                                </p-button>
                                            </div>
                                            <p-divider></p-divider>
                                            <input type="text" pInputText
                                                   [(ngModel)]="'Opacity: ' + highlightService.pickedOpacity"
                                                   class="w-full" style="width: 100%; text-align: center"/>
                                            <p-slider [(ngModel)]="highlightService.pickedOpacity"
                                                      (ngModelChange)="updateHighlightOpacity()"
                                                      class="w-full"></p-slider>
                                        </p-overlayPanel>
                                        <p-button (click)="togglePaletteOverlay(paletteoverlay, $event)"
                                                  icon="pi pi-palette" label=""
                                                  [style]="{width: '2em', height: '2em'}"
                                                  pTooltip="Adjust highlighting" tooltipPosition="left">
                                        </p-button>
                                        <p-button (click)="copyGeoJsonToClipboard()" icon="pi pi-fw pi-copy" label=""
                                                  [style]="{width: '2rem', height: '2em'}"
                                                  pTooltip="Copy GeoJSON" tooltipPosition="bottom">
                                        </p-button>

                                    </div>
                                </div>
                            </ng-template>
                            <ng-template pTemplate="body" let-rowNode let-rowData="rowData">
                                <tr [ttRow]="rowNode" (click)="onRowClick(rowNode)">
                                    <td *ngFor="let col of cols; let i = index">
                                        <div style="white-space: nowrap; overflow-x: auto; scrollbar-width: thin;"
                                             [pTooltip]="rowData[col.field].toString()" tooltipPosition="left"
                                             [tooltipOptions]="tooltipOptions">
                                            <p-treeTableToggler [rowNode]="rowNode" *ngIf="i === 0"
                                                                (click)="$event.stopPropagation()">
                                            </p-treeTableToggler>
                                            <span (click)="$event.stopPropagation()">{{ rowData[col.field] }}</span>
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
    `,
    styles: [`
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
        showDelay: 1500,
        autoHide: false
    };

    constructor(private messageService: InfoMessageService,
                public highlightService: HighlightService,
                public mapService: MapService,
                public inspectionService: InspectionService) {
        this.inspectionService.featureTree.subscribe((tree: string) => {
            this.jsonTree = tree;
            this.filteredTree = tree ? JSON.parse(tree) : [];
            this.expandTreeNodes(this.filteredTree);
        });
    }

    ngOnInit(): void {
        this.cols = [
            { field: 'k', header: 'Key' },
            { field: 'v', header: 'Value' }
        ];
    }

    copyGeoJsonToClipboard() {
        navigator.clipboard.writeText(this.inspectionService.selectedFeatureGeoJsonText).then(
            () => {
                this.messageService.showSuccess("Copied GeoJSON content to clipboard!");
            },
            () => {
                this.messageService.showError("Could not copy GeoJSON content to clipboard.");
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

    filterTree(event: any) {
        const query = event.target.value.toLowerCase();
        if (!query) {
            this.filteredTree = JSON.parse(this.jsonTree);
            this.expandTreeNodes(this.filteredTree);
            return;
        }

        const filterNodes = (nodes: TreeTableNode[]): TreeTableNode[] => {
            return nodes.reduce<TreeTableNode[]>((filtered, node) => {
                const key = node.data.k.toString().toLowerCase();
                const value = node.data.v.toString().toLowerCase();
                let matches = key.includes(query) || value.includes(query);

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

    togglePaletteOverlay(paletteOverlay: OverlayPanel, event: any) {
        paletteOverlay.toggle(event);
    }

    updateHighlightColor(color: Color) {
        this.highlightService.setHighlightColor(color);
        if (this.mapService.mapView?.pickedFeature) {
            this.mapService.mapView.setFeatureColor(
                this.mapService.mapView?.pickedFeature,
                this.highlightService.pickedColor);
        }
        this.mapService.mapView?.updateViewport();
    }

    updateHighlightOpacity() {
        this.highlightService.setOpacity();
        if (this.mapService.mapView?.pickedFeature) {
            this.mapService.mapView.setFeatureColor(
                this.mapService.mapView?.pickedFeature,
                this.highlightService.pickedColor);
        }
        this.mapService.mapView?.updateViewport();
    }
}