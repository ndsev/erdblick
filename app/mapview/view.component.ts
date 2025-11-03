import {AppStateService, VIEW_SYNC_LAYERS, VIEW_SYNC_MOVEMENT, VIEW_SYNC_POSITION, VIEW_SYNC_PROJECTION} from "../shared/appstate.service";
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
import {environment} from "../environments/environment";

@Component({
    selector: 'map-view',
    template: `
        <div #viewer [ngClass]="{'border': outlined}" [id]="canvasId" class="mapviewer-renderlayer" style="z-index: 0"></div>
        @if (!environment.visualizationOnly && showSyncMenu) {
            <p-buttonGroup class="viewsync-select">
                @for (option of syncOptions; track $index) {
                    <p-toggleButton onIcon="" offIcon="" [ngClass]="{'green': option.value}"
                                    [(ngModel)]="option.value" (ngModelChange)="updateSelectedOptions()" 
                                    onLabel="" offLabel="" pTooltip="{{option.tooltip}}" tooltipPosition="bottom">
                        <ng-template #icon>
                            <span class="material-symbols-outlined">{{ option.icon }}</span>
                        </ng-template>
                    </p-toggleButton>
                }
            </p-buttonGroup>
        }
        <p-contextMenu *ngIf="!appModeService.isVisualizationOnly && !isNarrow" [target]="viewer" [model]="menuItems"
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
export class MapViewComponent implements AfterViewInit, OnDestroy, OnInit {
    menuItems: MenuItem[] = [];
    is2DMode: boolean = false;
    mapView?: MapView;
    viewIndex: InputSignal<number> = input.required<number>();
    outlined: boolean = false;
    showSyncMenu: boolean = false;
    isNarrow: boolean = false;
    syncOptions: {name: string, code: string, value: boolean, icon: string, tooltip: string}[] = [
        {name: "Position", code: VIEW_SYNC_POSITION, value: false, icon: "location_on", tooltip: "Sync camera position/orientation across views"},
        {name: "Movement", code: VIEW_SYNC_MOVEMENT, value: false, icon: "drag_pan", tooltip: "Sync camera movement delta across views"},
        {name: "Projection", code: VIEW_SYNC_PROJECTION, value: false, icon: "3d_rotation", tooltip: "Sync projection mode across views"},
        {name: "Layers", code: VIEW_SYNC_LAYERS, value: false, icon: "layers", tooltip: "Sync layer activation/style/OSM settings across views"},
    ];
    @ViewChild('viewer', { static: true }) viewerElement!: ElementRef<HTMLDivElement>;

    private modeSubscription?: Subscription;
    private mediaQueryList?: MediaQueryList;
    private mediaQueryChangeListener?: (event: MediaQueryListEvent) => void;

    /**
     * Construct a Cesium View with a Model.
     * @param mapService The map model service providing access to data
     * @param featureSearchService
     * @param stateService The parameter service, used to update
     * @param jumpService
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

    ngOnInit() {
        if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
            this.mediaQueryList = window.matchMedia('(max-width: 56em)');
            this.isNarrow = this.mediaQueryList.matches;
            this.mediaQueryChangeListener = (event: MediaQueryListEvent) => {
                this.isNarrow = event.matches;
                this.cdr.markForCheck();
            };
            if (typeof this.mediaQueryList.addEventListener === 'function') {
                this.mediaQueryList.addEventListener('change', this.mediaQueryChangeListener);
            } else {
                this.mediaQueryList.addListener(this.mediaQueryChangeListener);
            }
        }
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
        if (this.mediaQueryList && this.mediaQueryChangeListener) {
            if (typeof this.mediaQueryList.removeEventListener === 'function') {
                this.mediaQueryList.removeEventListener('change', this.mediaQueryChangeListener);
            } else {
                this.mediaQueryList.removeListener(this.mediaQueryChangeListener);
            }
        }
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
            this.syncOptions.forEach(option => option.value = currentSyncState.has(option.code));
            this.cdr.markForCheck();
        });
    }

    get canvasId(): string {
        return `mapViewContainer-${this.viewIndex()}`;
    }

    updateSelectedOptions() {
        const previousSelection = new Set(this.stateService.viewSync);
        const hasMovement = this.syncOptions.some(option =>
            option.code === VIEW_SYNC_MOVEMENT && option.value);
        const hasPosition = this.syncOptions.some(option =>
            option.code === VIEW_SYNC_POSITION && option.value);

        if (hasMovement && hasPosition) {
            let valueToRemove = VIEW_SYNC_POSITION;
            if (!previousSelection.has(VIEW_SYNC_POSITION) && previousSelection.has(VIEW_SYNC_MOVEMENT)) {
                valueToRemove = VIEW_SYNC_MOVEMENT;
            } else if (!previousSelection.has(VIEW_SYNC_MOVEMENT) && previousSelection.has(VIEW_SYNC_POSITION)) {
                valueToRemove = VIEW_SYNC_POSITION;
            } else if (!previousSelection.has(VIEW_SYNC_MOVEMENT)) {
                valueToRemove = VIEW_SYNC_POSITION;
            } else if (!previousSelection.has(VIEW_SYNC_POSITION)) {
                valueToRemove = VIEW_SYNC_MOVEMENT;
            }
            for (const option of this.syncOptions) {
                if (option.code === valueToRemove) {
                    option.value = false;
                }
            }
        }

        this.stateService.viewSync = this.syncOptions.filter(option =>
            option.value).map(option=> option.code);
        this.stateService.syncViews();
    }

    protected readonly environment = environment;
}
