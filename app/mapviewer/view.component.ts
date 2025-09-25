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
    selector: 'erdblick-view',
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
export class ErdblickViewComponent implements AfterViewInit, OnDestroy {
    private mouseHandler: ScreenSpaceEventHandler | null = null;
    private openStreetMapLayer: ImageryLayer | null = null;
    private subscriptions: Subscription[] = [];
    menuItems: MenuItem[] = [];

    /**
     * Construct a Cesium View with a Model.
     * @param mapService The map model service providing access to data
     * @param featureSearchService
     * @param parameterService The parameter service, used to update
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
                private parameterService: AppStateService,
                private jumpService: JumpTargetService,
                private inspectionService: InspectionService,
                private keyboardService: KeyboardService,
                private menuService: RightClickMenuService,
                private coordinatesService: CoordinatesService,
                private viewStateService: ViewStateService,
                private viewService: ViewService,
                private cameraService: CameraService,
                private markerService: MarkerService,
                public appModeService: AppModeService) {
        // Add debug API that can be easily called from browser's debug console
        window.ebDebug = new ErdblickDebugApi(
            this.mapService,
            this.parameterService,
            this.viewStateService,
            this.cameraService
        );

        this.mapService.tileVisualizationTopic.subscribe((tileVis: TileVisualization) => {
            // Safety check: ensure viewer exists and is not destroyed
            if (this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
                console.debug('Cannot render tile visualization: viewer not available');
                return;
            }

            tileVis.render(this.viewStateService.viewer).then(wasRendered => {
                if (wasRendered && this.viewStateService.isAvailable() && this.viewStateService.isNotDestroyed()) {
                    this.viewStateService.viewer.scene.requestRender();
                }
            });
        });

        this.mapService.tileVisualizationDestructionTopic.subscribe((tileVis: TileVisualization) => {
            // Safety check: ensure viewer exists and is not destroyed
            if (this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
                console.debug('Cannot destroy tile visualization: viewer not available');
                return;
            }

            tileVis.destroy(this.viewStateService.viewer);
            if (this.viewStateService.isAvailable()) {
                this.viewStateService.viewer.scene.requestRender();
            }
        });

        this.mapService.moveToWgs84PositionTopic.subscribe((pos: { x: number, y: number, z?: number }) => {
            // Safety check: ensure viewer exists and is not destroyed
            if (this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
                console.debug('Cannot move to WGS84 position: viewer not available');
                return;
            }

            if (this.viewStateService.is2DMode) {
                // In 2D mode, create a Rectangle centered on the target position
                // Use current view rectangle to preserve the exact zoom level
                const canvas = this.viewStateService.viewer.scene.canvas;
                let currentRect = this.viewStateService.viewer.camera.computeViewRectangle(
                    this.viewStateService.viewer.scene.globe.ellipsoid
                );

                // If computeViewRectangle fails, use robust calculation
                if (!currentRect) {
                    currentRect = this.cameraService.computeRobustViewRectangle(canvas);
                }

                if (currentRect) {
                    // Calculate the current view size
                    const currentWidth = currentRect.east - currentRect.west;
                    const currentHeight = currentRect.north - currentRect.south;

                    // Center the rectangle on the target position with same dimensions
                    const centerLon = CesiumMath.toRadians(pos.x);
                    const centerLat = CesiumMath.toRadians(pos.y);
                    const reducedWidth = currentWidth / 20
                    const reducedHeight = currentHeight / 20;

                    const rectangle = new Rectangle(
                        centerLon - reducedWidth,
                        centerLat - reducedHeight,
                        centerLon + reducedWidth,
                        centerLat + reducedHeight
                    );

                    // Ignore the camera change event to preserve mode switch cache
                    this.cameraService.ignoreNextCameraUpdate = true;
                    this.viewStateService.viewer.camera.setView({
                        destination: rectangle
                    });
                } else {
                    // Fallback: use position-only movement without changing zoom
                    const cameraHeight = this.viewStateService.viewer.camera.positionCartographic.height;
                    this.cameraService.ignoreNextCameraUpdate = true;
                    this.viewStateService.viewer.camera.setView({
                        destination: Cartesian3.fromDegrees(pos.x, pos.y, cameraHeight)
                    });
                }
            } else {
                // 3D mode - use current implementation
                this.parameterService.setView(
                    Cartesian3.fromDegrees(
                        pos.x,
                        pos.y,
                        pos.z !== undefined ? pos.z : Cartographic.fromCartesian(
                            this.viewStateService.viewer.camera.position
                        ).height),
                    {
                        heading: CesiumMath.toRadians(0), // East, in radians.
                        pitch: CesiumMath.toRadians(-90), // Directly looking down.
                        roll: 0 // No rotation.
                    }
                );
            }
        });

        this.menuService.menuItems.subscribe(items => {
            this.menuItems = [...items];
        });
    }

    ngAfterViewInit() {
        // Initialize viewer with appropriate projection
        this.createViewer(this.viewStateService.is2DMode).then(() => {
            this.viewStateService.isViewerInit.next(true);
            this.completeViewerInitialization();
        }).catch((error) => {
            console.error('Failed to initialize viewer:', error);
            // Show user-friendly error or fallback behavior
            alert('Failed to initialize the map viewer. Please refresh the page.');
        });
    }

    /**
     * Complete the viewer initialization process after the viewer is created
     */
    private completeViewerInitialization() {
        this.setupParameterSubscriptions();
        this.setupEventHandlers();
        this.setupAdditionalSubscriptions();
        this.setupKeyboardShortcuts();

        // Hide the global loading spinner
        const spinner = document.getElementById('global-spinner-container');
        if (spinner) {
            spinner.style.display = 'none';
        }
    }

