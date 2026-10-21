import {signalStoreFeature, withState} from "@ngrx/signals";
import {z} from "zod";
import {roundCoordinateStateValue} from "../coords/coordinate-state";
import {Boolish} from "../shared/app-state";
import {clampLod3TileThreshold, DEFAULT_LOD3_TILE_THRESHOLD} from "../shared/lod-policy";
import {
    DEFAULT_POINT_CLOUD_POLICY,
    pointCloudDetailSchema,
    pointCloudGpuMemorySchema,
    pointCloudWorkingMemorySchema
} from "../shared/point-cloud-policy";
import {AppStateOptions, deepCopy} from "../shared/state-value";
import {clampTileSubsetRenderWorkerCount} from "../shared/tile-render-policy";
import {
    CameraViewState,
    clampFeatureZoomClearanceMeters,
    clampMapZoomStep,
    DEFAULT_FEATURE_ZOOM_CLEARANCE_METERS,
    DEFAULT_MAP_ZOOM_STEP,
    MAX_NUM_TILES_TO_LOAD,
    VIEW_SYNC_LAYERS,
    VIEW_SYNC_MOVEMENT,
    VIEW_SYNC_POSITION,
    VIEW_SYNC_PROJECTION
} from "./map-view-state.model";
import type {ViewId} from "./view-id";

export interface MapViewStateServiceValues {
    marker: boolean;
    markedPosition: number[];
    focusedViewId: ViewId;
    viewSync: string[];
    cameraViewData: Record<string, CameraViewState>;
    mode2d: Record<string, boolean>;
    deckAntialiasingEnabled: boolean;
    semanticCompositingEnabled: boolean;
    contactShadingEnabled: boolean;
    lod3TileThreshold: number;
    tileSubsetRenderWorkerCount: number;
    pointCloudDownsamplingEnabled: boolean;
    pointCloudDetailPixels: number;
    pointCloudWorkingMemoryMiB: number;
    pointCloudGpuMemoryMiB: number;
    mapZoomStep: number;
    featureZoomClearanceMeters: number;
    tilesLoadLimit: number;
}

