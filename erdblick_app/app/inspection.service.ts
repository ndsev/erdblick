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
    selectedFeatureIdText: string = "";
    hooveredFeatureIdToHighlight: BehaviorSubject<string> = new BehaviorSubject<string>("");

    constructor(mapService: MapService) {
        mapService.selectionTopic.subscribe(selectedFeature => {
            if (!selectedFeature) {
                this.isInspectionPanelVisible = false;
                return;
            }

            selectedFeature.peek((feature: Feature) => {
                this.selectedFeatureInspectionModel = feature.inspectionModel();
                this.selectedFeatureGeoJsonText = feature.geojson() as string;
                this.selectedFeatureIdText = feature.id() as string;
                this.isInspectionPanelVisible = true;
                this.loadFeatureData();
            })
        })
    }

    // getFeatureTreeData() {
    //     let jsonData = JSON.parse(this.selectedFeatureGeoJsonText);
    //     if (jsonData.hasOwnProperty("id")) {
    //         delete jsonData["id"];
    //     }
    //     if (jsonData.hasOwnProperty("properties")) {
    //         jsonData["attributes"] = jsonData["properties"];
    //         delete jsonData["properties"];
    //     }
    //     // Push leaf values up
    //     const sortedJson: Record<string, any> = {};
    //     for (const key in jsonData) {
    //         if (typeof jsonData[key] === "string" || typeof jsonData[key] === "number") {
    //             sortedJson[key] = jsonData[key];
    //         }
    //     }
    //     for (const key in jsonData) {
    //         if (typeof jsonData[key] !== "string" && typeof jsonData[key] !== "number") {
    //             sortedJson[key] = jsonData[key];
    //         }
    //     }
    //
    //     let convertToTreeTableNodes = (json: any): TreeTableNode[] => {
    //         const treeTableNodes: TreeTableNode[] = [];
    //
    //         for (const key in json) {
    //             if (json.hasOwnProperty(key)) {
    //                 const value = json[key];
    //                 const node: TreeTableNode = {};
    //
    //                 if (typeof value === 'object' && value !== null) {
    //                     if (Array.isArray(value)) {
    //                         // If it's an array, iterate through its elements and convert them to TreeTableNodes
    //                         node.data = {k: key, v: "", t: "", vt: InspectionValueType.ArrayBit, rv: value.toString()};
    //                         node.children = value.map((item: any, index: number) => {
    //                             if (typeof item === 'object') {
    //                                 return {data: {k: index, v: "", vt: InspectionValueType.Boolean, rv: item.toString()}, children: convertToTreeTableNodes(item)};
    //                             } else {
    //                                 return {data: {k: index, v: item.toString(), vt: InspectionValueType.String, rv: item.toString()}};
    //                             }
    //                         });
    //                     } else {
    //                         // If it's an object, recursively call the function to convert it to TreeTableNodes
    //                         node.data = {k: key, v: "", vt: InspectionValueType.Number, rv: value.toString()}
    //                         node.children = convertToTreeTableNodes(value);
    //                     }
    //                 } else {
    //                     // If it's a primitive value, set it as the node's data
    //                     node.data = {
    //                         k: key,
    //                         v: value ? value : "null" ,
    //                         vt: InspectionValueType.Null,
    //                         rv: value?.toString()
    //                     };
    //                 }
    //
    //                 treeTableNodes.push(node);
    //             }
    //         }
    //
    //         return treeTableNodes;
    //     }
    //
    //     const node: TreeTableNode = {};
    //     node.data = {k: "VALUES", v: "", valueType: InspectionValueType.Section, rv: sortedJson, i: "All your values belong to us!"}
    //     node.children = convertToTreeTableNodes(sortedJson);
    //     return [node, node];
    // }

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
                node.children = data.children !== undefined ? convertToTreeTableNodes(data.children) : [];
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