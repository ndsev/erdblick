import {
    AppStateService,
    type TileFeatureId
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
import {MapInfoService} from "../mapdata/map-info.service";
import {MapViewStateService, ViewRecalculationReason} from "./map-view-state.service";
import {MapTileStreamService} from "../mapdata/map-tile-stream.service";
import {InspectionSelectionService} from "../inspection/inspection-selection.service";
import {FeatureSearchService} from "../search/feature.search.service";
import {CoordinatesService} from "../coords/coordinates.service";
import {JumpTargetService} from "../search/jump.service";
import {KeyboardService} from "../shared/keyboard.service";
import {MenuItem} from "primeng/api";
import {ContextMenu} from "primeng/contextmenu";
import {
    FirstPersonViewMenuRequest,
    RightClickMenuService,
    SourceDataDropdownOption,
    TileDiagnosticsMenuOption
} from "./rightclickmenu.service";
import {AppModeService} from "../shared/app-mode.service";
import {DeckMapView2D} from "./deck/deck-view2d";
import {DeckMapView3D} from "./deck/deck-view3d";
import {
    IRenderView,
    MAP_VIEW_LAYOUT_RESIZE_PREPARE_EVENT,
    RenderNavigationTarget
} from "./render-view.model";
import {combineLatest, Subscription} from "rxjs";
import {filter} from "rxjs/operators";
import {environment} from "../environments/environment";
import {Popover} from "primeng/popover";
import {coreLib} from "../integrations/wasm";
import {AppConfigService} from "../shared/app-config.service";
import {StyleService} from "../styledata/style.service";
import {ViewLayerController} from "./view-layer.controller";
import {
    TileSubsetLayerRenderService
} from "./deck/tile-subset-layer-render.service";
import {
    ViewLayerDiagnosticsService
} from "./view-layer-diagnostics.service";
import {
    StyleValidationReportService
} from "../styledata/style-validation-report.service";

interface PreparedContextMenuPosition {
    screenPos: {x: number; y: number};
    cartographic: {lon: number; lat: number; alt: number};
    navigationTarget?: RenderNavigationTarget;
    featureIds: TileFeatureId[];
}

@Component({
    selector: 'map-view',
    template: `
        <div #viewer
             [ngClass]="{'border': outlined}"
             [id]="canvasId"
             [attr.data-testid]="canvasId"
             class="mapviewer-renderlayer"
             style="z-index: 0"></div>
        @if (viewerInitError) {
            <div class="mapviewer-error-state" role="alert">
                <span class="material-symbols-outlined">warning</span>
                <div>
                    <strong>Map renderer unavailable</strong>
                    <p>{{ viewerInitError }}</p>
                </div>
            </div>
        }
        @if (mapView?.isFirstPersonViewActive()) {
            <p-button class="first-person-exit-button"
                      [attr.data-testid]="'exit-first-person-view-' + viewIndex()"
                      label="Exit First Person View"
                      severity="primary"
                      size="small"
                      (onClick)="exitFirstPersonView()">
                <ng-template #icon let-iconClass="class">
                    <span [class]="iconClass + ' material-symbols-outlined'">ar_on_you</span>
                </ng-template>
            </p-button>
        }
        @if (!environment.visualizationOnly && showSyncMenu) {
            <p-buttonGroup class="viewsync-select" data-testid="viewsync-select">
                @for (option of stateService.syncOptions; track option.code) {
                    <p-toggleButton onIcon="" offIcon=""
                                    [ngModel]="isSyncOptionSelected(option.code)"
                                    [ngClass]="{'green': isSyncOptionSelected(option.code)}"
                                    (ngModelChange)="onSyncOptionToggle(option.code, $event)"
                                    onLabel="" offLabel="" pTooltip="{{option.tooltip}}" tooltipPosition="bottom">
                        <ng-template #icon>
                            <span class="material-symbols-outlined">{{ option.icon }}</span>
                        </ng-template>
                    </p-toggleButton>
                }
            </p-buttonGroup>
        }
        @if (!appModeService.isVisualizationOnly && !isNarrow) {
            <p-contextMenu #viewerContextMenu [model]="menuItems" (onShow)="onContextMenuShow()"
                           (onHide)="onContextMenuHide()" appendTo="body">
                <ng-template #item let-item>
                    <a pRipple class="p-contextmenu-item-link"
                       [attr.data-automationid]="item.automationId"
                       [attr.title]="item.title">
                        @if (item.icon) {
                            <span class="p-contextmenu-item-icon" [ngClass]="item.icon"></span>
                        }
                        @if (item.mapIdLabel) {
                            <p-tag class="picked-feature-map-tag"
                                   severity="contrast"
                                   [rounded]="true"
                                   [value]="item.mapIdLabel"/>
                        }
                        <span class="p-contextmenu-item-label">{{ item.label }}</span>
                        @if (item.items?.length) {
                            <span class="p-contextmenu-submenu-icon pi pi-angle-right"></span>
                        }
                    </a>
                </ng-template>
            </p-contextMenu>
        }
        @if (!appModeService.isVisualizationOnly) {
            <sourcedatadialog></sourcedatadialog>
        }
        @defer (when mapView) {
            <erdblick-view-ui [mapView]="mapView!" [is2D]="is2DMode"></erdblick-view-ui>
        }
        <div #popoverAnchor class="popover-anchor"></div>
        <p-popover #popover styleClass="feature-hover-popover hover-label-surface">
            <ng-template pTemplate="content">
                @for (content of featureIdsContent; track $index) {
                    {{ content }}<br>
                }
            </ng-template>
        </p-popover>
    `,
    standalone: false
})
/**
 * Host component for one interactive map view.
 * It owns renderer creation, hover popovers, right-click context-menu preparation, and view-local mode toggles.
 */
export class MapViewComponent implements AfterViewInit, OnDestroy, OnInit {
    private static readonly RIGHT_DRAG_SUPPRESS_THRESHOLD_PX = 4;
    private static readonly SOURCE_DATA_TILE_LEVEL_COUNT = 16;
    private static readonly WEBGL_SETUP_HINT =
        "Ensure WebGL2 is available and browser hardware acceleration is enabled. " +
        "If hardware acceleration is unavailable, switch the browser to a supported software WebGL renderer " +
        "(this is controlled by the browser). Reload the page afterwards.";
    protected readonly isSyncOptionSelected = (code: string) => this.stateService.viewSync.includes(code);

    subscriptions: Subscription[] = [];
    menuItems: MenuItem[] = [];
    is2DMode: boolean = false;
    mapView?: IRenderView;
    viewerInitError = "";
    viewIndex: InputSignal<number> = input.required<number>();
    outlined: boolean = false;
    showSyncMenu: boolean = false;
    isNarrow: boolean = false;
    @ViewChild('viewer', { static: true }) viewerElement!: ElementRef<HTMLDivElement>;

    private modeSubscription?: Subscription;
    private hoverSubscription?: Subscription;
    private firstPersonViewActiveSubscription?: Subscription;
    private firstPersonViewRequestSubscription?: Subscription;
    private mediaQueryList?: MediaQueryList;
    private mediaQueryChangeListener?: (event: MediaQueryListEvent) => void;
    private deckAntialiasingEnabled = true;
    private contextMenuVisible = false;
    private pendingContextMenuOpenEvent: {clientX: number; clientY: number; pageX: number; pageY: number} | null = null;
    private pendingContextMenuOpenTimeout?: ReturnType<typeof setTimeout>;
    private rightPressStart: {x: number; y: number} | null = null;
    private rightPressMoved = false;
    private viewerPointerDownCapture?: (event: PointerEvent) => void;
    private viewerPointerMoveCapture?: (event: PointerEvent) => void;
    private viewerPointerUpCapture?: (_event: PointerEvent) => void;
    private viewerPointerCancelCapture?: (_event: PointerEvent) => void;
    private viewerContextMenuCapture?: (event: MouseEvent) => void;
    private layoutResizePrepareListener?: (event: Event) => void;
    private viewerSetupGeneration = 0;
    private layerController?: ViewLayerController;

    @ViewChild('popover') featureIdsPopover!: Popover;
    @ViewChild('popoverAnchor') anchorRef!: ElementRef<HTMLDivElement>;
    @ViewChild('viewerContextMenu') viewerContextMenu?: ContextMenu;
    featureIdsContent: string[] = [];

    /**
     * Constructs the host component for one deck-backed view, wiring in the shared
     * map, search, config, and input services the renderer depends on.
     */
    constructor(public mapService: MapInfoService,
                public mapViewState: MapViewStateService,
                public tileStream: MapTileStreamService,
                public inspectionSelection: InspectionSelectionService,
                public featureSearchService: FeatureSearchService,
                public stateService: AppStateService,
                public jumpService: JumpTargetService,
                public keyboardService: KeyboardService,
                public menuService: RightClickMenuService,
                public coordinatesService: CoordinatesService,
                public appModeService: AppModeService,
                public configService: AppConfigService,
                private styleService: StyleService,
                private subsetRenderService: TileSubsetLayerRenderService,
                private viewLayerDiagnostics: ViewLayerDiagnosticsService,
                private styleValidationReports: StyleValidationReportService,
                private cdr: ChangeDetectorRef,
                private ngZone: NgZone
    ) {
        this.subscriptions.push(
            this.stateService.focusedViewState.subscribe(focusedViewIndex => {
                this.outlined = this.stateService.numViews > 1 && this.mapView?.viewIndex === focusedViewIndex;
            })
        );
    }

    /** Mirrors one sync toggle button back into the canonical view-sync selection. */
    onSyncOptionToggle(code: string, enabled: boolean): void {
        const nextSelection = enabled
            ? [...this.stateService.viewSync, code]
            : this.stateService.viewSync.filter(currentCode => currentCode !== code);
        this.stateService.updateSelectedSyncOptions(nextSelection);
    }

    /** Registers menu subscriptions and viewport-size listeners once the component inputs are available. */
    ngOnInit() {
        this.layerController = new ViewLayerController(
            this.viewIndex(),
            this.mapService,
            this.mapViewState,
            this.tileStream,
            this.styleService,
            this.subsetRenderService,
            this.featureSearchService,
            this.inspectionSelection,
            this.viewLayerDiagnostics,
            this.styleValidationReports
        );
        this.subscriptions.push(
            this.menuService.menuItems.subscribe(items => {
                this.menuItems = [...items];
                if (this.stateService.numViews === 1) {
                    this.menuItems.push({
                        label: 'Split View',
                        icon: 'pi pi-plus',
                        command: () => {
                            this.stateService.numViews += 1;
                        }
                    });
                } else if (this.viewIndex() > 0) {
                    this.menuItems.push({
                        label: 'Close View',
                        icon: 'pi pi-times',
                        command: () => {
                            this.stateService.numViews -= 1;
                        }
                    });
                }
            })
        );
        this.subscriptions.push(
            this.menuService.closeContextMenus.subscribe(() => {
                this.pendingContextMenuOpenEvent = null;
                this.clearPendingContextMenuOpenTimeout();
                this.viewerContextMenu?.hide();
            })
        );
        this.subscriptions.push(
            this.stateService.hoverLabelFeatureIdState.subscribe(enabled => {
                if (!enabled) {
                    this.featureIdsContent = [];
                    this.featureIdsPopover?.hide();
                }
            })
        );
        this.firstPersonViewRequestSubscription = this.menuService.firstPersonViewRequests.subscribe(request => {
            if (request.viewIndex !== this.viewIndex()) {
                return;
            }
            this.applyFirstPersonViewRequest(request);
        });
        this.mediaQueryList = window.matchMedia('(max-width: 56em)');
        this.isNarrow = this.mediaQueryList.matches;
        this.mediaQueryChangeListener = (event: MediaQueryListEvent) => {
            this.isNarrow = event.matches;
            this.mapView?.setDesktopDrillPickingEnabled(!event.matches);
            this.cdr.markForCheck();
        };
        this.mediaQueryList.addEventListener('change', this.mediaQueryChangeListener);
        this.layoutResizePrepareListener = () => {
            if (!this.mapView) {
                return;
            }
            const rect = this.viewerElement?.nativeElement.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) {
                return;
            }
            this.ngZone.runOutsideAngular(() => {
                this.mapView?.prepareForLayoutResize({
                    width: rect.width,
                    height: rect.height
                });
            });
        };
        window.addEventListener(MAP_VIEW_LAYOUT_RESIZE_PREPARE_EVENT, this.layoutResizePrepareListener);
    }

    /** Creates or recreates the renderer once app state is ready and the 2D/3D mode is known. */
    ngAfterViewInit() {
        this.setupViewerContextMenuHandling();
        this.modeSubscription = combineLatest([
            this.stateService.ready.pipe(filter(ready => ready)),
            this.stateService.mode2dState.pipe(this.viewIndex()),
            this.stateService.deckAntialiasingEnabledState
        ]).subscribe(([_, mode2d, antialiasingEnabled]) => {
            const needsRebuild =
                this.is2DMode !== mode2d || this.deckAntialiasingEnabled !== antialiasingEnabled || !this.mapView;
            this.is2DMode = mode2d;
            this.deckAntialiasingEnabled = antialiasingEnabled;
            if (needsRebuild) {
                this.initializeViewer(mode2d);
            }
        });
    }

    /** Handles context-menu teardown and queued reopen requests when the menu is toggled while already open. */
    onContextMenuHide() {
        this.contextMenuVisible = false;
        if (this.pendingContextMenuOpenEvent && this.viewerContextMenu) {
            const event = this.pendingContextMenuOpenEvent;
            this.pendingContextMenuOpenEvent = null;
            this.pendingContextMenuOpenTimeout = setTimeout(() => {
                this.pendingContextMenuOpenTimeout = undefined;
                this.openContextMenu(this.viewerContextMenu!, event);
            }, 0);
            return;
        }
        this.resetPreparedSourceData(false, false);
        this.menuService.setFeatureSearchScope(null);
        if (!this.menuService.isSourceDataDialogOpen()) {
            this.menuService.tileOutline.next(null);
        }
    }

    /** Tracks whether the PrimeNG context menu is currently visible. */
    onContextMenuShow() {
        this.contextMenuVisible = true;
    }

    /**
     * Recreate the viewer with different projection for 2D/3D modes
     */
    private async createViewerForMode(is2D: boolean, setupGeneration: number): Promise<IRenderView | undefined> {
        this.hoverSubscription?.unsubscribe();
        this.hoverSubscription = undefined;
        this.firstPersonViewActiveSubscription?.unsubscribe();
        this.firstPersonViewActiveSubscription = undefined;
        if (this.mapView) {
            this.layerController?.detachScene();
            await this.ngZone.runOutsideAngular(() => this.mapView!.destroy());
            this.mapView = undefined;
        }
        const mapView: IRenderView = is2D
            ? new DeckMapView2D(
                this.viewIndex(), this.canvasId, this.mapService, this.mapViewState, this.tileStream,
                this.inspectionSelection, this.featureSearchService,
                this.menuService, this.coordinatesService, this.stateService, this.configService,
                this.layerController!
            )
            : new DeckMapView3D(
                this.viewIndex(), this.canvasId, this.mapService, this.mapViewState, this.tileStream,
                this.inspectionSelection, this.featureSearchService,
                this.menuService, this.coordinatesService, this.stateService, this.configService,
                this.layerController!
            );
        mapView.setDesktopDrillPickingEnabled(!this.isNarrow);
        // Keep renderer setup out of Angular zone to avoid global change detection on pointer/move loops.
        await this.ngZone.runOutsideAngular(() => mapView.setup());
        if (setupGeneration !== this.viewerSetupGeneration) {
            await this.ngZone.runOutsideAngular(() => mapView.destroy({clearTileVisualizations: false}));
            return undefined;
        }
        this.mapView = mapView;
        this.layerController?.attachScene(mapView.getSceneHandle());
        this.viewerInitError = "";
        return mapView;
    }

    /**
     * Component cleanup when destroyed
     */
    ngOnDestroy() {
        this.viewerSetupGeneration++;
        this.pendingContextMenuOpenEvent = null;
        this.clearPendingContextMenuOpenTimeout();
        this.viewerContextMenu?.hide();
        this.teardownViewerContextMenuHandling();
        if (this.mediaQueryList && this.mediaQueryChangeListener) {
            this.mediaQueryList.removeEventListener('change', this.mediaQueryChangeListener);
        }
        if (this.layoutResizePrepareListener) {
            window.removeEventListener(MAP_VIEW_LAYOUT_RESIZE_PREPARE_EVENT, this.layoutResizePrepareListener);
            this.layoutResizePrepareListener = undefined;
        }
        this.modeSubscription?.unsubscribe();
        this.hoverSubscription?.unsubscribe();
        this.firstPersonViewActiveSubscription?.unsubscribe();
        this.firstPersonViewRequestSubscription?.unsubscribe();
        if (this.mapView) {
            this.ngZone.runOutsideAngular(() => this.mapView!.destroy()).then();
        }
        this.layerController?.dispose();
        this.layerController = undefined;
    }

    /**
     * Rebuilds view-local UI bindings after the renderer instance changed.
     * This includes hover popovers, sync toggles, and the initial viewport refresh.
     */
    private initializeViewer(mode2d: boolean) {
        const setupGeneration = ++this.viewerSetupGeneration;
        this.createViewerForMode(mode2d, setupGeneration).catch((error) => {
            if (setupGeneration !== this.viewerSetupGeneration) {
                return;
            }
            console.error('Failed to initialize viewer:', error);
            const detail = error instanceof Error ? error.message : String(error);
            const summary = detail.split(" userAgent=")[0] || "WebGL2 context could not be created.";
            this.viewerInitError = `${summary} ${MapViewComponent.WEBGL_SETUP_HINT}`;
        }).finally(() => {
            if (setupGeneration !== this.viewerSetupGeneration) {
                return;
            }
            // Hide the global loading spinner
            const spinner = document.getElementById('global-spinner-container');
            if (spinner) {
                spinner.style.display = 'none';
            }
            this.stateService.focusedView = this.stateService.focusedView.valueOf(); // Focus on the last focused view
            const mapView = this.mapView;
            if (!mapView) {
                this.cdr.markForCheck();
                return;
            }
            this.showSyncMenu = this.stateService.numViews > 1 && mapView.viewIndex > 0;
            this.firstPersonViewActiveSubscription = mapView.firstPersonViewActive.subscribe(() => {
                this.cdr.markForCheck();
            });
            this.hoverSubscription = mapView.hoveredFeatureIds.subscribe(result => {
                this.featureIdsContent = [];
                if (!this.stateService.hoverLabelFeatureId ||
                    !result || !result.featureIds.length) {
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
                const canvasRect = mapView.getCanvasClientRect();
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
            this.mapViewState.requestViewRecalculation(ViewRecalculationReason.HoverPopover);
            this.cdr.markForCheck();
        });
    }

    /** Returns the DOM id used for this map view canvas. */
    get canvasId(): string {
        return `mapViewContainer-${this.viewIndex()}`;
    }

    /** Clears the transient state used to distinguish a right-click from a right-drag gesture. */
    private resetRightPressTracking(): void {
        this.rightPressStart = null;
        this.rightPressMoved = false;
    }

    /** Cancels a queued same-view context-menu reopen when another view is about to open one. */
    private clearPendingContextMenuOpenTimeout(): void {
        if (this.pendingContextMenuOpenTimeout === undefined) {
            return;
        }
        clearTimeout(this.pendingContextMenuOpenTimeout);
        this.pendingContextMenuOpenTimeout = undefined;
    }

    /**
     * Installs capturing pointer listeners directly on the viewer DOM element.
     * This avoids PrimeNG/Cesium/deck interaction quirks and lets us suppress context menus after drags.
     */
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

    /** Removes the custom pointer/context-menu handlers installed on the viewer element. */
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

    /** Prepares source-data context and opens the PrimeNG context menu at the supplied screen position. */
    private openContextMenu(menu: ContextMenu, event: {clientX: number; clientY: number; pageX: number; pageY: number}) {
        this.menuService.closeAllContextMenus();
        const screenPos = this.contextMenuScreenPosition(event);
        const featureIds = screenPos && this.mapView
            ? this.mapView.drillPickFeatures(
                screenPos,
                this.stateService.drillPickRadius,
                this.stateService.inspectionsLimit
            ).featureIds
            : [];
        this.menuService.setPickedFeatures(featureIds);
        let contextPosition: PreparedContextMenuPosition | null = null;
        try {
            contextPosition = screenPos
                ? this.contextMenuPosition(screenPos, featureIds)
                : null;
            this.prepareSourceDataContextMenu(contextPosition);
        } catch (error) {
            console.error("Failed to prepare source-data context menu.", error);
            this.menuService.tileIdsForSourceData.next([]);
            this.menuService.setTileDiagnosticsOptions([]);
        }
        this.prepareFirstPersonViewContextMenu(contextPosition);
        this.menuService.setExternalViewerLocation(contextPosition
            ? {lon: contextPosition.cartographic.lon, lat: contextPosition.cartographic.lat}
            : null);
        try {
            this.prepareFeatureSearchContextMenu();
        } catch (error) {
            console.error("Failed to prepare feature-search context menu.", error);
            this.menuService.setFeatureSearchScope(null);
        }
        menu.show(this.contextMenuShowEvent(event) as MouseEvent);
    }

    /** Converts a context-menu client position to CSS pixels relative to the render canvas. */
    private contextMenuScreenPosition(event: {clientX: number; clientY: number}): {x: number; y: number} | null {
        if (!this.mapView) {
            return null;
        }
        this.stateService.focusedView = this.viewIndex();
        const canvasRect = this.mapView.getCanvasClientRect();
        return {
            x: event.clientX - canvasRect.left,
            y: event.clientY - canvasRect.top
        };
    }

    /** Resolves the WGS84 position represented by a context-menu canvas position. */
    private contextMenuPosition(
        screenPos: {x: number; y: number},
        featureIds: TileFeatureId[]
    ): PreparedContextMenuPosition | null {
        if (!this.mapView) {
            return null;
        }
        const navigationTarget = this.is2DMode ? undefined : this.mapView.pickNavigationTarget(screenPos);
        const cartographic = navigationTarget
            ? {
                lon: navigationTarget.position[0],
                lat: navigationTarget.position[1],
                alt: navigationTarget.position[2]
            }
            : this.mapView.pickCartographic(screenPos);
        return cartographic ? {screenPos, cartographic, navigationTarget, featureIds} : null;
    }

    /** Applies a view-scoped ephemeral first-person request without persisting it in app state. */
    private applyFirstPersonViewRequest(request: FirstPersonViewMenuRequest): void {
        if (!this.mapView) {
            return;
        }
        this.ngZone.runOutsideAngular(() => {
            if (request.action === "enter") {
                this.mapView?.enterFirstPersonView(request.target);
            } else {
                this.mapView?.exitFirstPersonView();
            }
        });
        this.cdr.markForCheck();
    }

    /** Leaves this renderer's ephemeral first-person camera and restores its map camera. */
    protected exitFirstPersonView(): void {
        const mapView = this.mapView;
        if (!mapView?.isFirstPersonViewActive()) {
            return;
        }
        this.ngZone.runOutsideAngular(() => mapView.exitFirstPersonView());
    }

    /** Prepares enter only for an exact 3D feature target, while exit remains available over empty space. */
    private prepareFirstPersonViewContextMenu(contextPosition: PreparedContextMenuPosition | null): void {
        if (!this.mapView) {
            this.menuService.setFirstPersonViewContext(null);
            return;
        }
        const viewIndex = this.viewIndex();
        if (this.mapView.isFirstPersonViewActive()) {
            this.menuService.setFirstPersonViewContext({viewIndex, active: true});
        } else if (!this.is2DMode && contextPosition?.navigationTarget) {
            this.menuService.setFirstPersonViewContext({
                viewIndex,
                active: false,
                target: contextPosition.navigationTarget
            });
        } else {
            this.menuService.setFirstPersonViewContext(null);
        }
    }

    /** Copies the event coordinates we need because the original pointer event may no longer be usable later. */
    private copyContextMenuEvent(event: MouseEvent | PointerEvent): {clientX: number; clientY: number; pageX: number; pageY: number} {
        return {
            clientX: event.clientX,
            clientY: event.clientY,
            pageX: event.pageX,
            pageY: event.pageY
        };
    }

    /** Creates the minimal event-like object PrimeNG needs to position a context menu. */
    private contextMenuShowEvent(event: {pageX: number; pageY: number}): {pageX: number; pageY: number; preventDefault: () => void; stopPropagation: () => void} {
        return {
            pageX: event.pageX,
            pageY: event.pageY,
            preventDefault: () => {},
            stopPropagation: () => {}
        };
    }

    /**
     * Derives source-data tile choices from the clicked world position and updates the menu service.
     * The preferred tile tries to match picked feature tiles first, then visible feature levels.
     */
    private prepareSourceDataContextMenu(contextPosition: PreparedContextMenuPosition | null): void {
        if (!this.mapView || this.appModeService.isVisualizationOnly) {
            this.resetPreparedSourceData(true);
            this.menuService.setTileDiagnosticsOptions([]);
            return;
        }

        if (!contextPosition) {
            this.resetPreparedSourceData(true);
            this.menuService.setTileDiagnosticsOptions([]);
            return;
        }
        const {featureIds, cartographic} = contextPosition;

        const tileIds = Array.from({length: MapViewComponent.SOURCE_DATA_TILE_LEVEL_COUNT}, (_, level) => {
            const tileId = coreLib.getTileIdFromPosition(cartographic.lon, cartographic.lat, level);
            return {
                id: tileId,
                name: `${tileId} (level ${level})`,
                tileLevel: level,
                disabled: this.mapService.findSourceDataMapsForTileId(tileId).length === 0
            };
        });
        const preferredPickedTileId = this.preferredPickedTileId(featureIds, tileIds);
        const preferredVisibleLevelTileId = this.preferredVisibleLevelTileId(tileIds);
        this.menuService.preferredTileIdForSourceData =
            preferredPickedTileId ??
            preferredVisibleLevelTileId;
        this.menuService.tileIdsForSourceData.next(tileIds);

        const outlinedTile = this.menuService.preferredSourceDataTile(tileIds);
        if (outlinedTile) {
            this.menuService.outlineTile(Number(outlinedTile.id));
        } else {
            this.menuService.tileOutline.next(null);
        }
        this.prepareTileDiagnosticsContextMenu(cartographic.lon, cartographic.lat);
    }

    /** Builds grouped tile diagnostics entries for enabled loaded feature layers at the clicked position. */
    private prepareTileDiagnosticsContextMenu(lon: number, lat: number): void {
        const viewIndex = this.viewIndex();
        const groupsByTileId = new Map<string, TileDiagnosticsMenuOption>();

        for (const layer of this.mapService.maps.allFeatureLayers()) {
            if (!this.mapService.maps.getMapLayerVisibility(viewIndex, layer.mapId, layer.id)) {
                continue;
            }

            const level = this.mapViewState.getEffectiveMapLayerLevel(viewIndex, layer.mapId, layer.id);
            const tileId = coreLib.getTileIdFromPosition(lon, lat, level);
            if (!this.mapViewState.showsFeatureTileInView(viewIndex, layer.mapId, layer.id, tileId)) {
                continue;
            }

            if (this.layerController?.occupancyForTile(
                tileId,
                [{mapId: layer.mapId, layerId: layer.id}]
            ) !== "non-empty") {
                continue;
            }

            const tileIdString = tileId.toString();
            const group = groupsByTileId.get(tileIdString);
            if (group) {
                group.layers.push({mapId: layer.mapId, layerId: layer.id});
                continue;
            }
            groupsByTileId.set(tileIdString, {
                tileId: tileIdString,
                level,
                layers: [{mapId: layer.mapId, layerId: layer.id}]
            });
        }

        const options = Array.from(groupsByTileId.values())
            .sort((left, right) => right.level - left.level || left.tileId.localeCompare(right.tileId));
        this.menuService.setTileDiagnosticsOptions(options);
    }

    /** Prepares a view-scoped feature-search action for the right-click menu. */
    private prepareFeatureSearchContextMenu(): void {
        if (!this.mapView || this.appModeService.isVisualizationOnly) {
            this.menuService.setFeatureSearchScope(null);
            return;
        }
        const viewIndex = this.viewIndex();
        this.menuService.setFeatureSearchScope({
            viewIndex,
            selectedMapLayers: this.featureSearchService.featureSearchLayersWithDataForView(viewIndex)
        });
    }

    /** Chooses the deepest available source-data tile among the features picked under the cursor. */
    private preferredPickedTileId(
        featureIds: TileFeatureId[],
        tileIds: SourceDataDropdownOption[]
    ): number | null {
        const availableTileIds = new Set(
            tileIds
                .filter(tileId => !tileId.disabled)
                .map(tileId => Number(tileId.id))
        );
        let bestTileId: number | null = null;
        for (const featureId of featureIds) {
            const [, , tileId] = coreLib.parseMapTileKey(featureId.mapTileKey) as [string, string, number];
            if (!availableTileIds.has(tileId)) {
                continue;
            }
            if (bestTileId === null || coreLib.getTileLevel(tileId) > coreLib.getTileLevel(bestTileId)) {
                bestTileId = tileId;
            }
        }
        return bestTileId;
    }

    /** Falls back to the deepest source-data tile whose level matches currently visible feature data. */
    private preferredVisibleLevelTileId(tileIds: SourceDataDropdownOption[]): number | null {
        const visibleLevels = this.mapViewState.visibleFeatureLevelsInView(this.viewIndex());
        const preferredTile = [...tileIds]
            .reverse()
            .find(tileId => !tileId.disabled && visibleLevels.has(tileId.tileLevel ?? -1));
        return preferredTile === undefined ? null : Number(preferredTile.id);
    }

    /** Clears the transient source-data context prepared for the right-click menu. */
    private resetPreparedSourceData(clearTileIds: boolean = false, clearOutline: boolean = true): void {
        this.menuService.preferredTileIdForSourceData = null;
        this.menuService.setFeatureSearchScope(null);
        this.menuService.setExternalViewerLocation(null);
        this.menuService.setFirstPersonViewContext(null);
        this.menuService.setPickedFeatures([]);
        if (clearOutline) {
            this.menuService.tileOutline.next(null);
        }
        if (clearTileIds) {
            this.menuService.tileIdsForSourceData.next([]);
            this.menuService.setTileDiagnosticsOptions([]);
        }
    }

    protected readonly environment = environment;
}
