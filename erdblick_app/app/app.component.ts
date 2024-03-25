import {Component} from '@angular/core';
import {ErdblickView} from "./erdblick.view";
import {ErdblickModel} from "./erdblick.model";
import {DebugWindow, ErdblickDebugApi} from "./debugapi.component";
import {HttpClient} from "@angular/common/http";
import MainModuleFactory, {Feature, MainModule as ErdblickCore} from '../../build/libs/core/erdblick-core';
import {JumpTargetService} from "./jump.service";
import {MapInfoItem, MapService} from "./map.service";
import {ActivatedRoute, Params, Router} from "@angular/router";
import {StyleService} from "./style.service";
import {InspectionService} from "./inspection.service";
import {ParametersService} from "./parameters.service";
import {OverlayPanel} from "primeng/overlaypanel";

// Redeclare window with extended interface
declare let window: DebugWindow;

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
            <input type="text" pInputText [(ngModel)]="searchValue" 
                   (click)="toggleOverlay(searchValue, searchoverlay, $event)" 
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
        this.httpClient.get('./bundle/VERSION', {responseType: 'text'}).subscribe(
            data => {
                this.version = data.toString();
            });

        MainModuleFactory().then((coreLib: ErdblickCore) => {
            console.log("  ...done.")
            this.mapService.coreLib = coreLib;

            coreLib.setExceptionHandler((excType: string, message: string) => {
                throw new Error(`${excType}: ${message}`);
            });

            this.styleService.stylesLoaded.subscribe(loaded => {
                if (loaded) this.init();
            });
        });
    }

    init() {
        let erdblickModel = new ErdblickModel(this.mapService.coreLib, this.styleService, this.parametersService);
        this.mapService.mapModel.next(erdblickModel);
        this.mapService.mapView = new ErdblickView(erdblickModel, 'mapViewContainer', this.parametersService);
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

        this.mapService.mapModel.getValue()!.mapInfoTopic.subscribe((mapItems: Map<string, MapInfoItem>) => {
            this.mapService.mapModel.getValue()!.availableMapItems.next(mapItems);
        });

        this.activatedRoute.queryParams.subscribe((params: Params) => {
            this.parametersService.parseAndApplyParams(params, this.firstParamUpdate);
            if (this.firstParamUpdate) {
                this.firstParamUpdate = false;
                this.mapService.mapModel.getValue()?.update();
                this.mapService.mapModel.getValue()?.reapplyAllStyles();
            }
            setTimeout(() => { this.mapService.mapView?.updateViewport() }, 1000);
        });

        this.parametersService.parameters.subscribe(parameters => {
            const entries = [...Object.entries(parameters)];
            entries.forEach(entry => entry[1] = JSON.stringify(entry[1]));
            this.updateQueryParams(Object.fromEntries(entries));
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
