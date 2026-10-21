import { Injectable } from "@angular/core";
import { Params } from "@angular/router";
import { InspectionStateService } from "../inspection/inspection-state.service";
import { coreLib } from "../integrations/wasm";
import { MapLayerStateService } from "../mapdata/map-layer-state.service";
import { MapViewStateService } from "../mapview/map-view-state.service";
import { MapViewState } from "./app-state";
import { DEFAULT_HIGHLIGHT_COLORS } from "./app-state.model";
import { AppStateService } from "./appstate.service";
import type { UrlV2MapTileKeyFactory } from "./url-state-codec";
import {
compressUrlCsvRuns,
decodeLayerNamesV2,
decodeMapNamesV2,
decodeSelectionsV2,
decodeStyleOptionsV2,
encodeLayerNamesV2,
encodeSelectionsV2,
encodeStyleOptionsV2,
featureSelectionLayerNames,
firstParamValue,
sourceDataSelectionMapIds
} from "./url-state-codec";

/** Coordinates the shared URL layer/style/selection dictionary and legacy share-link migration. */
@Injectable({providedIn: "root"})
export class AppUrlStateService {
    /** Validates identity first, so a malformed share link cannot partially replace state. */
    hydrate(params: Params, identitiesPrepared = false): void {
        if (!Object.keys(params).length) return;
        if (Array.isArray(params["vid"])) throw new Error("The share link contains more than one view ID list.");
        const encodedIds = firstParamValue(params, "vid");
        const ids = encodedIds === undefined ? undefined : encodedIds.split(",").map(decodeURIComponent);
        const count = firstParamValue(params, "n") ?? ids?.length ?? this.viewSettings.numViews;
        const nextIds = this.viewSettings.prepareImportedViews(count, ids, !identitiesPrepared);
        this.viewSettings.importViews(nextIds);
        this.layerState.hasAuthoritativeUrlLayerList = firstParamValue(params, "l") !== undefined;
        if (firstParamValue(params, "v2") === "1") this.hydrateFromUrlV2(params);
        else for (const state of this.persistence.registeredStates.values()) {
            if (state === this.viewSettings.viewIdsState || state === this.viewSettings.numViewsState) continue;
            this.persistence.deserializeStateSafely(state, params);
        }
    }

    /** Prepares one shared identity mapping before importing positional snapshot values. */
    prepareSnapshot(values: Record<string, unknown>, replaceMissing: boolean): Record<string, unknown> {
        const ids = values["viewIds"];
        const count = values["numberOfViews"] ?? (Array.isArray(ids) ? ids.length : replaceMissing ? 1 : this.viewSettings.numViews);
        const nextIds = this.viewSettings.prepareImportedViews(count, ids, replaceMissing);
        return {viewIds: nextIds, numberOfViews: nextIds.length,
            focus: Math.max(0, nextIds.indexOf(this.viewSettings.focusedViewIdState.value)), ...values};
    }

    /** Applies config-versus-user storage choices before any positional value is decoded. */
    prepareStoredViews(values: Map<string, string>, params: Params): void {
        if (Array.isArray(params["vid"])) throw new Error("The share link contains more than one view ID list.");
        const urlIds = firstParamValue(params, "vid");
        const savedIds = values.get("viewIds");
        const savedCount = values.get("numberOfViews");
        const hasUrl = Object.keys(params).length > 0;
        const ids = urlIds !== undefined ? urlIds.split(",").map(decodeURIComponent)
            : hasUrl || savedIds === undefined ? undefined : JSON.parse(savedIds);
        const count = firstParamValue(params, "n") ?? (urlIds !== undefined && Array.isArray(ids) ? ids.length
            : savedCount !== undefined ? JSON.parse(savedCount) : Array.isArray(ids) ? ids.length : this.viewSettings.numViews);
        this.viewSettings.importViews(this.viewSettings.prepareImportedViews(count, ids, hasUrl));
        // The shared identity preparation consumed these two compatibility keys.
        values.delete("viewIds");
        values.delete("numberOfViews");
    }

    /** Applies the old OSM alias only when no explicit background preference exists. */
    initialize(params: Params): void { this.viewSettings.migrateLegacyOsmState(params); }

