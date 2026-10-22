import { Injectable } from "@angular/core";
import { Params } from "@angular/router";
import { z } from "zod";
import { ActionRegistry } from "../actions/action-registry.service";
import { boundedCollection, identifierSchema, rejectAction } from "../actions/app-action";
import { AppActionContributor } from "../actions/app-action-contributor";
import { DEFAULT_HIGHLIGHT_COLORS } from "../inspection/inspection-state";
import { InspectionModel } from "../inspection/inspection.model";
import { coreLib } from "../integrations/wasm";
import { MapDataModel } from "../mapdata/mapdata.model";
import { MapViewModel, viewCountSchema, viewIdsSchema } from "../mapview/mapview.model";
import { FeatureSearchModel } from "../feature-search/feature-search.model";
import { boundedUnicodeString, unicodePrefix } from "../shared/unicode-string";
import { StyleService } from "../map-styles/style.service";
import { MapViewState } from "./app-state";
import { AppStateService } from "./app-state.service";
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
@Injectable({ providedIn: "root" })
export class AppUrlStateService implements AppActionContributor {
    /** Validates identity first, so a malformed share link cannot partially replace state. */
    hydrate(params: Params): void {
        if (!Object.keys(params).length) return;
        if (Array.isArray(params["vid"])) throw new Error("The share link contains more than one view ID list.");
        const encodedIds = firstParamValue(params, "vid");
        const ids = encodedIds === undefined ? undefined : encodedIds.split(",").map(decodeURIComponent);
        const count = firstParamValue(params, "n") ?? ids?.length ?? this.viewSettings.numViews;
        const nextIds = this.viewSettings.prepareImportedViews(count, ids, false);
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
        if (!replaceMissing && !Object.hasOwn(values, "viewIds") && !Object.hasOwn(values, "numberOfViews")) return values;
        const ids = values["viewIds"];
        const count = values["numberOfViews"] ?? (Array.isArray(ids) ? ids.length : replaceMissing ? 1 : this.viewSettings.numViews);
        const nextIds = this.viewSettings.prepareImportedViews(count, ids, replaceMissing);
        return {
            viewIds: nextIds, numberOfViews: nextIds.length,
            focus: Math.max(0, nextIds.indexOf(this.viewSettings.focusedViewIdState.value)), ...values
        };
    }

    /** Applies membership through its owner before generic positional snapshot codecs run. */
    applySnapshot(values: Record<string, unknown>): ReadonlySet<string> {
        if (!Object.hasOwn(values, "viewIds")) return new Set();
        this.viewSettings.importViews(viewIdsSchema.parse(values["viewIds"]));
        return new Set(["viewIds", "numberOfViews"]);
    }

    /** Applies config-versus-user storage choices before any positional value is decoded. */
    prepareStoredViews(values: Map<string, string>, params: Params, configKeys: ReadonlySet<string> = new Set()): void {
        if (Array.isArray(params["vid"])) throw new Error("The share link contains more than one view ID list.");
        const urlIds = firstParamValue(params, "vid");
        let savedIds: string[] | undefined;
        let savedCount: number | undefined;
        try {
            const raw = values.get("viewIds");
            if (raw !== undefined) savedIds = viewIdsSchema.parse(JSON.parse(raw));
        } catch (error) { this.persistence.reportHydrationError("saved view identities", error); }
        try {
            const raw = values.get("numberOfViews");
            if (raw !== undefined) savedCount = viewCountSchema.parse(JSON.parse(raw));
        } catch (error) { this.persistence.reportHydrationError("saved view count", error); }
        let ids = urlIds !== undefined ? urlIds.split(",").map(decodeURIComponent)
            : savedIds;
        const configuredCount = savedCount === undefined && configKeys.has("numberOfViews");
        const count = firstParamValue(params, "n") ?? (urlIds !== undefined && Array.isArray(ids) ? ids.length
            : savedCount !== undefined ? savedCount : configuredCount ? this.viewSettings.numViews
                : Array.isArray(ids) ? ids.length : this.viewSettings.numViews);
        // Legacy links omit identities. Preserve saved/current identities, resizing only
        // for the effective count; explicit lists still require an exact count match.
        if (urlIds === undefined && ids !== undefined) ids = this.viewSettings.resizeStoredViews(ids, count);
        this.viewSettings.importViews(this.viewSettings.prepareImportedViews(count, ids, false));
        // The shared identity preparation consumed these two compatibility keys.
        values.delete("viewIds");
        values.delete("numberOfViews");
    }