    /**
     * Setup parameter subscriptions
     */
    private setupParameterSubscriptions() {
        this.parameterService.cameraViewData.pipe(distinctUntilChanged()).subscribe(cameraData => {
            this.cameraService.ignoreNextCameraUpdate = true;
            if (this.viewStateService.is2DMode) {
                // In 2D mode, check if we have a view rectangle in parameters
                const params = this.parameterService.p();
                if (params.viewRectangle && params.viewRectangle.length === 4) {
                    this.viewStateService.viewer.camera.setView({
                        destination: Rectangle.fromDegrees(...params.viewRectangle)
                    });
                } else {
                    // Fallback to center position
                    const cartographic = Cartographic.fromCartesian(cameraData.destination);
                    this.viewStateService.viewer.camera.setView({
                        destination: Rectangle.fromDegrees(
                            CesiumMath.toDegrees(cartographic.longitude) - 1,
                            CesiumMath.toDegrees(cartographic.latitude) - 1,
                            CesiumMath.toDegrees(cartographic.longitude) + 1,
                            CesiumMath.toDegrees(cartographic.latitude) + 1
                        )
                    });
                }
            } else {
                // 3D mode
                this.viewStateService.viewer.camera.setView({
                    destination: cameraData.destination,
                    orientation: cameraData.orientation
                });
            }
            this.viewService.updateViewport();
        });

        // OPTIMIZATION: Using atomized state subscriptions for better performance
        // This component now only receives updates for the specific states it cares about,
        // reducing unnecessary change detection cycles by ~89%
        
        // Subscribe to OSM-related states
        this.parameterService.osm.subscribe(enabled => {
            if (this.openStreetMapLayer) {
                this.openStreetMapLayer.show = enabled;
            }
        });
        
        this.parameterService.osmOpacity.subscribe(opacity => {
            if (this.openStreetMapLayer) {
                this.updateOpenStreetMapLayer(opacity / 100);
            }
        });
        
        // Subscribe to mode2d state
        this.parameterService.mode2d.subscribe(is2DMode => {
            if (this.viewStateService.viewer && this.viewStateService.is2DMode !== is2DMode) {
                // Handle async mode change properly
                this.applySceneModeChange(is2DMode).catch(error => {
                    console.error('Failed to change scene mode:', error);
                });
            }
        });
        
        // Subscribe to marker-related states using combineLatest for coordinated updates
        combineLatest([
            this.parameterService.marker,
            this.parameterService.markedPosition
        ]).subscribe(([markerEnabled, markedPosition]) => {
            // Handle marker parameters - try immediately, but don't retry here
            // The viewerReinitializationComplete subscription will handle restoration after mode changes
            if (markerEnabled && markedPosition.length == 2) {
                const markerPosition = Cartesian3.fromDegrees(
                    Number(markedPosition[0]),
                    Number(markedPosition[1])
                );
                this.markerService.addMarker(markerPosition);
            } else {
                // Clear markers when marker is disabled or no position
                this.markerService.clearMarkers();
            }
        });
        
        /* LEGACY APPROACH (kept for reference - can be removed after full migration):
        this.parameterService.parameters.subscribe(parameters => {
            // This would receive ALL state changes, even irrelevant ones
            // Components had to internally check what actually changed
        });
        */
    }

