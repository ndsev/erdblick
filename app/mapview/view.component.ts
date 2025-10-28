import {AppStateService, VIEW_SYNC_POSITION, VIEW_SYNC_PROJECTION} from "../shared/appstate.service";
import {
    AfterViewInit,
    ChangeDetectorRef,
    Component,
    ElementRef,
    OnDestroy,
    OnInit,
    ViewChild,
    input,
    InputSignal
} from "@angular/core";
import {MapDataService} from "../mapdata/map.service";
import {FeatureSearchService} from "../search/feature.search.service";
import {CoordinatesService} from "../coords/coordinates.service";
import {JumpTargetService} from "../search/jump.service";
import {KeyboardService} from "../shared/keyboard.service";
import {MenuItem} from "primeng/api";
import {RightClickMenuService} from "./rightclickmenu.service";
import {AppModeService} from "../shared/app-mode.service";
import {MapView} from "./view";
import {MapView2D} from "./view2d";
import {MapView3D} from "./view3d";
import {combineLatest, Subscription} from "rxjs";
import {filter} from "rxjs/operators";

@Component({
    selector: 'map-view',
    template: `
        <div #viewer [ngClass]="{'border': outlined}" [id]="canvasId" class="mapviewer-renderlayer" style="z-index: 0"></div>
        <p-multiSelect *ngIf="showSyncMenu" dropdownIcon="pi pi-link" [options]="syncOptions" [(ngModel)]="selectedOptions"
                       (ngModelChange)="updateSelectedOptions()" optionLabel="name" [filter]="false" [showToggleAll]="false"
                       placeholder="" class="viewsync-select"/>
        <p-contextMenu *ngIf="!appModeService.isVisualizationOnly" [target]="viewer" [model]="menuItems"
                       (onHide)="onContextMenuHide()" appendTo="body" />
        <sourcedatadialog *ngIf="!appModeService.isVisualizationOnly"></sourcedatadialog>
        @defer (when mapView) {
            <erdblick-view-ui [mapView]="mapView!" [is2D]="is2DMode"></erdblick-view-ui>
        }
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
    outlined: boolean = false;
    showSyncMenu: boolean = false;
    syncOptions: {name: string, value: string}[] = [
        {name: "Position", value: VIEW_SYNC_POSITION},
        {name: "Projection", value: VIEW_SYNC_PROJECTION}
    ];
    selectedOptions: {name: string, value: string}[] = [];
    @ViewChild('viewer', { static: true }) viewerElement!: ElementRef<HTMLDivElement>;

    private modeSubscription?: Subscription;

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
     * @param appModeService
     * @param cdr
     */
    constructor(public mapService: MapDataService,
                public featureSearchService: FeatureSearchService,
                public stateService: AppStateService,
                public jumpService: JumpTargetService,
                public keyboardService: KeyboardService,
                public menuService: RightClickMenuService,
                public coordinatesService: CoordinatesService,
                public appModeService: AppModeService,
                private cdr: ChangeDetectorRef
    ) {
        // TODO: Consider only if the view is focused?
        //   Fix the tile outline
        this.menuService.menuItems.subscribe(items => {
            // if (this.stateService.focusedView === this.mapView?.viewIndex)
            this.menuItems = [...items];
        });

        this.stateService.focusedViewState.subscribe(focusedViewIndex => {
            this.outlined = this.stateService.numViews > 1 && this.mapView?.viewIndex === focusedViewIndex;
        });
    }

    ngAfterViewInit() {
        this.modeSubscription = combineLatest([
            this.stateService.ready.pipe(filter(ready => ready)),
            this.stateService.mode2dState.pipe(this.viewIndex())
        ]).subscribe(([_, mode2d]) => {
            const needsRebuild = this.is2DMode !== mode2d || !this.mapView;
            this.is2DMode = mode2d;
            if (needsRebuild) {
                this.initializeViewer(mode2d);
            }
        });
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
        const mapView = is2D
            ? new MapView2D(
                this.viewIndex(), this.canvasId, this.mapService, this.featureSearchService,
                this.jumpService, this.menuService, this.coordinatesService, this.stateService)
            : new MapView3D(
                this.viewIndex(), this.canvasId, this.mapService, this.featureSearchService,
                this.jumpService, this.menuService, this.coordinatesService, this.stateService);
        await mapView.setup();
        this.mapView = mapView;
    }

    /**
     * Component cleanup when destroyed
     */
    ngOnDestroy() {
        this.modeSubscription?.unsubscribe();
        this.mapView?.destroy().then();
    }

    private initializeViewer(mode2d: boolean) {
        this.createViewerForMode(mode2d).catch((error) => {
            console.error('Failed to initialize viewer:', error);
            alert('Failed to initialize the map viewer. Please refresh the page.');
        }).finally(() => {
            // Hide the global loading spinner
            const spinner = document.getElementById('global-spinner-container');
            if (spinner) {
                spinner.style.display = 'none';
            }
            this.stateService.focusedView = this.stateService.focusedView.valueOf(); // Focus on the last focused view
            this.showSyncMenu = this.stateService.numViews > 1 && this.mapView!.viewIndex > 0;
            const currentSyncState = new Set(this.stateService.viewSync);
            this.selectedOptions = this.syncOptions.filter(option => currentSyncState.has(option.value));
            this.cdr.markForCheck();
        });
    }

    get canvasId(): string {
        return `mapViewContainer-${this.viewIndex()}`;
    }

    updateSelectedOptions() {
        this.stateService.viewSync = this.selectedOptions.map(option => option.value);
        this.stateService.syncViews();
    }
}
