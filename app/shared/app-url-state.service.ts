import {Injectable, inject} from "@angular/core";
import {Params} from "@angular/router";
import {z} from "zod";
import {bounded, identifierSchema, observed} from "../actions/action-schema";
import {collectActionItems, rejectAction} from "../actions/action-utils";
import {AppActionService} from "../actions/app-action.service";
import {DEFAULT_HIGHLIGHT_COLORS} from "../inspection/inspection-state.model";
import {InspectionStateService} from "../inspection/inspection-state.service";
import {coreLib} from "../integrations/wasm";
import {MapLayerStateService} from "../mapdata/map-layer-state.service";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {FeatureSearchService} from "../search/feature.search.service";
import {StyleService} from "../styledata/style.service";
import {MapViewState} from "./app-state";
import {AppStateService} from "./appstate.service";
import {boundedUnicodeString, unicodePrefix} from "./unicode-string";
import type {UrlV2MapTileKeyFactory} from "./url-state-codec";
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

/** Builds shareable URL state and explains the local data a recipient also needs. */
@Injectable({providedIn: "root"})
export class AppUrlStateService {
    static readonly actions = {
        getShareLink: {
            name: "viewer_get_share_link",
            description:
                "Return a link for the current URL-backed cameras, layers, style options and selections using the viewer's normal URL codec. Does not copy unknown/authentication URL parameters, modify the tab, publish anything or contact another person. Browser-local search overlays and YAML styles are not embedded; localSearchIds and localStyleIds identify dependencies the recipient would also need. Export searches separately with viewer_export_search and styles with viewer_get_style. localOnly means the hostname is loopback: recipients need an accessible address for the same configured viewer.",
            mutation: false,
            inputSchema: z.strictObject({}),
            outputSchema: z.strictObject({
                ...observed,
                ...bounded,
                url: boundedUnicodeString(48000, true),
                localOnly: z.boolean(),
                localStyleIds: z.array(identifierSchema).max(100),
                localSearchIds: z.array(identifierSchema).max(100)
            })
        }
    } as const;

    private readonly state = inject(AppStateService);
    private readonly styles = inject(StyleService);
    private readonly searches = inject(FeatureSearchService);
    private readonly layers = inject(MapLayerStateService);
    private readonly views = inject(MapViewStateService);
    private readonly inspections = inject(InspectionStateService);
    private readonly actionEncoder = new TextEncoder();

    constructor() {
        this.state.registerUrlCodec({
            serialize: (params) => this.serializeUrlV2(true, params),
            hydrate: (params) => this.hydrate(params)
        });
        inject(AppActionService).registerAction(AppUrlStateService.actions.getShareLink, () => this.getShareLink());
    }

