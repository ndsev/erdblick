import { Injectable } from "@angular/core";
import { z } from "zod";
import { InspectionStateService } from "../inspection/inspection-state.service";
import { coreLib } from "../integrations/wasm";
import { MapViewStateService } from "../mapview/map-view-state.service";
import { Boolish,MapViewState } from "../shared/app-state";
import { InspectionPanelModel,isSourceOrMetaData,LayerPresetSelections,LayerViewConfig,MapPresetSelections,STORED_LAYER_PRESET_REF_SCHEMA,StyleOptionStateUpdate,TileFeatureId } from "../shared/app-state.model";
import { AppStateService } from "../shared/appstate.service";
import type { LayerPresetRef } from "../styledata/layer-preset.model";
import { ErdblickStyle,StyleService } from "../styledata/style.service";
import { MapTreeNode } from "./map.tree.model";
import { parseMapPartitionKey } from "./partition.model";

/** Owns aligned layer settings, style-option associations, presets and catalog retention. */
@Injectable({providedIn: "root"})
export class MapLayerStateService {
    /** Seeds all persisted layer settings and option values before a new view becomes observable. */
    private seedViews(previous: number, count: number, sourceIndex: number): void {
        for (let target = previous; target < count; target++) {
            for (const state of this.viewValues) state.next(target, structuredClone(state.getValue(sourceIndex)));
        }
        this.stylesState.replacePositional(new Map([...this.styles].map(([key, values]) => {
            const next = [...values];
            for (let target = previous; target < count; target++) next[target] = next[sourceIndex];
            return [key, next];
        })));
    }

    /** Retains all layer and preset associations in the supplied logical view order. */
    private retainViews(indices: readonly number[]): void {
        const ids = indices.map(index => this.viewSettings.viewIdAt(index));
        for (const state of this.viewValues) state.retain(ids);
        this.stylesState.retain(ids);
    }

    private get viewValues(): Array<MapViewState<unknown>> {
        return [this.layerSyncOptionsState, this.layerVisibilityState, this.layerZoomLevelState,
            this.layerAutoZoomLevelState, this.layerPresetSelectionState, this.mapPresetSelectionState] as Array<MapViewState<unknown>>;
    }

    constructor(private readonly persistence: AppStateService,
        private readonly viewSettings: MapViewStateService,
        private readonly styleService: StyleService,
        private readonly inspectionState: InspectionStateService) {
        viewSettings.registerMembershipOwner({seed: (previous, count, sourceIndex) => this.seedViews(previous, count, sourceIndex), retain: indices => this.retainViews(indices),
            import: (previous, ids) => {
                for (const state of this.viewValues) state.rekey(previous, ids);
                this.stylesState.rekey(previous, ids);
            }
        });
    }

    hasAuthoritativeUrlLayerList = false;


    readonly layerSyncOptionsState = this.persistence.registerMapViewState<boolean>({
        name: 'layerSyncOptions',
        defaultValue: false,
        schema: Boolish,
        urlIncludeInVisualizationOnly: false
    }, () => this.viewSettings.viewIds);


    readonly layerNamesState = this.persistence.registerState<Array<string>>({
        name: "layerNames",
        defaultValue: [],
        schema: z.array(z.string()),
        urlParamName: 'l'
    });


    readonly layerVisibilityState = this.persistence.registerMapViewState<Array<boolean>>({
        name: "visibility",
        defaultValue: [],
        schema: z.array(Boolish),
        urlParamName: 'v'
    }, () => this.viewSettings.viewIds);


    readonly layerZoomLevelState = this.persistence.registerMapViewState<Array<number>>({
        name: "zoomLevel",
        defaultValue: [],
        schema: z.array(z.number().min(0).max(15)),
        urlParamName: 'z'
    }, () => this.viewSettings.viewIds);


    readonly layerAutoZoomLevelState = this.persistence.registerMapViewState<Array<boolean>>({
        name: "autoZoomLevel",
        defaultValue: [],
        schema: z.array(Boolish),
        urlParamName: 'az'
    }, () => this.viewSettings.viewIds);


    readonly stylesState = this.persistence.registerStyleState(() => this.viewSettings.viewIds);


    readonly layerPresetSelectionState = this.persistence.registerMapViewState<LayerPresetSelections>({
        name: "stylePresetSelection",
        defaultValue: {},
        schema: z.record(z.string(), z.record(z.string(), STORED_LAYER_PRESET_REF_SCHEMA)),
        snapshotPersist: false
    }, () => this.viewSettings.viewIds);


