import {
    MapController,
    WebMercatorViewport
} from "@deck.gl/core";
import {
    navigationAnchorInViewportWorld,
    viewStateKeepingSafeNavigationAnchor
} from "./web-mercator-feature-navigation";
import type {
    NavigationAnchor,
    NavigationAnchorChangeHandler,
    NavigationAnchorProvider,
    NavigationScreenPosition,
    RetainedNavigationAnchorProvider
} from "./feature-navigation.types";

/** Controller options added by feature-relative three-dimensional navigation. */
export type FeatureNavigationMapControllerProps =
    Parameters<MapController["setProps"]>[0] & {
        getNavigationAnchor?: NavigationAnchorProvider;
        getRetainedNavigationAnchor?: RetainedNavigationAnchorProvider;
        onNavigationAnchorChange?: NavigationAnchorChangeHandler;
    };

type NavigationOperation = "pan" | "rotate" | "zoom";
type MapControllerState = MapController["controllerState"];

/**
 * A geospatial map controller that keeps resolved 3D coordinates under the
 * pointer while panning, zooming, and rotating.
 */
export class FeatureNavigationMapController extends MapController {
    private static readonly DISCRETE_ZOOM_RELEASE_MS = 150;

    private getNavigationAnchor?: NavigationAnchorProvider;
    private getRetainedNavigationAnchor?: RetainedNavigationAnchorProvider;
    private onNavigationAnchorChange?: NavigationAnchorChangeHandler;
    private readonly activeOperations = new Set<NavigationOperation>();
    private lockedAnchor: NavigationAnchor | null = null;
    private discreteZoomAnchor: NavigationAnchor | null = null;
    private discreteZoomReleaseTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Installs a MapState specialization while retaining deck.gl's MapController
     * event handling, transitions, constraints, and rotation calculations.
     */
    constructor(...args: ConstructorParameters<typeof MapController>) {
        super(...args);

        const BaseMapState = this.ControllerState;

        /** Starts one part of a compound navigation operation. */
        const beginOperation = (
            operation: NavigationOperation,
            position: NavigationScreenPosition
        ): NavigationAnchor | null => this.beginOperation(operation, position);

        /** Ends one part of a compound navigation operation. */
        const endOperation = (operation: NavigationOperation): void => this.endOperation(operation);

        /** Returns the coordinate shared by every active part of the gesture. */
        const getLockedAnchor = (): NavigationAnchor | null => this.lockedAnchor;

        /** Returns whether one continuous operation currently owns the gesture coordinate. */
        const isOperationActive = (operation: NavigationOperation): boolean =>
            this.activeOperations.has(operation);

        /** Resolves or reuses the coordinate retained for a discrete zoom burst. */
        const retainDiscreteZoomAnchor = (position: NavigationScreenPosition): NavigationAnchor | null =>
            this.retainDiscreteZoomAnchor(position);

        /** Resolves the coordinate used by a pointerless navigation command. */
        const resolveCommandAnchor = (state: MapControllerState): NavigationAnchor | null =>
            this.resolveCommandAnchor(state);

        /** Reports a coordinate through the callbacks currently supplied in props. */
        const emitNavigationAnchor = (anchor: NavigationAnchor | null, active: boolean): void =>
            this.emitNavigationAnchor(anchor, active);

        this.ControllerState = class FeatureNavigationMapState extends BaseMapState {
            /** Captures the physical coordinate grabbed by a drag-pan gesture. */
            override panStart({pos}: {pos: NavigationScreenPosition}) {
                beginOperation("pan", pos);
                return super.panStart({pos});
            }

            /** Repositions the map so the captured 3D coordinate follows the pointer. */
            override pan(params: {
                pos: NavigationScreenPosition;
                startPos?: NavigationScreenPosition;
            }) {
                const anchor = getLockedAnchor();
                if (!anchor) {
                    return super.pan(params);
                }

                const viewport = this.makeViewport(this.getViewportProps());
                if (!(viewport instanceof WebMercatorViewport)) {
                    return super.pan(params);
                }

                return this._getUpdatedState(
                    viewport.panByPosition3D(
                        navigationAnchorInViewportWorld(anchor, viewport),
                        params.pos
                    )
                );
            }

            /** Clears the drag-pan lock after deck.gl computes optional inertia. */
            override panEnd() {
                const result = super.panEnd();
                endOperation("pan");
                return result;
            }

            /** Initializes stock rotation state with the exact resolved coordinate. */
            override rotateStart({pos}: {pos: NavigationScreenPosition}) {
                const anchor = beginOperation("rotate", pos);
                const viewportProps = this.getViewportProps();
                const viewport = this.makeViewport(viewportProps);
                const localAnchor = anchor && viewport instanceof WebMercatorViewport
                    ? navigationAnchorInViewportWorld(anchor, viewport)
                    : anchor;
                return this._getUpdatedState({
                    startRotatePos: pos,
                    startRotateLngLat: localAnchor ?? undefined,
                    startBearing: viewportProps.bearing,
                    startPitch: viewportProps.pitch
                });
            }

            /** Retains deck.gl's rotation math and releases the shared anchor lock. */
            override rotateEnd() {
                const result = super.rotateEnd();
                endOperation("rotate");
                return result;
            }

            /** Captures one coordinate for a continuous pinch gesture. */
            override zoomStart({pos}: {pos: NavigationScreenPosition}) {
                beginOperation("zoom", pos);
                return super.zoomStart({pos});
            }

            /** Applies constrained zoom while preserving the anchor's 3D screen position. */
            override zoom(params: {
                pos: NavigationScreenPosition;
                startPos?: NavigationScreenPosition;
                scale: number;
            }) {
                const anchor = isOperationActive("zoom")
                    ? getLockedAnchor()
                    : retainDiscreteZoomAnchor(params.startPos ?? params.pos);
                if (!anchor) {
                    return super.zoom(params);
                }

                const stockState = super.zoom(params);
                const zoom = stockState.getViewportProps().zoom;
                const currentProps = this.getViewportProps();
                const viewport = this.makeViewport(currentProps);
                if (!(viewport instanceof WebMercatorViewport)) {
                    return stockState;
                }

                return this._getUpdatedState(viewStateKeepingSafeNavigationAnchor(
                    currentProps,
                    {...currentProps, zoom},
                    anchor,
                    params.pos,
                    viewport.width,
                    viewport.height,
                    viewport.orthographic
                ));
            }

            /** Releases the pinch-zoom part of a compound touch gesture. */
            override zoomEnd() {
                const result = super.zoomEnd();
                endOperation("zoom");
                return result;
            }

            /** Moves left while preserving the retained coordinate at its shifted pixel. */
            override moveLeft(speed = 100): MapControllerState {
                return this.moveKeepingAnchor([speed, 0], speed, "left");
            }

            /** Moves right while preserving the retained coordinate at its shifted pixel. */
            override moveRight(speed = 100): MapControllerState {
                return this.moveKeepingAnchor([-speed, 0], speed, "right");
            }

            /** Moves up while preserving the retained coordinate at its shifted pixel. */
            override moveUp(speed = 100): MapControllerState {
                return this.moveKeepingAnchor([0, speed], speed, "up");
            }

            /** Moves down while preserving the retained coordinate at its shifted pixel. */
            override moveDown(speed = 100): MapControllerState {
                return this.moveKeepingAnchor([0, -speed], speed, "down");
            }

            /** Zooms in around the retained coordinate rather than the ground-plane center. */
            override zoomIn(speed = 2): MapControllerState {
                return this.changePoseKeepingAnchor(() => super.zoomIn(speed));
            }

            /** Zooms out around the retained coordinate rather than the ground-plane center. */
            override zoomOut(speed = 2): MapControllerState {
                return this.changePoseKeepingAnchor(() => super.zoomOut(speed));
            }

            /** Rotates left around the retained coordinate. */
            override rotateLeft(speed = 15): MapControllerState {
                return this.changePoseKeepingAnchor(() => super.rotateLeft(speed));
            }

            /** Rotates right around the retained coordinate. */
            override rotateRight(speed = 15): MapControllerState {
                return this.changePoseKeepingAnchor(() => super.rotateRight(speed));
            }

            /** Tilts up around the retained coordinate. */
            override rotateUp(speed = 10): MapControllerState {
                return this.changePoseKeepingAnchor(() => super.rotateUp(speed));
            }

            /** Tilts down around the retained coordinate. */
            override rotateDown(speed = 10): MapControllerState {
                return this.changePoseKeepingAnchor(() => super.rotateDown(speed));
            }

            /** Applies one keyboard pan using the same three-dimensional anchor invariant. */
            private moveKeepingAnchor(
                pixelOffset: NavigationScreenPosition,
                speed: number,
                direction: "left" | "right" | "up" | "down"
            ): MapControllerState {
                const anchor = resolveCommandAnchor(this);
                if (!anchor) {
                    return this.moveWithoutAnchor(speed, direction);
                }
                const viewport = this.makeViewport(this.getViewportProps());
                if (!(viewport instanceof WebMercatorViewport)) {
                    return this.moveWithoutAnchor(speed, direction);
                }
                const localAnchor = navigationAnchorInViewportWorld(anchor, viewport);
                const projected = viewport.project(localAnchor);
                emitNavigationAnchor(anchor, false);
                return this._getUpdatedState(viewport.panByPosition3D(
                    localAnchor,
                    [projected[0] + pixelOffset[0], projected[1] + pixelOffset[1]]
                ));
            }

            /** Delegates one keyboard movement to the unmodified MapState behavior. */
            private moveWithoutAnchor(
                speed: number,
                direction: "left" | "right" | "up" | "down"
            ): MapControllerState {
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

            /** Corrects stock keyboard zoom/rotation around the retained 3D coordinate. */
            private changePoseKeepingAnchor(
                getStockState: () => MapControllerState
            ): MapControllerState {
                const anchor = resolveCommandAnchor(this);
                if (!anchor) {
                    return getStockState();
                }
                const currentViewport = this.makeViewport(this.getViewportProps());
                const stockState = getStockState();
                const nextViewport = this.makeViewport(stockState.getViewportProps());
                if (!(currentViewport instanceof WebMercatorViewport)
                    || !(nextViewport instanceof WebMercatorViewport)) {
                    return stockState;
                }
                const currentAnchor = navigationAnchorInViewportWorld(anchor, currentViewport);
                const projected = currentViewport.project(currentAnchor);
                emitNavigationAnchor(anchor, false);
                return this._getUpdatedState(viewStateKeepingSafeNavigationAnchor(
                    this.getViewportProps(),
                    stockState.getViewportProps(),
                    anchor,
                    [projected[0], projected[1]],
                    currentViewport.width,
                    currentViewport.height,
                    currentViewport.orthographic
                ));
            }
        };
    }

    /** Updates callbacks before forwarding resolved view and interaction options to deck.gl. */
    override setProps(props: FeatureNavigationMapControllerProps): void {
        this.getNavigationAnchor = props.getNavigationAnchor;
        this.getRetainedNavigationAnchor = props.getRetainedNavigationAnchor;
        this.onNavigationAnchorChange = props.onNavigationAnchorChange;
        super.setProps(props);
    }

    /** Releases timers and active anchors before controller teardown. */
    override finalize(): void {
        this.releaseDiscreteZoomAnchor();
        this.cancelActiveOperations();
        super.finalize();
    }

    /** Locks one resolved coordinate for the duration of a compound gesture. */
    private beginOperation(
        operation: NavigationOperation,
        position: NavigationScreenPosition
    ): NavigationAnchor | null {
        if (this.activeOperations.size === 0) {
            this.releaseDiscreteZoomAnchor();
            this.lockedAnchor = this.resolveNavigationAnchor(position);
            this.emitNavigationAnchor(this.lockedAnchor, true);
        }
        this.activeOperations.add(operation);
        return this.lockedAnchor;
    }

    /** Releases the gesture coordinate after every part of a compound operation ends. */
    private endOperation(operation: NavigationOperation): void {
        if (!this.activeOperations.delete(operation) || this.activeOperations.size > 0) {
            return;
        }
        const anchor = this.lockedAnchor;
        this.lockedAnchor = null;
        this.emitNavigationAnchor(anchor, false);
    }

    /** Cancels any unfinished compound operation during controller replacement. */
    private cancelActiveOperations(): void {
        if (this.activeOperations.size === 0) {
            return;
        }
        const anchor = this.lockedAnchor;
        this.activeOperations.clear();
        this.lockedAnchor = null;
        this.emitNavigationAnchor(anchor, false);
    }

    /** Keeps one coordinate across a burst of wheel or double-click zoom events. */
    private retainDiscreteZoomAnchor(screenPosition: NavigationScreenPosition): NavigationAnchor | null {
        if (!this.discreteZoomAnchor) {
            this.discreteZoomAnchor = this.resolveNavigationAnchor(screenPosition);
            if (!this.discreteZoomAnchor) {
                return null;
            }
            this.emitNavigationAnchor(this.discreteZoomAnchor, true);
        }
        if (this.discreteZoomReleaseTimer) {
            clearTimeout(this.discreteZoomReleaseTimer);
        }
        this.discreteZoomReleaseTimer = setTimeout(
            () => this.releaseDiscreteZoomAnchor(),
            FeatureNavigationMapController.DISCRETE_ZOOM_RELEASE_MS
        );
        return this.discreteZoomAnchor;
    }

    /** Ends one debounced discrete zoom burst and reports its released coordinate. */
    private releaseDiscreteZoomAnchor(): void {
        if (this.discreteZoomReleaseTimer) {
            clearTimeout(this.discreteZoomReleaseTimer);
            this.discreteZoomReleaseTimer = null;
        }
        if (!this.discreteZoomAnchor) {
            return;
        }
        const anchor = this.discreteZoomAnchor;
        this.discreteZoomAnchor = null;
        this.emitNavigationAnchor(anchor, false);
    }

    /** Resolves a view-local screen coordinate to an eligible physical coordinate. */
    private resolveNavigationAnchor(screenPosition: NavigationScreenPosition): NavigationAnchor | null {
        return this.getNavigationAnchor?.(screenPosition) ?? null;
    }

    /** Resolves the retained coordinate, then falls back to an eligible center feature. */
    private resolveCommandAnchor(
        state: MapControllerState
    ): NavigationAnchor | null {
        const retainedAnchor = this.getRetainedNavigationAnchor?.() ?? null;
        if (retainedAnchor) {
            return retainedAnchor;
        }
        const {width, height} = state.getViewportProps();
        return this.resolveNavigationAnchor([width / 2, height / 2]);
    }

    /** Reports anchor-lock changes without extending deck.gl's InteractionState. */
    private emitNavigationAnchor(anchor: NavigationAnchor | null, active: boolean): void {
        this.onNavigationAnchorChange?.(anchor, active);
    }
}
