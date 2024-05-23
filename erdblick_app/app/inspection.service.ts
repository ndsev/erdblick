import {Injectable} from "@angular/core";
import {TreeTableNode} from "primeng/api";
import {BehaviorSubject} from "rxjs";
import {MapService} from "./map.service";
import {Feature} from "../../build/libs/core/erdblick-core";

export enum InspectionValueType {
    Null = 0,
    Number = 1,
    String = 2,
    Boolean = 3,
    FeatureId = 4,
    Section = 5,
    ArrayBit = 128,
}

interface InspectionModelData {
    key: string;
    type: InspectionValueType;
    value: any;
    info?: string;
    hoverId?: string;
    children: Array<InspectionModelData>;
}

@Injectable({providedIn: 'root'})
export class InspectionService {

    featureTree: BehaviorSubject<string> = new BehaviorSubject<string>("");
    isInspectionPanelVisible: boolean = false;
    selectedFeatureGeoJsonText: string = "";
    selectedFeatureInspectionModel: Array<InspectionModelData> | null = null;
    selectedFeatureIdName: string = "";
    selectedMapIdName: string = "";
    hooveredFeatureIdToHighlight: BehaviorSubject<string> = new BehaviorSubject<string>("");

    constructor(mapService: MapService) {
        mapService.selectionTopic.subscribe((selectedFeature) => {
            if (!selectedFeature) {
                this.isInspectionPanelVisible = false;
                return;
            }
            this.selectedMapIdName = selectedFeature.featureTile.mapName;
            selectedFeature.peek((feature: Feature) => {
                this.selectedFeatureInspectionModel = feature.inspectionModel();
                this.selectedFeatureGeoJsonText = feature.geojson() as string;
                this.selectedFeatureIdName = feature.id() as string;
                this.isInspectionPanelVisible = true;
                this.loadFeatureData();
            })
        });
    }

    getFeatureTreeDataFromModel() {
        let convertToTreeTableNodes = (dataNodes: Array<InspectionModelData>): TreeTableNode[] => {
            let treeNodes: Array<TreeTableNode> = [];
            for (const data of dataNodes) {
                const node: TreeTableNode = {};
                node.data = {
                    key: data.key,
                    value: data.type == InspectionValueType.Null && data.children === undefined ? "NULL" : data.value,
                    type: data.type
                };
                if (data.hasOwnProperty("info")) {
                    node.data["info"] = data.info;
                }
                if (data.hasOwnProperty("hoverId")) {
                    node.data["hoverId"] = data.hoverId;
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
}