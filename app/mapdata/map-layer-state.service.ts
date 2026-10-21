import {ownerState} from "./map-layer-state.service.state";

import {Injectable} from "@angular/core";
import {Params} from "@angular/router";
import {InspectionPanelModel, TileFeatureId} from "../inspection/inspection-state.model";
import {InspectionStateService} from "../inspection/inspection-state.service";
import {coreLib} from "../integrations/wasm";
import {MapTreeNode} from "../mapdata/map.tree.model";
import {parseMapPartitionKey} from "../mapdata/partition.model";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {BackgroundLayerConfig, clampBackgroundOpacity} from "../shared/app-config.service";
import {MapViewState} from "../shared/app-state";
import {AppStateService} from "../shared/appstate.service";
import {firstParamValue} from "../shared/url-state-codec";
import type {LayerPresetRef} from "../styledata/layer-preset.model";
import {ErdblickStyle, StyleService} from "../styledata/style.service";
import {
    BackgroundLayerViewState,
    isSourceOrMetaData,
    LayerPresetSelections,
    LayerViewConfig,
    StyleOptionStateUpdate
} from "./map-layer-state.model";

/** Owns layers values, validation, and user operations. */
@Injectable({providedIn: "root"})
export class MapLayerStateService {
    private hasAuthoritativeUrlLayerList = false;

    readonly layerSyncOptionsState = this.stateService.registerView(
        ownerState.layerSyncOptions,
        "layers",
        "layerSyncOptions"
    );

    readonly backgroundState = this.stateService.registerView(ownerState.background, "layers", "background");

    readonly layerNamesState = this.stateService.register(ownerState.layerNames, "layers", "layerNames");

    readonly layerVisibilityState = this.stateService.registerView(
        ownerState.layerVisibility,
        "layers",
        "layerVisibility"
    );

    readonly viewTileBordersState = this.stateService.registerView(
        ownerState.viewTileBorders,
        "layers",
        "viewTileBorders"
    );

    readonly viewTileGridModeState = this.stateService.registerView(
        ownerState.viewTileGridMode,
        "layers",
        "viewTileGridMode"
    );

    readonly viewTileGridLevelState = this.stateService.registerView(
        ownerState.viewTileGridLevel,
        "layers",
        "viewTileGridLevel"
    );

    readonly viewTileGridAutoLevelState = this.stateService.registerView(
        ownerState.viewTileGridAutoLevel,
        "layers",
        "viewTileGridAutoLevel"
    );

    readonly viewTileGridColorState = this.stateService.registerView(
        ownerState.viewTileGridColor,
        "layers",
        "viewTileGridColor"
    );

    readonly viewTileGridOpacityState = this.stateService.registerView(
        ownerState.viewTileGridOpacity,
        "layers",
        "viewTileGridOpacity"
    );

    readonly layerZoomLevelState = this.stateService.registerView(
        ownerState.layerZoomLevel,
        "layers",
        "layerZoomLevel"
    );

    readonly layerAutoZoomLevelState = this.stateService.registerView(
        ownerState.layerAutoZoomLevel,
        "layers",
        "layerAutoZoomLevel"
    );

    readonly stylesState = this.stateService.registerStyles();

    readonly layerPresetSelectionState = this.stateService.registerView(
        ownerState.layerPresetSelection,
        "layers",
        "layerPresetSelection"
    );

    readonly mapPresetSelectionState = this.stateService.registerView(
        ownerState.mapPresetSelection,
        "layers",
        "mapPresetSelection"
    );

    readonly mapsOpenState = this.stateService.register(ownerState.mapsOpen, "layers", "mapsOpen");

    get layerNames() {
        return this.layerNamesState.getValue();
    }

    set layerNames(val: Array<string>) {
        this.stateService.transaction(() => {
            this.layerNamesState.next(val);
        });
    }

    get styles() {
        return this.stylesState.getValue();
    }

    /** Returns whether layer visibility/options sync is enabled for the given view. */
    getLayerSyncOption(viewIndex: number): boolean {
        return this.layerSyncOptionsState.getValue(viewIndex);
    }

    /** Sets whether layer visibility/options sync is enabled for the given view. */
    setLayerSyncOption(viewIndex: number, enabled: boolean): void {
        return this.stateService.transaction(() => {
            this.layerSyncOptionsState.next(viewIndex, enabled);
        });
    }

