import {Component} from '@angular/core';
import {ErdblickView} from "./erdblick.view";
import {ErdblickModel} from "./erdblick.model";
import {DebugWindow, ErdblickDebugApi} from "./debugapi.component";
import {HttpClient} from "@angular/common/http";
import libErdblickCore, {Feature} from '../../build/libs/core/erdblick-core';
import {JumpTargetService} from "./jump.service";
import {ErdblickLayer, ErdblickMap, MapService} from "./map.service";
import {ActivatedRoute, Params, Router} from "@angular/router";
import {Cartesian3} from "cesium";
import {StyleService} from "./style.service";
import {InspectionService} from "./inspection.service";
import {ParametersService} from "./parameters.service";
import {OverlayPanel} from "primeng/overlaypanel";

// Redeclare window with extended interface
declare let window: DebugWindow;

export interface MapItemLayer extends Object {
    canRead: boolean;
    canWrite: boolean;
    coverage: number[];
    featureTypes: Object[];
    layerId: string;
    type: string;
    version: Object;
    zoomLevels: number[];
}

export interface MapInfoItem extends Object {
    extraJsonAttachment: Object;
    layers: Map<string, MapItemLayer>;
    mapId: string;
    maxParallelJobs: number;
    nodeId: string;
    protocolVersion: Map<string, number>;
}

@Component({
    selector: 'app-root',
    template: `
        <div id="mapViewContainer" class="mapviewer-renderlayer" style="z-index: 0"></div>
        <map-panel></map-panel>
        <p-toast position="bottom-center" key="tc"></p-toast>
        <p-overlayPanel #searchoverlay>
            <search-menu-items></search-menu-items>
        </p-overlayPanel>
        <span class="p-input-icon-left search-input">
            <i class="pi pi-search"></i>
            <input type="text" pInputText [(ngModel)]="searchValue" (click)="toggleOverlay(searchValue, searchoverlay, $event)"
                   (ngModelChange)="setTargetValue(searchValue)"/>
        </span>
        <pref-components></pref-components>
        <inspection-panel></inspection-panel>
        <div id="info">
            {{title}} {{version}}
        </div>
        <router-outlet></router-outlet>
    `,
    styles: [`
        @media only screen and (max-width: 56em) {
            .elevated {
                bottom: 3.5em;
                padding-bottom: 0;
            }
        }
    `]
})
export class AppComponent {

    title: string = 'erdblick';
    version: string = "v0.3.0";
    searchValue: string = ""
    firstParamUpdate: boolean = true;