    /** Exports the normal URL projection without browser navigation or credentials. */
    getShareLink(): z.output<typeof AppUrlStateService.actions.getShareLink.outputSchema> {
        const url = this.shareableUrl();
        if (this.actionEncoder.encode(url).length > 48000)
            rejectAction("The share link exceeds the response budget; reduce URL-backed state first");
        const hostname = new URL(url).hostname;
        const styles = collectActionItems(
            function* (this: AppUrlStateService) {
                for (const style of this.styles.styles.values()) {
                    if (style.visible && (style.imported || style.modified)) yield unicodePrefix(style.id, 4096);
                }
            }.call(this),
            100,
            64000
        );
        const searches = collectActionItems(
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
            localOnly: hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname),
            localStyleIds: styles.items,
            localSearchIds: searches.items,
            complete: styles.complete && searches.complete,
            reason: styles.reason ?? searches.reason
        };
    }

    /** Returns current URL-backed state without copying authentication or unknown URL parameters. */
    shareableUrl(): string {
        const url = new URL(window.location.pathname, window.location.origin);
        for (const [key, value] of Object.entries(this.serializeUrlV2(false))) {
            for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
        }
        return url.href;
    }

    /** Builds a complete v2 query-param set so all layer-indexed params share one order. */
    serializeUrlV2(includeUnknownParams = true, currentParams: Params = {}): Record<string, string | string[]> {
        const params = includeUnknownParams ? this.preservedUnknownUrlParams(currentParams) : {};
        params["v2"] = "1";

        const urlLayerNames = this.urlLayerNamesForSerialization();

        for (const state of this.state.registeredStates) {
            if (
                state === this.layers.layerNamesState ||
                state === this.inspections.selectionState ||
                state === this.layers.stylesState ||
                this.isLayerIndexedMapViewState(state)
            ) {
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

        const layerEncoding = encodeLayerNamesV2(urlLayerNames, sourceDataSelectionMapIds(this.inspections.selection));
        if (layerEncoding.map) {
            params["map"] = layerEncoding.map;
        }
        if (layerEncoding.l !== null) {
            params["l"] = layerEncoding.l;
        } else if (!urlLayerNames.length) {
            params["l"] = "";
        }
        this.serializeLayerIndexedMapViewParam(
            params,
            "v",
            this.layers.layerVisibilityState,
            urlLayerNames,
            false,
            (value) => (value ? "1" : "0")
        );
        this.serializeLayerIndexedMapViewParam(
            params,
            "z",
            this.layers.layerZoomLevelState,
            urlLayerNames,
            13,
            (value) => String(value)
        );
        this.serializeLayerIndexedMapViewParam(
            params,
            "az",
            this.layers.layerAutoZoomLevelState,
            urlLayerNames,
            true,
            (value) => (value ? "1" : "0")
        );

        const selection = encodeSelectionsV2(
            this.inspections.selection,
            urlLayerNames,
            layerEncoding.mapNames,
            DEFAULT_HIGHLIGHT_COLORS
        );
        if (selection) {
            params["sel"] = selection;
        }

        for (const [key, value] of Object.entries(
            encodeStyleOptionsV2(this.layers.styles, urlLayerNames, this.views.numViews)
        )) {
            params[key] = value;
        }

        return params;
    }

    /** Returns URL layers that are currently visible or required by feature selections. */
    private urlLayerNamesForSerialization(): string[] {
        const selectedLayerNames = new Set(featureSelectionLayerNames(this.inspections.selection));
        const urlLayerNames: string[] = [];
        const addLayerName = (layerName: string) => {
            if (!urlLayerNames.includes(layerName)) {
                urlLayerNames.push(layerName);
            }
        };

        this.layers.layerNames.forEach((layerName, layerIndex) => {
            if (selectedLayerNames.has(layerName) || this.isLayerVisibleInAnyView(layerIndex)) {
                addLayerName(layerName);
            }
        });
        selectedLayerNames.forEach(addLayerName);
        return urlLayerNames;
    }

    /** Returns whether a layer slot is active in at least one configured map view. */
    private isLayerVisibleInAnyView(layerIndex: number): boolean {
        for (let viewIndex = 0; viewIndex < Math.max(1, this.views.numViews); viewIndex++) {
            if (this.layers.layerVisibilityState.getValue(viewIndex)[layerIndex]) {
                return true;
            }
        }
        return false;
    }

    /** Returns true for per-view arrays whose entries are indexed by `layerNames`. */
    private isLayerIndexedMapViewState(state: unknown): boolean {
        return (
            state === this.layers.layerVisibilityState.appState ||
            state === this.layers.layerZoomLevelState.appState ||
            state === this.layers.layerAutoZoomLevelState.appState
        );
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
        const currentLayerIndexByName = new Map(this.layers.layerNames.map((layerName, index) => [layerName, index]));
        const groups: string[] = [];
        for (let viewIndex = 0; viewIndex < Math.max(1, this.views.numViews); viewIndex++) {
            const currentValues = state.getValue(viewIndex);
            groups.push(
                urlLayerNames
                    .map((layerName) => {
                        const currentIndex = currentLayerIndexByName.get(layerName);
                        const value =
                            currentIndex !== undefined && currentIndex < currentValues.length
                                ? currentValues[currentIndex]
                                : fallback;
                        return encode(value);
                    })
                    .join(",")
            );
        }
        params[key] = compressUrlCsvRuns(groups.join(":"));
    }

    /** Keeps non-Erdblick query params while dropping stale v1 and v2 state params. */
    private preservedUnknownUrlParams(currentParams: Params): Record<string, string | string[]> {
        const managedKeys = this.managedUrlParamKeys();
        const params: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(currentParams)) {
            if (managedKeys.has(key) || this.layers.stylesState.isStyleOptionUrlParamKey(key)) {
                continue;
            }
            params[key] = Array.isArray(value) ? value.map((entry) => String(entry)) : String(value);
        }
        return params;
    }

    /** Returns query-param keys owned by Erdblick URL state. */
    private managedUrlParamKeys(): Set<string> {
        const keys = new Set<string>(["v2", "map", "osm"]);
        keys.add("s");
        for (const state of this.state.registeredStates) {
            if (state === this.layers.stylesState || !state.isUrlState()) {
                continue;
            }
            const serialized = state.serialize(true);
            if (serialized === undefined) {
                continue;
            }
            for (const key of Object.keys(serialized)) {
                keys.add(key);
            }
        }
        return keys;
    }

    /** Creates persisted selection MapTileKeys exclusively through mapget's C++ serializer. */
    private readonly createMapTileKeyFromUrlComponents: UrlV2MapTileKeyFactory = (
        layerType,
        mapId,
        layerId,
        tileId
    ) => {
        return coreLib.createMapTileKey(layerType, mapId, layerId, tileId);
    };

    /** Restores v2 URL params through a coordinated layer-indexed decode path. */
    private hydrateFromUrlV2(params: Params): void {
        const mapParam = firstParamValue(params, "map");
        const layerParam = firstParamValue(params, "l");

        const decodedLayerNames = decodeLayerNamesV2(mapParam, layerParam);
        if (decodedLayerNames.length) {
            this.layers.layerNamesState.next(decodedLayerNames);
        }

        for (const state of this.state.registeredStates) {
            if (
                state === this.layers.layerNamesState ||
                state === this.inspections.selectionState ||
                state === this.layers.stylesState
            ) {
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
                this.layers.layerNames,
                this.views.numViews,
                this.layers.stylesState.getValue()
            );
            this.layers.stylesState.next(decodedStyles);
        }

        const selectionParam = firstParamValue(params, "sel");
        if (selectionParam !== undefined) {
            try {
                const mapNames = mapParam ? decodeMapNamesV2(mapParam) : [];
                const panels = decodeSelectionsV2(
                    selectionParam,
                    this.layers.layerNames,
                    mapNames,
                    DEFAULT_HIGHLIGHT_COLORS,
                    this.createMapTileKeyFromUrlComponents
                );
                if (panels.length || !this.looksLikeLegacySelectionParam(selectionParam)) {
                    this.inspections.selectionState.next(panels);
                } else {
                    this.inspections.selectionState.next([]);
                    this.deserializeStateSafely(this.inspections.selectionState, {sel: selectionParam});
                }
            } catch (error) {
                console.error("[AppStateService] Failed to hydrate v2 selection state", error);
            }
        } else {
            this.inspections.selectionState.next([]);
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
        return Object.keys(params).some((key) => this.layers.stylesState.isStyleOptionUrlParamKey(key));
    }

    /** Keeps one malformed persisted state entry from aborting startup hydration. */
    private deserializeStateSafely(
        state: {name: string; deserialize(raw: string | Params): void},
        raw: string | Params
    ): void {
        try {
            state.deserialize(raw);
        } catch (error) {
            console.error(`[AppStateService] Failed to hydrate ${state.name}.`, error);
        }
    }
    /** Owners share one decoded dictionary; persistence supplies the enclosing hydration transaction. */
    private hydrate(params: Params): void {
        if (!Object.keys(params).length) return;
        if (firstParamValue(params, "v2") === "1") this.hydrateFromUrlV2(params);
        else for (const state of this.state.registeredStates) this.deserializeStateSafely(state, params);
    }
}
