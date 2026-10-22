import {Injectable, inject, Injector} from "@angular/core";
import {Params} from "@angular/router";
import {z} from "zod";
import {getState} from "@ngrx/signals";
import {StyleOptionsCodec} from "./state-codec";
import {collectActionItems, rejectAction} from "../actions/action-utils";
import {appActions} from "./app-actions.store-feature";
import {AppStore, AppStoreValues} from "./app.store";
import {DEFAULT_HIGHLIGHT_COLORS} from "../inspection/inspection-state.model";
import {coreLib} from "../integrations/wasm";
import {StyleService} from "../styledata/style.service";
import {persistenceDescriptors} from "./persisted-state";
import {unicodePrefix} from "./unicode-string";
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

/**
 * Projects the native store into erdblick's released URL formats. Like browser
 * persistence, it discovers the domain codecs from AppStore itself. It has no
 * registration callback or dependency on AppStateService: that service asks this
 * owner to prepare complete URL imports and to serialize scheduled URL updates.
 *
 * Constructing the codec does not start resource engines. Share-link diagnostics
 * resolve StyleService only when the user actually requests a link.
 */
@Injectable({providedIn: "root"})
export class AppUrlStateService {
    private readonly injector = inject(Injector);
    private readonly store = inject(AppStore);
    private readonly fields = persistenceDescriptors(this.store);
    private readonly styleOptions = this.fields.find(field => field.name === "styleOptions")!;
    private readonly selection = this.fields.find(field => field.name === "selected")!;
    private readonly actionEncoder = new TextEncoder();

