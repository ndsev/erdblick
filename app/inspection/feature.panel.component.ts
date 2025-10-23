import {Component, effect, input} from "@angular/core";
import {TreeTableNode} from "primeng/api";
import {MapDataService, SelectedFeatures} from "../mapdata/map.service";
import {coreLib} from "../integrations/wasm";
import {InspectionPanelModel} from "../shared/appstate.service";
import {FeatureWrapper} from "../mapdata/features.model";
import {Column, FeatureFilterOptions} from "./inspection.tree.component";
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
                         [filterOptions]="filterOptions" [geoJson]="geoJson" [selectedFeatures]="selectedFeatures">
        </inspection-tree>
    `,
    styles: [``],
    standalone: false
})
export class FeaturePanelComponent {

    panel = input.required<InspectionPanelModel<FeatureWrapper>>();

    treeData: TreeTableNode[] = [];
    columns: Column[] = [
        { key: "key",   header: "Key",   width: '0*', transform: this.formatWithSourceDataButtons.bind(this) },
        { key: "value", header: "Value", width: '0*', transform: this.formatWithInfoButton.bind(this) }
    ];
    filterOptions = new FeatureFilterOptions();
    geoJson: string = "";
    selectedFeatures?: SelectedFeatures;

    constructor(private mapService: MapDataService,
                private keyboardService: KeyboardService) {
        this.keyboardService.registerShortcut("Ctrl+j", this.zoomToFeature.bind(this));
        effect(() => {
            this.selectedFeatures = {
                viewIndex: 0,
                features: this.panel().selectedFeatures
            };

            const selectedFeatureInspectionModel: InspectionModelData[] = [];
            const selectedFeatureGeoJsonTexts: string[] = [];

            this.selectedFeatures.features.forEach(featureWrapper => {
                featureWrapper.peek((feature: Feature) => {
                    selectedFeatureInspectionModel.push(...feature.inspectionModel());
                    selectedFeatureGeoJsonTexts.push(feature.geojson() as string);
                });
            });
            this.geoJson = `{"type": "FeatureCollection", "features": [${selectedFeatureGeoJsonTexts.join(", ")}]}`;
            this.treeData = this.getFeatureTreeDataFromModel(selectedFeatureInspectionModel);
        });
    }

    getFeatureTreeDataFromModel(inspectionModels: InspectionModelData[]) {
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
        if (inspectionModels) {
            for (let i = 0; i < inspectionModels.length; i++) {
                const section = inspectionModels[i];
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

    formatWithSourceDataButtons(colKey: string, rowData: any) {
        if (!colKey || !rowData.hasOwnProperty(colKey)) {
            return "";
        }
        const keyHtml = `<span>${rowData[colKey]}</span>`;
        if (!rowData.hasOwnProperty("sourceDataReferences") || !rowData["sourceDataReferences"].length) {
            return keyHtml;
        }
        return keyHtml;
    }

    formatWithInfoButton(colKey: string, rowData: any) {
        if (!colKey || !rowData.hasOwnProperty(colKey)) {
            return "";
        }

        const valueHtml = `<span>${rowData[colKey]}</span>`;
        if (!rowData.hasOwnProperty("info")) {
            return valueHtml;
        }
        const infoCircle = `
            <span>
                <i class="pi pi-info-circle" [pTooltip]="rowData['info'].toString()" tooltipPosition="left"></i>
            </span>
        `;
        return `${valueHtml}${infoCircle}`;
    }

    zoomToFeature() {
        // Currently only takes the first element for Jump to Feature functionality.
        // TODO: Allow to use the whole set for Jump to Feature.
        if (!this.selectedFeatures) {
            return;
        }
        this.mapService.zoomToFeature(this.selectedFeatures.viewIndex, this.selectedFeatures.features[0]);
    }
}
