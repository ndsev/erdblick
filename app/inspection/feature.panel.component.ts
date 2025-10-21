import {
    AfterViewInit,
    Component, ElementRef, input,
    OnDestroy,
    OnInit, Renderer2,
    ViewChild
} from "@angular/core";
import {MenuItem, TreeNode, TreeTableNode} from "primeng/api";
import {InspectionService} from "./inspection.service";
import {JumpTargetService} from "../search/jump.service";
import {Menu} from "primeng/menu";
import {MapDataService} from "../mapdata/map.service";
import {distinctUntilChanged, Subscription} from "rxjs";
import {coreLib} from "../integrations/wasm";
import {ClipboardService} from "../shared/clipboard.service";
import {TreeTable} from "primeng/treetable";
import {AppStateService, InspectionPanelModel} from "../shared/appstate.service";
import {InfoMessageService} from "../shared/info.service";
import {FeatureWrapper} from "../mapdata/features.model";
import {Column} from "./inspection.tree.component";

interface InspectionModelData {
    key: string;
    type: number;
    value: any;
    info?: string;
    hoverId?: string
    geoJsonPath?: string;
    mapId?: string;
    sourceDataReferences?: Array<object>;
    children: Array<InspectionModelData>;
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
                <p-button (click)="mapService.focusOnFeature(0, inspectionService.selectedFeatures[0])"
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
             (mouseup)="stateService.onInspectionContainerResize($event)"
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
        
