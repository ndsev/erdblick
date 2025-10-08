import {EventEmitter, Injectable} from "@angular/core";
import {TreeTableNode} from "primeng/api";
import {BehaviorSubject, distinctUntilChanged, Subject} from "rxjs";
import {MapDataService} from "../mapdata/map.service";
import {Feature, TileSourceDataLayer} from "../../build/libs/core/erdblick-core";
import {FeatureWrapper} from "../mapdata/features.model";
import {AppStateService} from "../shared/appstate.service";
import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import {JumpTargetService} from "../search/jump.service";
import {Fetch} from "../mapdata/fetch";
import {Cartesian3} from "../integrations/cesium";
import {InfoMessageService} from "../shared/info.service";
import {KeyboardService} from "../shared/keyboard.service";


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

export interface SelectedSourceData {
    mapId: string,
    tileId: number,
    layerId: string,
    address?: bigint,
    featureIds?: string,
}

export function selectedSourceDataEqualTo(a: SelectedSourceData | null, b: SelectedSourceData | null) {
    if (!a || !b)
        return false;
    return (a === b || (a.mapId === b.mapId && a.tileId === b.tileId && a.layerId === b.layerId && a.address === b.address && a.featureIds === b.featureIds));
}

export function selectedFeaturesEqualTo(a: FeatureWrapper[] | null, b: FeatureWrapper[] | null) {
    if (!a || !b)
        return false;
    if (a.length !== b.length) {
        return false
    }
    for (let i = 0; i < a.length; ++i) {
        if (!a[i].equals(b[i])) {
            return false;
        }
    }
    return true;
}

@Injectable({providedIn: 'root'})
export class InspectionService {

    featureTree: BehaviorSubject<string> = new BehaviorSubject<string>("");
    featureTreeFilterValue: string = "";
    isInspectionPanelVisible: boolean = false;
    selectedFeatureGeoJsonTexts: string[] = [];
    selectedFeatureInspectionModel: InspectionModelData[] = [];
    selectedFeatures: FeatureWrapper[] = [];
    selectedFeatureGeometryType: any;
    selectedFeatureCenter: Cartesian3 | null = null;
    selectedFeatureOrigin: Cartesian3 | null = null;
    selectedFeatureBoundingRadius: number = 0;
    originAndNormalForFeatureZoom: Subject<[Cartesian3, Cartesian3]> = new Subject();
    selectedSourceData = new BehaviorSubject<SelectedSourceData | null>(null);

    // Event called when the active inspector of the inspection panel changed
    inspectionPanelChanged  = new EventEmitter<void>();