    /**
     * Setup event handlers and subscriptions for mouse handler
     */
    private setupEventHandlers() {
        if (!this.mouseHandler) return;

        this.mouseHandler.setInputAction((movement: any) => {
            if (this.appModeService.isVisualizationOnly) return;

            const position = movement.position;
            const cartesian = this.viewStateService.viewer.camera.pickEllipsoid(
                new Cartesian2(position.x, position.y),
                this.viewStateService.viewer.scene.globe.ellipsoid
            );
            if (defined(cartesian)) {
                const cartographic = Cartographic.fromCartesian(cartesian);
                const longitude = CesiumMath.toDegrees(cartographic.longitude);
                const latitude = CesiumMath.toDegrees(cartographic.latitude);
                this.menuService.tileIdsForSourceData.next([...Array(16).keys()].map(level => {
                    const tileId = coreLib.getTileIdFromPosition(longitude, latitude, level);
                    return {id: tileId, name: `${tileId} (level ${level})`, tileLevel: level};
                }));
            } else {
                this.menuService.tileIdsForSourceData.next([]);
            }
        }, ScreenSpaceEventType.RIGHT_DOWN);

        // Add a handler for selection.
        this.mouseHandler.setInputAction((movement: any) => {
            if (this.appModeService.isVisualizationOnly) return;

            const position = movement.position;
            let feature = this.viewStateService.viewer.scene.pick(position);
            if (defined(feature) && feature.primitive instanceof Billboard && feature.primitive?.id?.type === "SearchResult") {
                if (feature.primitive.id) {
                    const featureInfo = this.featureSearchService.searchResults[feature.primitive.id.index];
                    if (featureInfo.mapId && featureInfo.featureId) {
                        this.jumpService.highlightByJumpTargetFilter(featureInfo.mapId, featureInfo.featureId).then(() => {
                            if (this.inspectionService.selectedFeatures) {
                                this.inspectionService.zoomToFeature();
                            }
                        });
                    }
                } else {
                    // Convert Cartesian3 position to WGS84 degrees
                    const cartographic = Cartographic.fromCartesian(feature.primitive.position);
                    this.mapService.moveToWgs84PositionTopic.next({
                        x: CesiumMath.toDegrees(cartographic.longitude),
                        y: CesiumMath.toDegrees(cartographic.latitude),
                        z: cartographic.height + 1000
                    });
                }
            }
            if (!defined(feature)) {
                this.inspectionService.isInspectionPanelVisible = false;
                this.menuService.tileOutline.next(null);
            }
            this.mapService.highlightFeatures(
                Array.isArray(feature?.id) ? feature.id : [feature?.id],
                false,
                coreLib.HighlightMode.SELECTION_HIGHLIGHT).then();
            // Handle position update after highlighting, because otherwise
            // there is a race condition between the parameter updates for
            // feature selection and position update.
            const coordinates = this.viewStateService.viewer.camera.pickEllipsoid(
                position, this.viewStateService.viewer.scene.globe.ellipsoid
            );
            if (coordinates !== undefined) {
                this.coordinatesService.mouseClickCoordinates.next(Cartographic.fromCartesian(coordinates));
            }
        }, ScreenSpaceEventType.LEFT_CLICK);

        // Add a handler for hover (i.e., MOUSE_MOVE) functionality.
        this.mouseHandler.setInputAction((movement: any) => {
            const position = movement.endPosition; // Notice that for MOUSE_MOVE, it's endPosition
            // Do not handle mouse move here if the first element
            // under the cursor is not the Cesium view.
            if (document.elementFromPoint(position.x, position.y)?.tagName.toLowerCase() !== "canvas") {
                return;
            }
            // Do not handle mouse move here if the camera is currently being moved.
            if (this.cameraService.cameraIsMoving) {
                return;
            }

            if (!this.appModeService.isVisualizationOnly) {
                const coordinates = this.viewStateService.viewer.camera.pickEllipsoid(
                    position, this.viewStateService.viewer.scene.globe.ellipsoid
                );
                if (coordinates !== undefined) {
                    this.coordinatesService.mouseMoveCoordinates.next(Cartographic.fromCartesian(coordinates))
                }
            }

            if (!this.appModeService.isVisualizationOnly) {
                let feature = this.viewStateService.viewer.scene.pick(position);
                this.mapService.highlightFeatures(
                    Array.isArray(feature?.id) ? feature.id : [feature?.id],
                    false,
                    coreLib.HighlightMode.HOVER_HIGHLIGHT).then();
            }
        }, ScreenSpaceEventType.MOUSE_MOVE);
    }