    /** Returns the persisted background-layer state for the given view. */
    getBackgroundState(viewIndex: number): BackgroundLayerViewState {
        const value = this.backgroundState.getValue(viewIndex);
        return {
            layerId: value.layerId,
            opacity: clampBackgroundOpacity(value.opacity)
        };
    }

    /** Returns the effective background-layer state after missing ids are mapped to the configured default. */
    resolveBackgroundState(
        viewIndex: number,
        availableLayers: readonly BackgroundLayerConfig[],
        defaultBackgroundLayerId: string | null
    ): BackgroundLayerViewState {
        const rawState = this.getBackgroundState(viewIndex);
        if (rawState.layerId === null) {
            return rawState;
        }

        const availableLayerIds = new Set(availableLayers.map((layer) => layer.id));
        if (availableLayerIds.has(rawState.layerId)) {
            return rawState;
        }

        const defaultLayer = defaultBackgroundLayerId
            ? availableLayers.find((layer) => layer.id === defaultBackgroundLayerId)
            : undefined;
        if (defaultLayer) {
            return {
                layerId: defaultLayer.id,
                opacity: defaultLayer.defaultOpacity
            };
        }

        return {
            layerId: null,
            opacity: rawState.opacity
        };
    }

    /** Writes the selected background-layer id and opacity for one view. */
    setBackgroundState(viewIndex: number, layerId: string | null, opacity: number): void {
        return this.stateService.transaction(() => {
            this.backgroundState.next(viewIndex, {
                layerId,
                opacity: clampBackgroundOpacity(opacity)
            });
        });
    }

    /** Returns the configured background opacity for the given view. */
    getBackgroundOpacity(viewIndex: number): number {
        return this.getBackgroundState(viewIndex).opacity;
    }

    /** Reads saved values with catalog defaults, without creating persisted state. */
    mapLayerConfig(mapId: string, layerId: string, fallbackVisibility = true, fallbackLevel = 13): LayerViewConfig[] {
        if (isSourceOrMetaData(layerId)) return [];
        const index = this.layerNames.indexOf(`${mapId}/${layerId}`);
        const visible = index < 0 && this.hasAuthoritativeUrlLayerList ? false : fallbackVisibility;
        return this.viewState.viewIds().map((_, viewIndex) => ({
            autoLevel: this.layerAutoZoomLevelState.getValue(viewIndex)[index] ?? true,
            visible: this.layerVisibilityState.getValue(viewIndex)[index] ?? visible,
            level: this.layerZoomLevelState.getValue(viewIndex)[index] ?? fallbackLevel
        }));
    }

    /** Materializes catalog defaults during tree preparation, preserving config ownership. */
    initializeMapLayerConfig(
        mapId: string,
        layerId: string,
        fallbackVisibility = true,
        fallbackLevel = 13
    ): LayerViewConfig[] {
        const values = this.mapLayerConfig(mapId, layerId, fallbackVisibility, fallbackLevel);
        this.stateService.withSystemStateMutation(() => {
            this.setMapLayerConfig(mapId, layerId, values, fallbackLevel);
        });
        return values;
    }

    /** Writes per-view visibility and level configuration for one map/layer pair. */
    setMapLayerConfig(mapId: string, layerId: string, viewConfig: LayerViewConfig[], fallbackLevel: number = 13) {
        return this.stateService.transaction(() => {
            if (isSourceOrMetaData(layerId) || viewConfig.length < this.viewState.numViewsState.getValue()) {
                return;
            }
            const mapLayerId = `${mapId}/${layerId}`;
            const names = this.layerNames;
            let layerIndex = names.findIndex((ml) => ml === mapLayerId);
            if (layerIndex === -1) {
                layerIndex = names.length;
                this.layerNamesState.next([...names, mapLayerId]);
            }

            const insertLayerState = <T>(state: MapViewState<T[]>, viewIndex: number, value: T, defaultValue: T) => {
                const values = [...state.getValue(viewIndex)];
                while (values.length <= layerIndex) {
                    values.push(defaultValue);
                }
                values[layerIndex] = value;
                state.next(viewIndex, values);
            };

            for (let viewIndex = 0; viewIndex < viewConfig.length; viewIndex++) {
                insertLayerState(this.layerAutoZoomLevelState, viewIndex, viewConfig[viewIndex].autoLevel, true);
                insertLayerState(this.layerVisibilityState, viewIndex, viewConfig[viewIndex].visible, false);
                insertLayerState(this.layerZoomLevelState, viewIndex, viewConfig[viewIndex].level, fallbackLevel);
            }
        });
    }

