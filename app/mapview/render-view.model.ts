import {BehaviorSubject} from "rxjs";
import {CameraViewState, TileFeatureId} from "../shared/appstate.service";
import {Viewport} from "../../build/libs/core/erdblick-core";

/** Hover pick payload emitted by a render view after a screen-space hover query. */
export interface HoveredFeatureIds {
    featureIds: (TileFeatureId | null)[];
    position: {x: number, y: number};
}

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

/** Exact selectable feature surface used as a 3D navigation or first-person camera target. */
export interface RenderNavigationTarget {
    position: [longitude: number, latitude: number, altitude: number];
    featureIds: TileFeatureId[];
}

export type RenderBackend = "deck";

export const MAP_VIEW_LAYOUT_RESIZE_PREPARE_EVENT = "erdblick-map-view-layout-resize-prepare";

/** Controls how much shared renderer state is torn down when a render view is destroyed. */
export interface RenderViewDestroyOptions {
    clearTileVisualizations?: boolean;
}

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
    readonly hoveredFeatureIds: BehaviorSubject<HoveredFeatureIds | undefined>;
    readonly firstPersonViewActive: BehaviorSubject<boolean>;

    setup(): Promise<void>;
    destroy(options?: RenderViewDestroyOptions): Promise<void>;
    isAvailable(): boolean;
    requestRender(): void;
    prepareForLayoutResize(targetCssSize: {width: number; height: number}): void;

    getCanvasClientRect(): DOMRect;
    getCameraHeadingDegrees(): number;
    onTick(cb: () => void): void;
    offTick(cb: () => void): void;
    getSceneMode(): unknown;
    getSceneHandle(): IRenderSceneHandle;

    pickFeature(screenPos: {x: number; y: number}): (TileFeatureId | null)[];
    pickCartographic(screenPos: {x: number; y: number}): {lon: number; lat: number; alt: number} | undefined;
    pickNavigationTarget(screenPos: {x: number; y: number}): RenderNavigationTarget | undefined;

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
