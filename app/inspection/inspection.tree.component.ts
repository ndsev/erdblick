import {Component, ViewChild, input, OnInit, OnDestroy} from "@angular/core";
import {MenuItem, TreeNode, TreeTableNode} from "primeng/api";
import {TreeTable} from "primeng/treetable";
import {toObservable} from "@angular/core/rxjs-interop";
import {Subscription} from "rxjs";
import {coreLib} from "../integrations/wasm";
import {InfoMessageService} from "../shared/info.service";
import {MapDataService} from "../mapdata/map.service";
import {Menu} from "primeng/menu";
import {ClipboardService} from "../shared/clipboard.service";
import {AppStateService, SelectedSourceData} from "../shared/appstate.service";

export interface Column {
    key: string,
    header: string,
    width: string,
    transform?: (v: any) => any
}

export class FeatureFilterOptions {
    filterByKeys: boolean = true;
    filterByValues: boolean = true;
    filterOnlyFeatureIds: boolean = false;
    filterGeometryEntries: boolean = false;
}

@Component({
    selector: 'inspection-tree',
    template: `
        <ng-container>
            <p-treeTable #tt scrollHeight="flex" filterMode="strict"
                [value]="treeData()"
                [autoLayout]="true"
                [scrollable]="true"
                [resizableColumns]="true"
                [virtualScroll]="true"
                [virtualScrollItemSize]="26"
                [tableStyle]="{'min-height': '1px', 'padding': '0px'}"
                [globalFilterFields]="filterFields()">
                <ng-template pTemplate="caption">
                    <p-iconfield class="filter-container">
                        <p-inputicon (click)="filterPanel.toggle($event)" styleClass="pi pi-filter" style="cursor: pointer"/>
                        <input class="filter-input" type="text" pInputText placeholder="Filter data for selected layer"
                               [(ngModel)]="filterString"
                               (ngModelChange)="filterTree(filterString)"
                               (input)="filterTree($any($event.target).value)"/>
                        <i *ngIf="filterString" (click)="clearFilter()" class="pi pi-times clear-icon" style="cursor: pointer"></i>
                    </p-iconfield>
                </ng-template>

                <ng-template pTemplate="colgroup">
                    <colgroup>
                        <col *ngFor="let col of columns()" [style.width]="col.width" />
                    </colgroup>
                </ng-template>

                <ng-template pTemplate="header">
                    <tr>
                        <th *ngFor="let col of columns()" ttResizableColumn>
                            {{ col.header }}
                        </th>
                    </tr>
                </ng-template>

                <ng-template pTemplate="body" let-rowNode let-rowData="rowData">
                    <tr [ttRow]="rowNode" [class]="rowData.styleClass || ''">
                        <td *ngFor="let col of columns(); let i = index" style="white-space: nowrap; text-overflow: ellipsis">
                            <p-treeTableToggler [rowNode]="rowNode" *ngIf="i == 0" />
                            <span *ngIf="filterFields().indexOf(col.key) != -1" [innerHTML]="col?.transform(rowData[col.key]) | highlight: filterString"></span>
                            <span *ngIf="filterFields().indexOf(col.key) == -1" [innerHTML]="col?.transform(rowData[col.key])"></span>
                        </td>
                    </tr>
                </ng-template>
            </p-treeTable>
        </ng-container>
        <p-menu #inspectionMenu [model]="inspectionMenuItems" [popup]="true" [baseZIndex]="9999" appendTo="body"
                [style]="{'font-size': '0.9em'}"></p-menu>
        <p-popover *ngIf="filterOptions() !== undefined" #filterPanel class="filter-panel">
            <div class="font-bold white-space-nowrap" style="display: flex; justify-items: flex-start; gap: 0.5em; flex-direction: column">
                <p-checkbox [(ngModel)]="filterOptions()!.filterByKeys" (ngModelChange)="filterTree(filterString)" inputId="fbk" [binary]="true"/>
                <label for="fbk" style="margin-left: 0.5em; cursor: pointer">Filter by Keys</label>
                <p-checkbox [(ngModel)]="filterOptions()!.filterByValues" (ngModelChange)="filterTree(filterString)" inputId="fbv" [binary]="true"/>
                <label for="fbv" style="margin-left: 0.5em; cursor: pointer">Filter by Values</label>
                <p-checkbox [(ngModel)]="filterOptions()!.filterOnlyFeatureIds" (ngModelChange)="filterTree(filterString)" inputId="fofids" [binary]="true"/>
                <label for="fofids" style="margin-left: 0.5em; cursor: pointer">Filter only FeatureIDs</label>
                <p-checkbox [(ngModel)]="filterOptions()!.filterGeometryEntries" (ngModelChange)="filterTree(filterString)" inputId="ige" [binary]="true"/>
                <label for="ige" style="margin-left: 0.5em; cursor: pointer">Include Geometry Entries</label>
            </div>
        </p-popover>
    `,
    styles: [`
        .section-style {
            background-color: var(--p-highlight-background);
            margin-top: 1em;
        }

        .feature-id-style {
            cursor: pointer;
            text-decoration: underline dotted;
            font-style: italic;
        }

        @media only screen and (max-width: 56em) {
            .resizable-container-expanded {
                height: calc(100vh - 3em);
            }
        }
    `],
    standalone: false
})
export class InspectionTreeComponent implements OnInit, OnDestroy {

    @ViewChild('tt') table!: TreeTable;

    treeData = input.required<TreeTableNode[]>();
    filterFields = input.required<string[]>();
    columns = input.required<Column[]>();
    panelId = input.required<number>();
    firstHighlightedItemIndex = input<number>();
    firstHighlightedItemIndex$ = toObservable(this.firstHighlightedItemIndex);
    subscriptions: Subscription[] = [];
    filterOptions = input<FeatureFilterOptions>();