    constructor(private readonly persistence: AppStateService,
        private readonly layerState: MapLayerStateService,
        private readonly inspectionState: InspectionStateService,
        private readonly viewSettings: MapViewStateService) {
        persistence.registerUrlProjection(this);
    }


    /** Builds a complete v2 query-param set so all layer-indexed params share one order. */
    serialize(params: Record<string, string | string[]>): Record<string, string | string[]> {
        params["v2"] = "1";

        const urlLayerNames = this.urlLayerNamesForSerialization();

        for (const state of this.persistence.registeredStates.values()) {
            if (state === this.layerState.layerNamesState
                || state === this.inspectionState.selectionState
                || state === this.layerState.stylesState
                || this.isLayerIndexedMapViewState(state)) {
                continue;
            }
            if (!state.isUrlState()) {
                continue;
            }
            const serialized = state.serialize(true);
            if (serialized === undefined) {
                continue;
            }
            for (const [key, value] of Object.entries(serialized)) {
                if (value !== null) {
                    params[key] = compressUrlCsvRuns(value);
                }
            }
        }

        const layerEncoding = encodeLayerNamesV2(
            urlLayerNames,
            sourceDataSelectionMapIds(this.inspectionState.selection)
        );
        if (layerEncoding.map) {
            params["map"] = layerEncoding.map;
        }
        if (layerEncoding.l !== null) {
            params["l"] = layerEncoding.l;
        } else if (!urlLayerNames.length) {
            params["l"] = "";
        }
        this.serializeLayerIndexedMapViewParam(params, "v", this.layerState.layerVisibilityState, urlLayerNames, false, value => value ? "1" : "0");
        this.serializeLayerIndexedMapViewParam(params, "z", this.layerState.layerZoomLevelState, urlLayerNames, 13, value => String(value));
        this.serializeLayerIndexedMapViewParam(params, "az", this.layerState.layerAutoZoomLevelState, urlLayerNames, true, value => value ? "1" : "0");

        const selection = encodeSelectionsV2(
            this.inspectionState.selection,
            urlLayerNames,
            layerEncoding.mapNames,
            DEFAULT_HIGHLIGHT_COLORS
        );
        if (selection) {
            params["sel"] = selection;
        }

        for (const [key, value] of Object.entries(encodeStyleOptionsV2(
            this.layerState.styles,
            urlLayerNames,
            this.viewSettings.numViews
        ))) {
            params[key] = value;
        }

        return params;
    }


    /** Returns URL layers that are currently visible or required by feature selections. */
    private urlLayerNamesForSerialization(): string[] {
        const selectedLayerNames = new Set(featureSelectionLayerNames(this.inspectionState.selection));
        const urlLayerNames: string[] = [];
        const addLayerName = (layerName: string) => {
            if (!urlLayerNames.includes(layerName)) {
                urlLayerNames.push(layerName);
            }
        };

        this.layerState.layerNames.forEach((layerName, layerIndex) => {
            if (selectedLayerNames.has(layerName) || this.isLayerVisibleInAnyView(layerIndex)) {
                addLayerName(layerName);
            }
        });
        selectedLayerNames.forEach(addLayerName);
        return urlLayerNames;
    }


    /** Returns whether a layer slot is active in at least one configured map view. */
    private isLayerVisibleInAnyView(layerIndex: number): boolean {
        for (let viewIndex = 0; viewIndex < Math.max(1, this.viewSettings.numViews); viewIndex++) {
            if (this.layerState.layerVisibilityState.getValue(viewIndex)[layerIndex]) {
                return true;
            }
        }
        return false;
    }


    /** Returns true for per-view arrays whose entries are indexed by `layerNames`. */
    private isLayerIndexedMapViewState(state: unknown): boolean {
        return state === this.layerState.layerVisibilityState.appState
            || state === this.layerState.layerZoomLevelState.appState
            || state === this.layerState.layerAutoZoomLevelState.appState;
    }


