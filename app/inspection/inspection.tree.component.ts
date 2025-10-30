import {Component, ViewChild, input, OnDestroy, effect} from "@angular/core";
import {MenuItem, TreeNode, TreeTableNode} from "primeng/api";
import {TreeTable} from "primeng/treetable";
import {toObservable} from "@angular/core/rxjs-interop";
import {Subscription} from "rxjs";
import {coreLib} from "../integrations/wasm";
import {InfoMessageService} from "../shared/info.service";
import {MapDataService, SelectedFeatures} from "../mapdata/map.service";
import {Menu} from "primeng/menu";
import {ClipboardService} from "../shared/clipboard.service";
import {AppStateService, SelectedSourceData} from "../shared/appstate.service";
import {Popover} from "primeng/popover";
import {JumpTargetService} from "../search/jump.service";

export interface Column {
    key: string,
    header: string,
    width: string,
    transform: (colKey: string, rowData: any) => any
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
        <p-treeTable #tt scrollHeight="flex" filterMode="strict"
                     [value]="data"
                     [autoLayout]="true"
                     [scrollable]="true"
                     [resizableColumns]="true"
                     [virtualScroll]="true"
                     [virtualScrollItemSize]="26"
                     [tableStyle]="{'min-height': '1px', 'padding': '0px'}"
                     [globalFilterFields]="filterFields">
            <ng-template pTemplate="caption">
                <!-- TODO: transfer the inlined styles to styles.SCSS -->
                <div class="flex justify-content-end align-items-center"
                     style="display: flex; align-content: center; justify-content: center; width: 100%;">
                    <p-iconfield class="filter-container">
                        @if (filterOptions()) {
                            <p-inputicon (click)="filterPanel.toggle($event)" styleClass="pi pi-filter"
                                         style="cursor: pointer"/>
                        }
                        <input class="filter-input" type="text" pInputText placeholder="Filter inspection tree"
                               [(ngModel)]="filterString"
                               (ngModelChange)="filterTree(filterString)"
                               (input)="filterTree($any($event.target).value)"/>
                        @if (filterString) {
                            <i (click)="clearFilter()" class="pi pi-times clear-icon" style="cursor: pointer"></i>
                        }
                    </p-iconfield>
                    @if (selectedFeatures()) {
                        <p-button (click)="mapService.focusOnFeature(selectedFeatures()!.viewIndex, selectedFeatures()!.features[0])"
                                label="" pTooltip="Focus on feature" tooltipPosition="bottom"
                                [style]="{'padding-left': '0', 'padding-right': '0', 'margin-left': '0.5em', width: '2em', height: '2em'}">
                            <span class="material-icons" style="font-size: 1.2em; margin: 0 auto;">loupe</span>
                        </p-button>
                    }
                    @if (geoJson()) {
                        <p-button (click)="copyToClipboard(geoJson()!)" icon="pi pi-fw pi-copy" label=""
                                  [style]="{'margin-left': '0.5em', width: '2em', height: '2em'}"
                                  pTooltip="Copy GeoJSON" tooltipPosition="bottom">
                        </p-button>
                    }
                </div>
            </ng-template>

            <ng-template pTemplate="colgroup">
                <colgroup>
                    @for (col of columns(); track col.key) {
                        <col [style.width]="col.width"/>
                    }
                </colgroup>
            </ng-template>

            <ng-template pTemplate="header">
                <tr>
                    @for (col of columns(); track col.key) {
                        <th ttResizableColumn>
                            {{ col.header }}
                        </th>
                    }
                </tr>
            </ng-template>

