import {
    AfterViewInit,
    Component, ElementRef,
    OnDestroy,
    OnInit, Renderer2,
    ViewChild
} from "@angular/core";
import {MenuItem, TreeNode, TreeTableNode} from "primeng/api";
import {InspectionService} from "./inspection.service";
import {JumpTargetService} from "../search/jump.service";
import {Menu} from "primeng/menu";
import {MapService} from "../mapdata/map.service";
import {distinctUntilChanged, Subscription} from "rxjs";
import {coreLib} from "../integrations/wasm";
import {ClipboardService} from "../shared/clipboard.service";
import {TreeTable} from "primeng/treetable";
import {AppStateService} from "../shared/appstate.service";
import {InfoMessageService} from "../shared/info.service";

interface Column {
    field: string;
    header: string;
}

@Component({
    selector: 'feature-panel',
    template: `
        <div class="flex justify-content-end align-items-center"
             style="display: flex; align-content: center; justify-content: center; width: 100%; padding: 0.5em;">
            <p-iconfield class="filter-container">
                <p-inputicon (click)="filterPanel.toggle($event)" styleClass="pi pi-filter" style="cursor: pointer" />
                <input class="filter-input" type="text" pInputText placeholder="Filter data for selected feature"
                       [(ngModel)]="inspectionService.featureTreeFilterValue" (ngModelChange)="filterTree()"
                       (keydown)="onKeydown($event)"
                />
                <i *ngIf="inspectionService.featureTreeFilterValue" (click)="clearFilter()"
                   class="pi pi-times clear-icon" style="cursor: pointer"></i>
            </p-iconfield>
            <div>
                <p-button (click)="mapService.focusOnFeature(inspectionService.selectedFeatures[0])"
                          label="" pTooltip="Focus on feature" tooltipPosition="bottom"
                          [style]="{'padding-left': '0', 'padding-right': '0', 'margin-left': '0.5em', width: '2em', height: '2em'}">
                    <span class="material-icons" style="font-size: 1.2em; margin: 0 auto;">loupe</span>
                </p-button>
            </div>
            <div>
                <p-button (click)="copyToClipboard(inspectionService.selectedFeatureGeoJsonCollection())"
                          icon="pi pi-fw pi-copy" label=""
                          [style]="{'margin-left': '0.5em', width: '2em', height: '2em'}"
                          pTooltip="Copy GeoJSON" tooltipPosition="bottom">
                </p-button>
            </div>
        </div>
        <div class="flex resizable-container" #resizeableContainer
             [style.width.px]="inspectionContainerWidth"
             [style.height.px]="inspectionContainerHeight"
             (mouseup)="parameterService.onInspectionContainerResize($event)"
             [ngClass]="{'resizable-container-expanded': isExpanded}">
<!--            <div class="resize-handle" (click)="isExpanded = !isExpanded">-->
<!--                <i *ngIf="!isExpanded" class="pi pi-chevron-up"></i>-->
<!--                <i *ngIf="isExpanded" class="pi pi-chevron-down"></i>-->
<!--            </div>-->
            <p-treeTable #tt filterMode="strict" scrollHeight="flex"
                         [value]="filteredTree"
                         [columns]="cols"
                         [scrollable]="true"
                         [virtualScroll]="true"
                         [virtualScrollItemSize]="26"
                         [tableStyle]="{'min-width': '1px', 'min-height': '1px'}"
            >
                <ng-template pTemplate="body" let-rowNode let-rowData="rowData">
                    <tr [ttRow]="rowNode" (click)="onRowClick(rowNode)">
                        <td [ngClass]="{'section-style': rowData['type']==InspectionValueType.SECTION.value}">
                            <div style="white-space: nowrap; overflow-x: auto; scrollbar-width: thin;"
                                 [pTooltip]="rowData['key'].toString()" tooltipPosition="left"
                                 [tooltipOptions]="tooltipOptions">
                                <div style="display: flex; flex-direction: row; gap: 0.25em">
                                    <p-treeTableToggler [rowNode]="rowNode" (click)="$event.stopPropagation()">
                                    </p-treeTableToggler>
                                    <span (click)="onKeyClick($event, rowData)"
                                          (mouseover)="onKeyHover($event, rowData)"
                                          (mouseout)="onKeyHoverExit($event, rowData)"
                                          style="cursor: pointer">
                                        {{ rowData['key'] }}
                                    </span>
                                    <p-buttonGroup *ngIf="rowData['sourceDataReferences']"
                                                   class="source-data-ref-container">
                                        <ng-template ngFor let-item [ngForOf]="rowData.sourceDataReferences">
                                            <p-button class="source-data-button"
                                                      (click)="showSourceData($event, item)"
                                                      severity="secondary"
                                                      label="{{ item.qualifier.substring(0, 1).toUpperCase() }}"
                                                      pTooltip="Go to {{ item.qualifier }} Source Data"
                                                      tooltipPosition="bottom" />
                                        </ng-template>
                                    </p-buttonGroup>
                                </div>
                            </div>
                        </td>
                        <td [class]="getStyleClassByType(rowData['type'])">
                            <div style="white-space: nowrap; overflow-x: auto; scrollbar-width: thin;"
                                 [pTooltip]="rowData['value'].toString()" tooltipPosition="left"
                                 [tooltipOptions]="tooltipOptions">
                                <div (click)="onValueClick($event, rowData)"
                                     (mouseover)="onValueHover($event, rowData)"
                                     (mouseout)="onValueHoverExit($event, rowData)">
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
        <p-menu #inspectionMenu [model]="inspectionMenuItems" [popup]="true" [baseZIndex]="9999" appendTo="body"
                [style]="{'font-size': '0.9em'}"></p-menu>
        <p-popover #filterPanel class="filter-panel">
            <div class="font-bold white-space-nowrap"
                 style="display: flex; justify-items: flex-start; gap: 0.5em; flex-direction: column">
                <div style="display: inline-block; cursor: pointer" (click)="filterByKeys = !filterByKeys">
                    <p-checkbox [(ngModel)]="filterByKeys" (ngModelChange)="filterTree()" inputId="fbk" [binary]="true"/>
                    <label for="fbk" style="margin-left: 0.5em; cursor: pointer">Filter by Keys</label>
                </div>
                <div style="display: inline-block; cursor: pointer" (click)="filterByValues = !filterByValues">
                    <p-checkbox [(ngModel)]="filterByValues" (ngModelChange)="filterTree()" inputId="fbv" [binary]="true"/>
                    <label for="fbv" style="margin-left: 0.5em; cursor: pointer">Filter by Values</label>
                </div>
                <div style="display: inline-block; cursor: pointer" (click)="filterOnlyFeatureIds = !filterOnlyFeatureIds">
                    <p-checkbox [(ngModel)]="filterOnlyFeatureIds" (ngModelChange)="filterTree()" inputId="fofids" [binary]="true"/>
                    <label for="fofids" style="margin-left: 0.5em; cursor: pointer">Filter only FeatureIDs</label>
                </div>
                <div style="display: inline-block; cursor: pointer" (click)="filterGeometryEntries = !filterGeometryEntries">
                    <p-checkbox [(ngModel)]="filterGeometryEntries" (ngModelChange)="filterTree()" inputId="ige" [binary]="true"/>
                    <label for="ige" style="margin-left: 0.5em; cursor: pointer">Include Geometry Entries</label>
                </div>
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
export class FeaturePanelComponent implements OnInit, AfterViewInit, OnDestroy  {

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
    jsonTree = "";

    @ViewChild('tt') table!: TreeTable;

    @ViewChild('resizeableContainer') resizeableContainer!: ElementRef;
    @ViewChild('inspectionMenu') inspectionMenu!: Menu;
    inspectionMenuItems: MenuItem[] | undefined;
    inspectionMenuVisible: boolean = false;

    inspectionContainerWidth: number;
    inspectionContainerHeight: number;
    containerSizeSubscription: Subscription;

    constructor(private clipboardService: ClipboardService,
                public inspectionService: InspectionService,
                public jumpService: JumpTargetService,
                public parameterService: AppStateService,
                private renderer: Renderer2,
                private messageService: InfoMessageService,
                public mapService: MapService) {
        this.inspectionService.featureTree.pipe(distinctUntilChanged()).subscribe((tree: string) => {
            this.jsonTree = tree;
            this.filteredTree = tree ? JSON.parse(tree) : [];
            this.expandTreeNodes(this.filteredTree);
            if (this.inspectionService.featureTreeFilterValue) {
                this.filterTree();
            }
        });

        this.inspectionService.inspectionPanelChanged.subscribe(() => {
            // We have to force recalculate the tables number of visible items
            setTimeout(() => {
                let scroller = (<any>this.table.scrollableViewChild)?.scroller;
                if (scroller) {
                    scroller.init();
                    scroller.calculateAutoSize();
                }
            }, 0);
        });

        this.inspectionContainerWidth = this.parameterService.inspectionContainerWidth * this.parameterService.baseFontSize;
        this.inspectionContainerHeight = this.parameterService.inspectionContainerHeight * this.parameterService.baseFontSize;
        this.containerSizeSubscription = this.parameterService.panelState.subscribe(panel => {
            if (panel.length === 2) {
                this.inspectionContainerWidth = panel[0] * this.parameterService.baseFontSize;
                this.inspectionContainerHeight = panel[1] * this.parameterService.baseFontSize;
            } else {
                this.inspectionContainerWidth = this.parameterService.inspectionContainerWidth;
                this.inspectionContainerHeight = this.parameterService.inspectionContainerHeight;
            }
        });
    }

    ngOnInit(): void {
        this.cols = [
            { field: 'key', header: 'Key' },
            { field: 'value', header: 'Value' }
        ];
    }

    ngAfterViewInit() {
        this.detectSafari();
    }

    copyToClipboard(text: string) {
        this.clipboardService.copyToClipboard(text);
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
    }

    showSourceData(event: any, sourceDataRef: any) {
        event.stopPropagation();

        try {
            const layerId = sourceDataRef.layerId;
            const tileId = sourceDataRef.tileId;
            const address = sourceDataRef.address;
            const mapId = this.inspectionService.selectedFeatures[0].featureTile.mapName;
            const featureIds = this.inspectionService.selectedFeatures.map(f => f.featureId).join(", ");

            this.inspectionService.selectedSourceData.next({
                tileId: Number(tileId),
                layerId: String(layerId),
                mapId: String(mapId),
                address: BigInt(address),
                featureIds: featureIds,
            });
        } catch (e) {
            this.messageService.showError(`Encountered error: ${e}`);
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
                rowData["mapId"],
                rowData["value"]).then();
        }
    }

    private highlightHoveredEntry(rowData: any) {
        if (rowData["type"] == this.InspectionValueType.FEATUREID.value) {
            this.jumpService.highlightByJumpTargetFilter(
                rowData["mapId"],
                rowData["value"],
                coreLib.HighlightMode.HOVER_HIGHLIGHT).then();
        } else if (rowData["hoverId"]) {
            this.mapService.highlightFeatures([{
                mapTileKey: this.inspectionService.selectedFeatures[rowData["featureIndex"]].featureTile.mapTileKey,
                featureId: rowData["hoverId"]
            }], false, coreLib.HighlightMode.HOVER_HIGHLIGHT).then();
        }
    }

    onValueHover(event: any, rowData: any) {
        event.stopPropagation();
        this.highlightHoveredEntry(rowData);
    }

    onValueHoverExit(event: any, rowData: any) {
        event.stopPropagation();
        if (rowData["type"] == this.InspectionValueType.FEATUREID.value) {
            this.mapService.highlightFeatures([], false, coreLib.HighlightMode.HOVER_HIGHLIGHT).then();
        }
    }

    onKeyHover(event: any, rowData: any) {
        event.stopPropagation();
        this.highlightHoveredEntry(rowData);
    }

    onKeyHoverExit(event: any, rowData: any) {
        event.stopPropagation();
        if (rowData["type"] == this.InspectionValueType.FEATUREID.value) {
            this.mapService.highlightFeatures([], false, coreLib.HighlightMode.HOVER_HIGHLIGHT).then();
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

    ngOnDestroy() {
        this.containerSizeSubscription.unsubscribe();
    }

    detectSafari() {
        const isSafari = /Safari/i.test(navigator.userAgent);
        if (isSafari) {
            this.renderer.addClass(this.resizeableContainer.nativeElement, 'safari');
        }
    }
}
