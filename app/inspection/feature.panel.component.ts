import {Component, effect, input, OnDestroy, output, ViewChild} from "@angular/core";
import {TreeTableNode} from "primeng/api";
import {MapDataService} from "../mapdata/map.service";
import {coreLib} from "../integrations/wasm";
import {InspectionPanelModel} from "../shared/appstate.service";
import {FeatureWrapper} from "../mapdata/features.model";
import {Column, FeatureFilterOptions, InspectionTreeComponent} from "./inspection.tree.component";
import {KeyboardService} from "../shared/keyboard.service";
import {Feature} from '../../build/libs/core/erdblick-core';
import {Subscription} from "rxjs";

interface InspectionModelData {
    key: string;
    type: number;
    value: any;
    info?: string;
    hoverId?: string;
    geoJsonPath?: string;
    mapId?: string;
    sourceDataReferences?: Array<object>;
    children: Array<InspectionModelData>;
}

@Component({
    selector: 'feature-panel',
    template: `
        <div style="position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; min-height: 0;">
            @if (loading) {
                <div style="position: absolute; inset: 0; z-index: 1; display: flex; align-items: center; justify-content: center; background: rgba(255, 255, 255, 0.55);">
                    <p-progressSpinner ariaLabel="loading"/>
                </div>
            }
            <inspection-tree [treeData]="treeData" [columns]="columns" [panelId]="panel().id"
                             [geoJson]="geoJson"
                             [filterText]="filterText()" (filterTextChange)="filterTextChange.emit($event)"
                             [showFilter]="showFilter()"
                             [enableSourceDataNavigation]="enableSourceDataNavigation()"
                             style="flex: 1 1 auto; min-height: 0;">
            </inspection-tree>
        </div>
    `,
    styles: [``],
    standalone: false
})
export class FeaturePanelComponent implements OnDestroy {

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
    loading: boolean = false;
    private readonly tileUpdateSubscription: Subscription;

    @ViewChild(InspectionTreeComponent) inspectionTree?: InspectionTreeComponent;

    constructor(private mapService: MapDataService,
                private keyboardService: KeyboardService) {
        // TODO: This shortcut is broken, the panels will race with each other.
        // this.keyboardService.registerShortcut("Ctrl+j", this.zoomToFeature.bind(this));
        effect(() => {
            this.rebuildInspectionTree();
        });
        this.tileUpdateSubscription = this.mapService.selectionTileUpdated.subscribe(tileKey => {
            const selectedFeatures = this.panel().features ?? [];
            const hasUpdatedSelectionTile = selectedFeatures.some(feature => feature.mapTileKey === tileKey);
            if (!hasUpdatedSelectionTile) {
                return;
            }
            this.rebuildInspectionTree();
        });
    }

    ngOnDestroy() {
        this.tileUpdateSubscription.unsubscribe();
    }

    refresh() {
        this.rebuildInspectionTree();
        this.inspectionTree?.refreshLayout();
    }

    refreshLayout() {
        this.inspectionTree?.refreshLayout();
    }

    measurePreferredHeightEm(): number | undefined {
        return this.inspectionTree?.measurePreferredContentHeightEm();
    }