/** Named codec declarations are also the single source of SignalStore defaults. */
export const ownerState = {
    marker: {
        name: "marker",
        defaultValue: false,
        schema: Boolish,
        urlParamName: "m",
        urlIncludeInVisualizationOnly: false
    } satisfies AppStateOptions<MapViewStateServiceValues["marker"]>,

    markedPosition: {
        name: "markedPosition",
        defaultValue: [],
        schema: z.array(z.coerce.number()).max(3),
        toStorage: (value: number[]) => value.map((v) => roundCoordinateStateValue(v)),
        fromStorage: (payload: any): number[] => (payload as number[]).map((v) => roundCoordinateStateValue(v)),
        urlParamName: "mp",
        urlIncludeInVisualizationOnly: false
    } satisfies AppStateOptions<MapViewStateServiceValues["markedPosition"]>,

    viewSync: {
        name: "viewSync",
        defaultValue: [],
        schema: z.array(
            z.union([
                z.literal(VIEW_SYNC_PROJECTION),
                z.literal(VIEW_SYNC_POSITION),
                z.literal(VIEW_SYNC_MOVEMENT),
                z.literal(VIEW_SYNC_LAYERS)
            ])
        ),
        urlParamName: "sync",
        urlIncludeInVisualizationOnly: false
    } satisfies AppStateOptions<MapViewStateServiceValues["viewSync"]>,

    cameraViewData: {
        name: "cameraView",
        defaultValue: {
            destination: {lon: 22.837473, lat: 38.490817, alt: 16000000},
            orientation: {heading: 0, pitch: -Math.PI / 2, roll: 0},
            position: [0, 0, 0]
        },
        schema: z.object({
            lon: z.coerce.number().optional(),
            lat: z.coerce.number().optional(),
            alt: z.coerce.number().optional(),
            h: z.coerce.number().optional(),
            p: z.coerce.number().optional(),
            r: z.coerce.number().optional(),
            px: z.coerce.number().optional(),
            py: z.coerce.number().optional(),
            pz: z.coerce.number().optional()
        }),
        toStorage: (value: any) => ({
            lon: roundCoordinateStateValue(value.destination.lon),
            lat: roundCoordinateStateValue(value.destination.lat),
            alt: roundCoordinateStateValue(value.destination.alt),
            h: roundCoordinateStateValue(value.orientation.heading),
            p: roundCoordinateStateValue(value.orientation.pitch),
            r: roundCoordinateStateValue(value.orientation.roll),
            px: roundCoordinateStateValue(value.position?.[0] ?? 0),
            py: roundCoordinateStateValue(value.position?.[1] ?? 0),
            pz: roundCoordinateStateValue(value.position?.[2] ?? 0)
        }),
        fromStorage: (payload: any, currentValue: CameraViewState): CameraViewState => ({
            destination: {
                lon: roundCoordinateStateValue(payload.lon ?? currentValue.destination.lon),
                lat: roundCoordinateStateValue(payload.lat ?? currentValue.destination.lat),
                alt: roundCoordinateStateValue(payload.alt ?? currentValue.destination.alt)
            },
            orientation: {
                heading: roundCoordinateStateValue(payload.h ?? currentValue.orientation.heading),
                pitch: roundCoordinateStateValue(payload.p ?? currentValue.orientation.pitch),
                roll: roundCoordinateStateValue(payload.r ?? currentValue.orientation.roll)
            },
            // Older URLs, local-storage entries, and snapshots have no map-centre offset.
            position: [
                roundCoordinateStateValue(payload.px ?? 0),
                roundCoordinateStateValue(payload.py ?? 0),
                roundCoordinateStateValue(payload.pz ?? 0)
            ]
        }),
        urlFormEncode: true
    } satisfies AppStateOptions<MapViewStateServiceValues["cameraViewData"][string]>,

    mode2d: {
        name: "mode2d",
        defaultValue: false,
        schema: Boolish,
        urlParamName: "m2d",
        urlIncludeInVisualizationOnly: false
    } satisfies AppStateOptions<MapViewStateServiceValues["mode2d"][string]>,

    deckAntialiasingEnabled: {
        name: "deckAntialiasingEnabled",
        defaultValue: true,
        schema: Boolish
    } satisfies AppStateOptions<MapViewStateServiceValues["deckAntialiasingEnabled"]>,

    semanticCompositingEnabled: {
        name: "semanticCompositingEnabled",
        defaultValue: true,
        schema: Boolish
    } satisfies AppStateOptions<MapViewStateServiceValues["semanticCompositingEnabled"]>,

    contactShadingEnabled: {
        name: "contactShadingEnabled",
        defaultValue: true,
        schema: Boolish
    } satisfies AppStateOptions<MapViewStateServiceValues["contactShadingEnabled"]>,

    lod3TileThreshold: {
        name: "lod3TileThreshold",
        defaultValue: DEFAULT_LOD3_TILE_THRESHOLD,
        schema: z.coerce.number().int(),
        toStorage: (value) => clampLod3TileThreshold(value, DEFAULT_LOD3_TILE_THRESHOLD),
        fromStorage: (value) => clampLod3TileThreshold(value, DEFAULT_LOD3_TILE_THRESHOLD)
    } satisfies AppStateOptions<MapViewStateServiceValues["lod3TileThreshold"]>,

    tileSubsetRenderWorkerCount: {
        name: "tileSubsetRenderWorkerCount",
        defaultValue: 0,
        schema: z.coerce.number().int(),
        toStorage: (value) => clampTileSubsetRenderWorkerCount(value),
        fromStorage: (value) => clampTileSubsetRenderWorkerCount(value)
    } satisfies AppStateOptions<MapViewStateServiceValues["tileSubsetRenderWorkerCount"]>,

    pointCloudDownsamplingEnabled: {
        name: "pointCloudDownsamplingEnabled",
        defaultValue: DEFAULT_POINT_CLOUD_POLICY.enabled,
        schema: Boolish
    } satisfies AppStateOptions<MapViewStateServiceValues["pointCloudDownsamplingEnabled"]>,

    pointCloudDetailPixels: {
        name: "pointCloudDetailPixels",
        defaultValue: DEFAULT_POINT_CLOUD_POLICY.detailPixels,
        schema: pointCloudDetailSchema
    } satisfies AppStateOptions<MapViewStateServiceValues["pointCloudDetailPixels"]>,

    pointCloudWorkingMemoryMiB: {
        name: "pointCloudWorkingMemoryMiB",
        defaultValue: DEFAULT_POINT_CLOUD_POLICY.workingMemoryMiB,
        schema: pointCloudWorkingMemorySchema
    } satisfies AppStateOptions<MapViewStateServiceValues["pointCloudWorkingMemoryMiB"]>,

    pointCloudGpuMemoryMiB: {
        name: "pointCloudGpuMemoryMiB",
        defaultValue: DEFAULT_POINT_CLOUD_POLICY.gpuMemoryMiB,
        schema: pointCloudGpuMemorySchema
    } satisfies AppStateOptions<MapViewStateServiceValues["pointCloudGpuMemoryMiB"]>,

    mapZoomStep: {
        name: "mapZoomStep",
        defaultValue: DEFAULT_MAP_ZOOM_STEP,
        schema: z.coerce.number(),
        fromStorage: (value) => clampMapZoomStep(Number(value))
    } satisfies AppStateOptions<MapViewStateServiceValues["mapZoomStep"]>,

    featureZoomClearanceMeters: {
        name: "featureZoomClearanceMeters",
        defaultValue: DEFAULT_FEATURE_ZOOM_CLEARANCE_METERS,
        schema: z.coerce.number(),
        fromStorage: (value) => clampFeatureZoomClearanceMeters(Number(value))
    } satisfies AppStateOptions<MapViewStateServiceValues["featureZoomClearanceMeters"]>,

    tilesLoadLimit: {
        name: "tilesLoadLimit",
        defaultValue: MAX_NUM_TILES_TO_LOAD,
        schema: z.coerce.number().nonnegative(),
        urlParamName: "tll"
    } satisfies AppStateOptions<MapViewStateServiceValues["tilesLoadLimit"]>
};

