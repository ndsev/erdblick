import {getState, signalStoreFeature, type, withMethods} from "@ngrx/signals";
import type {NamedEntityState} from "@ngrx/signals/entities";
import {InspectionValues, normalizeInspections} from "../inspection/inspection.store-feature";
import type {ViewIdentity} from "../mapview/view-id";
import type {AppLayoutValues} from "../shared/app-layout.store-feature";
import {patchAppState, StateWriteOrigin} from "../shared/persisted-state";
import type {StyleValues} from "../styledata/style.store-feature";
import {
    MapLayerValues,
    synchronizeLayerViews,
    updateMapLayerConfig,
    updateStyleOptions,
} from "./map-layer.store-feature";
import type {MapLayerTree} from "./map.tree.model";

/**
 * The resource tree resolves presets and defaults, then supplies copied values.
 * This feature receives that presentation without retaining the live mutable tree.
 */
type LayerPresentation = ReturnType<MapLayerTree["collectLayerPresentation"]>;
type CatalogState = NamedEntityState<ViewIdentity, "view"> & {
    layers: MapLayerValues;
    inspection: InspectionValues;
    layout: AppLayoutValues;
    styles: StyleValues;
};

/** Prepare a complete preset or catalog presentation without publishing any partial changes. */
function prepareLayerPresentation(
    layers: MapLayerValues,
    ids: readonly (string | number)[],
    presentation: LayerPresentation,
    syncFromView?: number,
): MapLayerValues {
    // Validate all targets before preparing any changes. A preset spanning several
    // layers either produces one complete value or leaves the application unchanged.
    for (const config of presentation.configs) {
        if (config.viewConfigs.length !== ids.length) {
            throw new Error("Layer presentation has a stale view count");
        }
        for (const value of config.viewConfigs) {
            if (!Number.isFinite(value.level) || value.level < 0 || value.level > 22) {
                throw new Error("Invalid layer level");
            }
        }
    }
    const viewId = (index: number): string => {
        if (!Number.isInteger(index) || ids[index] === undefined) {
            throw new Error("Layer presentation targets a retired view");
        }
        return String(ids[index]);
    };
    if (syncFromView !== undefined) {
        viewId(syncFromView);
    }
    presentation.layerPresets.forEach(value => viewId(value.viewIndex));
    presentation.mapPresets.forEach(value => viewId(value.viewIndex));

    let next = layers;
    for (const config of presentation.configs) {
        next = updateMapLayerConfig(next, ids, config.mapId, config.layerId, config.viewConfigs);
    }
    next = updateStyleOptions(next, ids, presentation.options);
    // Preset selections describe the values prepared above. Update both in this
    // candidate so a UI observer never sees a selected preset with the old options.
    const layerPresetSelection = {...next.layerPresetSelection};
    for (const value of presentation.layerPresets) {
        const id = viewId(value.viewIndex);
        const selection = {...layerPresetSelection[id]};
        const map = {...selection[value.mapId]};
        if (value.ref) {
            map[value.layerId] = {...value.ref};
        } else {
            delete map[value.layerId];
        }
        if (Object.keys(map).length) {
            selection[value.mapId] = map;
        } else {
            delete selection[value.mapId];
        }
        layerPresetSelection[id] = selection;
    }
    const mapPresetSelection = {...next.mapPresetSelection};
    for (const value of presentation.mapPresets) {
        const id = viewId(value.viewIndex);
        const selection = {...mapPresetSelection[id]};
        if (value.presetId) {
            selection[value.mapId] = value.presetId;
        } else {
            delete selection[value.mapId];
        }
        mapPresetSelection[id] = selection;
    }
    next = {...next, layerPresetSelection, mapPresetSelection};
    return syncFromView === undefined
        ? next
        : synchronizeLayerViews(next, ids, viewId(syncFromView));
}

/**
 * A datasource refresh changes several domains together: new layer defaults become
 * available, obsolete style choices disappear, and inspections of retired layers
 * close. The resource owner prepares its tree first; this feature publishes the
 * corresponding native values once. MapInfo installs the ready resource tree
 * before this publication, then emits its tree-replacement notification afterward.
 */
export function withMapCatalogState() {
    return signalStoreFeature(
        {state: type<CatalogState>()},
        withMethods(store => ({
            /**
             * Publish a layer edit or preset application, including any requested
             * synchronization, after the resource has resolved its complete values.
             */
            applyLayerPresentation(
                presentation: LayerPresentation,
                options: {
                    syncFromView?: number;
                    layerSync?: {viewIndex: number; enabled: boolean};
                    origin?: StateWriteOrigin;
                } = {},
            ): void {
                let layers = prepareLayerPresentation(
                    store.layers(),
                    store.viewIds(),
                    presentation,
                    options.syncFromView,
                );
                if (options.layerSync) {
                    const id = store.viewIds()[options.layerSync.viewIndex];
                    if (id === undefined) {
                        throw new Error("Layer synchronization targets a retired view");
                    }
                    layers = {
                        ...layers,
                        layerSyncOptions: {
                            ...layers.layerSyncOptions,
                            [id]: options.layerSync.enabled,
                        },
                    };
                }
                patchAppState(store, {layers}, options.origin ?? "user");
            },

            /**
             * The resource owner decides whether the catalog is complete enough to
             * prune and which inspections are still valid. This method receives those
             * facts as values and applies the resulting cross-domain change once.
             */
            applyCatalogState(
                presentation: LayerPresentation,
                catalog: {
                    layerNames: readonly string[];
                    styleIds: readonly string[];
                    styleShortIds: readonly string[];
                    retainedSelection: InspectionValues["selection"];
                },
                prune: boolean,
            ): void {
                const state = getState(store);
                let layers = prepareLayerPresentation(state.layers, state.viewIds, presentation);
                let inspection = state.inspection;
                let styles = state.styles;
                if (prune) {
                    const present = new Set(catalog.layerNames);
                    const keep = layers.layerNames.flatMap((name, index) => present.has(name) ? [index] : []);
                    const shortIds = new Set(catalog.styleShortIds);
                    // All layer-indexed arrays use the same retained positions. Removing
                    // a layer cannot shift another layer's visibility or level onto it.
                    const project = <Value>(records: Record<string, Value[]>, fallback: Value) =>
                        Object.fromEntries(state.viewIds.map(id => [
                            id,
                            keep.map(index => records[id]?.[index] ?? fallback),
                        ]));
                    layers = {
                        ...layers,
                        layerNames: keep.map(index => layers.layerNames[index]),
                        layerVisibility: project(layers.layerVisibility, false),
                        layerZoomLevel: project(layers.layerZoomLevel, 13),
                        layerAutoZoomLevel: project(layers.layerAutoZoomLevel, true),
                        options: new Map([...layers.options].filter(([key]) => {
                            const parts = key.split("/");
                            return parts.length >= 4 &&
                                present.has(parts.slice(0, -2).join("/")) &&
                                shortIds.has(parts.at(-2)!);
                        })),
                    };
                    inspection = {...inspection, selection: catalog.retainedSelection};
                    styles = {
                        ...styles,
                        styleVisibility: Object.fromEntries(
                            Object.entries(styles.styleVisibility).filter(([id]) => catalog.styleIds.includes(id))
                        ),
                    };
                }
                patchAppState(
                    store,
                    normalizeInspections({...state, layers, inspection, styles}, state.inspection.selection),
                    "system"
                );
            },
        })),
    );
}