    private rebuildInspectionTree() {
        this.selectedFeatures = this.panel().features ?? [];
        if (!this.selectedFeatures.length) {
            this.loading = false;
            this.geoJson = `{"type":"FeatureCollection","features":[]}`;
            this.treeData = [];
            return;
        }

        this.loading = this.selectedFeatures.some(feature =>
            !this.mapService.isTileInspectionDataComplete(feature.featureTile));

        const selectedFeatureInspectionModels: InspectionModelData[][] = [];
        const selectedFeatureGeoJsonTexts: string[] = [];
        this.selectedFeatures.forEach(featureWrapper => {
            try {
                featureWrapper.peek((feature: Feature) => {
                    selectedFeatureInspectionModels.push(feature.inspectionModel() as InspectionModelData[]);
                    selectedFeatureGeoJsonTexts.push(feature.geojson() as string);
                });
            } catch (error) {
                console.error("Failed to read inspection model for selected feature.", {
                    panelId: this.panel().id,
                    mapTileKey: featureWrapper.mapTileKey,
                    featureId: featureWrapper.featureId,
                    error
                });
            }
        });
        const nextGeoJson = `{"type": "FeatureCollection", "features": [${selectedFeatureGeoJsonTexts.join(", ")}]}`;
        let nextTreeData: TreeTableNode[] = [];
        try {
            nextTreeData = this.getFeatureTreeDataFromModel(selectedFeatureInspectionModels);
        } catch (error) {
            console.error("getFeatureTreeDataFromModel failed.", {
                panelId: this.panel().id,
                selectedFeatureCount: this.selectedFeatures.length,
                error
            });
        }

        // During staged loading, keep the existing tree until inspection data is available.
        if (!nextTreeData.length && this.loading && this.treeData.length) {
            return;
        }

        this.geoJson = nextGeoJson;
        this.treeData = nextTreeData;
        this.inspectionTree?.refreshLayout();
    }