    readonly mapPresetSelectionState = this.persistence.registerMapViewState<MapPresetSelections>({
        name: "mapPresetSelection",
        defaultValue: {},
        schema: z.record(z.string(), z.string()),
        snapshotPersist: false
    }, () => this.viewSettings.viewIds);

    get layerNames() {return this.layerNamesState.getValue();}

    set layerNames(val: Array<string>) {this.layerNamesState.next(val);}

    get styles() {return this.stylesState.positionalValues();}


    /** Returns whether layer visibility/options sync is enabled for the given view. */
    getLayerSyncOption(viewIndex: number): boolean {
        return this.layerSyncOptionsState.getValue(viewIndex);
    }


    /** Sets whether layer visibility/options sync is enabled for the given view. */
    setLayerSyncOption(viewIndex: number, enabled: boolean): void {
        this.layerSyncOptionsState.next(viewIndex, enabled);
    }


    /** Reads one layer's effective values without extending storage or taking ownership. */
    mapLayerConfig(mapId: string, layerId: string, fallbackVisibility = true, fallbackLevel = 13): LayerViewConfig[] {
        if (isSourceOrMetaData(layerId)) return [];
        const index = this.layerNames.indexOf(`${mapId}/${layerId}`);
        const visible = index < 0 && this.hasAuthoritativeUrlLayerList ? false : fallbackVisibility;
        return this.viewSettings.viewIds.map((_, viewIndex) => ({
            autoLevel: this.layerAutoZoomLevelState.getValue(viewIndex)[index] ?? true,
            visible: this.layerVisibilityState.getValue(viewIndex)[index] ?? visible,
            level: this.layerZoomLevelState.getValue(viewIndex)[index] ?? fallbackLevel
        }));
    }

    /** Catalog discovery materializes defaults explicitly as system state, never as a user edit. */
    materializeLayerDefaults(mapId: string, layerId: string, fallbackVisibility = true, fallbackLevel = 13): LayerViewConfig[] {
        const values = this.mapLayerConfig(mapId, layerId, fallbackVisibility, fallbackLevel);
        this.persistence.withSystemStateMutation(() => this.setMapLayerConfig(mapId, layerId, values, fallbackLevel));
        return values;
    }

    /** Writes per-view visibility and level configuration for one map/layer pair. */
    setMapLayerConfig(mapId: string, layerId: string, viewConfig: LayerViewConfig[], fallbackLevel: number = 13): void {
        this.persistence.transaction(() => this.writeMapLayerConfig(mapId, layerId, viewConfig, fallbackLevel));
    }

    private writeMapLayerConfig(mapId: string, layerId: string, viewConfig: LayerViewConfig[], fallbackLevel: number): void {
        if (isSourceOrMetaData(layerId) || viewConfig.length < this.viewSettings.numViewsState.getValue()) {
            return;
        }
        const mapLayerId = `${mapId}/${layerId}`;
        const names = this.layerNames;
        let layerIndex = names.findIndex(ml => ml === mapLayerId);
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
    }


    /** Reads stored or catalog-default options without extending storage. */
    styleOptionValues(
        mapId: string, layerId: string, shortStyleId: string, optionId: string,
        optionType: string, defaultValue: string | number | boolean
    ): (string | number | boolean)[] {
        const key = this.stylesState.styleOptionKey(mapId, layerId, shortStyleId, optionId);
        const values = this.styles.get(key);
        return this.viewSettings.viewIds.map((_, index) =>
            this.stylesState.coerceOptionValue(values?.[index] ?? defaultValue, optionType));
    }

    /** Resolves one discovered option and stores missing defaults under system ownership. */
    materializeStyleOptionDefaults(
        mapId: string, layerId: string, shortStyleId: string, optionId: string,
        optionType: string, defaultValue: string | number | boolean
    ): (string | number | boolean)[] {
        const values = this.styleOptionValues(mapId, layerId, shortStyleId, optionId, optionType, defaultValue);
        this.persistence.withSystemStateMutation(() =>
            this.setStyleOptionValues(mapId, layerId, shortStyleId, optionId, values));
        return values;
    }

    /**
     * Set style option values for a specific map layer style combination.
     * Note: This will NOT change the layerConfig array. Instead, if the
     *  map layer does not exist in layerNames, an exception will be thrown.
     */
    setStyleOptionValues(mapId: string, layerId: string, shortStyleId: string, optionId: string, value: (string|number|boolean)[]) {
        this.setStyleOptionValuesBatch([{
            mapId,
            layerId,
            shortStyleId,
            optionId,
            values: value
        }]);
    }