    /** Exports the normal URL projection without browser navigation or credentials. */
    getShareLink(): z.output<typeof appActions.getShareLink.outputSchema> {
        const url = this.shareableUrl();
        if (this.actionEncoder.encode(url).length > 48000) {
            rejectAction("The share link exceeds the response budget; reduce URL-backed state first");
        }
        const hostname = new URL(url).hostname;
        const styles = collectActionItems(
            function* (this: AppUrlStateService) {
                for (const style of this.injector.get(StyleService).styles.values()) {
                    if (style.visible && (style.imported || style.modified)) yield unicodePrefix(style.id, 4096);
                }
            }.call(this),
            100,
            64000
        );
        const searches = collectActionItems(
            function* (this: AppUrlStateService) {
                for (const search of this.store.featureSearchEntries()) {
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
        const current = getState(this.store);
        const params = includeUnknownParams ? this.preservedUnknownUrlParams(currentParams) : {};
        params["v2"] = "1";

        const urlLayerNames = this.urlLayerNamesForSerialization();

        for (const state of this.fields) {
            if (
                state.name === "layerNames" ||
                state.name === "selected" ||
                state.name === "styleOptions" ||
                this.isLayerIndexedMapViewState(state)
            ) {
                continue;
            }
            if (!state.codec.isUrlState()) {
                continue;
            }
            const serialized = state.serialize(current, true);
            if (serialized === undefined) {
                continue;
            }
            for (const [key, value] of Object.entries(serialized)) {
                if (value !== null) {
                    params[key] = compressUrlCsvRuns(value);
                }
            }
        }

        const layerEncoding = encodeLayerNamesV2(urlLayerNames, sourceDataSelectionMapIds(this.store.inspection.selection()));
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
            this.store.layers.layerVisibility(),
            urlLayerNames,
            false,
            (value) => (value ? "1" : "0")
        );
        this.serializeLayerIndexedMapViewParam(
            params,
            "z",
            this.store.layers.layerZoomLevel(),
            urlLayerNames,
            13,
            (value) => String(value)
        );
        this.serializeLayerIndexedMapViewParam(
            params,
            "az",
            this.store.layers.layerAutoZoomLevel(),
            urlLayerNames,
            true,
            (value) => (value ? "1" : "0")
        );

        const selection = encodeSelectionsV2(
            this.store.inspection.selection(),
            urlLayerNames,
            layerEncoding.mapNames,
            DEFAULT_HIGHLIGHT_COLORS
        );
        if (selection) {
            params["sel"] = selection;
        }

        for (const [key, value] of Object.entries(
            encodeStyleOptionsV2(this.styleOptions.read(current), urlLayerNames, current.viewIds.length)
        )) {
            params[key] = value;
        }

        return params;
    }

    /** Returns URL layers that are currently visible or required by feature selections. */
    private urlLayerNamesForSerialization(): string[] {
        const selectedLayerNames = new Set(featureSelectionLayerNames(this.store.inspection.selection()));
        const urlLayerNames: string[] = [];
        const addLayerName = (layerName: string) => {
            if (!urlLayerNames.includes(layerName)) {
                urlLayerNames.push(layerName);
            }
        };

        this.store.layers.layerNames().forEach((layerName, layerIndex) => {
            if (selectedLayerNames.has(layerName) || this.isLayerVisibleInAnyView(layerIndex)) {
                addLayerName(layerName);
            }
        });
        selectedLayerNames.forEach(addLayerName);
        return urlLayerNames;
    }

    /** Returns whether a layer slot is active in at least one configured map view. */
    private isLayerVisibleInAnyView(layerIndex: number): boolean {
        for (let viewIndex = 0; viewIndex < Math.max(1, this.store.viewIds().length); viewIndex++) {
            if (this.store.layers.layerVisibility()[this.store.viewIds()[viewIndex]][layerIndex]) {
                return true;
            }
        }
        return false;
    }

    /** Layer arrays share the v2 dictionary built from visible/selected layer names. */
    private isLayerIndexedMapViewState(state: {name: string}): boolean {
        return ["visibility", "zoomLevel", "autoZoomLevel"].includes(state.name);
    }

    /** Serializes one layer-indexed per-view state against the finalized v2 URL layer order. */
    private serializeLayerIndexedMapViewParam<T>(
        params: Record<string, string | string[]>,
        key: string,
        state: Record<string, T[]>,
        urlLayerNames: readonly string[],
        fallback: T,
        encode: (value: T) => string
    ): void {
        if (!urlLayerNames.length) {
            return;
        }
        const currentLayerIndexByName = new Map(this.store.layers.layerNames().map((layerName, index) => [layerName, index]));
        const groups: string[] = [];
        for (let viewIndex = 0; viewIndex < Math.max(1, this.store.viewIds().length); viewIndex++) {
            const currentValues = state[this.store.viewIds()[viewIndex]] ?? [];
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
            const styleOptionKey = this.styleOptions.codec instanceof StyleOptionsCodec &&
                this.styleOptions.codec.isStyleOptionUrlParamKey(key);
            if (managedKeys.has(key) || styleOptionKey) {
                continue;
            }
            params[key] = Array.isArray(value) ? value.map((entry) => String(entry)) : String(value);
        }
        return params;
    }

    /** Returns query-param keys owned by Erdblick URL state. */
    private managedUrlParamKeys(): Set<string> {
        const current = getState(this.store);
        const keys = new Set<string>(["v2", "map", "osm"]);
        keys.add("s");
        for (const state of this.fields) {
            if (state.name === "styleOptions" || !state.codec.isUrlState()) {
                continue;
            }
            const serialized = state.serialize(current, true);
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

    /**
     * Decode dictionaries into a local root value. The persistence owner installs
     * the completed result once, after the view layout and all selection keys pass
     * their ordinary codecs. No intermediate dictionary can reach a renderer.
     */
    prepare(state: AppStoreValues, params: Params): AppStoreValues {
        if (!Object.keys(params).length) {
            return state;
        }
        const v2 = firstParamValue(params, "v2") === "1";
        let next = {
            ...state,
            layers: {
                ...state.layers,
                authoritativeUrlLayers: v2 && firstParamValue(params, "l") !== undefined
            }
        };
        if (!v2) {
            for (const field of this.fields) {
                // The persistence owner resolves membership first, before any
                // positional field such as cameraView or visibility is decoded.
                if (field.name === "viewIds" || field.name === "numberOfViews") {
                    continue;
                }
                next = field.deserialize(next, params);
            }
            return next;
        }

        const mapParam = firstParamValue(params, "map");
        const layerParam = firstParamValue(params, "l");
        const names = decodeLayerNamesV2(mapParam, layerParam);
        if (layerParam !== undefined) {
            // An explicit empty dictionary clears the layers. An omitted dictionary
            // leaves existing layer order available to a partial link. Preserve
            // each retained layer's settings by name before applying URL overrides.
            const positions = names.map(name => next.layers.layerNames.indexOf(name));
            const project = <Value>(records: Record<string, Value[]>, fallback: Value) =>
                Object.fromEntries(next.viewIds.map(id => [
                    id,
                    positions.map(index => records[id]?.[index] ?? fallback)
                ]));
            next = {
                ...next,
                layers: {
                    ...next.layers,
                    layerNames: names,
                    layerVisibility: project(next.layers.layerVisibility, false),
                    layerZoomLevel: project(next.layers.layerZoomLevel, 13),
                    layerAutoZoomLevel: project(next.layers.layerAutoZoomLevel, true)
                }
            };
        }

        for (const field of this.fields) {
            if (["viewIds", "numberOfViews", "layerNames", "selected", "styleOptions"].includes(field.name)) {
                continue;
            }
            next = field.deserialize(next, params);
        }

        const styles = this.styleOptions;
        if (Object.keys(params).some(key => (styles.codec as StyleOptionsCodec).isStyleOptionUrlParamKey(key))) {
            next = styles.replace(next, decodeStyleOptionsV2(
                params,
                next.layers.layerNames,
                next.viewIds.length,
                styles.read(next)
            ));
        }

        // Selection is a scene replacement: an omitted v2 sel means no panels.
        // Invalid native keys reject the candidate before AppStateService publishes it.
        const selectionParam = firstParamValue(params, "sel");
        if (selectionParam === undefined) {
            return {...next, inspection: {...next.inspection, selection: []}};
        }
        const mapNames = mapParam ? decodeMapNamesV2(mapParam) : [];
        const panels = decodeSelectionsV2(
            selectionParam,
            next.layers.layerNames,
            mapNames,
            DEFAULT_HIGHLIGHT_COLORS,
            this.createMapTileKeyFromUrlComponents
        );
        next = {...next, inspection: {...next.inspection, selection: panels}};
        if (!panels.length && (selectionParam.includes("Features:") || selectionParam.includes("SourceData:"))) {
            next = this.selection.deserialize(next, {sel: selectionParam});
        }
        return next;
    }
}