    /** Reads typed option values with defaults without creating persisted state. */
    styleOptionValues(
        mapId: string,
        layerId: string,
        shortStyleId: string,
        optionId: string,
        optionType: string,
        defaultValue: string | number | boolean
    ): (string | number | boolean)[] {
        const key = this.stylesState.styleOptionKey(mapId, layerId, shortStyleId, optionId);
        const current = this.styles.get(key);
        return this.viewState
            .viewIds()
            .map((_, index) => this.stylesState.coerceOptionValue(current?.[index] ?? defaultValue, optionType));
    }

    /** Stores catalog defaults explicitly when constructing the runtime layer tree. */
    initializeStyleOptionValues(
        mapId: string,
        layerId: string,
        shortStyleId: string,
        optionId: string,
        optionType: string,
        defaultValue: string | number | boolean
    ): (string | number | boolean)[] {
        const values = this.styleOptionValues(mapId, layerId, shortStyleId, optionId, optionType, defaultValue);
        this.stateService.withSystemStateMutation(() => {
            this.setStyleOptionValues(mapId, layerId, shortStyleId, optionId, values);
        });
        return values;
    }

    /**
     * Set style option values for a specific map layer style combination.
     * Note: This will NOT change the layerConfig array. Instead, if the
     *  map layer does not exist in layerNames, an exception will be thrown.
     */
    setStyleOptionValues(
        mapId: string,
        layerId: string,
        shortStyleId: string,
        optionId: string,
        value: (string | number | boolean)[]
    ) {
        return this.stateService.transaction(() => {
            this.setStyleOptionValuesBatch([
                {
                    mapId,
                    layerId,
                    shortStyleId,
                    optionId,
                    values: value
                }
            ]);
        });
    }

    /** Writes a complete collection of style-option arrays and emits style state exactly once. */
    setStyleOptionValuesBatch(updates: StyleOptionStateUpdate[]): void {
        return this.stateService.transaction(() => {
            if (!updates.length) {
                return;
            }
            for (const update of updates) {
                const mapLayerId = `${update.mapId}/${update.layerId}`;
                if (!this.layerNames.includes(mapLayerId)) {
                    throw new Error(
                        `[AppStateService] Unknown map layer '${mapLayerId}' when writing style option values`
                    );
                }
            }

            const views = this.viewState.numViewsState.getValue();
            const nextStyles = new Map(this.styles);
            for (const update of updates) {
                const key = this.stylesState.styleOptionKey(
                    update.mapId,
                    update.layerId,
                    update.shortStyleId,
                    update.optionId
                );
                let nextValues = [...update.values];
                if (nextValues.length < views) {
                    const last = nextValues.length ? nextValues[nextValues.length - 1] : false;
                    nextValues = nextValues.concat(Array.from({length: views - nextValues.length}, () => last));
                } else if (nextValues.length > views) {
                    nextValues = nextValues.slice(0, views);
                }
                nextStyles.set(key, nextValues);
            }
            this.stylesState.next(nextStyles);
        });
    }

    /** Returns the locally selected qualified layer preset for one map/layer/view. */
    getLayerPresetSelection(viewIndex: number, mapId: string, layerId: string): LayerPresetRef | null {
        const ref = this.layerPresetSelectionState.getValue(viewIndex)[mapId]?.[layerId];
        return ref ? {...ref} : null;
    }