/**
 * The store starts with no live view records. registerView materializes each UI pane from
 * its declaration's per-view default when MapViewStateService establishes membership.
 * The owner binds those same declarations to storage/URL codecs; there is no second set of defaults.
 */
export function withMapViewState() {
    return signalStoreFeature(
        withState(() => {
            const initial: MapViewStateServiceValues = {
                marker: deepCopy(ownerState.marker.defaultValue),
                markedPosition: deepCopy(ownerState.markedPosition.defaultValue),
                focusedViewId: "",
                viewSync: deepCopy(ownerState.viewSync.defaultValue),
                cameraViewData: {},
                mode2d: {},
                deckAntialiasingEnabled: deepCopy(ownerState.deckAntialiasingEnabled.defaultValue),
                semanticCompositingEnabled: deepCopy(ownerState.semanticCompositingEnabled.defaultValue),
                contactShadingEnabled: deepCopy(ownerState.contactShadingEnabled.defaultValue),
                lod3TileThreshold: deepCopy(ownerState.lod3TileThreshold.defaultValue),
                tileSubsetRenderWorkerCount: deepCopy(ownerState.tileSubsetRenderWorkerCount.defaultValue),
                pointCloudDownsamplingEnabled: deepCopy(ownerState.pointCloudDownsamplingEnabled.defaultValue),
                pointCloudDetailPixels: deepCopy(ownerState.pointCloudDetailPixels.defaultValue),
                pointCloudWorkingMemoryMiB: deepCopy(ownerState.pointCloudWorkingMemoryMiB.defaultValue),
                pointCloudGpuMemoryMiB: deepCopy(ownerState.pointCloudGpuMemoryMiB.defaultValue),
                mapZoomStep: deepCopy(ownerState.mapZoomStep.defaultValue),
                featureZoomClearanceMeters: deepCopy(ownerState.featureZoomClearanceMeters.defaultValue),
                tilesLoadLimit: deepCopy(ownerState.tilesLoadLimit.defaultValue)
            };
            return {views: initial};
        })
    );
}