    getFeatureTreeDataFromModel(inspectionModelsByFeature: InspectionModelData[][]) {
        interface HoverAnnotationContext {
            mapTileKey: string;
            softHoverGroupId?: string;
            strongHoverGroupId?: string;
            nodePath: string;
        }

        const isGeometryTypeValue = (value: unknown): boolean => {
            if (typeof value !== "string") {
                return false;
            }
            return value === "Points" || value === "Polyline" || value === "Polygon" || value === "Mesh";
        };

        const hideGeometryStageLabelChild = (children: TreeTableNode[]): TreeTableNode[] => {
            const stageLabelNode = children.find(child => child.data?.["key"] === "stageLabel");
            if (!stageLabelNode) {
                return children;
            }
            return children.filter(child => child.data?.["key"] !== "stageLabel");
        };

        const extractGeometryStageBubble = (children: TreeTableNode[]): string | null => {
            const stageLabelNode = children.find(child => child.data?.["key"] === "stageLabel");
            const stageLabel = stageLabelNode?.data?.["value"];
            if (typeof stageLabel !== "string") {
                return null;
            }
            const trimmed = stageLabel.trim();
            if (!trimmed.length) {
                return null;
            }
            return trimmed;
        };

        const stripValiditySuffix = (hoverId: string): string => {
            const validityIndex = hoverId.indexOf(":validity#");
            if (validityIndex >= 0) {
                return hoverId.slice(0, validityIndex);
            }
            return hoverId;
        };

        const makeNodeId = (context: HoverAnnotationContext, key: string, ordinal: number): string =>
            `${context.nodePath}/${ordinal}:${key}`;

        const convertToTreeTableNodes = (
            dataNodes: Array<InspectionModelData> | undefined,
            context: HoverAnnotationContext
        ): TreeTableNode[] => {
            if (!Array.isArray(dataNodes) || !dataNodes.length) {
                return [];
            }
            const treeNodes: TreeTableNode[] = [];
            for (let nodeIndex = 0; nodeIndex < dataNodes.length; nodeIndex++) {
                const data = dataNodes[nodeIndex];
                const node: TreeTableNode = {};
                const valueType = Number(data?.type ?? coreLib.ValueType.NULL.value);
                let value = data?.value;
                if (valueType === coreLib.ValueType.NULL.value && data?.children === undefined) {
                    value = "NULL";
                } else if ((valueType & coreLib.ValueType.ARRAY.value)
                    && (valueType & coreLib.ValueType.NUMBER.value)
                    && Array.isArray(value)) {
                    for (let i = 0; i < value.length; i++) {
                        if (!Number.isInteger(value[i])) {
                            const strValue = String(value[i]);
                            const index = strValue.indexOf(".");
                            if (index !== -1 && strValue.length - index - 1 > 8) {
                                value[i] = Number(value[i]).toFixed(8);
                            }
                        }
                    }
                }

                if (valueType & coreLib.ValueType.ARRAY.value) {
                    if (Array.isArray(value)) {
                        value = value.join(", ");
                    } else if (value === null || value === undefined) {
                        value = "";
                    } else {
                        value = String(value);
                    }
                }

                node.data = {
                    key: data?.key ?? "",
                    value: value ?? "",
                    type: valueType,
                    mapTileKey: context.mapTileKey,
                    nodeId: makeNodeId(context, data?.key ?? "", nodeIndex)
                };
                if (data?.hasOwnProperty("info")) {
                    node.data["info"] = data.info;
                }
                if (data?.hasOwnProperty("hoverId")) {
                    node.data["hoverId"] = data.hoverId;
                }
                if (data?.hasOwnProperty("mapId")) {
                    node.data["mapId"] = data.mapId;
                }
                if (data?.hasOwnProperty("geoJsonPath")) {
                    node.data["geoJsonPath"] = data.geoJsonPath;
                }
                if (data?.hasOwnProperty("sourceDataReferences")) {
                    node.data["sourceDataReferences"] = data.sourceDataReferences;
                }

                let nextSoftHoverGroupId = context.softHoverGroupId;
                let nextStrongHoverGroupId = context.strongHoverGroupId;
                if (typeof data?.hoverId === "string") {
                    if (data.hoverId.includes(":validity#")) {
                        nextSoftHoverGroupId = stripValiditySuffix(data.hoverId);
                        nextStrongHoverGroupId = data.hoverId;
                    } else {
                        nextSoftHoverGroupId = data.hoverId;
                        nextStrongHoverGroupId = undefined;
                    }
                }
                if (nextSoftHoverGroupId) {
                    node.data["softHoverGroupId"] = nextSoftHoverGroupId;
                }
                if (nextStrongHoverGroupId) {
                    node.data["strongHoverGroupId"] = nextStrongHoverGroupId;
                }

                let children = convertToTreeTableNodes(
                    Array.isArray(data?.children) ? data.children : [],
                    {
                        mapTileKey: context.mapTileKey,
                        softHoverGroupId: nextSoftHoverGroupId,
                        strongHoverGroupId: nextStrongHoverGroupId,
                        nodePath: node.data["nodeId"]
                    }
                );
                if (isGeometryTypeValue(node.data["value"])) {
                    const stageBubble = extractGeometryStageBubble(children);
                    if (stageBubble) {
                        node.data["stageLabelBubble"] = stageBubble;
                    }
                    children = hideGeometryStageLabelChild(children);
                }
                node.children = children;
                treeNodes.push(node);
            }
            return treeNodes;
        };

        const treeNodes: Array<TreeTableNode> = [];
        if (!Array.isArray(inspectionModelsByFeature)) {
            return treeNodes;
        }
        for (let featureIndex = 0; featureIndex < inspectionModelsByFeature.length; featureIndex++) {
            const inspectionModels = inspectionModelsByFeature[featureIndex];
            if (!Array.isArray(inspectionModels)) {
                continue;
            }
            const mapTileKey = this.selectedFeatures?.[featureIndex]?.mapTileKey ?? "";
            for (const section of inspectionModels) {
                const node: TreeTableNode = {};
                node.data = {
                    key: section?.key ?? "",
                    value: section?.value ?? "",
                    type: section?.type ?? coreLib.ValueType.NULL.value
                };
                if (section?.hasOwnProperty("info")) {
                    node.data["info"] = section.info;
                }
                if (section?.hasOwnProperty("sourceDataReferences")) {
                    node.data["sourceDataReferences"] = section.sourceDataReferences;
                }
                node.children = convertToTreeTableNodes(
                    Array.isArray(section?.children) ? section.children : [],
                    {
                        mapTileKey,
                        nodePath: `feature-${featureIndex}:${section?.key ?? ""}`
                    }
                );
                treeNodes.push(node);
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