            <ng-template pTemplate="body" let-rowNode let-rowData="rowData">
                <tr [ttRow]="rowNode" (click)="onRowClick(rowNode)" [class]="rowData.styleClass || ''">
                    @for (col of columns(); track $index) {
                        <td [class]="getStyleClassByType(rowData)"
                            style="white-space: nowrap; overflow-x: auto; scrollbar-width: thin;"
                            [pTooltip]="rowData[col.key]" tooltipPosition="left"
                            [tooltipOptions]="tooltipOptions">
                            <div style="display: flex; flex-direction: row; gap: 0.25em;">
                                @if ($index === 0) {
                                    <p-treeTableToggler [rowNode]="rowNode"/>
                                }
                                @if (filterFields.indexOf(col.key) !== -1) {
                                    <span (click)="onNodeClick($event, rowData, col.key)"
                                          (mouseover)="onNodeHover($event, rowData)"
                                          (mouseout)="onNodeHoverExit($event, rowData)"
                                          style="cursor: pointer; overflow: hidden; white-space: nowrap; text-overflow: ellipsis"
                                          [innerHTML]="col.transform(col.key, rowData) | highlight: filterString">
                                    </span>
                                    @if (rowData.hasOwnProperty("info") && $index !== 0) {
                                        <span>
                                            <i class="pi pi-info-circle" [pTooltip]="rowData['info']" tooltipPosition="top"></i>
                                        </span>
                                    }
                                    @if (rowData.hasOwnProperty("sourceDataReferences") && 
                                         rowData["sourceDataReferences"].length > 0 &&
                                         $index === 0) {
                                        <p-buttonGroup class="source-data-ref-container">
                                            @for (item of rowData["sourceDataReferences"]; track $index) {
                                                <p-button class="source-data-button"
                                                          (click)="showSourceData($event, item)"
                                                          severity="secondary"
                                                          label="{{ item.qualifier.substring(0, 1).toUpperCase() }}"
                                                          pTooltip="Go to {{ item.qualifier }} Source Data"
                                                          tooltipPosition="bottom" />
                                            }
                                        </p-buttonGroup>
                                    }
                                } @else {
                                    <span (click)="onNodeClick($event, rowData, col.key)"
                                          (mouseover)="onNodeHover($event, rowData)"
                                          (mouseout)="onNodeHoverExit($event, rowData)"
                                          style="cursor: pointer" [innerHTML]="col.transform(col.key, rowData)">
                                    </span>
                                    @if (rowData.hasOwnProperty("info") && $index !== 0) {
                                        <span>
                                            <i class="pi pi-info-circle" [pTooltip]="rowData['info']" tooltipPosition="top"></i>
                                        </span>
                                    }
                                    @if (rowData.hasOwnProperty("sourceDataReferences") &&
                                         rowData["sourceDataReferences"].length > 0 &&
                                         $index === 0) {
                                        <p-buttonGroup class="source-data-ref-container">
                                            @for (item of rowData["sourceDataReferences"]; track $index) {
                                                <p-button class="source-data-button"
                                                          (click)="showSourceData($event, item)"
                                                          severity="secondary"
                                                          label="{{ item.qualifier.substring(0, 1).toUpperCase() }}"
                                                          pTooltip="Go to {{ item.qualifier }} Source Data"
                                                          tooltipPosition="bottom" />
                                            }
                                        </p-buttonGroup>
                                    }
                                }
                            </div>
                        </td>
                    }
                </tr>
            </ng-template>

            <ng-template pTemplate="emptymessage">
                <tr>
                    <td [attr.colspan]="columns().length">No entries found.</td>
                </tr>
            </ng-template>
        </p-treeTable>
        <p-menu #inspectionMenu [model]="inspectionMenuItems" [popup]="true" [baseZIndex]="9999" appendTo="body"
                [style]="{'font-size': '0.9em'}"></p-menu>
        <p-popover *ngIf="filterOptions() !== undefined" #filterPanel class="filter-panel">
            <div class="font-bold white-space-nowrap"
                 style="display: flex; justify-items: flex-start; gap: 0.5em; flex-direction: column">
                <p-checkbox [(ngModel)]="filterOptions()!.filterByKeys" (ngModelChange)="filterTree(filterString)"
                            inputId="fbk" [binary]="true"/>
                <label for="fbk" style="margin-left: 0.5em; cursor: pointer">Filter by Keys</label>
                <p-checkbox [(ngModel)]="filterOptions()!.filterByValues" (ngModelChange)="filterTree(filterString)"
                            inputId="fbv" [binary]="true"/>
                <label for="fbv" style="margin-left: 0.5em; cursor: pointer">Filter by Values</label>
                <p-checkbox [(ngModel)]="filterOptions()!.filterOnlyFeatureIds"
                            (ngModelChange)="filterTree(filterString)"
                            inputId="fofids" [binary]="true"/>
                <label for="fofids" style="margin-left: 0.5em; cursor: pointer">Filter only FeatureIDs</label>
                <p-checkbox [(ngModel)]="filterOptions()!.filterGeometryEntries"
                            (ngModelChange)="filterTree(filterString)"
                            inputId="ige" [binary]="true"/>
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
export class InspectionTreeComponent implements OnDestroy {