    filterString = "";
    @ViewChild('inspectionMenu') inspectionMenu!: Menu;
    inspectionMenuItems: MenuItem[] | undefined;

    constructor(private clipboardService: ClipboardService,
                private mapService: MapDataService,
                private stateService: AppStateService,
                private messageService: InfoMessageService) {}

    ngOnInit() {
        // We have to force recalculate the tables number of visible items
        // setTimeout(() => {
        //     let scroller = (<any>this.table.scrollableViewChild)?.scroller;
        //     if (scroller) {
        //         scroller.init();
        //         scroller.calculateAutoSize();
        //     }
        // }, 0);

        this.subscriptions.push(this.firstHighlightedItemIndex$.subscribe(index => {
            setTimeout(() => this.table.scrollToVirtualIndex(index ?? 0), 5);
        }));
    }

    ngOnDestroy() {
        this.subscriptions.forEach(s => s.unsubscribe());
    }

    clearFilter() {
        this.filterString = "";
        this.table.filterGlobal("" , 'contains')
    }

    onKeydown(event: any) {
        event.stopPropagation();

        if (event.key === 'Escape') {
            this.clearFilter();
        }
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
            {
                label: 'Copy Key/Value',
                command: () => {
                    this.copyToClipboard(`{${key}: ${value}}`);
                }
            },
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
    }

    onValueClick(event: any, rowData: any) {
        event.stopPropagation();
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) {
            return;
        }

        if (rowData["type"] == this.InspectionValueType.FEATUREID.value) {
            this.jumpService.highlightByJumpTargetFilter(
                0,
                rowData["mapId"],
                rowData["value"]).then();
        }
    }

    onValueHover(event: any, rowData: any) {
        event.stopPropagation();
        this.highlightHoveredEntry(rowData);
    }

    onValueHoverExit(event: any, rowData: any) {
        event.stopPropagation();
        if (rowData["type"] === this.InspectionValueType.FEATUREID.value) {
            this.mapService.setHoveredFeatures([]).then();
        }
    }

    onKeyHover(event: any, rowData: any) {
        event.stopPropagation();
        this.highlightHoveredEntry(rowData);
    }

    onKeyHoverExit(event: any, rowData: any) {
        event.stopPropagation();
        if (rowData["type"] === this.InspectionValueType.FEATUREID.value) {
            this.mapService.setHoveredFeatures([]).then();
        }
    }

    private highlightHoveredEntry(rowData: any) {
        if (rowData["type"] == this.InspectionValueType.FEATUREID.value) {
            this.jumpService.highlightByJumpTargetFilter(
                0,
                rowData["mapId"],
                rowData["value"],
                coreLib.HighlightMode.HOVER_HIGHLIGHT).then();
        } else if (rowData["hoverId"]) {
            this.mapService.setHoveredFeatures([{
                mapTileKey: this.inspectionService.selectedFeatures[rowData["featureIndex"]].featureTile.mapTileKey,
                featureId: rowData["hoverId"]
            }]).then();
        }
    }

    showSourceData(event: any, sourceDataRef: any) {
        event.stopPropagation();

        try {
            this.stateService.setSelection({
                mapTileKey: sourceDataRef.mapTileKey,
                address: sourceDataRef.address
            } as SelectedSourceData, this.panelId());
        } catch (e) {
            this.messageService.showError(`Encountered error: ${e}`);
        }
    }

    getStyleClassByType(valueType: number): string {
        switch (valueType) {
            case this.InspectionValueType.SECTION.value:
                return "section-style";
            case this.InspectionValueType.FEATUREID.value:
                return "feature-id-style";
            default:
                return "standard-style";
        }
    }

    copyToClipboard(text: string) {
        this.clipboardService.copyToClipboard(text);
    }

    filterTree(filterString: string) {
        if (!filterString) {
            return;
        }

        const query = filterString.toLowerCase();
        if (!this.filterOptions()) {
            this.table.filterGlobal(query, "contains");
            return;
        }

        if (this.filterOptions()!.filterOnlyFeatureIds) {
            this.filterOptions()!.filterByKeys = false;
            this.filterOptions()!.filterByValues = false;
            this.filterOptions()!.filterGeometryEntries = false;
        }

        const filterNodes = (nodes: TreeTableNode[]): TreeTableNode[] => {
            return nodes.reduce<TreeTableNode[]>((filtered, node) => {
                let matches = false;
                if (!this.filterOptions()!.filterGeometryEntries && node.data.key == "Geometry") {
                    return filtered;
                }

                if (this.filterOptions()!.filterOnlyFeatureIds) {
                    if (node.data.type == this.InspectionValueType.FEATUREID.value) {
                        matches = String(node.data.value).toLowerCase().includes(query) || String(node.data.hoverId).toLowerCase().includes(query);
                    }
                } else {
                    if (this.filterOptions()!.filterByKeys && this.filterOptions()!.filterByValues) {
                        matches = String(node.data.key).toLowerCase().includes(query) || String(node.data.value).toLowerCase().includes(query);
                    } else if (this.filterOptions()!.filterByKeys) {
                        matches = String(node.data.key).toLowerCase().includes(query);
                    } else if (this.filterOptions()!.filterByValues) {
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

    expandTreeNodes(nodes: TreeTableNode[], parent: any = null): void {
        nodes.forEach(node => {
            const isTopLevelNode = parent === null;
            const isSection = node.data && node.data["type"] === this.InspectionValueType.SECTION.value;
            const hasSingleChild = node.children && node.children.length === 1;
            node.expanded = isTopLevelNode || isSection || hasSingleChild;

            if (node.children) {
                this.expandTreeNodes(node.children, node);
            }
        });
    }

    protected readonly InspectionValueType = coreLib.ValueType;
}
