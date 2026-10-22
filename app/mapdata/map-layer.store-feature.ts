import {signalStoreFeature, type, withMethods, withProps} from "@ngrx/signals";
import {z} from "zod";
import type {NamedEntityState} from "@ngrx/signals/entities";
import type {Params} from "@angular/router";
import type {ViewIdentity} from "../mapview/view-id";
import {
    patchAppState,
    perView,
    PersistenceDescriptor,
    StateWriteOrigin,
    transient,
    withPersistedState,
} from "../shared/persisted-state";
import {StyleOptionsCodec} from "../shared/state-codec";
import type {BackgroundLayerConfig} from "../shared/app-config.service";
import type {LayerPresetRef} from "../styledata/layer-preset.model";
import {isSourceOrMetaData, LayerViewConfig, StyleOptionStateUpdate} from "./map-layer-state.model";
import {Boolish} from "../shared/state-value";
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
    TileGridMode,
    tileGridMaxLevel,
} from "./map-layer-state.model";

/**
 * Each pane's presentation is keyed by its logical view ID. Within a pane, layer
 * visibility and level arrays follow the shared `layerNames` order. Updating that
 * order must therefore update those arrays together so values stay with their layers.
 */
export interface MapLayerValues {
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
    authoritativeUrlLayers: boolean;
}

/**
 * Retains the saved names, defaults and compact URL formats for layer controls.
 * Each per-view declaration describes one pane's value; `perView` below maps its
 * saved array onto the native records keyed by view ID.
 */
export const ownerState = {
    layerSyncOptions: {
        name: "layerSyncOptions",
        defaultValue: false,
        schema: Boolish,
        urlIncludeInVisualizationOnly: false
    } satisfies AppStateOptions<MapLayerValues["layerSyncOptions"][string]>,

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
    } satisfies AppStateOptions<MapLayerValues["background"][string]>,

    layerNames: {
        name: "layerNames",
        defaultValue: [],
        schema: z.array(z.string()),
        urlParamName: "l"
    } satisfies AppStateOptions<MapLayerValues["layerNames"]>,

    layerVisibility: {
        name: "visibility",
        defaultValue: [],
        schema: z.array(Boolish),
        urlParamName: "v"
    } satisfies AppStateOptions<MapLayerValues["layerVisibility"][string]>,

    viewTileBorders: {
        name: "tileBorders",
        defaultValue: true,
        schema: Boolish,
        urlParamName: "tb"
    } satisfies AppStateOptions<MapLayerValues["viewTileBorders"][string]>,

    viewTileGridMode: {
        name: "tileGridMode",
        defaultValue: "nds",
        schema: z.enum(["xyz", "nds"]),
        urlParamName: "tgm"
    } satisfies AppStateOptions<MapLayerValues["viewTileGridMode"][string]>,

    viewTileGridLevel: {
        name: "tileGridLevel",
        defaultValue: DEFAULT_TILE_GRID_LEVEL,
        schema: z.coerce.number().int().min(0).max(22),
        urlParamName: "tgl"
    } satisfies AppStateOptions<MapLayerValues["viewTileGridLevel"][string]>,

    viewTileGridAutoLevel: {
        name: "tileGridAutoLevel",
        defaultValue: false,
        schema: Boolish,
        urlParamName: "tga"
    } satisfies AppStateOptions<MapLayerValues["viewTileGridAutoLevel"][string]>,

    viewTileGridColor: {
        name: "tileGridColor",
        defaultValue: DEFAULT_TILE_GRID_COLOR,
        schema: z.string(),
        toStorage: (value: string) => normalizeTileGridColor(value),
        fromStorage: (payload: unknown) => normalizeTileGridColor(payload),
        urlParamName: "tgc"
    } satisfies AppStateOptions<MapLayerValues["viewTileGridColor"][string]>,

    viewTileGridOpacity: {
        name: "tileGridOpacity",
        defaultValue: DEFAULT_TILE_GRID_OPACITY,
        schema: z.coerce.number().min(0).max(100),
        toStorage: (value: number) => clampTileGridOpacity(value),
        fromStorage: (payload: unknown) => clampTileGridOpacity(payload),
        urlParamName: "tgo"
    } satisfies AppStateOptions<MapLayerValues["viewTileGridOpacity"][string]>,

    layerZoomLevel: {
        name: "zoomLevel",
        defaultValue: [],
        schema: z.array(z.number().min(0).max(15)),
        urlParamName: "z"
    } satisfies AppStateOptions<MapLayerValues["layerZoomLevel"][string]>,

    layerAutoZoomLevel: {
        name: "autoZoomLevel",
        defaultValue: [],
        schema: z.array(Boolish),
        urlParamName: "az"
    } satisfies AppStateOptions<MapLayerValues["layerAutoZoomLevel"][string]>,

    layerPresetSelection: {
        name: "stylePresetSelection",
        defaultValue: {},
        schema: z.record(z.string(), z.record(z.string(), STORED_LAYER_PRESET_REF_SCHEMA)),
        snapshotPersist: false
    } satisfies AppStateOptions<MapLayerValues["layerPresetSelection"][string]>,

    mapPresetSelection: {
        name: "mapPresetSelection",
        defaultValue: {},
        schema: z.record(z.string(), z.string()),
        snapshotPersist: false
    } satisfies AppStateOptions<MapLayerValues["mapPresetSelection"][string]>,

    mapsOpen: {
        name: "mapsOpenState",
        defaultValue: false,
        schema: Boolish
    } satisfies AppStateOptions<MapLayerValues["mapsOpen"]>
};

