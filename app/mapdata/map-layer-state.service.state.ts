import {signalStoreFeature, withState} from "@ngrx/signals";
import {z} from "zod";
import {Boolish} from "../shared/app-state";
import {AppStateOptions, deepCopy} from "../shared/state-value";
import {
    clampBackgroundOpacity,
    DEFAULT_BACKGROUND_LAYER_ID,
    DEFAULT_BACKGROUND_OPACITY
} from "./background-layer.model";
import {
    BackgroundLayerViewState,
    clampTileGridOpacity,
    DEFAULT_TILE_GRID_COLOR,
    DEFAULT_TILE_GRID_LEVEL,
    DEFAULT_TILE_GRID_OPACITY,
    LayerPresetSelections,
    MapPresetSelections,
    normalizeTileGridColor,
    STORED_LAYER_PRESET_REF_SCHEMA,
    TileGridMode
} from "./map-layer-state.model";

export interface MapLayerStateServiceValues {
    layerSyncOptions: Record<string, boolean>;
    background: Record<string, BackgroundLayerViewState>;
    layerNames: Array<string>;
    layerVisibility: Record<string, Array<boolean>>;
    viewTileBorders: Record<string, boolean>;
    viewTileGridMode: Record<string, TileGridMode>;
    viewTileGridLevel: Record<string, number>;
    viewTileGridAutoLevel: Record<string, boolean>;
    viewTileGridColor: Record<string, string>;
    viewTileGridOpacity: Record<string, number>;
    layerZoomLevel: Record<string, Array<number>>;
    layerAutoZoomLevel: Record<string, Array<boolean>>;
    options: Map<string, Record<string, string | number | boolean>>;
    layerPresetSelection: Record<string, LayerPresetSelections>;
    mapPresetSelection: Record<string, MapPresetSelections>;
    mapsOpen: boolean;
}