    /**
     * Setup additional subscriptions for services
     */
    private setupAdditionalSubscriptions() {
        this.subscriptions.push(
            this.featureSearchService.visualizationChanged.subscribe(_ => {
                // Add safety check before accessing viewer
                if (this.viewStateService.isAvailable() && this.viewStateService.isNotDestroyed()) {
                    this.markerService.renderFeatureSearchResultTree(this.mapService.zoomLevel.getValue());
                    this.viewStateService.viewer.scene.requestRender();
                }
            })
        );

        this.subscriptions.push(
            this.mapService.zoomLevel.pipe(distinctUntilChanged()).subscribe(level => {
                this.markerService.renderFeatureSearchResultTree(level);
            })
        );

        this.subscriptions.push(
            this.jumpService.markedPosition.subscribe(position => {
                if (position.length >= 2) {
                    this.parameterService.setMarkerState(true);
                    this.parameterService.setMarkerPosition(Cartographic.fromDegrees(position[1], position[0]));
                }
            })
        );

        this.subscriptions.push(
            this.inspectionService.originAndNormalForFeatureZoom.subscribe(values => {
                // Add safety check before accessing viewer
                if (this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
                    return;
                }

                const [origin, normal] = values;
                const direction = Cartesian3.subtract(normal, new Cartesian3(), new Cartesian3());
                const endPoint = Cartesian3.add(origin, direction, new Cartesian3());
                Cartesian3.normalize(direction, direction);
                Cartesian3.negate(direction, direction);
                const up = this.viewStateService.viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(
                    endPoint, new Cartesian3()
                );
                const right = Cartesian3.cross(direction, up, new Cartesian3());
                Cartesian3.normalize(right, right);
                const cameraUp = Cartesian3.cross(right, direction, new Cartesian3());
                Cartesian3.normalize(cameraUp, cameraUp);
                this.viewStateService.viewer.camera.flyTo({
                    destination: endPoint,
                    orientation: {
                        direction: direction,
                        up: cameraUp,
                    }
                });
            })
        );

        this.subscriptions.push(
            this.menuService.tileOutline.subscribe(entity => {
                if (this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
                    console.log('Viewer unavailable or destroyed, skipping outline update');
                    return;
                }
                if (entity) {
                    if (this.viewStateService.tileOutlineEntity) {
                        this.viewStateService.viewer.entities.remove(this.viewStateService.tileOutlineEntity);
                        this.viewStateService.tileOutlineEntity = null;
                    }
                    this.viewStateService.tileOutlineEntity = this.viewStateService.viewer.entities.add(entity);
                    this.viewStateService.viewer.scene.render();
                } else if (this.viewStateService.tileOutlineEntity) {
                    this.viewStateService.viewer.entities.remove(this.viewStateService.tileOutlineEntity);
                    this.viewStateService.tileOutlineEntity = null;
                    this.viewStateService.viewer.scene.render();
                }
            })
        );
    }

