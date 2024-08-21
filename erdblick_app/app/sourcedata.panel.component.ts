import {
    Component,
    OnInit,
    Input,
    ViewChild,
    HostListener,
    Directive,
    Output,
    EventEmitter,
    OnDestroy, AfterViewInit, ElementRef,
    Renderer2
} from "@angular/core";
import {TreeTableNode} from "primeng/api";
import {InspectionService, SelectedSourceData} from "./inspection.service";
import {coreLib} from "./wasm";
import {SourceDataAddressFormat} from "build/libs/core/erdblick-core";
import {TreeTable, TTScrollableView} from "primeng/treetable";
import {VirtualScroller} from "primeng/virtualscroller";
import {combine} from "cesium";


@Component({
    selector: 'sourcedata-panel',
    template: `
        <div #resizableContainer class="flex resizable-container" [ngClass]="{'resizable-container-expanded': isExpanded}" >
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
                    [scrollable]="true"
                    [resizableColumns]="true"
                    columnResizeMode="expand"
                    [virtualScroll]="true"
                    [virtualScrollItemSize]="26" 
                    [tableStyle]="{ 'min-width': '30em', 'min-height': '26px' }"
                             
                    
                    filterMode="strict"
                    [globalFilterFields]="filterFields"
                >
                    <ng-template pTemplate="caption">
                        <div class="filter-wrapper">
                            <div class="p-input-icon-left ml-auto filter-container">
                                <i class="pi pi-search"></i>
                                <input class="filter-input" type="text" pInputText placeholder="Filter data"
                                       [(ngModel)]="filterString"
                                       (ngModelChange)="tt.filterGlobal(filterString, 'contains')"
                                       (input)="tt.filterGlobal($any($event.target).value, 'contains')"
                                />
                                <i *ngIf="filterString" (click)="clearFilter()"
                                   class="pi pi-times clear-icon" style="cursor: pointer"></i>
                            </div>
                        </div>
                    </ng-template>

                    <ng-template pTemplate="header">
                        <tr style="visibility: collapse">
                            <th *ngFor="let col of columns">
                                {{ col.header }}
                            </th>
                        </tr>
                    </ng-template>

                    <ng-template pTemplate="body" let-rowNode let-rowData="rowData">
                        <tr [ttRow]="rowNode" [class]="rowData.styleClass || ''">
                            <td *ngFor="let col of columns; let i = index">
                                <div class="scroll-cell">
                                    <p-treeTableToggler [rowNode]="rowNode" *ngIf="i == 0" />
                                    <span *ngIf="filterFields.indexOf(col.key) != -1" [innerHTML]="col.transform(rowData[col.key]) | highlight: filterString"></span>
                                    <span *ngIf="filterFields.indexOf(col.key) == -1" [innerHTML]="col.transform(rowData[col.key])"></span>
                                </div>
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
    `
})
export class SourceDataPanelComponent implements OnInit {
    @Input() sourceData!: SelectedSourceData;

    @ViewChild('tt') table!: TreeTable;
    @ViewChild('resizableContainer') resizableContainer!: HTMLDivElement;

    treeData: TreeTableNode[] = [];
    filterFields = [
        "key",
        "value"
    ];
    columns = [
        { key: "key", header: "Key", transform: (v: any) => v },
        { key: "value", header: "Value", transform: (v: any) => v },
        { key: "address", header: "Address", transform: this.addressFormatter },
        { key: "type", header: "Type", transform: this.schemaTypeURLFormatter },
    ]

    loading: boolean = true;
    addressFormat: SourceDataAddressFormat = coreLib.SourceDataAddressFormat.BIT_RANGE;
    errorMessage = "";
    isExpanded = false;
    filterString = "";

    constructor(private renderer: Renderer2,
                private inspectionService: InspectionService) {}

    ngOnInit(): void {
        this.inspectionService.loadSourceDataLayer(this.sourceData.tileId, this.sourceData.layerId, this.sourceData.mapId)
            .then(layer => {
                let root = layer.toObject()
                this.addressFormat = layer.addressFormat();

                layer.delete();

                if (root) {
                    const firstRow = {data: {key: "Key", value: "Value", address: "Address", type: "Type"}, children: []};
                    this.treeData = root.children ? [firstRow, ...root.children] : [firstRow, root];
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

        // Test for a string like "nds.v1234_56.a.b.c"
        if (!schema.match(/^nds\.(.*\.)+v\d{4}_\d{2}(\..*)+/)) {
            return schema;
        }

        let url = schema.replaceAll(".", "/")
            .replace(/^nds\//, "")
            .replace(/v(\d{4})_(\d{2})/, "$1.$2");
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

        // console.log(`Highlighting item with address`, searchAddress);
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

    onContainerResize(event: any) {
        const scrollableChild = this.table.scrollableViewChild as unknown as TTScrollableView;
    }
}
