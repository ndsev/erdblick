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

export type RenderBackend = "deck";

/** Opaque handle that lets visualizations talk to the currently active renderer implementation. */
export interface IRenderSceneHandle {
    readonly renderer: RenderBackend;
    readonly scene: unknown;
}

/** Minimal tile surface required by the shared visualization scheduler. */
export interface TileVisualizationTile {
    mapTileKey: string;
    nodeId: string;
    mapName: string;
    layerName: string;
    tileId: bigint;
    dataVersion: number;
    disposed: boolean;
    stats: Map<string, number[]>;

    setRenderOrder(order: number): void;
    renderOrder(): number;
    setVertexCount(count: number): void;
}

/**
 * Contract implemented by tile visualizations regardless of renderer backend.
 * Instances are long-lived and can be marked dirty multiple times as tiles or style options change.
 */
export interface ITileVisualization {
    readonly viewIndex: number;
    readonly styleId: string;
    readonly tile: TileVisualizationTile;
    styleOrder: number;
    highFidelityStage: number;
    prefersHighFidelity: boolean;
    maxLowFiLod: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | null;
    showTileBorder: boolean;

    render(sceneHandle: IRenderSceneHandle): Promise<boolean>;
    destroy(sceneHandle: IRenderSceneHandle): void;
    isDirty(): boolean;
    renderRank(): number;
    updateStatus(renderQueued?: boolean): void;
    setStyleOption(optionId: string, value: string | number | boolean): boolean;
}

/**
 * Minimal renderer abstraction used by the rest of the frontend.
 * Views expose picking, camera sync, and movement without leaking deck-specific details upward.
 */
export interface IRenderView {
    readonly viewIndex: number;
    readonly hoveredFeatureIds: BehaviorSubject<HoveredFeatureIds | undefined>;

    setup(): Promise<void>;
    destroy(): Promise<void>;
    isAvailable(): boolean;
    requestRender(): void;

    getCanvasClientRect(): DOMRect;
    getCameraHeadingDegrees(): number;
    onTick(cb: () => void): void;
    offTick(cb: () => void): void;
    getSceneMode(): unknown;
    getSceneHandle(): IRenderSceneHandle;

    pickFeature(screenPos: {x: number; y: number}): (TileFeatureId | null)[];
    pickCartographic(screenPos: {x: number; y: number}): {lon: number; lat: number; alt: number} | undefined;

    setViewFromState(cameraData: CameraViewState): void;
    getViewState(): CameraViewState;
    computeViewport(): Viewport | undefined;

    moveUp(): void;
    moveDown(): void;
    moveLeft(): void;
    moveRight(): void;
    zoomIn(): void;
    zoomOut(): void;
    resetOrientation(): void;
}