type LayerRoot = NamedEntityState<ViewIdentity, "view"> & {layers: MapLayerValues};
type StyleOption = string | number | boolean;

/**
 * The compact style dictionary stores one value per pane position. Native style
 * options use logical view IDs, so this descriptor projects the current view order
 * on export and assigns imported positions back to those IDs before publication.
 */
class StyleOptionsPersistence extends PersistenceDescriptor<Map<string, StyleOption[]>> {
    constructor() {
        super("layers", "options", new StyleOptionsCodec());
    }

    override read(state: object): Map<string, StyleOption[]> {
        const root = state as LayerRoot;
        return new Map([...root.layers.options].map(([key, values]) => [
            key,
            root.viewIds.map(id => values[id]),
        ]));
    }

    override replace<S extends object>(state: S, value: Map<string, StyleOption[]>): S {
        const root = state as unknown as LayerRoot;
        const options = new Map([...value].map(([key, values]) => [
            key,
            Object.fromEntries(root.viewIds.map((id, index) => [id, values[index]])),
        ]));
        return {...state, layers: {...root.layers, options}};
    }

    override hasChanged(previous: object, current: object): boolean {
        const before = previous as LayerRoot;
        const after = current as LayerRoot;
        // URL style keys contain layer indices, so a changed layer order matters
        // even when every option retains the same value.
        return before.layers.layerNames !== after.layers.layerNames || super.hasChanged(previous, current);
    }

    override serialize(state: object, forUrl: boolean) {
        const root = state as LayerRoot;
        return (this.codec as StyleOptionsCodec).serialize(
            this.read(state),
            forUrl,
            {layerNames: root.layers.layerNames, viewCount: root.viewIds.length},
        );
    }

    override deserialize<S extends object>(state: S, raw: string | Params): S {
        const root = state as unknown as LayerRoot;
        return this.replace(state, (this.codec as StyleOptionsCodec).deserialize(
            raw,
            this.read(state),
            {layerNames: root.layers.layerNames, viewCount: root.viewIds.length},
        ));
    }
}

/**
 * Prepare all positional layer arrays together. The map tree calls this while
 * materializing a newly available layer, and preset operations reuse the same
 * calculation before publishing their complete visibility/style change.
 */
