import {
    MapController,
    WebMercatorViewport
} from "@deck.gl/core";
import {longitudeInNearestWorld} from "./deck-camera-navigation";

export type NavigationPivot = [
    longitude: number,
    latitude: number,
    altitude: number
];

export type NavigationPivotProvider = (
    screenPosition: [x: number, y: number]
) => NavigationPivot | null;

export type RetainedNavigationPivotProvider = () => NavigationPivot | null;

export type NavigationPivotChangeHandler = (
    pivot: NavigationPivot | null,
    active: boolean
) => void;

export type PivotMapControllerProps =
    Parameters<MapController["setProps"]>[0] & {
        getNavigationPivot?: NavigationPivotProvider;
        getRetainedNavigationPivot?: RetainedNavigationPivotProvider;
        onNavigationPivotChange?: NavigationPivotChangeHandler;
    };

type NavigationOperation = "pan" | "rotate" | "zoom";
type MapControllerState = MapController["controllerState"];

/** Resolves a physical pivot into the repeated-world copy local to a viewport. */
function pivotInViewportWorld(
    pivot: NavigationPivot,
    viewport: WebMercatorViewport
): NavigationPivot {
    return [
        longitudeInNearestWorld(pivot[0], viewport.longitude),
        pivot[1],
        pivot[2]
    ];
}

/**
 * A geospatial map controller that keeps picked 3D positions under the pointer
 * while panning, zooming, and rotating.
 */
