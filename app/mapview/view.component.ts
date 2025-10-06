import {AppStateService} from "../shared/appstate.service";
import {AfterViewInit, Component, input, InputSignal, OnDestroy} from "@angular/core";
import {MapService} from "../mapdata/map.service";
import {DebugWindow} from "../app.debugapi.component";
import {FeatureSearchService} from "../search/feature.search.service";
import {CoordinatesService} from "../coords/coordinates.service";
import {JumpTargetService} from "../search/jump.service";
import {InspectionService} from "../inspection/inspection.service";
import {KeyboardService} from "../shared/keyboard.service";
import {MenuItem} from "primeng/api";
import {RightClickMenuService} from "./rightclickmenu.service";
import {AppModeService} from "../shared/app-mode.service";
import {MapView} from "./view";
import {MapView2D} from "./view2d";
import {SceneMode} from "../integrations/cesium";
import {MapView3D} from "./view3d";

// Redeclare window with extended interface
declare let window: DebugWindow;

@Component({
    selector: 'map-view',
    template: `
        <div #viewer id="mapViewContainer" class="mapviewer-renderlayer" style="z-index: 0"></div>
        <p-contextMenu *ngIf="!appModeService.isVisualizationOnly" [target]="viewer" [model]="menuItems"
                       (onHide)="onContextMenuHide()"/>
        <sourcedatadialog *ngIf="!appModeService.isVisualizationOnly"></sourcedatadialog>
        <erdblick-view-ui [mapView]="mapView" [is2D]="is2DMode"></erdblick-view-ui>
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
export class MapViewComponent implements AfterViewInit, OnDestroy {
    menuItems: MenuItem[] = [];
    is2DMode: boolean = false;
    mapView?: MapView;
    viewIndex: InputSignal<number> = input.required<number>();

    /**
     * Construct a Cesium View with a Model.
     * @param mapService The map model service providing access to data
     * @param featureSearchService
     * @param stateService The parameter service, used to update
     * @param jumpService
     * @param inspectionService
     * @param keyboardService
     * @param menuService
     * @param coordinatesService Necessary to pass mouse events to the coordinates panel
     * @param viewStateService
     * @param viewService
     * @param cameraService
     * @param markerService
     * @param appModeService
     */
    constructor(public mapService: MapService,
                public featureSearchService: FeatureSearchService,
                public stateService: AppStateService,
                public jumpService: JumpTargetService,
                public inspectionService: InspectionService,
                public keyboardService: KeyboardService,
                public menuService: RightClickMenuService,
                public coordinatesService: CoordinatesService,
                public appModeService: AppModeService)
    {
    }

    ngAfterViewInit() {
        this.stateService.mode2dState.subscribe(this.viewIndex(), mode2d => {
            this.is2DMode = mode2d;
            // Initialize viewer with appropriate projection
            this.createViewerForMode(mode2d).catch((error) => {
                console.error('Failed to initialize viewer:', error);
                alert('Failed to initialize the map viewer. Please refresh the page.');
            }).finally(() => {
                // Hide the global loading spinner
                const spinner = document.getElementById('global-spinner-container');
                if (spinner) {
                    spinner.style.display = 'none';
                }
            });
        });
        this.setupKeyboardShortcuts();
    }

    /**
     * Setup keyboard shortcuts
     */
    private setupKeyboardShortcuts() {
        if (!this.appModeService.isVisualizationOnly) {
            // TODO: Only react to shortcuts if we are the focused view!
            this.keyboardService.registerShortcut('q', this.mapView!.zoomIn.bind(this.mapView!), true);
            this.keyboardService.registerShortcut('e', this.mapView!.zoomOut.bind(this.mapView!), true);
            this.keyboardService.registerShortcut('w', this.mapView!.moveUp.bind(this.mapView!), true);
            this.keyboardService.registerShortcut('a', this.mapView!.moveLeft.bind(this.mapView!), true);
            this.keyboardService.registerShortcut('s', this.mapView!.moveDown.bind(this.mapView!), true);
            this.keyboardService.registerShortcut('d', this.mapView!.moveRight.bind(this.mapView!), true);
            this.keyboardService.registerShortcut('r', this.mapView!.resetOrientation.bind(this.mapView!), true);
        }
    }

    onContextMenuHide() {
        if (!this.menuService.tileSourceDataDialogVisible) {
            this.menuService.tileOutline.next(null);
        }
    }

    /**
     * Recreate the viewer with different projection for 2D/3D modes
     * This is necessary because Cesium doesn't support dynamic projection switching
     */
    private async createViewerForMode(is2D: boolean) {
        if (this.mapView) {
            await this.mapView.destroy();
        }
        if (is2D) {
            this.mapView = new MapView2D(
                this.viewIndex(), "mapViewContainer", SceneMode.SCENE2D,
                this.mapService, this.featureSearchService, this.jumpService, this.inspectionService,
                this.menuService, this.coordinatesService, this.stateService);
        } else {
            this.mapView = new MapView3D(
                this.viewIndex(), "mapViewContainer", SceneMode.SCENE3D,
                this.mapService, this.featureSearchService, this.jumpService, this.inspectionService,
                this.menuService, this.coordinatesService, this.stateService);
        }
        await this.mapView.setup();
    }

    /**
     * Component cleanup when destroyed
     */
    ngOnDestroy() {
        this.mapView?.destroy().then();
    }
}
