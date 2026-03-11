import {
    AppStateService,
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
import {ContextMenu} from "primeng/contextmenu";
import {RightClickMenuService, SourceDataDropdownOption} from "./rightclickmenu.service";
import {AppModeService} from "../shared/app-mode.service";
import {DeckMapView2D} from "./deck/deck-view2d";
import {DeckMapView3D} from "./deck/deck-view3d";
import {IRenderView} from "./render-view.model";
import {combineLatest, Subscription} from "rxjs";
import {filter} from "rxjs/operators";
import {environment} from "../environments/environment";
import {Popover} from "primeng/popover";
import {coreLib} from "../integrations/wasm";

@Component({
    selector: 'map-view',
    template: `
        <div #viewer
             [ngClass]="{'border': outlined}"
             [id]="canvasId"
             class="mapviewer-renderlayer"
             style="z-index: 0"></div>
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
            <p-contextMenu #viewerContextMenu [model]="menuItems" (onShow)="onContextMenuShow()" (onHide)="onContextMenuHide()" appendTo="body" />
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
    private static readonly RIGHT_DRAG_SUPPRESS_THRESHOLD_PX = 4;
    private static readonly SOURCE_DATA_TILE_LEVEL_COUNT = 16;

    subscriptions: Subscription[] = [];
    menuItems: MenuItem[] = [];
    is2DMode: boolean = false;
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
    private contextMenuVisible = false;
    private pendingContextMenuOpenEvent: {clientX: number; clientY: number; pageX: number; pageY: number} | null = null;
    private rightPressStart: {x: number; y: number} | null = null;
    private rightPressMoved = false;
    private viewerPointerDownCapture?: (event: PointerEvent) => void;
    private viewerPointerMoveCapture?: (event: PointerEvent) => void;
    private viewerPointerUpCapture?: (_event: PointerEvent) => void;
    private viewerPointerCancelCapture?: (_event: PointerEvent) => void;
    private viewerContextMenuCapture?: (event: MouseEvent) => void;

    @ViewChild('popover') featureIdsPopover!: Popover;
    @ViewChild('popoverAnchor') anchorRef!: ElementRef<HTMLDivElement>;
    @ViewChild('viewerContextMenu') viewerContextMenu?: ContextMenu;
    featureIdsContent: string[] = [];

    /**
     * Construct a map view component with deck-backed rendering.
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
            this.menuService.menuItems.subscribe(items => {
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
        this.setupViewerContextMenuHandling();
        this.modeSubscription = combineLatest([
            this.stateService.ready.pipe(filter(ready => ready)),
            this.stateService.mode2dState.pipe(this.viewIndex())
        ]).subscribe(([_, mode2d]) => {
            const needsRebuild =
                this.is2DMode !== mode2d || !this.mapView;
            this.is2DMode = mode2d;
            if (needsRebuild) {
                this.initializeViewer(mode2d);
            }
        });
    }

    onContextMenuHide() {
        this.contextMenuVisible = false;
        if (this.pendingContextMenuOpenEvent && this.viewerContextMenu) {
            const event = this.pendingContextMenuOpenEvent;
            this.pendingContextMenuOpenEvent = null;
            setTimeout(() => this.openContextMenu(this.viewerContextMenu!, event), 0);
            return;
        }
        this.resetPreparedSourceData(false, false);
        if (!this.menuService.tileSourceDataDialogVisible) {
            this.menuService.tileOutline.next(null);
        }
    }

    onContextMenuShow() {
        this.contextMenuVisible = true;
    }

    /**
     * Recreate the viewer with different projection for 2D/3D modes
     */
    private async createViewerForMode(is2D: boolean) {
        this.hoverSubscription?.unsubscribe();
        this.hoverSubscription = undefined;
        if (this.mapView) {
            await this.ngZone.runOutsideAngular(() => this.mapView!.destroy());
        }
        const mapView: IRenderView = is2D
            ? new DeckMapView2D(
                this.viewIndex(), this.canvasId, this.mapService, this.featureSearchService,
                this.jumpService, this.menuService, this.coordinatesService, this.stateService
            )
            : new DeckMapView3D(
                this.viewIndex(), this.canvasId, this.mapService, this.featureSearchService,
                this.jumpService, this.menuService, this.coordinatesService, this.stateService
            );
        // Keep renderer setup out of Angular zone to avoid global change detection on pointer/move loops.
        await this.ngZone.runOutsideAngular(() => mapView.setup());
        this.mapView = mapView;
    }

    /**
     * Component cleanup when destroyed
     */
    ngOnDestroy() {
        this.teardownViewerContextMenuHandling();
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

    private resetRightPressTracking(): void {
        this.rightPressStart = null;
        this.rightPressMoved = false;
    }

    private setupViewerContextMenuHandling(): void {
        const viewer = this.viewerElement?.nativeElement;
        if (!viewer) {
            return;
        }

        this.viewerPointerDownCapture = (event: PointerEvent) => {
            if (event.button === 0 && this.contextMenuVisible && this.viewerContextMenu) {
                this.ngZone.run(() => this.viewerContextMenu?.hide());
            }
            if (event.button !== 2) {
                return;
            }
            this.rightPressStart = {x: event.clientX, y: event.clientY};
            this.rightPressMoved = false;
        };
        this.viewerPointerMoveCapture = (event: PointerEvent) => {
            if (!this.rightPressStart || (event.buttons & 2) === 0 || this.rightPressMoved) {
                return;
            }
            const dx = event.clientX - this.rightPressStart.x;
            const dy = event.clientY - this.rightPressStart.y;
            const threshold = MapViewComponent.RIGHT_DRAG_SUPPRESS_THRESHOLD_PX;
            if (Math.abs(dx) <= threshold && Math.abs(dy) <= threshold) {
                return;
            }
            this.rightPressMoved = true;
        };
        this.viewerPointerUpCapture = (event: PointerEvent) => {
            if (event.button !== 2) {
                return;
            }
            const menu = this.viewerContextMenu;
            const start = this.rightPressStart;
            const threshold = MapViewComponent.RIGHT_DRAG_SUPPRESS_THRESHOLD_PX;
            const movedSinceRightDown = !!start && (
                Math.abs(event.clientX - start.x) > threshold ||
                Math.abs(event.clientY - start.y) > threshold
            );
            if (menu && !this.rightPressMoved && !movedSinceRightDown) {
                this.ngZone.run(() => {
                    const menuEvent = this.copyContextMenuEvent(event);
                    if (this.contextMenuVisible) {
                        this.pendingContextMenuOpenEvent = menuEvent;
                        this.resetPreparedSourceData();
                        menu.hide();
                    } else {
                        queueMicrotask(() => this.openContextMenu(menu, menuEvent));
                    }
                });
            }
            this.resetRightPressTracking();
        };
        this.viewerPointerCancelCapture = (_event: PointerEvent) => {
            this.resetRightPressTracking();
        };
        this.viewerContextMenuCapture = (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
        };

        this.ngZone.runOutsideAngular(() => {
            viewer.addEventListener("pointerdown", this.viewerPointerDownCapture!, true);
            viewer.addEventListener("pointermove", this.viewerPointerMoveCapture!, true);
            viewer.addEventListener("pointerup", this.viewerPointerUpCapture!, true);
            viewer.addEventListener("pointercancel", this.viewerPointerCancelCapture!, true);
            viewer.addEventListener("contextmenu", this.viewerContextMenuCapture!, true);
        });
    }

    private teardownViewerContextMenuHandling(): void {
        const viewer = this.viewerElement?.nativeElement;
        if (!viewer) {
            return;
        }
        this.ngZone.runOutsideAngular(() => {
            if (this.viewerPointerDownCapture) {
                viewer.removeEventListener("pointerdown", this.viewerPointerDownCapture, true);
            }
            if (this.viewerPointerMoveCapture) {
                viewer.removeEventListener("pointermove", this.viewerPointerMoveCapture, true);
            }
            if (this.viewerPointerUpCapture) {
                viewer.removeEventListener("pointerup", this.viewerPointerUpCapture, true);
            }
            if (this.viewerPointerCancelCapture) {
                viewer.removeEventListener("pointercancel", this.viewerPointerCancelCapture, true);
            }
            if (this.viewerContextMenuCapture) {
                viewer.removeEventListener("contextmenu", this.viewerContextMenuCapture, true);
            }
        });
        this.viewerPointerDownCapture = undefined;
        this.viewerPointerMoveCapture = undefined;
        this.viewerPointerUpCapture = undefined;
        this.viewerPointerCancelCapture = undefined;
        this.viewerContextMenuCapture = undefined;
        this.resetRightPressTracking();
    }

    private openContextMenu(menu: ContextMenu, event: {clientX: number; clientY: number; pageX: number; pageY: number}) {
        try {
            this.prepareSourceDataContextMenu(event);
        } catch (error) {
            console.error("Failed to prepare source-data context menu.", error);
            this.menuService.tileIdsForSourceData.next([]);
        }
        menu.show(this.contextMenuShowEvent(event) as MouseEvent);
    }

    private copyContextMenuEvent(event: MouseEvent | PointerEvent): {clientX: number; clientY: number; pageX: number; pageY: number} {
        return {
            clientX: event.clientX,
            clientY: event.clientY,
            pageX: event.pageX,
            pageY: event.pageY
        };
    }

    private contextMenuShowEvent(event: {pageX: number; pageY: number}): {pageX: number; pageY: number; preventDefault: () => void; stopPropagation: () => void} {
        return {
            pageX: event.pageX,
            pageY: event.pageY,
            preventDefault: () => {},
            stopPropagation: () => {}
        };
    }

    private prepareSourceDataContextMenu(event: {clientX: number; clientY: number}): void {
        if (!this.mapView || this.appModeService.isVisualizationOnly) {
            this.resetPreparedSourceData(true);
            return;
        }

        this.stateService.focusedView = this.viewIndex();
        const canvasRect = this.mapView.getCanvasClientRect();
        const screenPos = {
            x: event.clientX - canvasRect.left,
            y: event.clientY - canvasRect.top
        };
        const cartographic = this.mapView.pickCartographic(screenPos);
        if (!cartographic) {
            this.resetPreparedSourceData(true);
            return;
        }

        const tileIds = Array.from({length: MapViewComponent.SOURCE_DATA_TILE_LEVEL_COUNT}, (_, level) => {
            const tileId = coreLib.getTileIdFromPosition(cartographic.lon, cartographic.lat, level);
            return {
                id: tileId,
                name: `${tileId} (level ${level})`,
                tileLevel: level,
                disabled: this.mapService.findSourceDataMapsForTileId(tileId).length === 0
            };
        });
        const preferredPickedTileId = this.preferredPickedTileId(screenPos, tileIds);
        const preferredVisibleLevelTileId = this.preferredVisibleLevelTileId(tileIds);
        this.menuService.preferredTileIdForSourceData =
            preferredPickedTileId ??
            preferredVisibleLevelTileId;
        this.menuService.tileIdsForSourceData.next(tileIds);

        const outlinedTile = this.menuService.preferredSourceDataTile(tileIds);
        if (outlinedTile) {
            this.menuService.outlineTile(BigInt(outlinedTile.id));
        } else {
            this.menuService.tileOutline.next(null);
        }
    }

    private preferredPickedTileId(
        screenPos: {x: number; y: number},
        tileIds: SourceDataDropdownOption[]
    ): bigint | null {
        if (!this.mapView) {
            return null;
        }
        const availableTileIds = new Set(
            tileIds
                .filter(tileId => !tileId.disabled)
                .map(tileId => tileId.id as bigint)
        );
        let bestTileId: bigint | null = null;
        for (const featureId of this.mapView.pickFeature(screenPos)) {
            if (!featureId) {
                continue;
            }
            const [, , tileId] = coreLib.parseMapTileKey(featureId.mapTileKey) as [string, string, bigint];
            if (!availableTileIds.has(tileId)) {
                continue;
            }
            if (bestTileId === null || coreLib.getTileLevel(tileId) > coreLib.getTileLevel(bestTileId)) {
                bestTileId = tileId;
            }
        }
        return bestTileId;
    }

    private preferredVisibleLevelTileId(tileIds: SourceDataDropdownOption[]): bigint | null {
        const visibleLevels = this.mapService.visibleFeatureLevelsInView(this.viewIndex());
        const preferredTile = [...tileIds]
            .reverse()
            .find(tileId => !tileId.disabled && visibleLevels.has(tileId.tileLevel ?? -1));
        return preferredTile?.id as bigint | undefined ?? null;
    }

    private resetPreparedSourceData(clearTileIds: boolean = false, clearOutline: boolean = true): void {
        this.menuService.preferredTileIdForSourceData = null;
        if (clearOutline) {
            this.menuService.tileOutline.next(null);
        }
        if (clearTileIds) {
            this.menuService.tileIdsForSourceData.next([]);
        }
    }

    protected readonly environment = environment;
}
