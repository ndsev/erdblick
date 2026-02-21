import {Component, effect, input, output, ViewChild} from "@angular/core";
import {TreeTableNode} from "primeng/api";
import {MapDataService} from "../mapdata/map.service";
import {coreLib} from "../integrations/wasm";
import {InspectionPanelModel} from "../shared/appstate.service";
import {FeatureWrapper} from "../mapdata/features.model";
import {Column, FeatureFilterOptions, InspectionTreeComponent} from "./inspection.tree.component";
import {KeyboardService} from "../shared/keyboard.service";
import {Feature} from '../../build/libs/core/erdblick-core';

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
        <inspection-tree [treeData]="treeData" [columns]="columns" [panelId]="panel().id"
                         [geoJson]="geoJson" [selectedFeatures]="selectedFeatures"
                         [filterText]="filterText()" (filterTextChange)="filterTextChange.emit($event)"
                         [showFilter]="showFilter()"
                         [enableSourceDataNavigation]="enableSourceDataNavigation()">
        </inspection-tree>
    `,
    styles: [``],
    standalone: false
})
export class FeaturePanelComponent {

    panel = input.required<InspectionPanelModel<FeatureWrapper>>();
    enableSourceDataNavigation = input<boolean>(true);
    filterText = input<string | undefined>();
    filterTextChange = output<string>();
    showFilter = input<boolean>(true);

    treeData: TreeTableNode[] = [];
    columns: Column[] = [
        { key: "key",   header: "Key",   width: '0*', transform: this.formatData.bind(this) },
        { key: "value", header: "Value", width: '0*', transform: this.formatData.bind(this) }
    ];
    filterOptions = new FeatureFilterOptions();
    geoJson: string = "";
    selectedFeatures?: FeatureWrapper[];

    @ViewChild(InspectionTreeComponent) inspectionTree?: InspectionTreeComponent;

    constructor(private mapService: MapDataService,
                private keyboardService: KeyboardService) {
        // TODO: This shortcut is broken, the panels will race with each other.
        // this.keyboardService.registerShortcut("Ctrl+j", this.zoomToFeature.bind(this));
        effect(() => {
            this.selectedFeatures = this.panel().features;
            const selectedFeatureInspectionModels: InspectionModelData[][] = [];
            const selectedFeatureGeoJsonTexts: string[] = [];

            this.selectedFeatures.forEach(featureWrapper => {
                featureWrapper.peek((feature: Feature) => {
                    selectedFeatureInspectionModels.push(feature.inspectionModel() as InspectionModelData[]);
                    selectedFeatureGeoJsonTexts.push(feature.geojson() as string);
                });
            });
            this.geoJson = `{"type": "FeatureCollection", "features": [${selectedFeatureGeoJsonTexts.join(", ")}]}`;
            this.treeData = this.getFeatureTreeDataFromModel(selectedFeatureInspectionModels);
        });
    }

    getFeatureTreeDataFromModel(inspectionModelsByFeature: InspectionModelData[][]) {
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
                    value: value ?? "",
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
        if (inspectionModelsByFeature) {
            for (let featureIndex = 0; featureIndex < inspectionModelsByFeature.length; featureIndex++) {
                const inspectionModels = inspectionModelsByFeature[featureIndex];
                for (const section of inspectionModels) {
                    const node: TreeTableNode = {};
                    node.data = {key: section.key, value: section.value, type: section.type};
                    if (section.hasOwnProperty("info")) {
                        node.data["info"] = section.info;
                    }
                    if (section.hasOwnProperty("sourceDataReferences")) {
                        node.data["sourceDataReferences"] = section.sourceDataReferences;
                    }
                    node.children = convertToTreeTableNodes(section.children, featureIndex);
                    treeNodes.push(node);
                }
            }
        }
        return treeNodes;
    }

    formatData(colKey: string, rowData: any) {
        if (!colKey || !rowData.hasOwnProperty(colKey)) {
            return "";
        }

        return rowData[colKey];
    }

    zoomToFeature() {
        // Currently only takes the first element for Jump to Feature functionality.
        // TODO: Allow to use the whole set for Jump to Feature.
        if (!this.selectedFeatures) {
            return;
        }
        this.mapService.zoomToFeature(undefined, this.selectedFeatures[0]);
    }

    showGeoJsonMenu(event: MouseEvent) {
        this.inspectionTree?.showGeoJsonMenu(event);
    }

    openGeoJsonInNewTab() {
        this.inspectionTree?.openGeoJsonInNewTab();
    }

    downloadGeoJson() {
        this.inspectionTree?.downloadGeoJson();
    }

    copyGeoJson() {
        this.inspectionTree?.copyGeoJson();
    }

    freezeTree() {
        this.inspectionTree?.freeze();
    }

    unfreezeTree() {
        this.inspectionTree?.unfreeze();
    }
}