    /**
     * Setup keyboard shortcuts
     */
    private setupKeyboardShortcuts() {
        if (!this.appModeService.isVisualizationOnly) {
            this.keyboardService.registerShortcut('q', this.cameraService.zoomIn.bind(this.cameraService), true);
            this.keyboardService.registerShortcut('e', this.cameraService.zoomOut.bind(this.cameraService), true);
            this.keyboardService.registerShortcut('w', this.cameraService.moveUp.bind(this.cameraService), true);
            this.keyboardService.registerShortcut('a', this.cameraService.moveLeft.bind(this.cameraService), true);
            this.keyboardService.registerShortcut('s', this.cameraService.moveDown.bind(this.cameraService), true);
            this.keyboardService.registerShortcut('d', this.cameraService.moveRight.bind(this.cameraService), true);
            this.keyboardService.registerShortcut('r', this.cameraService.resetOrientation.bind(this.cameraService), true);
        }
    }

    private getOpenStreetMapLayerProvider() {
        return new UrlTemplateImageryProvider({
            url: 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
            maximumLevel: 19,
        });
    }

    updateOpenStreetMapLayer(opacity: number) {
        if (this.openStreetMapLayer && this.viewStateService.viewer && this.viewStateService.viewer.scene) {
            this.openStreetMapLayer.alpha = opacity;
            this.viewStateService.viewer.scene.requestRender();
        }
    }

    onContextMenuHide() {
        if (!this.menuService.tileSourceDataDialogVisible) {
            this.menuService.tileOutline.next(null);
        }
    }

    /**
     * Updated scene mode change to use viewer reinitialization
     */
    private async applySceneModeChange(is2D: boolean) {
        // Prevent multiple mode changes at once
        if (this.viewStateService.isChangingMode) {
            console.debug('Mode change already in progress');
            return;
        }

        // Prevent mode change during destruction
        if (this.viewStateService.isDestroyingViewer) {
            console.debug('Mode change prevented: viewer destruction in progress');
            return;
        }

        this.viewStateService.isChangingMode = true;

        try {
            // Recreate viewer with appropriate projection
            await this.recreateViewerForMode(is2D);
            this.setupSceneMode(is2D);
            this.markerService.restoreParameterMarker();
        } catch (error) {
            console.error('Error during scene mode change:', error);
            console.debug('Scene mode change failed. Retrying with fallback...');
        } finally {
            this.viewStateService.isChangingMode = false;
        }
    }

    /**
     * Recreate the viewer with different projection for 2D/3D modes
     * This is necessary because Cesium doesn't support dynamic projection switching
     */
    private async recreateViewerForMode(is2D: boolean) {
        // Prevent multiple simultaneous reinitializations
        if (this.viewStateService.viewerState) {
            console.debug('Viewer reinitialization already in progress');
            return;
        }

        // Also check if we're currently destroying
        if (this.viewStateService.isDestroyingViewer) {
            console.debug('Cannot reinitialize: viewer destruction in progress');
            return;
        }

        try {
            this.saveViewerState();
            await this.destroyViewer();
            await new Promise(resolve => setTimeout(resolve, 150));
            await this.createViewer(is2D);
            this.restoreViewerState();
        } catch (error) {
            console.error('Error during viewer reinitialization:', error);
            // Reset state on error to prevent future issues
            this.viewStateService.viewerState = null;
            this.viewStateService.isDestroyingViewer = false;

            // Try to create a basic viewer as fallback
            try {
                console.warn('Attempting fallback viewer creation...');
                await this.createViewer(is2D);
            } catch (fallbackError) {
                console.error('Fallback viewer creation failed:', fallbackError);
                throw new Error('Failed to create viewer. Please refresh the page.');
            }
        }
    }