    /** Stores or clears one map/layer/view layer-preset association without changing option values. */
    setLayerPresetSelection(viewIndex: number, mapId: string, layerId: string, ref: LayerPresetRef | null): void {
        return this.stateService.transaction(() => {
            const current = this.layerPresetSelectionState.getValue(viewIndex);
            const currentRef = current[mapId]?.[layerId] ?? null;
            if (currentRef?.styleId === ref?.styleId && currentRef?.presetId === ref?.presetId) {
                return;
            }

            const next: LayerPresetSelections = {...current};
            const mapSelections = {...(next[mapId] ?? {})};
            if (ref) {
                mapSelections[layerId] = {...ref};
                next[mapId] = mapSelections;
            } else {
                delete mapSelections[layerId];
                if (Object.keys(mapSelections).length) {
                    next[mapId] = mapSelections;
                } else {
                    delete next[mapId];
                }
            }
            this.layerPresetSelectionState.next(viewIndex, next);
        });
    }

    /** Returns the selected map-level preset for one concrete map/view. */
    getMapPresetSelection(viewIndex: number, mapId: string): string | null {
        return this.mapPresetSelectionState.getValue(viewIndex)[mapId] ?? null;
    }

    /** Stores or clears a map-level preset association without changing option values. */
    setMapPresetSelection(viewIndex: number, mapId: string, presetId: string | null): void {
        return this.stateService.transaction(() => {
            const current = this.mapPresetSelectionState.getValue(viewIndex);
            if ((current[mapId] ?? null) === presetId) {
                return;
            }
            const next = {...current};
            if (presetId) {
                next[mapId] = presetId;
            } else {
                delete next[mapId];
            }
            this.mapPresetSelectionState.next(viewIndex, next);
        });
    }