export class PivotMapController extends MapController {
    private static readonly DISCRETE_ZOOM_RELEASE_MS = 150;
    private getNavigationPivot?: NavigationPivotProvider;
    private getRetainedNavigationPivot?: RetainedNavigationPivotProvider;
    private onNavigationPivotChange?: NavigationPivotChangeHandler;
    private discreteZoomPivot: NavigationPivot | null = null;
    private discreteZoomReleaseTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Installs a MapState specialization while retaining deck.gl's MapController
     * event handling, transitions, constraints, and rotation calculations.
     */
    constructor(...args: ConstructorParameters<typeof MapController>) {
        super(...args);

        const BaseMapState = this.ControllerState;
        const activeOperations = new Set<NavigationOperation>();
        let lockedPivot: NavigationPivot | null = null;

        /**
         * Resolves a pivot through the callbacks currently supplied in props.
         */
        const resolveNavigationPivot = (
            position: [number, number]
        ): NavigationPivot | null => this.resolveNavigationPivot(position);

        /**
         * Reports a pivot through the callbacks currently supplied in props.
         */
        const emitNavigationPivot = (
            pivot: NavigationPivot | null,
            active: boolean
        ): void => this.emitNavigationPivot(pivot, active);

        /** Retains one pivot across a discrete zoom burst. */
        const retainDiscreteZoomPivot = (
            position: [number, number]
        ): NavigationPivot | null => this.retainDiscreteZoomPivot(position);

        /** Resolves the retained target, then falls back to an eligible center feature. */
        const resolveCommandPivot = (
            state: InstanceType<typeof BaseMapState>
        ): NavigationPivot | null => {
            const retainedPivot = this.resolveRetainedNavigationPivot();
            if (retainedPivot) {
                return retainedPivot;
            }
            const {width, height} = state.getViewportProps();
            return resolveNavigationPivot([width / 2, height / 2]);
        };

        /**
         * Locks one picked pivot for the duration of a compound gesture.
         */
        const beginOperation = (
            operation: NavigationOperation,
            position: [number, number]
        ): NavigationPivot | null => {
            if (activeOperations.size === 0) {
                this.releaseDiscreteZoomPivot();
                lockedPivot = resolveNavigationPivot(position);
                emitNavigationPivot(lockedPivot, true);
            }
            activeOperations.add(operation);
            return lockedPivot;
        };

        /**
         * Releases the gesture lock after all parts of a compound gesture end.
         */
        const endOperation = (operation: NavigationOperation): void => {
            activeOperations.delete(operation);
            if (activeOperations.size === 0) {
                emitNavigationPivot(lockedPivot, false);
                lockedPivot = null;
            }
        };

        this.ControllerState = class PivotMapState extends BaseMapState {
            /**
             * Captures the feature position grabbed by a drag-pan gesture.
             */
            override panStart({pos}: {pos: [number, number]}) {
                beginOperation("pan", pos);
                return super.panStart({pos});
            }

            /**
             * Repositions the map so the captured 3D point follows the pointer.
             */
            override pan(params: {
                pos: [number, number];
                startPos?: [number, number];
            }) {
                if (!lockedPivot) {
                    return super.pan(params);
                }

                const viewport = this.makeViewport(this.getViewportProps());
                if (!(viewport instanceof WebMercatorViewport)) {
                    return super.pan(params);
                }

                return this._getUpdatedState(
                    viewport.panByPosition3D(
                        pivotInViewportWorld(lockedPivot, viewport),
                        params.pos
                    )
                );
            }

            /**
             * Clears the drag-pan lock after deck.gl computes optional inertia.
             */
            override panEnd() {
                const result = super.panEnd();
                endOperation("pan");
                return result;
            }

            /**
             * Captures the exact eligible pivot rather than deck.gl's unrestricted
             * internal pick, then initializes the stock rotation state.
             */
            override rotateStart({pos}: {pos: [number, number]}) {
                const pivot = beginOperation("rotate", pos);
                const viewportProps = this.getViewportProps();
                const viewport = this.makeViewport(viewportProps);
                const localPivot = pivot && viewport instanceof WebMercatorViewport
                    ? pivotInViewportWorld(pivot, viewport)
                    : pivot;
                return this._getUpdatedState({
                    startRotatePos: pos,
                    startRotateLngLat: localPivot ?? undefined,
                    startBearing: viewportProps.bearing,
                    startPitch: viewportProps.pitch
                });
            }

            /**
             * Retains deck.gl's rotation math and releases the shared pivot lock.
             */
            override rotateEnd() {
                const result = super.rotateEnd();
                endOperation("rotate");
                return result;
            }

            /**
             * Captures one pivot for a continuous pinch gesture.
             */
            override zoomStart({pos}: {pos: [number, number]}) {
                beginOperation("zoom", pos);
                return super.zoomStart({pos});
            }

            /**
             * Applies deck.gl's constrained zoom while preserving the pivot's
             * screen position in three dimensions.
             */
            override zoom(params: {
                pos: [number, number];
                startPos?: [number, number];
                scale: number;
            }) {
                const isContinuousGesture = activeOperations.has("zoom");
                const pivot = isContinuousGesture
                    ? lockedPivot
                    : retainDiscreteZoomPivot(params.startPos ?? params.pos);
                if (!pivot) {
                    return super.zoom(params);
                }

                const stockState = super.zoom(params);
                const zoom = stockState.getViewportProps().zoom;
                const viewport = this.makeViewport({
                    ...this.getViewportProps(),
                    zoom
                });
                if (!(viewport instanceof WebMercatorViewport)) {
                    return stockState;
                }

                const localPivot = pivotInViewportWorld(pivot, viewport);
                return this._getUpdatedState({
                    zoom,
                    ...viewport.panByPosition3D(localPivot, params.pos)
                });
            }

            /**
             * Releases the pinch-zoom part of a compound touch gesture.
             */
            override zoomEnd() {
                const result = super.zoomEnd();
                endOperation("zoom");
                return result;
            }

            /** Moves left while preserving the retained feature at its shifted screen pixel. */
            override moveLeft(speed = 100): MapControllerState {
                return this.moveKeepingPivot([speed, 0], speed, "left");
            }

            /** Moves right while preserving the retained feature at its shifted screen pixel. */
            override moveRight(speed = 100): MapControllerState {
                return this.moveKeepingPivot([-speed, 0], speed, "right");
            }

            /** Moves up while preserving the retained feature at its shifted screen pixel. */
            override moveUp(speed = 100): MapControllerState {
                return this.moveKeepingPivot([0, speed], speed, "up");
            }

            /** Moves down while preserving the retained feature at its shifted screen pixel. */
            override moveDown(speed = 100): MapControllerState {
                return this.moveKeepingPivot([0, -speed], speed, "down");
            }

            /** Zooms in around the retained feature rather than the ground-plane center. */
            override zoomIn(speed = 2): MapControllerState {
                return this.changePoseKeepingPivot(() => super.zoomIn(speed));
            }

            /** Zooms out around the retained feature rather than the ground-plane center. */
            override zoomOut(speed = 2): MapControllerState {
                return this.changePoseKeepingPivot(() => super.zoomOut(speed));
            }

            /** Rotates left around the retained feature. */
            override rotateLeft(speed = 15): MapControllerState {
                return this.changePoseKeepingPivot(() => super.rotateLeft(speed));
            }

            /** Rotates right around the retained feature. */
            override rotateRight(speed = 15): MapControllerState {
                return this.changePoseKeepingPivot(() => super.rotateRight(speed));
            }

            /** Tilts up around the retained feature. */
            override rotateUp(speed = 10): MapControllerState {
                return this.changePoseKeepingPivot(() => super.rotateUp(speed));
            }

            /** Tilts down around the retained feature. */
            override rotateDown(speed = 10): MapControllerState {
                return this.changePoseKeepingPivot(() => super.rotateDown(speed));
            }

            /** Applies one keyboard pan using the same three-dimensional pivot invariant. */
            private moveKeepingPivot(
                pixelOffset: [number, number],
                speed: number,
                direction: "left" | "right" | "up" | "down"
            ): MapControllerState {
                const pivot = resolveCommandPivot(this);
                if (!pivot) {
                    switch (direction) {
                        case "left":
                            return super.moveLeft(speed);
                        case "right":
                            return super.moveRight(speed);
                        case "up":
                            return super.moveUp(speed);
                        case "down":
                            return super.moveDown(speed);
                    }
                }
                const viewport = this.makeViewport(this.getViewportProps());
                if (!(viewport instanceof WebMercatorViewport)) {
                    return this;
                }
                const localPivot = pivotInViewportWorld(pivot, viewport);
                const projected = viewport.project(localPivot);
                emitNavigationPivot(pivot, false);
                return this._getUpdatedState(viewport.panByPosition3D(
                    localPivot,
                    [projected[0] + pixelOffset[0], projected[1] + pixelOffset[1]]
                ));
            }

            /** Corrects a stock keyboard zoom/rotation so the retained 3D point stays fixed. */
            private changePoseKeepingPivot(
                getStockState: () => MapControllerState
            ): MapControllerState {
                const pivot = resolveCommandPivot(this);
                if (!pivot) {
                    return getStockState();
                }
                const currentViewport = this.makeViewport(this.getViewportProps());
                const stockState = getStockState();
                const nextViewport = this.makeViewport(stockState.getViewportProps());
                if (!(currentViewport instanceof WebMercatorViewport)
                    || !(nextViewport instanceof WebMercatorViewport)) {
                    return stockState;
                }
                const currentPivot = pivotInViewportWorld(pivot, currentViewport);
                const nextPivot = pivotInViewportWorld(pivot, nextViewport);
                const projected = currentViewport.project(currentPivot);
                emitNavigationPivot(pivot, false);
                return this._getUpdatedState({
                    ...stockState.getViewportProps(),
                    ...nextViewport.panByPosition3D(nextPivot, [projected[0], projected[1]])
                });
            }
        };
    }

