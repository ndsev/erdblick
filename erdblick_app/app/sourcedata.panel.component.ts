import {
    Component,
    OnInit,
    Input,
    ViewChild,
    OnDestroy,
    AfterViewInit,
    ElementRef,
    Renderer2
} from "@angular/core";
import {TreeTableNode} from "primeng/api";
import {InspectionService, SelectedSourceData} from "./inspection.service";
import {MapService} from "./map.service";
import {coreLib} from "./wasm";
import {SourceDataAddressFormat} from "build/libs/core/erdblick-core";
import {TreeTable} from "primeng/treetable";
import {ParametersService} from "./parameters.service";
import {Subscription} from "rxjs";

@Component({
    selector: 'sourcedata-panel',
    template: `
        <div class="flex resizable-container" #resizeableContainer
             [style.width.px]="inspectionContainerWidth"
             [style.height.px]="inspectionContainerHeight"
             (mouseup)="parameterService.onInspectionContainerResize($event)"
             [ngClass]="{'resizable-container-expanded': isExpanded}">
<!--            <div class="resize-handle" (click)="isExpanded = !isExpanded">-->
<!--                <i *ngIf="!isExpanded" class="pi pi-chevron-up"></i>-->
<!--                <i *ngIf="isExpanded" class="pi pi-chevron-down"></i>-->
<!--            </div>-->
            <ng-container *ngIf="errorMessage.length == 0; else errorTemplate">
                <p-treeTable #tt scrollHeight="flex" filterMode="strict"
                    [value]="treeData"
                    [loading]="loading"
                    [autoLayout]="true"
                    [scrollable]="true"
                    [resizableColumns]="true"
                    [virtualScroll]="true"
                    [virtualScrollItemSize]="26"
                    [tableStyle]="{'min-height': '1px', 'padding': '0px'}"
                    [globalFilterFields]="filterFields"
                >
                    <ng-template pTemplate="caption">
                        <div class="p-input-icon-left ml-auto filter-container">
                            <i class="pi pi-filter"></i>
                            <input class="filter-input" type="text" pInputText placeholder="Filter data for selected layer"
                                   [(ngModel)]="filterString"
                                   (ngModelChange)="tt.filterGlobal(filterString, 'contains')"
                                   (input)="tt.filterGlobal($any($event.target).value, 'contains')"
                            />
                            <i *ngIf="filterString" (click)="clearFilter()"
                               class="pi pi-times clear-icon" style="cursor: pointer"></i>
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
                            <td *ngFor="let col of columns; let i = index" style="white-space: nowrap; text-overflow: ellipsis">
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
    `,
    styles: [`
        @media only screen and (max-width: 56em) {
            .resizable-container-expanded {
                height: calc(100vh - 3em);
            }
        }
    `]
})
export class SourceDataPanelComponent implements OnInit, AfterViewInit, OnDestroy {

    @Input() sourceData!: SelectedSourceData;
    @ViewChild('tt') table!: TreeTable;
    @ViewChild('resizeableContainer') resizeableContainer!: ElementRef;

    treeData: TreeTableNode[] = [];
    filterFields = [
        "key",
        "value"
    ];
    columns = [
        { key: "key",     header: "Key",     width: '0*',    transform: (v: any) => v },
        { key: "value",   header: "Value",   width: '0*',    transform: (v: any) => v },
        { key: "address", header: "Address", width: '100px', transform: this.addressFormatter },
        { key: "type",    header: "Type",    width: 'auto',  transform: this.schemaTypeURLFormatter },
    ]

    loading: boolean = true;
    filterString = "";
    addressFormat: SourceDataAddressFormat = coreLib.SourceDataAddressFormat.BIT_RANGE;
    errorMessage = "";
    isExpanded = false;

    inspectionContainerWidth: number;
    inspectionContainerHeight: number;
    containerSizeSubscription: Subscription;

    /**
     * Returns a human-readable layer name for a layer id.
     *
     * @param layerId Layer id to get the name for
     */
    public static layerNameForLayerId(layerId: string) {
        const match = layerId.match(/^SourceData-([^.]+\.)*(.*)-([\d]+)/);
        if (match)
            return `${match[2]}.${match[3]}`;
        return layerId;
    }