    @ViewChild('tt') table!: TreeTable;
    @ViewChild('filterPanel') filterPanel!: Popover;

    data: TreeTableNode[] = [];
    treeData = input.required<TreeTableNode[]>();
    columns = input.required<Column[]>();
    panelId = input.required<number>();
    firstHighlightedItemIndex = input<number>();
    firstHighlightedItemIndex$ = toObservable(this.firstHighlightedItemIndex);
    subscriptions: Subscription[] = [];
    filterOptions = input<FeatureFilterOptions>();
    geoJson = input<string>();
    selectedFeatures = input<SelectedFeatures>();

    filterFields: string[] = [
        "key",
        "value"
    ];
    tooltipOptions = {
        showDelay: 1000,
        autoHide: false
    };
    filterString = "";

    @ViewChild('inspectionMenu') inspectionMenu!: Menu;
    inspectionMenuItems: MenuItem[] | undefined;

    constructor(private clipboardService: ClipboardService,
                public mapService: MapDataService,
                private jumpService: JumpTargetService,
                private stateService: AppStateService,
                private messageService: InfoMessageService) {
        effect(() => {
            this.data = this.treeData();
            if (this.data[0].data.key === "Feature") {
                this.expandTreeNodes(this.data);
            }

            // FIXME We have to force recalculate the tables number of visible items?
            setTimeout(() => {
                let scroller = (<any>this.table.scrollableViewChild)?.scroller;
                if (scroller) {
                    scroller.init();
                    scroller.calculateAutoSize();
                }
            }, 0);

            this.subscriptions.push(this.firstHighlightedItemIndex$.subscribe(index => {
                setTimeout(() => this.table.scrollToVirtualIndex(index ?? 0), 5);
            }));
        });
    }

    ngOnDestroy() {
        this.subscriptions.forEach(s => s.unsubscribe());
    }

    clearFilter() {
        this.filterString = "";
        this.table.filterGlobal("" , 'contains');
        this.data = this.treeData();
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
        this.data = [...this.data];
    }

    onNodeClick(event: MouseEvent, rowData: any, colKey: string) {
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) {
            event.stopPropagation();
            return;
        }

        if (colKey === "key") {
            this.onKeyClick(event, rowData);
        } else if (colKey === "value") {
            this.onValueClick(event, rowData);
        }
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
        if (rowData["type"] == this.InspectionValueType.FEATUREID.value) {
            for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
                this.jumpService.highlightByJumpTargetFilter(
                    viewIndex,
                    rowData["mapId"],
                    rowData["value"]).then();
            }
        }
    }

    onNodeHover(event: any, rowData: any) {
        event.stopPropagation();
        this.highlightHoveredEntry(rowData);
    }

    onNodeHoverExit(event: any, rowData: any) {
        event.stopPropagation();
        if (!rowData.hasOwnProperty("type")) {
            return;
        }
        if (rowData["type"] === this.InspectionValueType.FEATUREID.value) {
            this.mapService.setHoveredFeatures([]).then();
        }
    }

    private highlightHoveredEntry(rowData: any) {
        if (!rowData.hasOwnProperty("type") && !rowData.hasOwnProperty("hoverId")) {
            return;
        }
        if (rowData["type"] == this.InspectionValueType.FEATUREID.value) {
            for (let viewIndex = 0; viewIndex < this.stateService.numViews; viewIndex++) {
                this.jumpService.highlightByJumpTargetFilter(
                    viewIndex,
                    rowData["mapId"],
                    rowData["value"],
                    coreLib.HighlightMode.HOVER_HIGHLIGHT).then();
            }
        } else if (rowData["hoverId"] && this.selectedFeatures()) {
            this.mapService.setHoveredFeatures([{
                mapTileKey: this.selectedFeatures()!.features[rowData["featureIndex"]].mapTileKey,
                featureId: rowData["hoverId"]
            }]).then();
        }
    }

    showSourceData(event: Event, sourceDataRef: any) {
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

    getStyleClassByType(rowData: any): string {
        if (!rowData || !rowData.hasOwnProperty("type")) {
            return "standard-style";
        }
        switch (rowData["type"]) {
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
            this.data = this.treeData();
            this.expandTreeNodes(this.data);
        }

        const query = filterString.toLowerCase();
        this.table.filterGlobal(query, "contains");
    }

    expandTreeNodes(nodes: TreeTableNode[], parent: TreeTableNode | null = null): void {
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
