import {Injectable} from "@angular/core";
import {TreeTableNode} from "primeng/api";
import {BehaviorSubject, distinctUntilChanged, distinctUntilKeyChanged, filter, ReplaySubject} from "rxjs";
import {MapService} from "./map.service";
import {Feature, TileSourceDataLayer} from "../../build/libs/core/erdblick-core";
import {FeatureWrapper} from "./features.model";
import {ParametersService} from "./parameters.service";
import {coreLib, uint8ArrayToWasm} from "./wasm";
import {JumpTargetService} from "./jump.service";
import {Fetch} from "./fetch.model";


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

export interface SelectedSourceData {
    mapId: string,
    tileId: number,
    layerId: string,
    address: bigint,
    featureId: string,
}

export function selectedSourceDataEqualTo(a: SelectedSourceData | null, b: SelectedSourceData | null) {
    if (!a || !b)
        return false;
    return (a == b || (a.mapId == b.mapId && a.tileId == b.tileId && a.layerId == b.layerId && a.address == b.address && a.featureId == b.featureId));
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
    selectedSourceData = new BehaviorSubject<SelectedSourceData | null>(null);

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

        this.parametersService.parameters.pipe(distinctUntilChanged()).subscribe(parameters => {
            if (parameters.selected.length == 2) {
                const [mapId, featureId] = parameters.selected;
                if (mapId != this.selectedMapIdName || featureId != this.selectedFeatureIdName) {
                    this.jumpService.highlightFeature(mapId, featureId);
                    if (this.selectedFeature != null) {
                        this.mapService.focusOnFeature(this.selectedFeature);
                    }
                }
            }
        });

        this.selectedSourceData.pipe(distinctUntilChanged(selectedSourceDataEqualTo)).subscribe(selection => {
            if (selection)
                this.parametersService.setSelectedSourceData(selection);
            else
                this.parametersService.unsetSelectedSourceData();
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

    async loadSourceDataLayer(tileId: number, layerId: string, mapId: string) : Promise<TileSourceDataLayer> {
        console.log(`Loading SourceDataLayer layerId=${layerId} tileId=${tileId}`);

        let requests = [{
            mapId: mapId,
            layerId: layerId,
            tileIds: [tileId]
        }];

        let tileParser = new coreLib.TileLayerParser();

        let newRequestBody = JSON.stringify({
            requests: requests
        });

        let layer: TileSourceDataLayer | undefined;
        let fetch = new Fetch("/tiles")
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
                    throw new Error(`Error loading layer.`);
                return layer;
            });
    }

    protected readonly InspectionValueType = coreLib.ValueType;
}