    /** Prepares replacement identities before navigation can reset or mutate the current page. */
    prepareUrl(params: Params, resetMissing: boolean): Params {
        if (Array.isArray(params["vid"])) throw new Error("The share link contains more than one view ID list.");
        const raw = firstParamValue(params, "vid");
        const ids = raw === undefined ? undefined : raw.split(",").map(decodeURIComponent);
        const count = firstParamValue(params, "n") ?? ids?.length ?? (resetMissing ? 1 : this.viewSettings.numViews);
        const prepared = this.viewSettings.prepareImportedViews(count, ids, resetMissing);
        return { ...params, n: String(prepared.length), vid: prepared.join(",") };
    }

    /** Applies the old OSM alias only when no explicit background preference exists. */
    initialize(params: Params): void { this.viewSettings.migrateLegacyOsmState(params); }

    constructor(private readonly persistence: AppStateService,
        private readonly layerState: MapDataModel,
        private readonly inspectionState: InspectionModel,
        private readonly viewSettings: MapViewModel,
        private readonly styles: StyleService,
        private readonly searches: FeatureSearchModel) {
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
                    this.persistence.deserializeStateSafely(this.inspectionState.selectionState, { sel: selectionParam });
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
    /** Registers semantic operations and their live omnibar candidates. */
    registerActions(actions: ActionRegistry): void {
        actions.registerAction(
            {
                name: "viewer_get_share_link",
                description:
                    "Return a link for the current URL-backed cameras, layers, style options and selections using " +
                    "the viewer's normal URL codec. Does not copy unknown/authentication URL parameters, modify the " +
                    "tab, publish anything or contact another person. Browser-local search overlays and YAML styles " +
                    "are not embedded; localSearchIds and localStyleIds identify dependencies the recipient would " +
                    "also need. Export searches separately with viewer_export_search and styles with " +
                    "viewer_get_style. localOnly means the hostname is loopback: recipients need an accessible " +
                    "address for the same configured viewer.",
                mutation: false,
                inputSchema: z.strictObject({}),
                outputSchema: z.strictObject({
                    observedAt: z.string(),
                    complete: z.boolean(),
                    reason: z.enum(["item_limit", "byte_limit", "text_limit", "loading"]).optional(),
                    url: boundedUnicodeString(48000, true),
                    localOnly: z.boolean(),
                    localStyleIds: z.array(identifierSchema).max(100),
                    localSearchIds: z.array(identifierSchema).max(100)
                })
            },
            () => this.getShareLink()
        );
    }


    /** Exports the normal URL projection without browser navigation or credentials. */
    getShareLink() {
        const url = this.persistence.shareableUrl();
        if (new TextEncoder().encode(url).length > 48000)
            rejectAction("The share link exceeds the response budget; reduce URL-backed state first");
        const hostname = new URL(url).hostname;
        const styles = boundedCollection(
            function* (this: AppUrlStateService) {
                for (const style of this.styles.styles.values()) {
                    if (style.visible && (style.imported || style.modified))
                        yield unicodePrefix(style.id, 4096);
                }
            }.call(this),
            100,
            64000
        );
        const searches = boundedCollection(
            function* (this: AppUrlStateService) {
                for (const search of this.searches.featureSearches) {
                    if (search.enabled && search.showResultsOnMap) yield unicodePrefix(search.id, 4096);
                }
            }.call(this),
            100,
            64000
        );
        return {
            observedAt: new Date().toISOString(),
            url,
            localOnly:
                hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname),
            localStyleIds: styles.items,
            localSearchIds: searches.items,
            complete: styles.complete && searches.complete,
            reason: styles.reason ?? searches.reason
        };
    }

}