    constructor(private httpClient: HttpClient,
                private router: Router,
                private activatedRoute: ActivatedRoute,
                public mapService: MapService,
                public jumpToTargetService: JumpTargetService,
                public styleService: StyleService,
                public inspectionService: InspectionService,
                public parametersService: ParametersService) {
        httpClient.get('./bundle/VERSION', {responseType: 'text'}).subscribe(
            data => {
                this.version = data.toString();
            });

        libErdblickCore().then((coreLib: any) => {
            console.log("  ...done.")
            this.mapService.coreLib = coreLib;

            let erdblickModel = new ErdblickModel(coreLib, styleService, parametersService);
            this.mapService.mapModel.next(erdblickModel);
            this.mapService.mapView = new ErdblickView(erdblickModel, 'mapViewContainer', parametersService);
            this.mapService.applyTileLimits(erdblickModel.maxLoadTiles, erdblickModel.maxVisuTiles);

            // Add debug API that can be easily called from browser's debug console
            window.ebDebug = new ErdblickDebugApi(this.mapService.mapView);

            this.mapService.mapView.selectionTopic.subscribe(selectedFeatureWrapper => {
                if (!selectedFeatureWrapper) {
                    this.inspectionService.isInspectionPanelVisible = false;
                    return;
                }

                selectedFeatureWrapper.peek((feature: Feature) => {
                    this.inspectionService.selectedFeatureGeoJsonText = feature.geojson() as string;
                    this.inspectionService.selectedFeatureIdText = feature.id() as string;
                    this.inspectionService.isInspectionPanelVisible = true;
                    this.inspectionService.loadFeatureData();
                })
            });

            this.mapService.mapModel.getValue()!.mapInfoTopic.subscribe((mapInfo: Object) => {
                let mapItems = new Map<string, ErdblickMap>();
                Object.entries(mapInfo).forEach(([mapName, mapInfoItem]) => {
                    let mapLayers: Array<ErdblickLayer> = new Array<ErdblickLayer>();
                    let firstCoverage = 0n;
                    Object.entries((mapInfoItem as MapInfoItem).layers).forEach(([layerName, layer]) => {
                        let layerCoverage = (layer as MapItemLayer).coverage;
                        if (layerCoverage.length > 0) {
                            firstCoverage = BigInt(layerCoverage[0]);
                        }
                        mapLayers.push({
                            name: layerName,
                            coverage: firstCoverage,
                            level: 13,
                            visible: true
                        });
                        this.mapService.mapModel.getValue()!.layerIdToLevel.set(mapName + '/' + layerName, 13);
                    })
                    mapItems.set(mapName, {
                        mapName: mapName,
                        coverage: firstCoverage,
                        level: 13,
                        mapLayers: mapLayers,
                        visible: true
                    });
                });
                this.mapService.mapModel.getValue()!.availableMapItems.next(mapItems);
            });

            this.activatedRoute.queryParams.subscribe((params: Params) => {
                let currentParameters = this.parametersService.parameters.getValue();
                const newPosition = {
                    lon: params["lon"] ? Number(params["lon"]) : currentParameters.lon,
                    lat: params["lat"] ? Number(params["lat"]) : currentParameters.lat,
                    alt: params["alt"] ? Number(params["alt"]) : currentParameters.alt
                }
                const newOrientation = {
                    heading: params["heading"] ? Number(params["heading"]) : currentParameters.heading,
                    pitch: params["pitch"] ? Number(params["pitch"]) : currentParameters.pitch,
                    roll: params["roll"] ? Number(params["roll"]) : currentParameters.roll
                }
                if (this.mapService.mapView !== undefined) {
                    this.mapService.mapView.viewer.camera.setView({
                        destination: Cartesian3.fromDegrees(newPosition.lon, newPosition.lat, newPosition.alt),
                        orientation: newOrientation
                    });
                }
                currentParameters.lon = newPosition.lon;
                currentParameters.lat = newPosition.lat;
                currentParameters.alt = newPosition.alt;
                currentParameters.heading = newOrientation.heading;
                currentParameters.roll = newOrientation.roll;
                currentParameters.pitch = newOrientation.pitch;

                const osmEnabled = params["osmEnabled"] ? params["osmEnabled"] == "true" : currentParameters.osmEnabled;
                const osmOpacity = params["osmOpacity"] ? Number(params["osmOpacity"]) : currentParameters.osmOpacity;
                this.mapService.osmEnabled = osmEnabled;
                this.mapService.osmOpacityValue = osmOpacity;
                if (osmEnabled) {
                    this.mapService.mapView?.updateOpenStreetMapLayer(osmOpacity / 100);
                } else {
                    this.mapService.mapView?.updateOpenStreetMapLayer(0);
                }
                currentParameters.osmEnabled = osmEnabled;
                currentParameters.osmOpacity = osmOpacity;

                let layerNamesLevels = currentParameters.layers;
                let currentLayers = new Array<Array<string>>;
                if (params["layers"]) {
                    layerNamesLevels = JSON.parse(params["layers"]);
                }
                layerNamesLevels.forEach((nameLevel: Array<string>) => {
                    const name = nameLevel[0];
                    const level = Number(nameLevel[1]);
                    if (mapService.mapModel.getValue()) {
                        if (this.mapService.mapModel.getValue()!.layerIdToLevel.has(name)) {
                            this.mapService.mapModel.getValue()!.layerIdToLevel.set(name, level);
                        }
                        const [mapName, layerName] = name.split('/');
                        this.mapService.mapModel.getValue()!.availableMapItems.getValue().forEach(
                            (mapItem: ErdblickMap, name: string) => {
                            if (name == mapName) {
                                mapItem.visible = true;
                                mapItem.mapLayers.forEach((mapLayer: ErdblickLayer) => {
                                    if (mapLayer.name == layerName) {
                                        mapLayer.visible = true;
                                        currentLayers.push([`${mapName}/${layerName}`, level.toString()])
                                    }
                                });
                            }
                        });
                    }
                });
                if (currentLayers) {
                    currentParameters.layers = currentLayers;
                }

                if (!this.firstParamUpdate) {
                    let styles = currentParameters.styles;
                    if (params["styles"]) {
                        styles = JSON.parse(params["styles"]);
                    }
                    let currentStyles = new Array<string>();
                    styles.forEach(styleId => {
                        if (this.styleService.activatedStyles.has(styleId)) {
                            this.styleService.activatedStyles.set(styleId, true);
                            currentStyles.push(styleId);
                        }
                    })
                    if (currentStyles) {
                        currentParameters.styles = currentStyles;
                    }
                    this.parametersService.parameters.next(currentParameters);
                }

                if (Object.keys(params).length && this.firstParamUpdate) {
                    this.mapService.mapModel.getValue()?.update();
                    this.mapService.mapModel.getValue()?.reapplyAllStyles();
                    this.firstParamUpdate = false;
                }
            });

            this.parametersService.parameters.subscribe(parameters => {
                const entries = [...Object.entries(parameters)];
                entries.forEach(entry => entry[1] = JSON.stringify(entry[1]));
                this.updateQueryParams(Object.fromEntries(entries));
            });

            this.mapService.mapModel.getValue()?.update();
            this.mapService.mapModel.getValue()?.reapplyAllStyles();
        });
    }

    toggleOverlay(value: string, searchOverlay: OverlayPanel, event: any) {
        if (value) {
            searchOverlay.show(event);
            return;
        }
        searchOverlay.toggle(event);
    }

    setTargetValue(value: string) {
        this.jumpToTargetService.targetValueSubject.next(value);
    }

    updateQueryParams(params: Params): void {
        this.router.navigate([], {
            queryParams: params,
            queryParamsHandling: 'merge',
            replaceUrl: true
        });
    }
}
