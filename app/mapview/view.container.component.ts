import {TileVisualization} from "./visualization.model"
import {
    Cartesian2,
    Cartesian3,
    Cartographic,
    CesiumMath,
    Color,
    Entity,
    ImageryLayer,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
    UrlTemplateImageryProvider,
    Viewer,
    SceneMode,
    Billboard,
    BillboardCollection,
    Rectangle,
    defined,
    WebMercatorProjection,
    GeographicProjection
} from "../integrations/cesium";
import {AppStateService} from "../shared/appstate.service";
import {AfterViewInit, Component, OnDestroy} from "@angular/core";
import {MapService} from "../mapdata/map.service";
import {DebugWindow, ErdblickDebugApi} from "../app.debugapi.component";
import {FeatureSearchService} from "../search/feature.search.service";
import {CoordinatesService} from "../coords/coordinates.service";
import {JumpTargetService} from "../search/jump.service";
import {combineLatest, distinctUntilChanged, Subscription} from "rxjs";
import {InspectionService} from "../inspection/inspection.service";
import {KeyboardService} from "../shared/keyboard.service";
import {coreLib} from "../integrations/wasm";
import {MenuItem} from "primeng/api";
import {RightClickMenuService} from "./rightclickmenu.service";
import {AppModeService} from "../shared/app-mode.service";
import {ViewService} from "./view.service";
import {CameraService} from "./camera.service";
import {MarkerService} from "../coords/marker.service";
import {ViewStateService} from "./view.state.service";

// Redeclare window with extended interface
declare let window: DebugWindow;

@Component({
    selector: 'mapview-container',
    template: `
<!--        <div style="display: flex">-->
<!--            <ng-container *ngFor="let mapView of mapViews">-->
<!--                &lt;!&ndash; with signals? &ndash;&gt;-->
<!--                <map-view></map-view>-->
<!--            </ng-container>-->
<!--        </div>-->
    `,
    styles: [`
        @media only screen and (max-width: 56em) {
            .elevated {
                bottom: 3.5em;
                padding-bottom: 0;
            }
        }
    `],
    standalone: false
})
export class MapViewContainerComponent implements AfterViewInit, OnDestroy {
    // TODO: Set up to manage instances of mapView views
}