/** Named codec declarations are also the single source of SignalStore defaults. */
export const ownerState = {
    layerSyncOptions: {
        name: "layerSyncOptions",
        defaultValue: false,
        schema: Boolish,
        urlIncludeInVisualizationOnly: false
    } satisfies AppStateOptions<MapLayerStateServiceValues["layerSyncOptions"][string]>,

    background: {
        name: "background",
        defaultValue: {
            layerId: DEFAULT_BACKGROUND_LAYER_ID,
            opacity: DEFAULT_BACKGROUND_OPACITY
        },
        schema: z.string(),
        toStorage: (value: BackgroundLayerViewState) =>
            `${encodeURIComponent(value.layerId ?? "")}~${clampBackgroundOpacity(value.opacity)}`,
        fromStorage: (payload: any, currentValue: BackgroundLayerViewState): BackgroundLayerViewState => {
            const parts = String(payload).split("~");
            const layerId = parts[0] ? decodeURIComponent(parts[0]) : null;
            const opacity = parts[1] === undefined ? currentValue.opacity : clampBackgroundOpacity(Number(parts[1]));
            return {layerId, opacity};
        },
        urlParamName: "bg"
    } satisfies AppStateOptions<MapLayerStateServiceValues["background"][string]>,

    layerNames: {
        name: "layerNames",
        defaultValue: [],
        schema: z.array(z.string()),
        urlParamName: "l"
    } satisfies AppStateOptions<MapLayerStateServiceValues["layerNames"]>,

    layerVisibility: {
        name: "visibility",
        defaultValue: [],
        schema: z.array(Boolish),
        urlParamName: "v"
    } satisfies AppStateOptions<MapLayerStateServiceValues["layerVisibility"][string]>,

    viewTileBorders: {
        name: "tileBorders",
        defaultValue: true,
        schema: Boolish,
        urlParamName: "tb"
    } satisfies AppStateOptions<MapLayerStateServiceValues["viewTileBorders"][string]>,

    viewTileGridMode: {
        name: "tileGridMode",
        defaultValue: "nds",
        schema: z.enum(["xyz", "nds"]),
        urlParamName: "tgm"
    } satisfies AppStateOptions<MapLayerStateServiceValues["viewTileGridMode"][string]>,

    viewTileGridLevel: {
        name: "tileGridLevel",
        defaultValue: DEFAULT_TILE_GRID_LEVEL,
        schema: z.coerce.number().int().min(0).max(22),
        urlParamName: "tgl"
    } satisfies AppStateOptions<MapLayerStateServiceValues["viewTileGridLevel"][string]>,

    viewTileGridAutoLevel: {
        name: "tileGridAutoLevel",
        defaultValue: false,
        schema: Boolish,
        urlParamName: "tga"
    } satisfies AppStateOptions<MapLayerStateServiceValues["viewTileGridAutoLevel"][string]>,

    viewTileGridColor: {
        name: "tileGridColor",
        defaultValue: DEFAULT_TILE_GRID_COLOR,
        schema: z.string(),
        toStorage: (value: string) => normalizeTileGridColor(value),
        fromStorage: (payload: unknown) => normalizeTileGridColor(payload),
        urlParamName: "tgc"
    } satisfies AppStateOptions<MapLayerStateServiceValues["viewTileGridColor"][string]>,

    viewTileGridOpacity: {
        name: "tileGridOpacity",
        defaultValue: DEFAULT_TILE_GRID_OPACITY,
        schema: z.coerce.number().min(0).max(100),
        toStorage: (value: number) => clampTileGridOpacity(value),
        fromStorage: (payload: unknown) => clampTileGridOpacity(payload),
        urlParamName: "tgo"
    } satisfies AppStateOptions<MapLayerStateServiceValues["viewTileGridOpacity"][string]>,

    layerZoomLevel: {
        name: "zoomLevel",
        defaultValue: [],
        schema: z.array(z.number().min(0).max(15)),
        urlParamName: "z"
    } satisfies AppStateOptions<MapLayerStateServiceValues["layerZoomLevel"][string]>,

    layerAutoZoomLevel: {
        name: "autoZoomLevel",
        defaultValue: [],
        schema: z.array(Boolish),
        urlParamName: "az"
    } satisfies AppStateOptions<MapLayerStateServiceValues["layerAutoZoomLevel"][string]>,

    layerPresetSelection: {
        name: "stylePresetSelection",
        defaultValue: {},
        schema: z.record(z.string(), z.record(z.string(), STORED_LAYER_PRESET_REF_SCHEMA)),
        snapshotPersist: false
    } satisfies AppStateOptions<MapLayerStateServiceValues["layerPresetSelection"][string]>,

    mapPresetSelection: {
        name: "mapPresetSelection",
        defaultValue: {},
        schema: z.record(z.string(), z.string()),
        snapshotPersist: false
    } satisfies AppStateOptions<MapLayerStateServiceValues["mapPresetSelection"][string]>,

    mapsOpen: {
        name: "mapsOpenState",
        defaultValue: false,
        schema: Boolish
    } satisfies AppStateOptions<MapLayerStateServiceValues["mapsOpen"]>
};

/**
 * The store starts with no live view records. registerView materializes each UI pane from
 * its declaration's per-view default when MapViewStateService establishes membership.
 * The owner binds those same declarations to storage/URL codecs; there is no second set of defaults.
 */
export function withMapLayerState() {
    return signalStoreFeature(
        withState(() => {
            const initial: MapLayerStateServiceValues = {
                layerSyncOptions: {},
                background: {},
                layerNames: deepCopy(ownerState.layerNames.defaultValue),
                layerVisibility: {},
                viewTileBorders: {},
                viewTileGridMode: {},
                viewTileGridLevel: {},
                viewTileGridAutoLevel: {},
                viewTileGridColor: {},
                viewTileGridOpacity: {},
                layerZoomLevel: {},
                layerAutoZoomLevel: {},
                options: new Map(),
                layerPresetSelection: {},
                mapPresetSelection: {},
                mapsOpen: deepCopy(ownerState.mapsOpen.defaultValue)
            };
            return {layers: initial};
        })
    );
}
