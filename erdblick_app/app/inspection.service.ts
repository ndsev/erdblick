import {Injectable} from "@angular/core";
import {TreeTableNode} from "primeng/api";
import {BehaviorSubject, distinctUntilChanged, filter, Subject} from "rxjs";
import {MapService} from "./map.service";
import {Feature} from "../../build/libs/core/erdblick-core";
import {FeatureWrapper} from "./features.model";
import {ParametersService} from "./parameters.service";
import {coreLib} from "./wasm";
import {JumpTargetService} from "./jump.service";
import {Cartesian3, Cartographic, CesiumMath, Color, Matrix3} from "./cesium";
import {InfoMessageService} from "./info.service";
import {KeyboardService} from "./keyboard.service";


interface InspectionModelData {
    key: string;
    type: number;
    value: any;
    info?: string;
    hoverId?: string
    geoJsonPath?: string;
    children: Array<InspectionModelData>;
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
    selectedFeatureGeometryType: string = "";
    selectedFeatureCenter: Cartesian3 | null = null;
    selectedFeatureOrigin: Cartesian3 | null = null;
    selectedFeatureBoundingRadius: number = 0;
    selectedFeature: FeatureWrapper | null = null;
    originNormalAndRadiusForFeatureZoom: Subject<[Cartesian3, Cartesian3, number]> = new Subject();

    constructor(private mapService: MapService,
                private jumpService: JumpTargetService,
                private infoMessageService: InfoMessageService,
                private keyboardService: KeyboardService,
                public parametersService: ParametersService) {

        this.keyboardService.registerShortcut("Ctrl+j", this.zoomToFeature.bind(this));
        this.keyboardService.registerShortcut("Ctrl+J", this.zoomToFeature.bind(this));

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
                const center = feature.center() as Cartesian3;
                this.selectedFeatureCenter = center;
                this.selectedFeatureOrigin = Cartesian3.fromDegrees(center.x, center.y, center.z);
                let radiusPoint = feature.boundingRadiusVector() as Cartesian3;
                radiusPoint = Cartesian3.fromDegrees(radiusPoint.x, radiusPoint.y, radiusPoint.z);
                this.selectedFeatureBoundingRadius = Cartesian3.distance(this.selectedFeatureOrigin, radiusPoint);
                this.selectedFeatureGeometryType = this.getGeometryType();
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

    getGeometryType() {
        if (this.selectedFeatureInspectionModel) {
        for (const section of this.selectedFeatureInspectionModel) {
            if (section.key == "Geometry") {
                const geometryType = section.children[0].value;
                console.log(geometryType)
                return geometryType;
            }
        }
        }
        return "";
    }

    zoomToFeature() {
        if (!this.selectedFeature) {
            this.infoMessageService.showError("Could not zoom to feature: no feature is selected!");
            return;
        }
        if (!this.selectedFeatureGeometryType) {
            this.infoMessageService.showError("Could not zoom to feature: geometry type is missing for the feature!");
            return;
        }

        if (this.selectedFeatureGeometryType.toLowerCase() == "mesh") {
            let triangle: Array<Cartesian3> = [];
            if (this.selectedFeatureInspectionModel) {
                for (const section of this.selectedFeatureInspectionModel) {
                    if (section.key == "Geometry") {
                        for (let i = 0; i < 3; i++) {
                            const cartographic = section.children[0].children[i].value.map((coordinate: string) => Number(coordinate));
                            if (cartographic.length == 3) {
                                triangle.push(Cartesian3.fromDegrees(cartographic[0], cartographic[1], cartographic[2]));
                            }
                        }
                        break;
                    }
                }
            }
            if (this.selectedFeatureOrigin) {
                const normal = Cartesian3.cross(
                    Cartesian3.subtract(triangle[1], triangle[0], new Cartesian3()),
                    Cartesian3.subtract(triangle[2], triangle[0], new Cartesian3()),
                    new Cartesian3()
                );
                Cartesian3.negate(normal, normal);
                Cartesian3.normalize(normal, normal);
                Cartesian3.multiplyByScalar(normal, this.selectedFeatureBoundingRadius, normal);
                this.originNormalAndRadiusForFeatureZoom.next([this.selectedFeatureOrigin, normal, this.selectedFeatureBoundingRadius]);
            }
        } else if (this.selectedFeatureCenter) {
            this.mapService.moveToWgs84PositionTopic.next({
                x: this.selectedFeatureCenter.x,
                y: this.selectedFeatureCenter.y,
                z: this.selectedFeatureCenter.z + this.selectedFeatureBoundingRadius
            });
        }
    }

    protected readonly InspectionValueType = coreLib.ValueType;
}