    /** Writes a complete collection of style-option arrays and emits style state exactly once. */
    setStyleOptionValuesBatch(updates: StyleOptionStateUpdate[]): void {
        if (!updates.length) {
            return;
        }
        for (const update of updates) {
            const mapLayerId = `${update.mapId}/${update.layerId}`;
            if (!this.layerNames.includes(mapLayerId)) {
                throw new Error(`[AppStateService] Unknown map layer '${mapLayerId}' when writing style option values`);
            }
        }

        const views = this.viewSettings.numViewsState.getValue();
        const nextStyles = new Map(this.styles);
        for (const update of updates) {
            const key = this.stylesState.styleOptionKey(
                update.mapId,
                update.layerId,
                update.shortStyleId,
                update.optionId);
            let nextValues = [...update.values];
            if (nextValues.length < views) {
                const last = nextValues.length ? nextValues[nextValues.length - 1] : false;
                nextValues = nextValues.concat(Array.from({length: views - nextValues.length}, () => last));
            } else if (nextValues.length > views) {
                nextValues = nextValues.slice(0, views);
            }
            nextStyles.set(key, nextValues);
        }
        this.stylesState.replacePositional(nextStyles);
    }


    /** Returns the locally selected qualified layer preset for one map/layer/view. */
    getLayerPresetSelection(viewIndex: number, mapId: string, layerId: string): LayerPresetRef | null {
        const ref = this.layerPresetSelectionState.getValue(viewIndex)[mapId]?.[layerId];
        return ref ? {...ref} : null;
    }


    /** Stores or clears one map/layer/view layer-preset association without changing option values. */
    setLayerPresetSelection(viewIndex: number, mapId: string, layerId: string, ref: LayerPresetRef | null): void {
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
    }


    /** Returns the selected map-level preset for one concrete map/view. */
    getMapPresetSelection(viewIndex: number, mapId: string): string | null {
        return this.mapPresetSelectionState.getValue(viewIndex)[mapId] ?? null;
    }


    /** Stores or clears a map-level preset association without changing option values. */
    setMapPresetSelection(viewIndex: number, mapId: string, presetId: string | null): void {
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
    }


    /** Removes persisted map/layer/style references that no longer exist in the loaded data. */
    prune(presentMaps: Map<string, MapTreeNode>, presentStyles: Map<string, ErdblickStyle>) {
        this.persistence.withSystemStateMutation(() => {
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
            const presentShortStyleIds = new Set<string>([...presentStyles.values()].map(s => s.shortId));

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
                    keepIndices.map(idx => (idx < arr.length ? arr[idx] : fallback));

                const views = this.viewSettings.numViews;
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
            const parts = key.split('/');
            if (parts.length < 4) {
                stylesMap.delete(key);
                stylesChanged = true;
                continue;
            }
            const shortStyleId = parts[parts.length - 2];
            const mapLayerId = parts.slice(0, -2).join('/');
            if (!presentLayerIds.has(mapLayerId) || !presentShortStyleIds.has(shortStyleId)) {
                stylesMap.delete(key);
                stylesChanged = true;
            }
        }

        // 5) Prune extra views in MapViewStates and in StyleState values
        const views = this.viewSettings.numViews;
        const pruneViews = <T>(state: MapViewState<T>) => state.retain(this.viewSettings.viewIds);
        pruneViews(this.viewSettings.mode2dState);
        pruneViews(this.viewSettings.backgroundState);
        pruneViews(this.viewSettings.viewTileBordersState);
        pruneViews(this.viewSettings.viewTileGridModeState);
        pruneViews(this.viewSettings.viewTileGridLevelState);
        pruneViews(this.viewSettings.viewTileGridAutoLevelState);
        pruneViews(this.viewSettings.viewTileGridColorState);
        pruneViews(this.viewSettings.viewTileGridOpacityState);
        pruneViews(this.viewSettings.cameraViewDataState);
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
            this.stylesState.replacePositional(stylesMap);
        }

        // 6) Prune selections that reference maps/layers that are not present anymore
        const panels = this.inspectionState.selectionState.getValue();
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
                sourceData: panel.sourceData ? { ...panel.sourceData } : undefined,
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

            if (updated.features.length !== panel.features.length ||
                (panel.sourceData !== undefined && updated.sourceData === undefined)) {
                selectionChanged = true;
            }

            if (updated.features.length || updated.sourceData) {
                nextPanels.push(updated);
            } else {
                selectionChanged = true;
            }
        }

        if (selectionChanged || nextPanels.length !== panels.length) {
            this.inspectionState.selectionState.next(nextPanels);
        }
            this.inspectionState.sanitizeInspectionComparisonForSelection(nextPanels);

            // Sync all states, so the URL is replaced.
            this.persistence.syncAllStates();
        });
    }
}