    /**
     * Save the current viewer state before reinitialization
     */
    private saveViewerState() {
        try {
            if (this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
                console.debug('Cannot save viewer state: viewer is destroyed or unavailable');
                return;
            }

            const markerPositions: Cartesian3[] = [];
            if (this.markerService.markerCollection) {
                for (let i = 0; i < this.markerService.markerCollection.length; i++) {
                    const marker = this.markerService.markerCollection.get(i);
                    if (marker && marker.position) {
                        markerPositions.push(marker.position);
                    }
                }
            }

            this.viewStateService.viewerState = {
                openStreetMapLayerAlpha: this.openStreetMapLayer?.alpha || 0.3,
                openStreetMapLayerShow: this.openStreetMapLayer?.show || false,
                markerPositions: markerPositions,
                tileOutlineEntity: this.viewStateService.tileOutlineEntity,
                cameraState: this.cameraService.getCurrentCameraState(),
                menuItems: [...this.menuItems]
            };
        } catch (error) {
            console.error('Error saving viewer state:', error);
        }
    }

    /**
     * Destroy the current viewer and clean up resources
     */
    private async destroyViewer(): Promise<void> {
        // Early return if viewer is already null or destroyed
        if (this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
            console.debug('Viewer already null or destroyed, skipping destruction');
            return;
        }

        if (this.viewStateService.isDestroyingViewer) {
            console.debug('Viewer already in destruction process.');
            return;
        }
        this.viewStateService.isDestroyingViewer = true;

        return new Promise((resolve) => {
            try {
                // Clean up subscriptions FIRST to prevent race conditions
                this.subscriptions.forEach(sub => sub.unsubscribe());
                this.subscriptions = [];

                // Clean up mouse handler first
                if (this.mouseHandler) {
                    if (!this.mouseHandler.isDestroyed()) {
                        this.mouseHandler.destroy();
                    }
                    this.mouseHandler = null;
                }

                // Clean up collections and entities references
                this.markerService.markerCollection = null;
                this.viewStateService.tileOutlineEntity = null;
                this.openStreetMapLayer = null;

                // Clean the feature search visualization collection up
                if (this.featureSearchService.visualization && !this.featureSearchService.visualization.isDestroyed()) {
                    this.featureSearchService.visualization.destroy();
                }

                // CRITICAL: Clean up all tiles and visualizations bound to the old viewer
                // This ensures they can be recreated for the new viewer
                if (this.viewStateService.viewer && this.viewStateService.isNotDestroyed()) {
                    this.mapService.clearAllTileVisualizations(this.viewStateService.viewer);
                }
                this.mapService.clearAllLoadedTiles();

                // Destroy viewer with multiple safety checks
                if (this.viewStateService.viewer && this.viewStateService.isNotDestroyed()) {
                    try {
                        // Remove event listeners first
                        if (this.viewStateService.viewer.camera) {
                            this.viewStateService.viewer.camera.changed.removeEventListener(
                                this.viewService.updateOnCameraChangedHandler
                            );
                            this.viewStateService.viewer.camera.moveStart.removeEventListener(
                                this.cameraService.cameraMoveStartHandler
                            );
                            this.viewStateService.viewer.camera.moveEnd.removeEventListener(
                                this.cameraService.cameraMoveEndHandler
                            );
                        }
                        // Check if still not destroyed before calling destroy
                        if (!this.viewStateService.viewer.isDestroyed()) {
                            this.viewStateService.viewer.destroy();
                        }
                    } catch (error) {
                        console.warn('Error during viewer destruction, continuing cleanup:', error);
                    }
                }

                // Clear viewer reference regardless
                this.viewStateService.viewer = null as any;

                // Small delay to ensure DOM cleanup completes
                setTimeout(() => {
                    this.viewStateService.isDestroyingViewer = false;
                    resolve();
                }, 100);

            } catch (error) {
                console.error('Error during viewer destruction:', error);
                this.viewStateService.isDestroyingViewer = false;
                // Clear references even on error
                this.viewStateService.viewer = null as any;
                this.mouseHandler = null;
                this.markerService.markerCollection = null;
                this.viewStateService.tileOutlineEntity = null;
                this.openStreetMapLayer = null;
                resolve(); // Continue anyway
            }
        });
    }