    constructor(private mapService: MapDataService,
                private infoMessageService: InfoMessageService,
                private keyboardService: KeyboardService,
                public stateService: AppStateService) {

        this.keyboardService.registerShortcut("Ctrl+j", this.zoomToFeature.bind(this));

        this.stateService.selectionTopicState.pipe(distinctUntilChanged(selectedFeaturesEqualTo)).subscribe(selectedFeatures => {
            if (!selectedFeatures?.length) {
                this.isInspectionPanelVisible = false;
                this.featureTreeFilterValue = "";
                this.stateService.setSelectedFeatures(0, []);
                this.selectedFeatures = [];
                return;
            }
            this.selectedFeatureInspectionModel = [];
            this.selectedFeatureGeoJsonTexts = [];
            this.selectedFeatures = selectedFeatures;

            // Currently only takes the first element for Jump to Feature functionality.
            // TODO: Allow to use the whole set for Jump to Feature.
            if (selectedFeatures.length) {
                selectedFeatures[0].peek((feature: Feature) => {
                    this.selectedFeatureInspectionModel.push(...feature.inspectionModel());
                    this.selectedFeatureGeoJsonTexts.push(feature.geojson() as string);
                    const center = feature.center() as Cartesian3;
                    this.selectedFeatureCenter = center;
                    this.selectedFeatureOrigin = Cartesian3.fromDegrees(center.x, center.y, center.z);
                    let radiusPoint = feature.boundingRadiusEndPoint() as Cartesian3;
                    radiusPoint = Cartesian3.fromDegrees(radiusPoint.x, radiusPoint.y, radiusPoint.z);
                    this.selectedFeatureBoundingRadius = Cartesian3.distance(this.selectedFeatureOrigin, radiusPoint);
                    this.selectedFeatureGeometryType = feature.getGeometryType() as any;
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

            this.stateService.setSelectedFeatures(0, this.selectedFeatures.map(f => f.key()));
        });

        this.selectedSourceData.pipe(distinctUntilChanged(selectedSourceDataEqualTo)).subscribe(selection => {
            if (selection) {
                this.stateService.setSelectedSourceData(selection);
            } else {
                this.stateService.unsetSelectedSourceData();
            }
        });
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

    zoomToFeature() {
        if (!this.selectedFeatures) {
            this.infoMessageService.showError("Could not zoom to feature: no feature is selected!");
            return;
        }
        if (!this.selectedFeatureGeometryType) {
            this.infoMessageService.showError("Could not zoom to feature: geometry type is missing for the feature!");
            return;
        }

        if (this.selectedFeatureGeometryType === this.GeometryType.Mesh) {
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
                Cartesian3.multiplyByScalar(normal, 3 * this.selectedFeatureBoundingRadius, normal);
                this.originAndNormalForFeatureZoom.next([this.selectedFeatureOrigin, normal]);
            }
        } else if (this.selectedFeatureCenter) {
            this.mapService.moveToWgs84PositionTopic.next({
                targetView: 0,
                x: this.selectedFeatureCenter.x,
                y: this.selectedFeatureCenter.y,
                z: this.selectedFeatureCenter.z + 3 * this.selectedFeatureBoundingRadius
            });
        }
    }

    async loadSourceDataLayer(tileId: number, layerId: string, mapId: string) : Promise<TileSourceDataLayer> {
        const tileParser = new coreLib.TileLayerParser();
        const newRequestBody = JSON.stringify({
            requests: [{
                mapId: mapId,
                layerId: layerId,
                tileIds: [tileId]
            }]
        });

        let layer: TileSourceDataLayer | undefined;
        let fetch = new Fetch("tiles")
            .withChunkProcessing()
            .withMethod("POST")
            .withBody(newRequestBody)
            .withBufferCallback((message: any, messageType: any) => {
                if (messageType === Fetch.CHUNK_TYPE_FIELDS) {
                    uint8ArrayToWasm((wasmBuffer: any) => {
                        tileParser!.readFieldDictUpdate(wasmBuffer);
                    }, message);
                } else if (messageType === Fetch.CHUNK_TYPE_SOURCEDATA) {
                    const blob = message.slice(Fetch.CHUNK_HEADER_SIZE);
                    layer = uint8ArrayToWasm((wasmBlob: any) => {
                        return tileParser.readTileSourceDataLayer(wasmBlob);
                    }, blob);
                } else {
                    throw new Error(`Unknown message type ${messageType}.`)
                }
            });

        return fetch.go()
            .then(_ => {
                if (!layer)
                    throw new Error(`Unknown error while loading layer.`);
                const error = layer.getError();
                if (error) {
                    layer.delete();
                    throw new Error(`Error while loading layer: ${error}`);
                }
                return layer;
            });
    }

    selectedFeatureGeoJsonCollection() {
        return `{"type": "FeatureCollection", "features": [${this.selectedFeatureGeoJsonTexts.join(", ")}]}`;
    }

    loadSourceDataInspection(tileId: number, mapId: string, layerId: string) {
        this.isInspectionPanelVisible = true;
        this.selectedSourceData.next({
            tileId: tileId,
            layerId: layerId,
            mapId: mapId
        });
    }

    loadSourceDataInspectionForService(mapId: string, layerId: string) {
        this.isInspectionPanelVisible = true;
        this.selectedSourceData.next({
            tileId: 0,
            layerId: layerId,
            mapId: mapId
        });
    }

    /**
     * Returns a human-readable layer name for a layer id.
     *
     * @param layerId Layer id to get the name for
     * @param isMetadata Matches the metadata SourceDataLayers
     */
    layerNameForSourceDataLayerId(layerId: string, isMetadata: boolean = false) {
        const match = isMetadata ?
            layerId.match(/^Metadata-(.+)-(.+)/) :
            layerId.match(/^SourceData-(.+\.)([^.]+)/);
        if (!match) {
            return layerId;
        }
        return `${match[2]}`.replace('-', '.');
    }

    /**
     * Returns an internal layerId for a human-readable layer name.
     *
     * @param layerName Layer id to get the name for
     */
    sourceDataLayerIdForLayerName(layerName: string) {
        for (const [_, mapInfo] of this.mapService.maps.getValue().maps.entries()) {
            for (const [_, layerInfo] of mapInfo.layers.entries()) {
                if (layerInfo.type == "SourceData") {
                    if (this.layerNameForSourceDataLayerId(layerInfo.id) == layerName ||
                        this.layerNameForSourceDataLayerId(layerInfo.id) == layerName.replace('-', '.') ||
                        layerInfo.id == layerName) {
                        return layerInfo.id;
                    }
                }
            }
        }
        return null;
    }

    findLayersForMapId(mapId: string, isMetadata: boolean = false) {
        const map = this.mapService.maps.getValue().maps.get(mapId);
        if (map) {
            const prefix = isMetadata ? "Metadata" : "SourceData";
            const dataLayers = new Set<string>();
            for (const layer of map.layers.values()) {
                if (layer.type == "SourceData" && layer.id.startsWith(prefix)) {
                    dataLayers.add(layer.id);
                }
            }
            return [...dataLayers].map(layerId => ({
                id: layerId,
                name: this.layerNameForSourceDataLayerId(layerId, isMetadata)
            })).sort((a, b) => a.name.localeCompare(b.name));
        }
        return [];
    }

    protected readonly InspectionValueType = coreLib.ValueType;
    protected readonly GeometryType = coreLib.GeomType;
}