    /** Removes persisted map/layer/style references that no longer exist in the loaded data. */
    prune(presentMaps: Map<string, MapTreeNode>, presentStyles: Map<string, ErdblickStyle>) {
        return this.stateService.withSystemStateMutation(() => {
            this.stateService.transaction(() => {
                // 1) Build sets of present maps, layers and styles
                const presentLayerIds = new Set<string>(); // entries of form `${mapId}/${layerId}`
                const presentSelectionLayerIds = new Set<string>(); // includes SourceData layers
                const presentMapIds = new Set<string>();
                const mapsWithKnownFeatureLayers = new Set<string>();
                const mapsWithKnownSelectionLayers = new Set<string>();
                for (const [mapId, mapNode] of presentMaps.entries()) {
                    presentMapIds.add(mapId);
                    // Use feature layers (exclude SourceData) via children
                    for (const layer of mapNode.children) {
                        presentLayerIds.add(`${mapId}/${layer.id}`);
                    }
                    if (mapNode.children.length > 0) {
                        mapsWithKnownFeatureLayers.add(mapId);
                    }
                    // Selection pruning must keep SourceData inspections too.
                    for (const layerId of mapNode.layers.keys()) {
                        presentSelectionLayerIds.add(`${mapId}/${layerId}`);
                    }
                    if (mapNode.layers.size > 0) {
                        mapsWithKnownSelectionLayers.add(mapId);
                    }
                }

                const presentStyleIds = new Set<string>([...presentStyles.keys()]); // full style ids
                const presentShortStyleIds = new Set<string>([...presentStyles.values()].map((s) => s.shortId));

                // 2) Prune layerNames and per-view layer arrays (visibility, zoom levels)
                const oldLayerNames = this.layerNames;
                if (oldLayerNames.length) {
                    const keepIndices: number[] = [];
                    const nextLayerNames: string[] = [];
                    for (let i = 0; i < oldLayerNames.length; i++) {
                        const name = oldLayerNames[i];
                        if (presentLayerIds.has(name)) {
                            keepIndices.push(i);
                            nextLayerNames.push(name);
                        }
                    }

                    if (keepIndices.length !== oldLayerNames.length) {
                        // Update layer names
                        this.layerNames = nextLayerNames;

                        // Helper to filter layer-indexed arrays by keepIndices with fallback
                        const filterLayerArray = <T>(arr: T[], fallback: T): T[] =>
                            keepIndices.map((idx) => (idx < arr.length ? arr[idx] : fallback));

                        const views = this.viewState.numViews;
                        for (let v = 0; v < views; v++) {
                            const vis = this.layerVisibilityState.getValue(v);
                            const levels = this.layerZoomLevelState.getValue(v);
                            const autoLevels = this.layerAutoZoomLevelState.getValue(v);
                            this.layerVisibilityState.next(v, filterLayerArray<boolean>(vis ?? [], false));
                            this.layerZoomLevelState.next(v, filterLayerArray<number>(levels ?? [], 13));
                            this.layerAutoZoomLevelState.next(v, filterLayerArray<boolean>(autoLevels ?? [], true));
                        }
                    }
                }

                // 3) Prune style option values that reference pruned layers or non-present styles
                //    and 4) prune style visibility for non-present styles
                // Prune style visibility
                const styleVis = {...this.styleService.styleVisibility};
                let styleVisChanged = false;
                for (const key of Object.keys(styleVis)) {
                    if (!presentStyleIds.has(key)) {
                        delete styleVis[key];
                        styleVisChanged = true;
                    }
                }
                if (styleVisChanged) {
                    this.styleService.styleVisibility = styleVis;
                }

                // Prune style option values
                const stylesMap = new Map(this.styles); // Map<string, (string|number|boolean)[]>
                let stylesChanged = false;
                for (const key of Array.from(stylesMap.keys())) {
                    // Key format: `${mapId}/${layerId}/${shortStyleId}/${optionId}`
                    const parts = key.split("/");
                    if (parts.length < 4) {
                        stylesMap.delete(key);
                        stylesChanged = true;
                        continue;
                    }
                    const shortStyleId = parts[parts.length - 2];
                    const mapLayerId = parts.slice(0, -2).join("/");
                    if (!presentLayerIds.has(mapLayerId) || !presentShortStyleIds.has(shortStyleId)) {
                        stylesMap.delete(key);
                        stylesChanged = true;
                    }
                }

                // 5) Prune extra views in MapViewStates and in StyleState values
                const views = this.viewState.numViews;
                const pruneViews = <T>(state: MapViewState<T>) => {
                    const arr = state.appState.getValue();
                    if (arr.length > views) {
                        state.appState.next(arr.slice(0, views));
                    }
                };
                pruneViews(this.viewState.mode2dState);
                pruneViews(this.backgroundState);
                pruneViews(this.viewTileBordersState);
                pruneViews(this.viewTileGridModeState);
                pruneViews(this.viewTileGridLevelState);
                pruneViews(this.viewTileGridAutoLevelState);
                pruneViews(this.viewTileGridColorState);
                pruneViews(this.viewTileGridOpacityState);
                pruneViews(this.viewState.cameraViewDataState);
                pruneViews(this.layerVisibilityState);
                pruneViews(this.layerZoomLevelState);
                pruneViews(this.layerAutoZoomLevelState);

                // Also prune view-dimension from style option arrays
                for (const [k, vals] of stylesMap.entries()) {
                    if (vals.length > views) {
                        stylesMap.set(k, vals.slice(0, views));
                        stylesChanged = true;
                    }
                }
                if (stylesChanged) {
                    this.stylesState.next(stylesMap);
                }

                // 6) Prune selections that reference maps/layers that are not present anymore
                const panels = this.inspection.selectionState.getValue();
                const nextPanels: InspectionPanelModel<TileFeatureId>[] = [];
                let selectionChanged = false;

                const parseKey = (tileKey: string): {mapId: string; mapLayerId: string} | undefined => {
                    let parsed: [string, string, unknown];
                    try {
                        parsed = parseMapPartitionKey(coreLib, tileKey);
                    } catch {
                        return undefined;
                    }
                    const [mapId, layerId] = parsed;
                    return {mapId, mapLayerId: `${mapId}/${layerId}`};
                };

                const keepFeatureSelection = (tileKey: string): boolean => {
                    const parsed = parseKey(tileKey);
                    if (!parsed) {
                        return false;
                    }
                    if (presentLayerIds.has(parsed.mapLayerId)) {
                        return true;
                    }
                    // Nonblocking datasource startup can transiently publish a map before its layers.
                    return !presentMapIds.has(parsed.mapId) || !mapsWithKnownFeatureLayers.has(parsed.mapId);
                };

                const keepSourceDataSelection = (tileKey: string): boolean => {
                    const parsed = parseKey(tileKey);
                    if (!parsed) {
                        return false;
                    }
                    if (presentSelectionLayerIds.has(parsed.mapLayerId)) {
                        return true;
                    }
                    return !presentMapIds.has(parsed.mapId) || !mapsWithKnownSelectionLayers.has(parsed.mapId);
                };

                for (const panel of panels) {
                    const updated: InspectionPanelModel<TileFeatureId> = {
                        id: panel.id,
                        features: [],
                        locked: panel.locked,
                        size: panel.size,
                        sourceData: panel.sourceData ? {...panel.sourceData} : undefined,
                        color: panel.color,
                        undocked: panel.undocked,
                        focused: panel.focused
                    };

                    // Filter features
                    for (const feat of panel.features) {
                        if (keepFeatureSelection(feat.mapTileKey)) {
                            updated.features.push(feat);
                        }
                    }

                    // Validate sourceData if present
                    if (updated.sourceData && !keepSourceDataSelection(updated.sourceData.mapTileKey)) {
                        delete updated.sourceData;
                    }

                    if (
                        updated.features.length !== panel.features.length ||
                        (panel.sourceData !== undefined && updated.sourceData === undefined)
                    ) {
                        selectionChanged = true;
                    }

                    if (updated.features.length || updated.sourceData) {
                        nextPanels.push(updated);
                    } else {
                        selectionChanged = true;
                    }
                }

                if (selectionChanged || nextPanels.length !== panels.length) {
                    this.inspection.selectionState.next(nextPanels);
                }
                this.inspection.reconcileComparison(nextPanels);

                // Sync all states, so the URL is replaced.
                this.stateService.syncAllStates();
            });
        });
    }

