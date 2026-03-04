import {BehaviorSubject} from "rxjs";
import {CameraViewState, TileFeatureId} from "../shared/appstate.service";
import {Viewport} from "../../build/libs/core/erdblick-core";
import {FeatureTile} from "../mapdata/features.model";

export interface HoveredFeatureIds {
    featureIds: (TileFeatureId | null)[];
    position: {x: number, y: number};
}

export interface RenderRectangle {
    west: number;
    south: number;
    east: number;
    north: number;
}

export interface RenderVector3 {
    x: number;
    y: number;
    z: number;
}

export type RenderBackend = "deck";

export interface IRenderSceneHandle {
    readonly renderer: RenderBackend;
    readonly scene: unknown;
}

export interface ITileVisualization {
    readonly viewIndex: number;
    readonly styleId: string;
    readonly tile: FeatureTile;
    prefersHighFidelity: boolean;
    maxLowFiLod: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | null;
    showTileBorder: boolean;

    render(sceneHandle: IRenderSceneHandle): Promise<boolean>;
    destroy(sceneHandle: IRenderSceneHandle): void;
    isDirty(): boolean;
    renderRank(): readonly number[];
    updateStatus(renderQueued?: boolean): void;
    setStyleOption(optionId: string, value: string | number | boolean): boolean;
}

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
