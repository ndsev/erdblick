import {Component, OnInit, Input, ViewChild} from "@angular/core";
import {TreeTableNode} from "primeng/api";
import {InspectionService, SelectedSourceData} from "./inspection.service";
import {MapService} from "./map.service";
import {coreLib} from "./wasm";
import {SourceDataAddressFormat} from "build/libs/core/erdblick-core";
import {TreeTable} from "primeng/treetable";
import {Menu} from "primeng/menu";

@Component({
    selector: 'sourcedata-panel',
    template: `
        <div class="flex resizable-container" [ngClass]="{'resizable-container-expanded': isExpanded}">
            <div class="resize-handle" (click)="isExpanded = !isExpanded">
                <i *ngIf="!isExpanded" class="pi pi-chevron-up"></i>
                <i *ngIf="isExpanded" class="pi pi-chevron-down"></i>
            </div>
            <ng-container *ngIf="errorMessage.length == 0; else errorTemplate">
                <p-treeTable #tt
                    class="panel-tree"
                    scrollHeight="flex"
                    [value]="treeData"
                    [loading]="loading"
                    [autoLayout]="true"
                    [scrollable]="true"
                    [resizableColumns]="true"
                    [virtualScroll]="true"
                    [virtualScrollItemSize]="26"
                    [tableStyle]="{'min-width': '150px', 'min-height': '1px', 'padding': '0px'}"
                    
                    filterMode="strict"
                    [globalFilterFields]="filterFields"
                >
                    <ng-template pTemplate="caption">
                        <div class="p-input-icon-left ml-auto filter-container">
                            <i class="pi pi-search"></i>
                            <input class="filter-input" type="text" pInputText placeholder="Filter data"
                                   [(ngModel)]="filterString"
                                   (ngModelChange)="tt.filterGlobal(filterString, 'contains')"
                                   (input)="tt.filterGlobal($any($event.target).value, 'contains')"
                            />
                            <i *ngIf="filterString" (click)="clearFilter()"
                               class="pi pi-times clear-icon" style="cursor: pointer"></i>
                            <p-button icon="pi pi-ellipsis-v" tooltip="Select Layer" (click)="layerListMenu.toggle($event)" />
                        </div>
                    </ng-template>

                    <ng-template pTemplate="colgroup">
                        <colgroup>
                            <col *ngFor="let col of columns" [style.width]="col.width" />
                        </colgroup>
                    </ng-template>

                    <ng-template pTemplate="header">
                        <tr>
                            <th *ngFor="let col of columns" ttResizableColumn>
                                {{ col.header }}
                            </th>
                        </tr>
                    </ng-template>

                    <ng-template pTemplate="body" let-rowNode let-rowData="rowData">
                        <tr [ttRow]="rowNode" [class]="rowData.styleClass || ''">
                            <td *ngFor="let col of columns; let i = index">
                                <p-treeTableToggler [rowNode]="rowNode" *ngIf="i == 0" />
                                <span *ngIf="filterFields.indexOf(col.key) != -1" [innerHTML]="col.transform(rowData[col.key]) | highlight: filterString"></span>
                                <span *ngIf="filterFields.indexOf(col.key) == -1" [innerHTML]="col.transform(rowData[col.key])"></span>
                            </td>
                        </tr>
                    </ng-template>
                </p-treeTable>
            </ng-container>
        </div>
    
        <ng-template #errorTemplate>
            <div class="error">
                <div>
                    <strong>Error</strong><br>
                    {{ errorMessage }}
                </div>
            </div>
        </ng-template>

        <p-menu #layerListMenu [model]="layerList" [popup]="true" appendTo="body" />
    `
})
export class SourceDataPanelComponent implements OnInit {
    @Input() sourceData!: SelectedSourceData;

    @ViewChild('tt') table!: TreeTable;
    @ViewChild('layerListMenu') layerListMenu!: Menu;

    treeData: TreeTableNode[] = [];
    filterFields = [
        "key",
        "value"
    ];
    columns = [
        { key: "key",     header: "Key",     width: '0*',   transform: (v: any) => v },
        { key: "value",   header: "Value",   width: '0*',   transform: (v: any) => v },
        { key: "address", header: "Address", width: '80px', transform: this.addressFormatter },
        { key: "type",    header: "Type",    width: 'auto', transform: this.schemaTypeURLFormatter },
    ]

    loading: boolean = true;
    addressFormat: SourceDataAddressFormat = coreLib.SourceDataAddressFormat.BIT_RANGE;
    errorMessage = "";
    isExpanded = false;
    filterString = "";

    layerList: any[] = [];

    constructor(private inspectionService: InspectionService, public mapService: MapService) {}

