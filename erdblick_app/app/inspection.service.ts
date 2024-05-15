import {Injectable} from "@angular/core";
import {TreeTableNode} from "primeng/api";
import {BehaviorSubject} from "rxjs";
import {MapService} from "./map.service";
import {Feature} from "../../build/libs/core/erdblick-core";

@Injectable({providedIn: 'root'})
export class InspectionService {

    featureTree: BehaviorSubject<string> = new BehaviorSubject<string>("");
    isInspectionPanelVisible: boolean = false;
    selectedFeatureGeoJsonText: string = "";
    selectedFeatureIdText: string = "";

    constructor() { }

    getFeatureTreeData() {
        let jsonData = JSON.parse(this.selectedFeatureGeoJsonText);
        if (jsonData.hasOwnProperty("id")) {
            delete jsonData["id"];
        }
        if (jsonData.hasOwnProperty("properties")) {
            jsonData["attributes"] = jsonData["properties"];
            delete jsonData["properties"];
        }
        // Push leaf values up
        const sortedJson: Record<string, any> = {};
        for (const key in jsonData) {
            if (typeof jsonData[key] === "string" || typeof jsonData[key] === "number") {
                sortedJson[key] = jsonData[key];
            }
        }
        for (const key in jsonData) {
            if (typeof jsonData[key] !== "string" && typeof jsonData[key] !== "number") {
                sortedJson[key] = jsonData[key];
            }
        }

        let convertToTreeTableNodes = (json: any): TreeTableNode[] => {
            const treeTableNodes: TreeTableNode[] = [];

            for (const key in json) {
                if (json.hasOwnProperty(key)) {
                    const value = json[key];
                    const node: TreeTableNode = {};

                    if (typeof value === 'object' && value !== null) {
                        if (Array.isArray(value)) {
                            // If it's an array, iterate through its elements and convert them to TreeTableNodes
                            node.data = {k: key, v: "", t: ""};
                            node.children = value.map((item: any, index: number) => {
                                if (typeof item === 'object') {
                                    return {data: {k: index, v: "", t: typeof item}, children: convertToTreeTableNodes(item)};
                                } else {
                                    return {data: {k: index, v: item.toString(), t: typeof item}};
                                }
                            });
                        } else {
                            // If it's an object, recursively call the function to convert it to TreeTableNodes
                            node.data = {k: key, v: "", t: ""}
                            node.children = convertToTreeTableNodes(value);
                        }
                    } else {
                        // If it's a primitive value, set it as the node's data
                        node.data = {k: key, v: value ? value : "null" , t: typeof value};
                    }

                    treeTableNodes.push(node);
                }
            }

            return treeTableNodes;
        }

        return convertToTreeTableNodes(sortedJson);
    }

    loadFeatureData() {
        this.featureTree.next(JSON.stringify(this.getFeatureTreeData()));
    }
}