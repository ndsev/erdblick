import {Injectable} from "@angular/core";
import {Cartesian2, Cartesian3, Color, HeightReference, BillboardCollection} from "../integrations/cesium";
import {AppStateService} from "../shared/appstate.service";
import {FeatureSearchService, SearchResultPrimitiveId} from "../search/feature.search.service";
import {SearchResultPosition} from "../search/search.worker";

interface MarkersParams {
    id?: SearchResultPrimitiveId;
    position: Cartesian3;
    image?: string;
    width: number;
    height: number;
    eyeOffset?: Cartesian3;
    pixelOffset?: Cartesian2;
    color?: Color;
    disableDepthTestDistance?: number;
    heightReference?: HeightReference;
}

@Injectable({providedIn: 'root'})
export class MarkerService {
    markerCollection: BillboardCollection | null = null;

    constructor(private featureSearchService: FeatureSearchService,
                private stateService: AppStateService) {
    }

    addMarker(cartesian: Cartesian3) {
        // Ensure collection and viewer exist
        if (!this.markerCollection || this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
            console.debug('Cannot add marker: MarkerCollection or viewer not initialized or is destroyed');
            return false;
        }

        // Clear any existing markers in the collection
        try {
            this.markerCollection.removeAll();
        } catch (e) {
            console.error('Error clearing markers:', e);
            return false;
        }

        // Add marker using the same approach as search results
        try {
            const params: MarkersParams = {
                position: cartesian,
                image: this.featureSearchService.markerGraphics(),
                width: 32,
                height: 32
            };
            if (this.viewStateService.is2DMode) {
                params.disableDepthTestDistance = Number.POSITIVE_INFINITY;
            } else {
                params.pixelOffset = new Cartesian2(0, -10);
                params.eyeOffset = new Cartesian3(0, 0, -50);
                params.heightReference = HeightReference.CLAMP_TO_GROUND;
            }

            this.markerCollection.add(params);

            // Ensure the marker collection is properly added to the scene
            if (this.viewStateService.isAvailable() && this.viewStateService.isNotDestroyed() &&
                this.viewStateService.viewer.scene.primitives) {
                if (!this.viewStateService.viewer.scene.primitives.contains(this.markerCollection)) {
                    this.viewStateService.viewer.scene.primitives.add(this.markerCollection);
                }
                this.viewStateService.viewer.scene.primitives.raiseToTop(this.markerCollection);
                this.viewStateService.viewer.scene.requestRender();
                console.debug('Focus marker added successfully');
            }
            return true;
        } catch (e) {
            console.error('Error adding marker:', e);
            return false;
        }
    }

    clearMarkers() {
        if (this.markerCollection) {
            try {
                this.markerCollection.removeAll();
                if (this.viewStateService.viewer && this.viewStateService.viewer.scene) {
                    this.viewStateService.viewer.scene.requestRender();
                }
            } catch (e) {
                console.error('Error clearing markers:', e);
            }
        }
    }

    renderFeatureSearchResultTree(level: number) {
        try {
            if (this.viewStateService.isUnavailable() || this.viewStateService.isDestroyed()) {
                console.debug('Cannot render feature search results: viewer not initialized or is destroyed');
                return;
            }

            this.featureSearchService.visualization.removeAll();
            const color = Color.fromCssColorString(this.featureSearchService.pointColor);
            let markers: Array<[SearchResultPrimitiveId, SearchResultPosition]> = [];

            // Use the level parameter directly - backend now receives correct viewport coordinates
            const nodes = this.featureSearchService.resultTree.getNodesAtLevel(level);

            for (const node of nodes) {
                if (node.markers.length) {
                    markers.push(...node.markers);
                } else if (node.count > 0 && node.center) {
                    // For cluster centers, always use the center position directly
                    // The backend coordinates are now correctly aligned with the projection
                    const params: MarkersParams = {
                        position: node.center,
                        image: this.featureSearchService.getPinGraphics(node.count),
                        width: 64,
                        height: 64
                    };
                    if (this.viewStateService.is2DMode) {
                        params.disableDepthTestDistance = Number.POSITIVE_INFINITY;
                    } else {
                        params.eyeOffset = new Cartesian3(0, 0, -50);
                    }
                    this.featureSearchService.visualization.add(params);
                }
            }

            if (markers.length) {
                markers.forEach(marker => {
                    // Always use cartographicRad if available, otherwise fall back to cartesian
                    // This ensures consistent positioning across projections
                    let markerPosition: Cartesian3;
                    if (marker[1].cartographicRad) {
                        markerPosition = Cartesian3.fromRadians(
                            marker[1].cartographicRad.longitude,
                            marker[1].cartographicRad.latitude,
                            marker[1].cartographicRad.height
                        );
                    } else {
                        markerPosition = marker[1].cartesian as Cartesian3;
                    }

                    const params: MarkersParams = {
                        id: marker[0],
                        position: markerPosition,
                        image: this.featureSearchService.markerGraphics(),
                        width: 32,
                        height: 32,
                        color: color
                    };
                    if (this.viewStateService.is2DMode) {
                        params.disableDepthTestDistance = Number.POSITIVE_INFINITY;
                    } else {
                        params.pixelOffset = new Cartesian2(0, -10);
                        params.eyeOffset = new Cartesian3(0, 0, -50);
                    }
                    this.featureSearchService.visualization.add(params);
                });
            }

            if (this.viewStateService.isAvailable() && this.viewStateService.isNotDestroyed() &&
                this.viewStateService.viewer.scene.primitives) {
                this.viewStateService.viewer.scene.primitives.raiseToTop(this.featureSearchService.visualization);
            }
        } catch (error) {
            console.error('Error rendering feature search result tree:', error);
        }
    }

    /**
     * Restore markers based on current parameters
     * This handles the case where parameter subscriptions fired before markerCollection was ready
     */
    restoreParameterMarker() {
        try {
            const markerEnabled = this.stateService.markerState.getValue();
            const markedPosition = this.stateService.markedPositionState.getValue();
            if (markerEnabled && markedPosition.length === 2) {
                const markerPosition = Cartesian3.fromDegrees(
                    Number(markedPosition[0]),
                    Number(markedPosition[1])
                );
                const success = this.addMarker(markerPosition);
                if (success) {
                    console.debug('Parameter-driven focus marker restored after viewer reinitialization');
                } else {
                    console.debug('Failed to restore parameter-driven focus marker');
                }
            }
        } catch (error) {
            console.error('Error restoring parameter markers:', error);
        }
    }
}