    /**
     * Updates callbacks before forwarding resolved view and interaction options
     * to deck.gl's MapController.
     */
    override setProps(props: PivotMapControllerProps): void {
        this.getNavigationPivot = props.getNavigationPivot;
        this.getRetainedNavigationPivot = props.getRetainedNavigationPivot;
        this.onNavigationPivotChange = props.onNavigationPivotChange;
        super.setProps(props);
    }

    /** Releases delayed wheel/double-click pivot state before controller teardown. */
    override finalize(): void {
        if (this.discreteZoomReleaseTimer) {
            clearTimeout(this.discreteZoomReleaseTimer);
            this.discreteZoomReleaseTimer = null;
        }
        this.discreteZoomPivot = null;
        super.finalize();
    }

    /** Keeps one pivot across a burst of discrete wheel or double-click zoom events. */
    private retainDiscreteZoomPivot(screenPosition: [number, number]): NavigationPivot | null {
        if (!this.discreteZoomPivot) {
            this.discreteZoomPivot = this.resolveNavigationPivot(screenPosition);
            if (!this.discreteZoomPivot) {
                return null;
            }
            this.emitNavigationPivot(this.discreteZoomPivot, true);
        }
        if (this.discreteZoomReleaseTimer) {
            clearTimeout(this.discreteZoomReleaseTimer);
        }
        this.discreteZoomReleaseTimer = setTimeout(
            () => this.releaseDiscreteZoomPivot(),
            PivotMapController.DISCRETE_ZOOM_RELEASE_MS
        );
        return this.discreteZoomPivot;
    }

    /** Ends one debounced discrete zoom burst and retains its target for later UI commands. */
    private releaseDiscreteZoomPivot(): void {
        if (this.discreteZoomReleaseTimer) {
            clearTimeout(this.discreteZoomReleaseTimer);
            this.discreteZoomReleaseTimer = null;
        }
        if (this.discreteZoomPivot) {
            this.emitNavigationPivot(this.discreteZoomPivot, false);
            this.discreteZoomPivot = null;
        }
    }

    /**
     * Resolves a view-local screen coordinate to an eligible scene pivot.
     */
    private resolveNavigationPivot(
        screenPosition: [number, number]
    ): NavigationPivot | null {
        return this.getNavigationPivot?.(screenPosition) ?? null;
    }

    /** Resolves the last successfully activated feature for pointerless commands. */
    private resolveRetainedNavigationPivot(): NavigationPivot | null {
        return this.getRetainedNavigationPivot?.() ?? null;
    }

    /**
     * Reports pivot lock changes without adding fields to deck.gl's
     * InteractionState.
     */
    private emitNavigationPivot(
        pivot: NavigationPivot | null,
        active: boolean
    ): void {
        this.onNavigationPivotChange?.(pivot, active);
    }
}
