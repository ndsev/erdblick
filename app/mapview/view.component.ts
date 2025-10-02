import {AppStateService} from "../shared/appstate.service";
import {AfterViewInit, Component, effect, Input, input, OnDestroy} from "@angular/core";
import {MapService} from "../mapdata/map.service";
import {DebugWindow, ErdblickDebugApi} from "../app.debugapi.component";
import {FeatureSearchService} from "../search/feature.search.service";
import {CoordinatesService} from "../coords/coordinates.service";
import {JumpTargetService} from "../search/jump.service";
import {InspectionService} from "../inspection/inspection.service";
import {KeyboardService} from "../shared/keyboard.service";
import {MenuItem} from "primeng/api";
import {RightClickMenuService} from "./rightclickmenu.service";
import {AppModeService} from "../shared/app-mode.service";
import {MarkerService} from "../coords/marker.service";
import {MapView} from "./view";
import {MapView3D} from "./view3d";
import {MapView2D} from "./view2d";

// Redeclare window with extended interface
declare let window: DebugWindow;

@Component({
    selector: 'map-view',
    template: `
        <div #viewer id="mapViewContainer" class="mapviewer-renderlayer" style="z-index: 0"></div>
        <p-contextMenu *ngIf="!appModeService.isVisualizationOnly" [target]="viewer" [model]="menuItems"
                       (onHide)="onContextMenuHide()"/>
        <sourcedatadialog *ngIf="!appModeService.isVisualizationOnly"></sourcedatadialog>
        <erdblick-view-ui></erdblick-view-ui>
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
    viewIndex = input.required<number>();

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
    constructor(private mapService: MapService,
                private featureSearchService: FeatureSearchService,
                private stateService: AppStateService,
                private jumpService: JumpTargetService,
                private inspectionService: InspectionService,
                private keyboardService: KeyboardService,
                private menuService: RightClickMenuService,
                private coordinatesService: CoordinatesService,
                private markerService: MarkerService,
                public appModeService: AppModeService)
    {
    }

    ngAfterViewInit() {
        this.stateService.mode2dState.subscribeFor(this.viewIndex(), mode2d => {
            // Initialize viewer with appropriate projection
            this.createViewerForMode(this.is2DMode).catch((error) => {
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
            this.mapView = new MapView2D(/* ... */);
        } else {
            this.mapView = new MapView3D(/* ... */);
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
