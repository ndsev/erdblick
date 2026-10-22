export const MAX_NUM_TILES_TO_LOAD = 512;

export const DEFAULT_MAP_ZOOM_STEP = 0.5;

export const MIN_MAP_ZOOM_STEP = 0.001;

export const MAX_MAP_ZOOM_STEP = 1.0;

export const DEFAULT_FEATURE_ZOOM_CLEARANCE_METERS = 20;

export const MIN_FEATURE_ZOOM_CLEARANCE_METERS = 0;

export const MAX_FEATURE_ZOOM_CLEARANCE_METERS = 100;

export const VIEW_SYNC_PROJECTION = "proj";

export const VIEW_SYNC_POSITION = "pos";

export const VIEW_SYNC_MOVEMENT = "mov";

export const VIEW_SYNC_LAYERS = "lay";

/** Minimal persisted camera state shared between 2D and 3D views. */
export interface CameraViewState {
    destination: {lon: number; lat: number; alt: number};
    orientation: {heading: number; pitch: number; roll: number};
    /** Local map-centre offset in metres; omitted legacy values resolve to zero. */
    position?: [x: number, y: number, z: number];
}

/** Enumerates view properties that can be synchronized across split views. */
export interface ViewSyncOptionDescriptor {
    name: string;
    code: string;
    icon: string;
    tooltip: string;
}

/** Clamps persisted zoom-step settings to the supported deck interaction range. */
export function clampMapZoomStep(value: number): number {
    if (!Number.isFinite(value)) {
        return DEFAULT_MAP_ZOOM_STEP;
    }
    return Math.min(MAX_MAP_ZOOM_STEP, Math.max(MIN_MAP_ZOOM_STEP, value));
}

/** Clamps the persisted minimum feature-navigation camera distance. */
export function clampFeatureZoomClearanceMeters(value: number): number {
    if (!Number.isFinite(value)) {
        return DEFAULT_FEATURE_ZOOM_CLEARANCE_METERS;
    }
    return Math.min(MAX_FEATURE_ZOOM_CLEARANCE_METERS, Math.max(MIN_FEATURE_ZOOM_CLEARANCE_METERS, value));
}