export function updateMapLayerConfig(
    layers: MapLayerValues,
    ids: readonly (string | number)[],
    mapId: string,
    layerId: string,
    viewConfig: readonly LayerViewConfig[],
    fallbackLevel = 13,
): MapLayerValues {
    if (isSourceOrMetaData(layerId) || viewConfig.length < ids.length) {
        return layers;
    }
    const mapLayerId = `${mapId}/${layerId}`;
    const layerNames = layers.layerNames.includes(mapLayerId)
        ? layers.layerNames
        : [...layers.layerNames, mapLayerId];
    const index = layerNames.indexOf(mapLayerId);
    const setColumn = <T>(records: Record<string, T[]>, values: readonly T[], fallback: T) =>
        Object.fromEntries(ids.map((id, view) => {
            const column = [...(records[id] ?? [])];
            while (column.length <= index) {
                column.push(fallback);
            }
            column[index] = values[view];
            return [id, column];
        }));
    return {
        ...layers,
        layerNames,
        layerVisibility: setColumn(layers.layerVisibility, viewConfig.map(value => value.visible), false),
        layerZoomLevel: setColumn(layers.layerZoomLevel, viewConfig.map(value => value.level), fallbackLevel),
        layerAutoZoomLevel: setColumn(layers.layerAutoZoomLevel, viewConfig.map(value => value.autoLevel), true),
    };
}

/**
 * Validates all layer targets before preparing a batch of style-option values.
 * Missing trailing pane values repeat the final supplied value, preserving the
 * existing compact representation's broadcast behavior.
 */
export function updateStyleOptions(
    layers: MapLayerValues,
    ids: readonly (string | number)[],
    updates: readonly StyleOptionStateUpdate[],
): MapLayerValues {
    for (const update of updates) {
        if (!layers.layerNames.includes(`${update.mapId}/${update.layerId}`)) {
            throw new Error(`Unknown map layer '${update.mapId}/${update.layerId}' when writing style option values`);
        }
    }
    const options = new Map(layers.options);
    for (const update of updates) {
        const key = `${update.mapId}/${update.layerId}/${update.shortStyleId}/${update.optionId}`;
        options.set(key, Object.fromEntries(ids.map((id, index) => [
            id,
            update.values[index] ?? update.values.at(-1) ?? false,
        ])));
    }
    return {...layers, options};
}

/**
 * Copies a source pane's background, grid, layers, options and selected presets.
 * Nested arrays and preset objects are copied for each destination pane. The caller
 * combines this prepared result with any camera or policy change and publishes once.
 */
export function synchronizeLayerViews(
    layers: MapLayerValues,
    ids: readonly (string | number)[],
    sourceId: string,
): MapLayerValues {
    const next = {...layers};
    const keys = [
        "background",
        "layerVisibility",
        "layerZoomLevel",
        "layerAutoZoomLevel",
        "viewTileBorders",
        "viewTileGridMode",
        "viewTileGridLevel",
        "viewTileGridAutoLevel",
        "viewTileGridColor",
        "viewTileGridOpacity",
        "layerPresetSelection",
        "mapPresetSelection",
    ] as const;
    for (const key of keys) {
        const source = layers[key][sourceId];
        (next[key] as Record<string, unknown>) = Object.fromEntries(ids.map(id => [id, deepCopy(source)]));
    }
    next.options = new Map([...layers.options].map(([key, values]) => [
        key,
        Object.fromEntries(ids.map(id => [id, values[sourceId] ?? false])),
    ]));
    return next;
}

/**
 * Older links and saved state used an `osm` visibility/opacity pair. Prepare its
 * background values only when the newer background field is absent. Startup folds
 * this result into its complete restore, so no observer sees an intermediate default
 * background before the legacy choice is applied.
 */
