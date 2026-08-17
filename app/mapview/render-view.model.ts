import {BehaviorSubject, type Observable} from "rxjs";
import {CameraViewState, TileFeatureId} from "../shared/appstate.service";
import {Viewport} from "../../build/libs/core/erdblick-core";

/** WGS84 rectangle used for fit-to-bounds navigation requests. */
export interface RenderRectangle {
    west: number;
    south: number;
    east: number;
    north: number;
}

/** Generic 3D vector payload used by view-agnostic navigation topics. */
export interface RenderVector3 {
    x: number;
    y: number;
    z: number;
}

/** Physical surface used as a 3D navigation or first-person camera target. */
export interface RenderNavigationTarget {
    position: [longitude: number, latitude: number, altitude: number];
    /** Application identities represented by the surface; empty for ground or identity-less geometry. */
    featureIds: TileFeatureId[];
    surfaceNormal?: [east: number, north: number, up: number];
}

/** Screen-aligned rectangle expressed in CSS pixels relative to the render canvas. */
export interface RenderScreenRectangle {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Logical feature result returned by bounded rendered-object picking operations. */
export interface RenderedFeaturePickResult {
    /** Unique exact feature identities in renderer traversal order. */
    featureIds: TileFeatureId[];
}

export type RenderBackend = "deck";

export const MAP_VIEW_LAYOUT_RESIZE_PREPARE_EVENT = "erdblick-map-view-layout-resize-prepare";

/** Opaque handle that lets visualizations talk to the currently active renderer implementation. */
export interface IRenderSceneHandle {
    readonly renderer: RenderBackend;
    readonly scene: unknown;
}

/**
 * Minimal renderer abstraction used by the rest of the frontend.
 * Views expose picking, camera sync, and movement without leaking deck-specific details upward.
 */
export interface IRenderView {
    readonly viewIndex: number;
    readonly hoveredFeatureIds: BehaviorSubject<TileFeatureId[]>;
    readonly firstPersonViewActive: BehaviorSubject<boolean>;
    /** Emits once when the browser invalidates this view's graphics context. */
    readonly contextLost: Observable<void>;

    setup(): Promise<void>;
    destroy(): Promise<void>;
    isAvailable(): boolean;
    requestRender(): void;
    prepareForLayoutResize(targetCssSize: {width: number; height: number}): void;
    setDesktopDrillPickingEnabled(enabled: boolean): void;

    getCanvasClientRect(): DOMRect;
    getCameraHeadingDegrees(): number;
    onTick(cb: () => void): void;
    offTick(cb: () => void): void;
    getSceneMode(): unknown;
    getSceneHandle(): IRenderSceneHandle;

    pickCartographic(screenPos: {x: number; y: number}): {lon: number; lat: number; alt: number} | undefined;
    pickNavigationTarget(screenPos: {x: number; y: number}): RenderNavigationTarget | undefined;
    drillPickFeatures(
        screenPos: {x: number; y: number},
        radius: number,
        maxObjects: number
    ): RenderedFeaturePickResult;
    pickFeaturesInRectangle(
        bounds: RenderScreenRectangle,
        maxObjects: number
    ): Promise<RenderedFeaturePickResult>;

    setViewFromState(cameraData: CameraViewState): void;
    getViewState(): CameraViewState;
    computeViewport(): Viewport | undefined;
    enterFirstPersonView(target: RenderNavigationTarget): void;
    exitFirstPersonView(): void;
    isFirstPersonViewActive(): boolean;

    moveUp(): void;
    moveDown(): void;
    moveLeft(): void;
    moveRight(): void;
    zoomIn(): void;
    zoomOut(): void;
    resetOrientation(): void;
}
