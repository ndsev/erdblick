import {
    AppStateService,
    RendererMode,
    VIEW_SYNC_LAYERS,
    VIEW_SYNC_MOVEMENT,
    VIEW_SYNC_POSITION,
    VIEW_SYNC_PROJECTION
} from "../shared/appstate.service";
import {
    AfterViewInit,
    ChangeDetectorRef,
    Component,
    ElementRef,
    NgZone,
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
import {CesiumMapView2D} from "./cesium/cesium-map-view2d";
import {CesiumMapView3D} from "./cesium/cesium-map-view3d";
import {DeckMapView2D} from "./deck/deck-view2d";
import {DeckMapView3D} from "./deck/deck-view3d";
import {IRenderView} from "./render-view.model";
import {combineLatest, Subscription} from "rxjs";
import {filter} from "rxjs/operators";
import {environment} from "../environments/environment";
import {Popover} from "primeng/popover";

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
        @if (!appModeService.isVisualizationOnly && !isNarrow) {
            <p-contextMenu [target]="viewer" [model]="menuItems" (onHide)="onContextMenuHide()" appendTo="body" />
        }
        @if (!appModeService.isVisualizationOnly) {
            <sourcedatadialog></sourcedatadialog>
        }
        @defer (when mapView) {
            <erdblick-view-ui [mapView]="mapView!" [is2D]="is2DMode"></erdblick-view-ui>
        }
        <div #popoverAnchor class="popover-anchor"></div>
        <p-popover #popover styleClass="feature-hover-popover">
            <ng-template pTemplate="content">
                @for (content of featureIdsContent; track $index) {
                    {{ content }}<br>
                }
            </ng-template>
        </p-popover>
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
    subscriptions: Subscription[] = [];
    menuItems: MenuItem[] = [];
    is2DMode: boolean = false;
    rendererMode: RendererMode = 'cesium';
    mapView?: IRenderView;
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
    private hoverSubscription?: Subscription;
    private mediaQueryList?: MediaQueryList;
    private mediaQueryChangeListener?: (event: MediaQueryListEvent) => void;

    @ViewChild('popover') featureIdsPopover!: Popover;
    @ViewChild('popoverAnchor') anchorRef!: ElementRef<HTMLDivElement>;
    featureIdsContent: string[] = [];

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
                private cdr: ChangeDetectorRef,
                private ngZone: NgZone
    ) {
        this.subscriptions.push(
            // TODO: Consider only if the view is focused?
            //   Fix the tile outline
            this.menuService.menuItems.subscribe(items => {
                // if (this.stateService.focusedView === this.mapView?.viewIndex)
                this.menuItems = [...items];
            })
        );

        this.subscriptions.push(
            this.stateService.focusedViewState.subscribe(focusedViewIndex => {
                this.outlined = this.stateService.numViews > 1 && this.mapView?.viewIndex === focusedViewIndex;
            })
        );
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
            this.stateService.mode2dState.pipe(this.viewIndex()),
            this.stateService.rendererModeState
        ]).subscribe(([_, mode2d, rendererMode]) => {
            const needsRebuild =
                this.is2DMode !== mode2d || this.rendererMode !== rendererMode || !this.mapView;
            this.is2DMode = mode2d;
            this.rendererMode = rendererMode;
            if (needsRebuild) {
                this.initializeViewer(mode2d, rendererMode);
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
    private async createViewerForMode(is2D: boolean, rendererMode: RendererMode) {
        this.hoverSubscription?.unsubscribe();
        this.hoverSubscription = undefined;
        if (this.mapView) {
            await this.ngZone.runOutsideAngular(() => this.mapView!.destroy());
        }
        const mapView: IRenderView = rendererMode === 'deck'
            ? (
                is2D
                    ? new DeckMapView2D(
                        this.viewIndex(), this.canvasId, this.mapService, this.featureSearchService,
                        this.jumpService, this.menuService, this.coordinatesService, this.stateService
                    )
                    : new DeckMapView3D(
                        this.viewIndex(), this.canvasId, this.mapService, this.featureSearchService,
                        this.jumpService, this.menuService, this.coordinatesService, this.stateService
                    )
            )
            : (
                is2D
                    ? new CesiumMapView2D(
                        this.viewIndex(), this.canvasId, this.mapService, this.featureSearchService,
                        this.jumpService, this.menuService, this.coordinatesService, this.stateService
                    )
                    : new CesiumMapView3D(
                        this.viewIndex(), this.canvasId, this.mapService, this.featureSearchService,
                        this.jumpService, this.menuService, this.coordinatesService, this.stateService
                    )
            );
        // Keep renderer setup out of Angular zone to avoid global change detection on pointer/move loops.
        await this.ngZone.runOutsideAngular(() => mapView.setup());
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
        this.hoverSubscription?.unsubscribe();
        if (this.mapView) {
            this.ngZone.runOutsideAngular(() => this.mapView!.destroy()).then();
        }
    }

    private initializeViewer(mode2d: boolean, rendererMode: RendererMode) {
        this.createViewerForMode(mode2d, rendererMode).catch((error) => {
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
            this.hoverSubscription = this.mapView!.hoveredFeatureIds.subscribe(result => {
                this.featureIdsContent = [];
                if (!result || !result.featureIds.length) {
                    this.featureIdsPopover.hide();
                    return;
                }
                const featureIdsContent: string[] = [];
                result.featureIds.forEach((featureId) => {
                    if (!featureId) {
                        return;
                    }
                    if (typeof featureId === "string") {
                        if (featureId !== 'hover-highlight') {
                            featureIdsContent.push(featureId);
                        }
                    } else {
                        if (featureId.featureId) {
                            featureIdsContent.push(featureId.featureId);
                        }
                    }
                });
                if (!featureIdsContent.length) {
                    this.featureIdsContent = [];
                    this.featureIdsPopover.hide();
                    return;
                }
                this.featureIdsContent = featureIdsContent;
                const canvasRect = this.mapView!.getCanvasClientRect();
                const x = result.position.x + canvasRect.left; // Add the offset from the canvas dom element.
                const y = result.position.y + canvasRect.top;
                const anchor = this.anchorRef.nativeElement;
                anchor.style.position = 'fixed';
                anchor.style.left = `${x - 16}px`;
                anchor.style.top = `${y - 4}px`;
                anchor.style.width = '1px';
                anchor.style.height = '1px';
                anchor.style.pointerEvents = 'none';

                if (this.featureIdsPopover.overlayVisible) {
                    this.featureIdsPopover.target = anchor;
                    this.featureIdsPopover.align();
                } else {
                    this.featureIdsPopover.show(null, anchor);
                }

            });
            this.mapService.scheduleUpdate();
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