    ngOnInit(): void {
        this.inspectionService.loadSourceDataLayer(this.sourceData.tileId, this.sourceData.layerId, this.sourceData.mapId)
            .then(layer => {
                let root = layer.toObject()
                this.addressFormat = layer.addressFormat();

                layer.delete();

                if (root) {
                    this.treeData = root.children ? root.children : [root]
                    this.selectItemWithAddress(this.sourceData.address);
                } else {
                    this.treeData = []
                    this.setError('Empty layer.')
                }
            })
            .catch(error => {
                this.setError(`${error}`)
            })
            .finally(() => {
                this.loading = false;
            });

        this.mapService.maps.subscribe(maps => {
            const map = maps.get(this.sourceData.mapId);
            if (map) {
                this.layerList = Array.from(map.layers.values())
                    .filter(item => item.layerId.startsWith("SourceData-"))
                    .map(item => {
                        return {
                            label: item.layerId,
                            disabled: item.layerId === this.sourceData.layerId,
                            command: () => {
                                let sourceData = {...this.sourceData};
                                sourceData.layerId = item.layerId;
                                sourceData.address = BigInt(0);

                                this.inspectionService.selectedSourceData.next(sourceData);
                            },
                        };
                    });
            } else {
                this.layerList = [];
            }
        });
    }

    /**
     * Set an error message that gets displayed.
     * Unsets the tree to an empty array.
     *
     * @param message Error message
     */
    setError(message: string) {
        this.loading = false;
        this.treeData = [];
        this.errorMessage = message;

        console.error(this.errorMessage);
    }

    /**
     * Returns an HTML <a> tag, with the URL pointing to the nds.live documentation
     * for the given zserio type schema.
     *
     * @param schema Zserio schema string
     * @return string HTML
     */
    schemaTypeURLFormatter(schema?: string) {
        if (!schema) {
            return schema;
        }

        const prefix = "https://developer.nds.live/schema/";

        let match = schema.match(/^nds\.(([^.]+\.)+)v(\d{4}_\d{2})((\.[^.]*)+)/);
        if (!match || match.length <= 4)
            return schema;

        // Sub-namespaces in front of the version get joined by "-". Names past the version get joined by "/"
        let url =
            match[1].replace(/^(.*)\.$/, "$1/").replaceAll(".", "-") +
            match[3].replaceAll("_", ".") +
            match[4].replaceAll(".", "/");
        return `<a href="${prefix + url}" target="_blank">${schema}</a>`;
    }

    addressFormatter(address?: any) {
        if (!address) {
            return address;
        }

        if (typeof address === 'object') {
            return `${address.offset}:${address.size}`
        } else {
            return `${address}`
        }
    }

    selectItemWithAddress(address: bigint) {
        let searchAddress: any = address;
        let addressInRange: any;
        if (this.addressFormat == coreLib.SourceDataAddressFormat.BIT_RANGE) {
            searchAddress = {
                offset: address >> BigInt(32) & BigInt(0xFFFFFFFF),
                size: address & BigInt(0xFFFFFFFF),
            }

            const addressLow = typeof searchAddress === 'object' ? searchAddress['offset'] : searchAddress;
            const addressHigh = addressLow + (typeof searchAddress === 'object' ? searchAddress['size'] : searchAddress);

            addressInRange = (addr: any) => {
                return addr.offset >= addressLow && addr.offset + addr.size <= addressHigh && (addr.size != 0 || addressLow == addressHigh);
            }
        } else {
            addressInRange = (addr: any) => {
                return addr == searchAddress;
            }
        }

        // Virtual row index (visible row index) of the first highlighted row, or undefined.
        let firstHighlightedItemIndex : number | undefined;

        let select = (node: TreeTableNode, parents: TreeTableNode[], highlight: boolean, virtualRowIndex: number) => {
            if (!node.data) {
                return;
            }

            if (highlight) {
                node.data.styleClass = "highlight";
            }

            const address = node.data.address;
            if (address && addressInRange(address)) {
                highlight = true;

                if (!firstHighlightedItemIndex)
                    firstHighlightedItemIndex = virtualRowIndex;

                node.data.styleClass = "highlight";
                parents.forEach((parent: TreeTableNode) =>{
                    parent.expanded = true;
                })
            }

            if (node.children) {
                node.children.forEach((item: TreeTableNode, index) => { select(item, [...parents, node], highlight, 1 + virtualRowIndex + index) })
            }
        };

        console.log(`Highlighting item with address`, searchAddress);
        this.treeData.forEach((item: TreeTableNode, index) => {
            select(item, [], false, index);
        });

        setTimeout(() => {
            this.table.scrollToVirtualIndex(firstHighlightedItemIndex || 0);
        }, 0);
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
}