export function prepareLegacyOsmState<State extends {
    viewIds: readonly (string | number)[];
    layers: MapLayerValues;
}>(
    state: State,
    params: Params,
    storage: Pick<Storage, "getItem">,
): State {
    if (storage.getItem("background") !== null || params["bg"] !== undefined) {
        return state;
    }
    const raw = params["osm"] ?? storage.getItem("osm");
    if (raw === undefined || raw === null) {
        return state;
    }

    let tokens: unknown[];
    try {
        tokens = String(raw).trim().startsWith("[")
            ? JSON.parse(String(raw))
            : String(raw).split(",");
    } catch {
        return state;
    }
    if (!Array.isArray(tokens)) {
        return state;
    }

    const background = {...state.layers.background};
    tokens.slice(0, state.viewIds.length).forEach((token, index) => {
        const [enabled, opacity] = String(token).split("~");
        background[String(state.viewIds[index])] = {
            layerId: enabled === "1" || enabled.toLowerCase() === "true" ? "osm" : null,
            opacity: opacity === undefined ? 6 : clampBackgroundOpacity(Number(opacity)),
        };
    });
    return {...state, layers: {...state.layers, background}};
}

/**
 * Owns layer presentation values and their operations. Signals such as
 * `store.layers.background()` read records keyed by view ID; methods accepting a
 * pane index resolve it against the current view order before preparing a change.
 * Loading layer resources and determining catalog availability remain service work.
 */