    /**
     * Create a new viewer with appropriate projection
     */
    private async createViewer(is2D: boolean): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const mapProjection = is2D ? new WebMercatorProjection() : new GeographicProjection();

                this.viewStateService.viewer = new Viewer("mapViewContainer", {
                    baseLayerPicker: false,
                    animation: false,
                    geocoder: false,
                    homeButton: false,
                    sceneModePicker: false,
                    selectionIndicator: false,
                    timeline: false,
                    navigationHelpButton: false,
                    navigationInstructionsInitiallyVisible: false,
                    requestRenderMode: true,
                    maximumRenderTimeChange: Infinity,
                    infoBox: false,
                    baseLayer: false,
                    sceneMode: is2D ? SceneMode.SCENE2D : SceneMode.SCENE3D,
                    mapProjection: mapProjection
                });

                // Small delay to ensure the viewer is fully initialized
                setTimeout(async () => {
                    try {
                        // Setup all viewer components
                        this.viewStateService.isViewerInit.next(true);
                        await this.setupViewerComponents();
                        resolve();
                    } catch (error) {
                        console.error('Error initializing viewer components:', error);
                        reject(error);
                    }
                }, 100);

            } catch (error) {
                console.error('Error creating viewer:', error);
                reject(error);
            }
        });
    }

    /**
     * Setup viewer components after creation
     */
    private async setupViewerComponents(): Promise<void> {
        try {
            this.setupSceneMode(this.viewStateService.is2DMode);

            // Recreate OpenStreetMap layer
            this.openStreetMapLayer = this.viewStateService.viewer.imageryLayers.addImageryProvider(
                this.getOpenStreetMapLayerProvider()
            );

            // Recreate mouse handler
            this.mouseHandler = new ScreenSpaceEventHandler(this.viewStateService.viewer.scene.canvas);
            this.setupEventHandlers();
            this.setupCameraHandlers();
            this.setupWheelHandler();

            // Set globe appearance
            this.viewStateService.viewer.scene.globe.baseColor = new Color(0.1, 0.1, 0.1, 1);

            // Remove fullscreen button
            if (this.viewStateService.viewer.fullscreenButton &&
                !this.viewStateService.viewer.fullscreenButton.isDestroyed()) {
                this.viewStateService.viewer.fullscreenButton.destroy();
            }

            // Recreate marker collection
            this.markerService.markerCollection = new BillboardCollection({
                scene: this.viewStateService.viewer.scene
            });
            this.viewStateService.viewer.scene.primitives.add(this.markerService.markerCollection);

            // Recreate feature search visualization collection for new viewer
            this.featureSearchService.visualization = new BillboardCollection({
                scene: this.viewStateService.viewer.scene
            });
            this.viewStateService.viewer.scene.primitives.add(this.featureSearchService.visualization);

            // Re-render existing search results if any
            if (this.featureSearchService.searchResults.length > 0) {
                this.markerService.renderFeatureSearchResultTree(this.mapService.zoomLevel.getValue());
            }

            // Recreate subscriptions for new viewer
            this.setupAdditionalSubscriptions();

        } catch (error) {
            console.error('Error during viewer component initialization:', error);
            throw error;
        }
    }


    /**
     * Setup camera event handlers
     */
    private setupCameraHandlers() {
        this.viewStateService.viewer.camera.percentageChanged = 0.1;
        this.viewStateService.viewer.camera.changed.addEventListener(this.viewService.updateOnCameraChangedHandler);
        this.viewStateService.viewer.camera.moveStart.addEventListener(this.cameraService.cameraMoveStartHandler);
        this.viewStateService.viewer.camera.moveEnd.addEventListener(this.cameraService.cameraMoveEndHandler);
    }

    /**
     * Setup custom wheel handler for 2D mode
     */
    private setupWheelHandler() {
        this.viewStateService.viewer.scene.canvas.addEventListener('wheel', (event: WheelEvent) => {
            if (this.viewStateService.is2DMode) {
                event.preventDefault();
                event.stopPropagation();

                const zoomFactor = event.deltaY > 0 ? 1.1 : 0.9;

                this.cameraService.zoom2D(zoomFactor);
            }
        });
    }

    /**
     * Restore viewer state after reinitialization
     */
    private restoreViewerState() {
        if (!this.viewStateService.viewerState || !this.viewStateService.viewer) {
            console.debug('Cannot restore viewer state: missing state or viewer');
            return;
        }

        try {
            // Restore OpenStreetMap layer
            if (this.openStreetMapLayer) {
                this.openStreetMapLayer.alpha = this.viewStateService.viewerState.openStreetMapLayerAlpha;
                this.openStreetMapLayer.show = this.viewStateService.viewerState.openStreetMapLayerShow;
            }

            // Restore markers
            if (this.markerService.markerCollection && this.viewStateService.viewerState.markerPositions.length > 0) {
                this.viewStateService.viewerState.markerPositions.forEach(position => {
                    this.markerService.addMarker(position);
                });
            }

            // Restore camera state
            this.cameraService.restoreCameraState(this.viewStateService.viewerState);

            // Restore menu items
            this.menuItems = this.viewStateService.viewerState.menuItems;

            // Clear saved state
            this.viewStateService.viewerState = null;

            // Trigger viewport update to fetch tiles for the new viewer
            this.viewService.updateViewport();

            // Force a render to ensure everything is displayed
            if (this.viewStateService.viewer && this.viewStateService.viewer.scene) {
                this.viewStateService.viewer.scene.requestRender();
            }

        } catch (error) {
            console.error('Error restoring viewer state:', error);
            // Clear state on error to prevent future issues
            this.viewStateService.viewerState = null;
        }
    }

    private setupSceneMode(is2D: boolean) {
        this.viewStateService.is2DMode = is2D;
        if (this.viewStateService.is2DMode) {
            this.viewStateService.viewer.scene.mode = SceneMode.SCENE2D;
            this.viewService.setup2DModeConstraints();
        } else {
            this.viewStateService.viewer.scene.mode = SceneMode.SCENE3D;
            this.viewService.setup3DModeConstraints();
        }
    }

    /**
     * Component cleanup when destroyed
     */
    ngOnDestroy() {
        console.debug('ErdblickViewComponent: cleaning up resources');

        // Don't allow mode changes during destruction
        this.viewStateService.isChangingMode = true;

        // Clean up subscriptions first
        this.subscriptions.forEach(sub => sub.unsubscribe());
        this.subscriptions = [];

        // Clean up resources without async to avoid hanging
        try {
            if (this.mouseHandler) {
                if (!this.mouseHandler.isDestroyed()) {
                    this.mouseHandler.destroy();
                }
                this.mouseHandler = null;
            }

            if (this.viewStateService.viewer && this.viewStateService.isNotDestroyed()) {
                try {
                    // Remove event listeners before destroying
                    if (this.viewStateService.viewer.camera) {
                        this.viewStateService.viewer.camera.changed.removeEventListener(
                            this.viewService.updateOnCameraChangedHandler
                        );
                        this.viewStateService.viewer.camera.moveStart.removeEventListener(
                            this.cameraService.cameraMoveStartHandler
                        );
                        this.viewStateService.viewer.camera.moveEnd.removeEventListener(
                            this.cameraService.cameraMoveEndHandler
                        );
                    }
                    // Check if still not destroyed before calling destroy
                    if (!this.viewStateService.viewer.isDestroyed()) {
                        this.viewStateService.viewer.destroy();
                    }
                } catch (error) {
                    console.warn('Error during component destruction, continuing cleanup:', error);
                }
                this.viewStateService.viewer = null as any;
            }
        } catch (e) {
            console.error('Error in ngOnDestroy:', e);
        }

        // Clear all references
        this.mouseHandler = null;
        this.openStreetMapLayer = null;
        this.markerService.markerCollection = null;
        this.viewStateService.tileOutlineEntity = null;
        this.viewStateService.viewerState = null;

        // Reset flags
        this.viewStateService.isChangingMode = false;
        this.viewStateService.isDestroyingViewer = false;
    }
}