    /** Serializes one layer-indexed per-view state against the finalized v2 URL layer order. */
    private serializeLayerIndexedMapViewParam<T>(
        params: Record<string, string | string[]>,
        key: string,
        state: MapViewState<T[]>,
        urlLayerNames: readonly string[],
        fallback: T,
        encode: (value: T) => string
    ): void {
        if (!urlLayerNames.length) {
            return;
        }
        const currentLayerIndexByName = new Map(this.layerState.layerNames.map((layerName, index) => [layerName, index]));
        const groups: string[] = [];
        for (let viewIndex = 0; viewIndex < Math.max(1, this.viewSettings.numViews); viewIndex++) {
            const currentValues = state.getValue(viewIndex);
            groups.push(urlLayerNames.map(layerName => {
                const currentIndex = currentLayerIndexByName.get(layerName);
                const value = currentIndex !== undefined && currentIndex < currentValues.length
                    ? currentValues[currentIndex]
                    : fallback;
                return encode(value);
            }).join(","));
        }
        params[key] = compressUrlCsvRuns(groups.join(":"));
    }


    /** Creates persisted selection MapTileKeys exclusively through mapget's C++ serializer. */
    private readonly createMapTileKeyFromUrlComponents: UrlV2MapTileKeyFactory = (
        layerType,
        mapId,
        layerId,
        tileId
    ) => {
        return coreLib.createMapTileKey(
            layerType,
            mapId,
            layerId,
            tileId);
    };


    /** Restores v2 URL params through a coordinated layer-indexed decode path. */
    private hydrateFromUrlV2(params: Params): void {
        const mapParam = firstParamValue(params, "map");
        const layerParam = firstParamValue(params, "l");
        this.layerState.hasAuthoritativeUrlLayerList = layerParam !== undefined;
        const decodedLayerNames = decodeLayerNamesV2(mapParam, layerParam);
        if (layerParam !== undefined) {
            this.layerState.layerNamesState.next(decodedLayerNames);
        }

        for (const state of this.persistence.registeredStates.values()) {
            if (state === this.layerState.layerNamesState || state === this.inspectionState.selectionState || state === this.layerState.stylesState
                || state === this.viewSettings.viewIdsState || state === this.viewSettings.numViewsState) {
                continue;
            }
            try {
                state.deserialize(params);
            } catch (error) {
                console.error(`[AppStateService] Failed to hydrate v2 state '${state.name}'`, error);
            }
        }

        if (this.hasStyleOptionParams(params)) {
            const decodedStyles = decodeStyleOptionsV2(
                params,
                this.layerState.layerNames,
                this.viewSettings.numViews,
                this.layerState.styles
            );
            this.layerState.stylesState.replacePositional(decodedStyles);
        }

        const selectionParam = firstParamValue(params, "sel");
        if (selectionParam !== undefined) {
            try {
                const mapNames = mapParam ? decodeMapNamesV2(mapParam) : [];
                const panels = decodeSelectionsV2(
                    selectionParam,
                    this.layerState.layerNames,
                    mapNames,
                    DEFAULT_HIGHLIGHT_COLORS,
                    this.createMapTileKeyFromUrlComponents
                );
                if (panels.length || !this.looksLikeLegacySelectionParam(selectionParam)) {
                    this.inspectionState.selectionState.next(panels);
                } else {
                    this.inspectionState.selectionState.next([]);
                    this.persistence.deserializeStateSafely(this.inspectionState.selectionState, {sel: selectionParam});
                }
            } catch (error) {
                console.error("[AppStateService] Failed to hydrate v2 selection state", error);
            }
        } else {
            this.inspectionState.selectionState.next([]);
        }
    }


    /** Detects pre-v2 `sel` payloads that may still be attached to a v2 URL during upgrades or shared-link reuse. */
    private looksLikeLegacySelectionParam(selectionParam: string): boolean {
        if (!selectionParam.trim()) {
            return false;
        }
        return selectionParam.includes("Features:") || selectionParam.includes("SourceData:");
    }


    /** Returns whether the params contain compact style-option entries. */
    private hasStyleOptionParams(params: Params): boolean {
        return Object.keys(params).some(key => this.layerState.stylesState.isStyleOptionUrlParamKey(key));
    }
}