export function withMapLayerState() {
    return signalStoreFeature(
        {state: type<NamedEntityState<ViewIdentity, "view">>()},
        withPersistedState<"layers", MapLayerValues>("layers", {
            layerSyncOptions: perView<MapLayerValues["layerSyncOptions"][string]>(ownerState.layerSyncOptions),
            background: perView<MapLayerValues["background"][string]>(ownerState.background),
            layerNames: ownerState.layerNames,
            layerVisibility: perView<MapLayerValues["layerVisibility"][string]>(ownerState.layerVisibility),
            viewTileBorders: perView<MapLayerValues["viewTileBorders"][string]>(ownerState.viewTileBorders),
            viewTileGridMode: perView<MapLayerValues["viewTileGridMode"][string]>(ownerState.viewTileGridMode),
            viewTileGridLevel: perView<MapLayerValues["viewTileGridLevel"][string]>(ownerState.viewTileGridLevel),
            viewTileGridAutoLevel: perView<MapLayerValues["viewTileGridAutoLevel"][string]>(ownerState.viewTileGridAutoLevel),
            viewTileGridColor: perView<MapLayerValues["viewTileGridColor"][string]>(ownerState.viewTileGridColor),
            viewTileGridOpacity: perView<MapLayerValues["viewTileGridOpacity"][string]>(ownerState.viewTileGridOpacity),
            layerZoomLevel: perView<MapLayerValues["layerZoomLevel"][string]>(ownerState.layerZoomLevel),
            layerAutoZoomLevel: perView<MapLayerValues["layerAutoZoomLevel"][string]>(ownerState.layerAutoZoomLevel),
            // The descriptor below owns the existing compact style-option format.
            options: transient(new Map()),
            layerPresetSelection: perView<MapLayerValues["layerPresetSelection"][string]>(ownerState.layerPresetSelection),
            mapPresetSelection: perView<MapLayerValues["mapPresetSelection"][string]>(ownerState.mapPresetSelection),
            mapsOpen: ownerState.mapsOpen,
            authoritativeUrlLayers: transient(false),
        }),
        withProps(() => ({
            styleOptionsPersistence: new StyleOptionsPersistence(),
        })),
        withMethods(store => {
            const optionCodec = new StyleOptionsCodec();
            const idAt = (index: number): string => {
                const id = store.viewIds()[index];
                if (id === undefined) {
                    throw new Error(`View index ${index} is unavailable`);
                }
                return String(id);
            };
            function setLayerViewValue<Key extends keyof MapLayerValues>(
                key: Key,
                index: number,
                value: MapLayerValues[Key] extends Record<string, infer Value> ? Value : never,
            ) {
                const id = idAt(index);
                patchAppState(store, {
                    layers: {
                        ...store.layers(),
                        [key]: {...store.layers()[key] as object, [id]: value},
                    },
                });
            }

            /** Project one layer's settings into the pane order expected by the map tree. */
            function mapLayerConfig(
                mapId: string,
                layerId: string,
                fallbackVisibility = true,
                fallbackLevel = 13,
            ): LayerViewConfig[] {
                if (isSourceOrMetaData(layerId)) {
                    return [];
                }
                const layers = store.layers();
                const index = layers.layerNames.indexOf(`${mapId}/${layerId}`);
                // An explicit layer list in a shared link keeps unlisted layers hidden
                // when the datasource catalog subsequently supplies their defaults.
                const visible = index < 0 && layers.authoritativeUrlLayers ? false : fallbackVisibility;
                return store.viewIds().map(id => ({
                    autoLevel: layers.layerAutoZoomLevel[id]?.[index] ?? true,
                    visible: layers.layerVisibility[id]?.[index] ?? visible,
                    level: layers.layerZoomLevel[id]?.[index] ?? fallbackLevel,
                }));
            }
            function setMapLayerConfig(
                mapId: string,
                layerId: string,
                config: LayerViewConfig[],
                fallbackLevel = 13,
                origin: StateWriteOrigin = "user",
            ) {
                patchAppState(store, {
                    layers: updateMapLayerConfig(store.layers(), store.viewIds(), mapId, layerId, config, fallbackLevel),
                }, origin);
            }

            function styleOptionValues(
                mapId: string,
                layerId: string,
                shortStyleId: string,
                optionId: string,
                optionType: string,
                defaultValue: StyleOption,
            ): StyleOption[] {
                const values = store.layers.options().get(`${mapId}/${layerId}/${shortStyleId}/${optionId}`);
                return store.viewIds().map(id => optionCodec.coerceOptionValue(values?.[id] ?? defaultValue, optionType));
            }
            function setStyleOptionValuesBatch(updates: StyleOptionStateUpdate[], origin: StateWriteOrigin = "user") {
                if (updates.length) {
                    patchAppState(store, {
                        layers: updateStyleOptions(store.layers(), store.viewIds(), updates),
                    }, origin);
                }
            }
            return {
                setLayerViewValue,

                setLayerNames(layerNames: string[]) {
                    patchAppState(store, {layers: {...store.layers(), layerNames}});
                },

                setMapsOpen(mapsOpen: boolean) {
                    patchAppState(store, {layers: {...store.layers(), mapsOpen}});
                },

                getLayerSyncOption(index: number) {
                    return store.layers.layerSyncOptions()[idAt(index)] ?? false;
                },

                setLayerSyncOption(index: number, enabled: boolean) {
                    setLayerViewValue("layerSyncOptions", index, enabled);
                },

                getBackgroundState(index: number): BackgroundLayerViewState {
                    const value = store.layers.background()[idAt(index)];
                    return {...value, opacity: clampBackgroundOpacity(value.opacity)};
                },

                /**
                 * Resolve an unavailable saved background against the current configuration.
                 * The returned display value does not overwrite the user's saved choice.
                 */
                resolveBackgroundState(
                    index: number,
                    available: readonly BackgroundLayerConfig[],
                    defaultId: string | null,
                ): BackgroundLayerViewState {
                    const value = store.layers.background()[idAt(index)];
                    if (value.layerId === null || available.some(layer => layer.id === value.layerId)) {
                        return value;
                    }
                    const fallback = available.find(layer => layer.id === defaultId);
                    return fallback
                        ? {layerId: fallback.id, opacity: fallback.defaultOpacity}
                        : {layerId: null, opacity: value.opacity};
                },

                /** Publish the background choice and opacity for all affected panes together. */
                setBackgroundState(
                    index: number,
                    layerId: string | null,
                    opacity: number,
                    synchronize = false,
                ): void {
                    const source = idAt(index);
                    const value = {layerId, opacity: clampBackgroundOpacity(opacity)};
                    const background = {...store.layers.background()};
                    for (const id of synchronize ? store.viewIds().map(String) : [source]) {
                        background[id] = value;
                    }
                    patchAppState(store, {layers: {...store.layers(), background}});
                },

                /**
                 * A grid-mode change can also change the valid level range. Prepare the
                 * full grid presentation first, then copy it to synchronized panes in
                 * the same publication so the renderer never observes a mismatched pair.
                 */
                setGridPresentation(
                    index: number,
                    value: Partial<{
                        visible: boolean;
                        mode: TileGridMode;
                        level: number;
                        autoLevel: boolean;
                        color: string;
                        opacity: number;
                    }>,
                    synchronize = false,
                ): void {
                    const id = idAt(index);
                    const layers = store.layers();
                    const mode = value.mode ?? layers.viewTileGridMode[id];
                    const level = Math.min(
                        tileGridMaxLevel(mode),
                        Math.max(0, Math.round(value.level ?? layers.viewTileGridLevel[id])),
                    );
                    const fields = {
                        viewTileBorders: value.visible ?? layers.viewTileBorders[id],
                        viewTileGridMode: mode,
                        viewTileGridLevel: level,
                        viewTileGridAutoLevel: value.autoLevel ?? layers.viewTileGridAutoLevel[id],
                        viewTileGridColor: normalizeTileGridColor(value.color ?? layers.viewTileGridColor[id]),
                        viewTileGridOpacity: clampTileGridOpacity(value.opacity ?? layers.viewTileGridOpacity[id])
                    };
                    const next = {...layers};
                    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
                        (next[key] as Record<string, unknown>) = {...layers[key]};
                        for (const target of synchronize ? store.viewIds().map(String) : [id]) {
                            (next[key] as Record<string, unknown>)[target] = fields[key];
                        }
                    }
                    patchAppState(store, {layers: next});
                },

                getBackgroundOpacity(index: number) {
                    return clampBackgroundOpacity(store.layers.background()[idAt(index)].opacity);
                },

                mapLayerConfig,
                setMapLayerConfig,

                /** Materialize a newly available layer without marking its defaults as a user edit. */
                initializeMapLayerConfig(mapId: string, layerId: string, visibility = true, level = 13) {
                    const values = mapLayerConfig(mapId, layerId, visibility, level);
                    setMapLayerConfig(mapId, layerId, values, level, "system");
                    return values;
                },

                styleOptionValues,

                /** Resolve declared option defaults for each pane as one system-owned value. */
                initializeStyleOptionValues(
                    mapId: string,
                    layerId: string,
                    shortStyleId: string,
                    optionId: string,
                    type: string,
                    fallback: StyleOption,
                ) {
                    const values = styleOptionValues(mapId, layerId, shortStyleId, optionId, type, fallback);
                    setStyleOptionValuesBatch([{mapId, layerId, shortStyleId, optionId, values}], "system");
                    return values;
                },

                setStyleOptionValues(
                    mapId: string,
                    layerId: string,
                    shortStyleId: string,
                    optionId: string,
                    values: StyleOption[],
                ) {
                    setStyleOptionValuesBatch([{mapId, layerId, shortStyleId, optionId, values}]);
                },

                setStyleOptionValuesBatch,

                getLayerPresetSelection(index: number, mapId: string, layerId: string): LayerPresetRef | null {
                    const ref = store.layers.layerPresetSelection()[idAt(index)]?.[mapId]?.[layerId];
                    return ref ? {...ref} : null;
                },

                setLayerPresetSelection(index: number, mapId: string, layerId: string, ref: LayerPresetRef | null) {
                    const current = store.layers.layerPresetSelection()[idAt(index)] ?? {};
                    const next = {...current};
                    const map = {...next[mapId]};
                    if (ref) {
                        map[layerId] = {...ref};
                    } else {
                        delete map[layerId];
                    }
                    if (Object.keys(map).length) {
                        next[mapId] = map;
                    } else {
                        delete next[mapId];
                    }
                    setLayerViewValue("layerPresetSelection", index, next);
                },

                getMapPresetSelection(index: number, mapId: string) {
                    return store.layers.mapPresetSelection()[idAt(index)]?.[mapId] ?? null;
                },

                setMapPresetSelection(index: number, mapId: string, presetId: string | null) {
                    const next = {...store.layers.mapPresetSelection()[idAt(index)]};
                    if (presetId) {
                        next[mapId] = presetId;
                    } else {
                        delete next[mapId];
                    }
                    setLayerViewValue("mapPresetSelection", index, next);
                },
            };
        }),
    );
}
