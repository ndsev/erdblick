import { EventEmitter, Injectable} from "@angular/core";
import {TreeTableNode} from "primeng/api";
import {BehaviorSubject, distinctUntilChanged, filter} from "rxjs";
import {MapService} from "./map.service";
import {Feature} from "../../build/libs/core/erdblick-core";
import {FeatureWrapper} from "./features.model";
import {ParametersService} from "./parameters.service";
import {coreLib} from "./wasm";
import {JumpTargetService} from "./jump.service";


interface InspectionModelData {
    key: string;
    type: number;
    value: any;
    info?: string;
    hoverId?: string
    geoJsonPath?: string;
    sourceDataReferences?: Array<object>;
    children: Array<InspectionModelData>;
}

interface ShowSourceDataEvent {
    mapId: string,
    tileId: number,
    layerId: string,
}

@Injectable({providedIn: 'root'})
export class InspectionService {

    featureTree: BehaviorSubject<string> = new BehaviorSubject<string>("");
    featureTreeFilterValue: string = "";
    isInspectionPanelVisible: boolean = false;
    selectedFeatureGeoJsonText: string = "";
    selectedFeatureInspectionModel: Array<InspectionModelData> | null = null;
    selectedFeatureIdName: string = "";
    selectedMapIdName: string = "";
    selectedFeature: FeatureWrapper | null = null;
    showSourceDataEvent = new EventEmitter<ShowSourceDataEvent>();

    constructor(private mapService: MapService,
                private jumpService: JumpTargetService,
                public parametersService: ParametersService) {
        this.mapService.selectionTopic.pipe(distinctUntilChanged()).subscribe(selectedFeature => {
            if (!selectedFeature) {
                this.isInspectionPanelVisible = false;
                this.featureTreeFilterValue = "";
                this.parametersService.unsetSelectedFeature();
                return;
            }
            this.selectedMapIdName = selectedFeature.featureTile.mapName;
            selectedFeature.peek((feature: Feature) => {
                this.selectedFeatureInspectionModel = feature.inspectionModel();
                this.selectedFeatureGeoJsonText = feature.geojson() as string;
                this.selectedFeatureIdName = feature.id() as string;
                this.isInspectionPanelVisible = true;
                this.loadFeatureData();
            });
            this.selectedFeature = selectedFeature;
            this.parametersService.setSelectedFeature(this.selectedMapIdName, this.selectedFeatureIdName);
        });

        this.parametersService.parameters.pipe(filter(
            parameters => parameters.selected.length == 2)).subscribe(parameters => {
            const [mapId, featureId] = parameters.selected;
            if (mapId != this.selectedMapIdName || featureId != this.selectedFeatureIdName) {
                this.jumpService.highlightFeature(mapId, featureId).then(() => {
                    if (this.selectedFeature) {
                        this.mapService.focusOnFeature(this.selectedFeature);
                    }
                });
            }
        });
    }

    getFeatureTreeDataFromModel() {
        let convertToTreeTableNodes = (dataNodes: Array<InspectionModelData>): TreeTableNode[] => {
            let treeNodes: Array<TreeTableNode> = [];
            for (const data of dataNodes) {
                const node: TreeTableNode = {};
                let value = data.value;
                if (data.type == this.InspectionValueType.NULL.value && data.children === undefined) {
                    value = "NULL";
                } else if ((data.type & 128) == 128 && (data.type - 128) == 1) {
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

                if ((data.type & 128) == 128) {
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
                }
                if (data.hasOwnProperty("geoJsonPath")) {
                    node.data["geoJsonPath"] = data.geoJsonPath;
                }
                if (data.hasOwnProperty("sourceDataReferences")) {
                    node.data["sourceDataReferences"] = data.sourceDataReferences;
                }
                node.children = data.hasOwnProperty("children") ? convertToTreeTableNodes(data.children) : [];
                treeNodes.push(node);
            }
            return treeNodes;
        }

        let treeNodes: Array<TreeTableNode> = [];
        if (this.selectedFeatureInspectionModel) {
            for (const section of this.selectedFeatureInspectionModel) {
                const node: TreeTableNode = {};
                node.data = {key: section.key, value: section.value, type: section.type};
                if (section.hasOwnProperty("info")) {
                    node.data["info"] = section.info;
                }
                node.children = convertToTreeTableNodes(section.children);
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

    protected readonly InspectionValueType = coreLib.ValueType;
}