    `,
    styles: [``],
    standalone: false
})
export class FeaturePanelComponent {

    panel = input.required<InspectionPanelModel<FeatureWrapper>>();

    filteredTree: TreeTableNode[] = [];
    columns: Column[] = [
        { key: "key",   header: "Key",   width: '0*' },
        { key: "value", header: "Value", width: '0*' },
    ];
    isExpanded: boolean = false;
    tooltipOptions = {
        showDelay: 1000,
        autoHide: false
    };
    jsonTree = "";

    @ViewChild('tt') table!: TreeTable;

    constructor(private clipboardService: ClipboardService,
                public inspectionService: InspectionService,
                public jumpService: JumpTargetService,
                public stateService: AppStateService,
                private messageService: InfoMessageService,
                public mapService: MapDataService) {
        this.inspectionService.featureTree.pipe(distinctUntilChanged()).subscribe((tree: string) => {
            this.jsonTree = tree;
            this.filteredTree = tree ? JSON.parse(tree) : [];
            this.expandTreeNodes(this.filteredTree);
            if (this.inspectionService.featureTreeFilterValue) {
                this.filterTree();
            }
        });
    }

    featureTree: BehaviorSubject<string> = new BehaviorSubject<string>("");
    featureTreeFilterValue: string = "";
    isInspectionPanelVisible: boolean = false;
    selectedFeatureGeoJsonTexts: string[] = [];
    selectedFeatureInspectionModel: InspectionModelData[] = [];
    selectedFeatures: FeatureWrapper[] = [];

    constructor(private mapService: MapDataService,
                private keyboardService: KeyboardService,
                public stateService: AppStateService) {

        this.keyboardService.registerShortcut("Ctrl+j", this.zoomToFeature.bind(this));

        this.mapService.selectionTopic.pipe(/*distinctUntilChanged(selectedFeaturesEqualTo)*/).subscribe(selectedPanels => {
            if (!selectedPanels?.length) {
                this.isInspectionPanelVisible = false;
                this.featureTreeFilterValue = "";
                // this.stateService.setSelection().setSelectedFeatures([]);
                this.selectedFeatures = [];
                return;
            }
            this.selectedFeatureInspectionModel = [];
            this.selectedFeatureGeoJsonTexts = [];
            const selectedFeatures = selectedPanels.map(panel => panel.selectedFeatures).flat();
            this.selectedFeatures = selectedFeatures;

            // Currently only takes the first element for Jump to Feature functionality.
            // TODO: Allow to use the whole set for Jump to Feature.
            if (selectedFeatures.length) {
                selectedFeatures[0].peek((feature: Feature) => {
                    this.selectedFeatureInspectionModel.push(...feature.inspectionModel());
                    this.selectedFeatureGeoJsonTexts.push(feature.geojson() as string);
                    this.isInspectionPanelVisible = true;
                });
            }
            if (selectedFeatures.length > 1) {
                selectedFeatures.slice(1).forEach(selectedFeature => {
                    selectedFeature.peek((feature: Feature) => {
                        this.selectedFeatureInspectionModel.push(...feature.inspectionModel());
                        this.selectedFeatureGeoJsonTexts.push(feature.geojson() as string);
                        this.isInspectionPanelVisible = true;
                    });
                });
            }
            this.loadFeatureData();

            // this.stateService.setSelectedFeatures(0, this.selectedFeatures.map(f => f.key()));
        });
    }

    selectedFeatureGeoJsonCollection() {
        return `{"type": "FeatureCollection", "features": [${this.selectedFeatureGeoJsonTexts.join(", ")}]}`;
    }

    getFeatureTreeDataFromModel() {
        let convertToTreeTableNodes = (dataNodes: Array<InspectionModelData>, featureIndex: number): TreeTableNode[] => {
            let treeNodes: Array<TreeTableNode> = [];
            for (const data of dataNodes) {
                const node: TreeTableNode = {};
                let value = data.value;
                if (data.type == coreLib.ValueType.NULL.value && data.children === undefined) {
                    value = "NULL";
                } else if ((data.type & coreLib.ValueType.ARRAY.value) && (data.type & coreLib.ValueType.NUMBER.value)) {
                    for (let i = 0; i < value.length; i++) {
                        if (!Number.isInteger(value[i])) {
                            const strValue = String(value[i])
                            const index = strValue.indexOf('.');
                            if (index !== -1 && strValue.length - index - 1 > 8) {
                                value[i] = value[i].toFixed(8);
                            }
                        }
                    }
                }

                if (data.type & coreLib.ValueType.ARRAY.value) {
                    value = value.join(", ");
                }

                node.data = {
                    key: data.key,
                    value: value,
                    type: data.type
                };
                if (data.hasOwnProperty("info")) {
                    node.data["info"] = data.info;
                }
                if (data.hasOwnProperty("hoverId")) {
                    node.data["hoverId"] = data.hoverId;
                    // Necessary to query one of the selectedFeatures for its mapTileKey
                    node.data["featureIndex"] = featureIndex;
                }
                if (data.hasOwnProperty("mapId")) {
                    node.data["mapId"] = data.mapId;
                }
                if (data.hasOwnProperty("geoJsonPath")) {
                    node.data["geoJsonPath"] = data.geoJsonPath;
                }
                if (data.hasOwnProperty("sourceDataReferences")) {
                    node.data["sourceDataReferences"] = data.sourceDataReferences;
                }
                node.children = data.hasOwnProperty("children") ? convertToTreeTableNodes(data.children, featureIndex) : [];
                treeNodes.push(node);
            }
            return treeNodes;
        }

        let treeNodes: Array<TreeTableNode> = [];
        if (this.selectedFeatureInspectionModel) {
            for (let i = 0; i < this.selectedFeatureInspectionModel.length; i++) {
                const section = this.selectedFeatureInspectionModel[i];
                const node: TreeTableNode = {};
                node.data = {key: section.key, value: section.value, type: section.type};
                if (section.hasOwnProperty("info")) {
                    node.data["info"] = section.info;
                }
                if (section.hasOwnProperty("sourceDataReferences")) {
                    node.data["sourceDataReferences"] = section.sourceDataReferences;
                }
                node.children = convertToTreeTableNodes(section.children, i);
                treeNodes.push(node);
            }
        }
        return treeNodes;
    }

    loadFeatureData() {
        if (this.selectedFeatureInspectionModel) {
            this.featureTree.next(JSON.stringify(this.getFeatureTreeDataFromModel(), (_, value) => {
                if (typeof value === 'bigint') {
                    return value.toString();
                } else if (value == null) {
                    return "";
                } else {
                    return value;
                }
            }));
        } else {
            this.featureTree.next('[]');
        }
    }
}