    /** Migrates legacy `osm` URL/storage payloads into the generic background-layer state once on startup. */
    migrateLegacyOsmState(params: Params): void {
        return this.stateService.transaction(() => {
            const hasBackgroundStorage = localStorage.getItem(this.backgroundState.appState.name) !== null;
            const hasBackgroundUrl =
                params[this.backgroundState.appState.urlParamName ?? this.backgroundState.appState.name] !== undefined;
            if (hasBackgroundStorage || hasBackgroundUrl) {
                return;
            }

            const legacyStorage = localStorage.getItem("osm");
            const legacyUrl = params["osm"];
            const legacyPayload = legacyUrl ?? legacyStorage;
            if (legacyPayload === undefined || legacyPayload === null) {
                return;
            }

            const serializedStates =
                typeof legacyPayload === "string" && legacyPayload.trim().startsWith("[")
                    ? this.parseLegacyOsmStorage(legacyPayload)
                    : this.parseLegacyOsmUrl(String(legacyPayload));
            if (!serializedStates.length) {
                return;
            }

            serializedStates.forEach((state, viewIndex) => {
                this.setBackgroundState(viewIndex, state.layerId, state.opacity);
            });
        });
    }

    /** Parses the JSON-encoded local-storage payload used by the removed `osm` state slot. */
    private parseLegacyOsmStorage(rawPayload: string): BackgroundLayerViewState[] {
        try {
            const parsed = JSON.parse(rawPayload);
            if (!Array.isArray(parsed)) {
                return [];
            }
            return parsed.map((token) => this.parseLegacyOsmToken(String(token)));
        } catch {
            return [];
        }
    }

    /** Parses the compact CSV URL form used by the removed `osm` query parameter. */
    private parseLegacyOsmUrl(rawPayload: string): BackgroundLayerViewState[] {
        if (!rawPayload.length) {
            return [];
        }
        return rawPayload.split(",").map((token) => this.parseLegacyOsmToken(token));
    }

    /** Converts one legacy `enabled~opacity` token into the new background-layer state shape. */
    private parseLegacyOsmToken(rawToken: string): BackgroundLayerViewState {
        const parts = rawToken.split("~");
        const enabled = parts[0] === "1" || parts[0].toLowerCase() === "true";
        const opacity = parts[1] === undefined ? 6 : clampBackgroundOpacity(Number(parts[1]));
        return {
            layerId: enabled ? "osm" : null,
            opacity
        };
    }
    constructor(
        private readonly stateService: AppStateService,
        private readonly viewState: MapViewStateService,
        private readonly styleService: StyleService,
        private readonly inspection: InspectionStateService
    ) {
        this.stateService.importingUrl.subscribe((params) => {
            this.hasAuthoritativeUrlLayerList =
                firstParamValue(params, "v2") === "1" && firstParamValue(params, "l") !== undefined;
        });
        this.stateService.importedStartupUrl.subscribe((params) => this.migrateLegacyOsmState(params));
    }
}