    constructor(private inspectionService: InspectionService,
                public parameterService: ParametersService,
                private renderer: Renderer2,
                public mapService: MapService) {
        this.inspectionContainerWidth = this.parameterService.inspectionContainerWidth * this.parameterService.baseFontSize;
        this.inspectionContainerHeight = this.parameterService.inspectionContainerHeight * this.parameterService.baseFontSize;
        console.log("New params", "Constructor", this.inspectionContainerWidth, this.inspectionContainerHeight);
        this.containerSizeSubscription = this.parameterService.parameters.subscribe(parameter => {
            console.log("Old params", "Subscription", this.inspectionContainerWidth, this.inspectionContainerHeight);
            if (parameter.panel.length == 2) {
                this.inspectionContainerWidth = parameter.panel[0] * this.parameterService.baseFontSize;
                this.inspectionContainerHeight = (parameter.panel[1] + 3) * this.parameterService.baseFontSize;
            } else {
                this.inspectionContainerWidth = this.parameterService.inspectionContainerWidth * this.parameterService.baseFontSize;
                this.inspectionContainerHeight = (window.innerHeight - (this.parameterService.inspectionContainerHeight + 3) * this.parameterService.baseFontSize) * this.parameterService.baseFontSize;
            }
            console.log("New params", "Subscription", this.inspectionContainerWidth, this.inspectionContainerHeight);
        });
    }

    ngOnInit(): void {
        this.inspectionService.loadSourceDataLayer(this.sourceData.tileId, this.sourceData.layerId, this.sourceData.mapId)
            .then(layer => {
                const root = layer.toObject()
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
    }

    ngAfterViewInit() {
        this.detectSafari();
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

        console.error("Error while processing SourceData tree:", this.errorMessage);
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

        const match = schema.match(/^nds\.(([^.]+\.)+)v(\d{4}_\d{2})((\.[^.]*)+)/);
        if (!match || match.length <= 4)
            return schema;

        // Sub-namespaces in front of the version get joined by "-". Names past the version get joined by "/"
        const url =
            match[1].replace(/^(.*)\.$/, "$1/").replaceAll(".", "-") +
            match[3].replaceAll("_", ".") +
            match[4].replaceAll(".", "/");
        return `<a href="${prefix + url}" target="_blank">${schema}</a>`;
    }

    addressFormatter(address?: any): string {
        if (typeof address === 'object') {
            return `${address.offset}:${address.size}`
        } else if (address) {
            return `${address}`
        } else {
            return '';
        }
    }

    selectItemWithAddress(address: bigint) {
        let addressInRange: any;
        if (this.addressFormat == coreLib.SourceDataAddressFormat.BIT_RANGE) {
            const searchAddress = {
                offset: address >> BigInt(32) & BigInt(0xFFFFFFFF),
                size: address & BigInt(0xFFFFFFFF),
            }

            const addressLow = typeof searchAddress === 'object' ? searchAddress['offset'] : searchAddress;
            const addressHigh = addressLow + (typeof searchAddress === 'object' ? searchAddress['size'] : searchAddress);

            addressInRange = (address: any) => {
                return address.offset >= addressLow &&
                    address.offset + address.size <= addressHigh &&
                    (address.size != 0 || addressLow == addressHigh);
            }
        } else {
            const searchAddress = address;
            addressInRange = (address: any) => {
                return address == searchAddress;
            }
        }

        // Virtual row index (visible row index) of the first highlighted row, or undefined.
        let firstHighlightedItemIndex: number | undefined;

        let select = (node: TreeTableNode, parents: TreeTableNode[], highlight: boolean, virtualRowIndex: number) => {
            if (!node.data) {
                return;
            }

            if (highlight) {
                node.data.styleClass = "highlight";
            }

            if (node.data.address && addressInRange(node.data.address)) {
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

    ngOnDestroy() {
        this.containerSizeSubscription.unsubscribe();
    }

    detectSafari() {
        console.log(navigator.userAgent)
        const isSafari = /Safari/i.test(navigator.userAgent);
        if (isSafari) {
            this.renderer.addClass(this.resizeableContainer.nativeElement, 'safari');
        }
    }
}
