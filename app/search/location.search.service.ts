import { HttpClient, HttpHeaders, HttpParams } from "@angular/common/http";
import { Injectable } from "@angular/core";
import {
    catchError,
    forkJoin,
    map,
    Observable,
    of,
    timeout
} from "rxjs";
import {
    AppConfigService,
    LocationSearchAdapterConfig,
    LocationSearchFieldSelector,
    LocationSearchProviderConfig
} from "../config/app-config.service";
import type { LocationArea } from "../mapview/render-view.model";
import { SearchTarget } from "../navigation/jump.service";
import { AppStateService } from "../state/app-state.service";
import { locationExtent, locationGeometryExtent, locationPoint, locationPolygons } from "./location-geometry";
import { LocationSearchStore } from "./location-search.store";

export type LocationPoint = [number, number];
export type LocationAabb = [LocationPoint, LocationPoint];

const MAPGET_LOCATION_PROVIDER_ID = "mapget-offline";
const MAPGET_LOCATION_ENDPOINT_URL = "/location";
const LOCATION_SEARCH_TARGET_PREFIX = "loc:";
const LOCATION_DETAIL_TIMEOUT_MS = 8000;

export interface LocationSearchMatch {
    id: string;
    name: string;
    lonLat?: LocationPoint;
    aabb?: LocationAabb;
    geometryAvailable?: boolean;
    attribution?: { name: string; url?: string; licenseUrl?: string };
    source?: string;
    countryCode?: string;
    population?: number;
    providerId: string;
    providerName: string;
}

/** The first usable representation of a selected result, separate from persisted metadata. */
export interface ResolvedLocationNavigation {
    area?: LocationArea;
    point?: LocationPoint;
    label?: string;
    notice?: string;
    error?: string;
}

const LOCATION_SEARCH_QUERY_PATTERN = /^\p{L}[\p{L}\p{M}\p{Zs}.'’,\-]*$/u;

/** Returns whether a query is suitable for configured place-name providers. */
export function isSupportedLocationSearchQuery(value: string): boolean {
    const query = value.trim().normalize("NFC");
    return query.length > 0 && LOCATION_SEARCH_QUERY_PATTERN.test(query);
}

/** Returns a normalized location payload, or null if the shape is not executable. */
export function normalizeLocationSearchPayload(raw: unknown): LocationSearchMatch | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return null;
    }
    const value = raw as Partial<LocationSearchMatch>;
    if (typeof value.id !== "string" || !value.id.trim()
        || typeof value.name !== "string" || !value.name.trim()
        || typeof value.providerId !== "string" || !value.providerId.trim()
        || typeof value.providerName !== "string" || !value.providerName.trim()) {
        return null;
    }

    const point = locationPoint(value.lonLat);
    const aabb = normalizeAabb(value.aabb) ?? (point ? [point, [0, 0]] as LocationAabb : undefined);
    const builtin = value.providerId === MAPGET_LOCATION_PROVIDER_ID && /^wof:[1-9]\d*$/.test(value.id);
    if (!point && !(builtin && (locationExtent(aabb) || value.geometryAvailable === true))) return null;

    const normalized: LocationSearchMatch = {
        id: value.id.trim(),
        name: value.name.trim(),
        ...(point ? { lonLat: point } : {}),
        ...(aabb ? { aabb } : {}),
        providerId: value.providerId.trim(),
        providerName: value.providerName.trim()
    };
    if (typeof value.geometryAvailable === "boolean") normalized.geometryAvailable = value.geometryAvailable;
    if (value.attribution && typeof value.attribution.name === "string") {
        normalized.attribution = { name: value.attribution.name.slice(0, 200) };
        for (const key of ["url", "licenseUrl"] as const) {
            const url = value.attribution[key];
            if (typeof url === "string" && /^https?:\/\//i.test(url) && url.length <= 2048) normalized.attribution[key] = url;
        }
    }

    if (typeof value.source === "string" && value.source.trim()) {
        normalized.source = value.source.trim();
    }
    if (typeof value.countryCode === "string" && value.countryCode.trim()) {
        normalized.countryCode = value.countryCode.trim();
    }
    if (typeof value.population === "number" && Number.isFinite(value.population)) {
        normalized.population = Number(value.population);
    }
    return normalized;
}

function normalizeAabb(value: unknown): LocationAabb | null {
    if (!(Array.isArray(value)
        && value.length === 2
        && Array.isArray(value[0])
        && Array.isArray(value[1])
        && value[0].length === 2
        && value[1].length === 2
        && value.flat().every(entry => typeof entry === "number" && Number.isFinite(entry)))) {
        return null;
    }
    const aabb = value as [[unknown, unknown], [unknown, unknown]];
    return [
        [Number(aabb[0][0]), Number(aabb[0][1])],
        [Number(aabb[1][0]), Number(aabb[1][1])]
    ];
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function populationRank(match: LocationSearchMatch): number {
    return typeof match.population === "number" && Number.isFinite(match.population)
        ? match.population
        : -1;
}

function compareLocationMatches(lhs: LocationSearchMatch, rhs: LocationSearchMatch): number {
    const populationDelta = populationRank(rhs) - populationRank(lhs);
    if (populationDelta !== 0) {
        return populationDelta;
    }
    return lhs.name.localeCompare(rhs.name)
        || lhs.providerName.localeCompare(rhs.providerName)
        || lhs.id.localeCompare(rhs.id);
}

function parseAdapterPath(path: string): Array<string | number> | null {
    let source = path.trim();
    if (!source || source === "$") {
        return [];
    }
    if (source.startsWith("$.")) {
        source = source.slice(2);
    } else if (source.startsWith("$")) {
        source = source.slice(1);
    }
    if (source.startsWith(".")) {
        source = source.slice(1);
    }

    const segments: Array<string | number> = [];
    let cursor = 0;
    while (cursor < source.length) {
        if (source[cursor] === ".") {
            cursor += 1;
            continue;
        }
        if (source[cursor] === "[") {
            const close = source.indexOf("]", cursor + 1);
            if (close < 0) {
                return null;
            }
            const token = source.slice(cursor + 1, close).trim();
            const quoted = (token.startsWith("\"") && token.endsWith("\""))
                || (token.startsWith("'") && token.endsWith("'"));
            if (quoted) {
                segments.push(token.slice(1, -1));
            } else {
                const index = Number(token);
                if (!Number.isInteger(index)) {
                    return null;
                }
                segments.push(index);
            }
            cursor = close + 1;
            continue;
        }

        const nextDot = source.indexOf(".", cursor);
        const nextBracket = source.indexOf("[", cursor);
        const next = [nextDot, nextBracket].filter(index => index >= 0).sort((lhs, rhs) => lhs - rhs)[0] ?? source.length;
        const key = source.slice(cursor, next).trim();
        if (!key) {
            return null;
        }
        segments.push(key);
        cursor = next;
    }

    return segments;
}

function readAdapterPath(source: unknown, path: string | undefined): unknown {
    if (!path) {
        return undefined;
    }
    const segments = parseAdapterPath(path);
    if (!segments) {
        return undefined;
    }

    let current = source;
    for (const segment of segments) {
        if (typeof segment === "number") {
            if (!Array.isArray(current) || segment < 0 || segment >= current.length) {
                return undefined;
            }
            current = current[segment];
            continue;
        }
        if (!current || typeof current !== "object" || Array.isArray(current) || !(segment in current)) {
            return undefined;
        }
        current = (current as Record<string, unknown>)[segment];
    }
    return current;
}

function renderAdapterTemplate(source: unknown, template: string): string {
    return template.replace(/\{([^{}]+)\}/g, (_match, path: string) => {
        const value = readAdapterPath(source, path);
        return value === undefined || value === null ? "" : String(value);
    }).trim();
}

function readAdapterField(source: unknown, selector: LocationSearchFieldSelector | undefined): unknown {
    if (selector === undefined) {
        return undefined;
    }
    if (typeof selector === "string") {
        return readAdapterPath(source, selector);
    }
    if (typeof selector === "number" || typeof selector === "boolean") {
        return selector;
    }
    if (selector.value !== undefined) {
        return selector.value;
    }
    if (selector.template !== undefined) {
        return renderAdapterTemplate(source, selector.template);
    }
    return readAdapterPath(source, selector.path);
}

function stringValue(value: unknown): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    const result = String(value).trim();
    return result ? result : undefined;
}

function numberValue(value: unknown): number | undefined {
    const result = Number(value);
    return Number.isFinite(result) ? result : undefined;
}

function arrayNumbers(value: unknown): number[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const result = value.map(entry => numberValue(entry));
    return result.every(entry => entry !== undefined) ? result as number[] : null;
}

@Injectable({ providedIn: "root" })
export class LocationSearchService {

    constructor(
        private readonly httpClient: HttpClient,
        private readonly configService: AppConfigService,
        private readonly persistence: AppStateService,
        public readonly store: LocationSearchStore) {
    }

    get debounceMs(): number {
        return this.configService.snapshot.locationSearch.debounceMs;
    }

    get minCharacters(): number {
        return this.configService.snapshot.locationSearch.minCharacters;
    }

    /** Requests location matches from every enabled configured provider. */
    search(query: string, limit: number): Observable<LocationSearchMatch[]> {
        const trimmedQuery = query.trim();
        if (!isSupportedLocationSearchQuery(trimmedQuery) || trimmedQuery.length < this.minCharacters) {
            return of([]);
        }

        const cappedLimit = Math.max(1, Math.trunc(limit));
        const providers = this.configService.snapshot.locationSearch.providers.filter(provider => provider.enabled);
        if (!providers.length) {
            return of([]);
        }

        return forkJoin(providers.map(provider => this.searchProvider(provider, trimmedQuery, cappedLimit))).pipe(
            map(results => results.flat().sort(compareLocationMatches).slice(0, cappedLimit))
        );
    }

    /** Converts a normalized location match into a search-palette target. */
    createSearchTarget(match: LocationSearchMatch): SearchTarget {
        return {
            id: this.targetId(match),
            icon: "location_city",
            iconType: "material",
            color: "green",
            name: match.name,
            label: this.labelForMatch(match),
            enabled: true,
            payload: match,
            jump: (_value: string, payload: unknown) => {
                const selected = normalizeLocationSearchPayload(payload ?? match);
                return selected?.lonLat ? [selected.lonLat[1], selected.lonLat[0], 0] : undefined;
            },
            validate: () => true
        };
    }

    /** Creates a stable search action id for one provider result. */
    targetId(match: LocationSearchMatch): string {
        return `${LOCATION_SEARCH_TARGET_PREFIX}${match.providerId}:${match.id}`;
    }

    /** Returns whether an action id belongs to a transient location-search target. */
    isLocationTargetId(actionId: string): boolean {
        return actionId.startsWith(LOCATION_SEARCH_TARGET_PREFIX);
    }

    /** Resolves selected WOF identities lazily; history retains only lightweight metadata. */
    resolveNavigation(actionId: string, payload?: unknown): Observable<ResolvedLocationNavigation> {
        const saved = normalizeLocationSearchPayload(payload);
        const match = saved && this.targetId(saved) === actionId ? saved : undefined;
        const prefix = `${LOCATION_SEARCH_TARGET_PREFIX}${MAPGET_LOCATION_PROVIDER_ID}:`;
        const id = actionId.startsWith(prefix) ? actionId.slice(prefix.length) : undefined;
        if (!id || !/^wof:[1-9]\d*$/.test(id)) {
            // Legacy GeoNames payloads and external adapters keep their point contract.
            return of(match?.lonLat ? { point: match.lonLat, label: match.name }
                : { error: "This saved location is unavailable. Search for the place again." });
        }
        if (match?.geometryAvailable === false) return of(this.navigationFromMatch(match));
        const provider = this.configuredMapgetLocationProvider();
        if (!provider?.enabled) return of(this.navigationFromMatch(match, undefined, "Location lookup is disabled."));
        let params = new HttpParams();
        for (const [key, value] of Object.entries(provider.params ?? {})) {
            if (!["name", "id", "geometry", "limit", provider.queryParam, provider.limitParam].includes(key)) {
                params = params.set(key, String(value));
            }
        }
        params = params.set("id", id);
        return this.httpClient.get<unknown>(provider.url, { params, headers: new HttpHeaders(provider.headers ?? {}) }).pipe(
            timeout(LOCATION_DETAIL_TIMEOUT_MS),
            map(response => {
                const raw = Array.isArray(response) && response.length === 1 ? response[0] : undefined;
                if (!raw || typeof raw !== "object" || raw.id !== id) {
                    return this.navigationFromMatch(match, undefined, "The location boundary is unavailable.");
                }
                // A bad point/extent must not discard a valid boundary, and vice versa.
                const polygons = locationPolygons(raw.geometry);
                const fresh = normalizeLocationSearchPayload({
                    ...raw, providerId: provider.id, providerName: provider.name,
                    ...(polygons ? { geometryAvailable: true } : {})
                }) ?? match;
                return this.navigationFromMatch(fresh, polygons,
                    !polygons && (raw.geometry !== undefined || raw.geometryAvailable === true)
                        ? "The location boundary could not be displayed." : undefined);
            }),
            catchError(() => of(this.navigationFromMatch(match, undefined, "The location boundary could not be loaded.")))
        );
    }

    /** Selects geometry, extent, then point without placing boundary arrays in search history. */
    private navigationFromMatch(
        match?: LocationSearchMatch, polygons?: LocationArea["polygons"], reason?: string
    ): ResolvedLocationNavigation {
        if (!match) return { error: reason ?? "This location has no usable position or extent." };
        const extent = locationExtent(match.aabb);
        const rectangle = polygons ? locationGeometryExtent(polygons, extent) : extent;
        if (rectangle) return {
            area: { rectangle, ...(polygons ? { polygons } : {}), label: match.name, representativePoint: match.lonLat },
            ...(reason ? { notice: `${reason} Showing its bounding extent.` } : {})
        };
        if (match.lonLat) return {
            point: match.lonLat, label: match.name,
            ...(reason ? { notice: `${reason} Showing its representative point.` } : {})
        };
        return { error: "This location has no usable position or extent." };
    }

    /** Returns the transient map label for an executable location payload. */
    labelFromPayload(payload: unknown): string | null {
        return normalizeLocationSearchPayload(payload)?.name ?? null;
    }

    private searchProvider(
        provider: LocationSearchProviderConfig,
        query: string,
        limit: number): Observable<LocationSearchMatch[]> {
        return this.searchProviderRequest(provider, query, limit).pipe(
            catchError(error => {
                console.warn(`[LocationSearchService] ${provider.id} request failed`, error);
                return of([]);
            })
        );
    }

    private searchProviderRequest(
        provider: LocationSearchProviderConfig,
        query: string,
        limit: number): Observable<LocationSearchMatch[]> {
        let params = new HttpParams();
        for (const [key, value] of Object.entries(provider.params ?? {})) {
            params = params.set(key, String(value));
        }
        params = params
            .set(provider.queryParam || "name", query)
            .set(provider.limitParam || "limit", String(limit));
        const headers = new HttpHeaders(provider.headers ?? {});

        return this.httpClient.get<unknown>(provider.url, { params, headers }).pipe(
            map(payload => this.normalizeProviderResponse(provider, payload))
        );
    }

    private configuredMapgetLocationProvider(): LocationSearchProviderConfig | undefined {
        return this.configService.snapshot.locationSearch.providers.find(provider =>
            provider.id === MAPGET_LOCATION_PROVIDER_ID && provider.url === MAPGET_LOCATION_ENDPOINT_URL);
    }

    private normalizeProviderResponse(
        provider: LocationSearchProviderConfig,
        payload: unknown): LocationSearchMatch[] {
        const rawMatches = this.providerResponseItems(provider, payload);
        if (!Array.isArray(rawMatches)) {
            return [];
        }

        const matches: LocationSearchMatch[] = [];
        for (const rawMatch of rawMatches) {
            if (!rawMatch || typeof rawMatch !== "object" || Array.isArray(rawMatch)) {
                continue;
            }
            const value = provider.adapter
                ? this.adaptProviderMatch(rawMatch, provider.adapter)
                : rawMatch as Record<string, unknown>;
            const candidate = normalizeLocationSearchPayload({
                ...value,
                providerId: provider.id,
                providerName: provider.name
            });
            if (candidate) {
                matches.push(candidate);
            }
        }
        return matches;
    }

    private providerResponseItems(provider: LocationSearchProviderConfig, payload: unknown): unknown {
        if (!provider.adapter?.itemsPath) {
            return payload;
        }
        return readAdapterPath(payload, provider.adapter.itemsPath);
    }

    private adaptProviderMatch(rawMatch: unknown, adapter: LocationSearchAdapterConfig): Record<string, unknown> {
        const fields = adapter.fields ?? {};
        const normalizedRaw = rawMatch as Record<string, unknown>;
        const adapted: Record<string, unknown> = {
            id: stringValue(readAdapterField(rawMatch, fields.id)) ?? normalizedRaw["id"],
            name: stringValue(readAdapterField(rawMatch, fields.name)) ?? normalizedRaw["name"],
            lonLat: this.adapterLonLat(rawMatch, adapter) ?? normalizedRaw["lonLat"],
            aabb: this.adapterAabb(rawMatch, adapter) ?? normalizedRaw["aabb"],
            source: stringValue(readAdapterField(rawMatch, fields.source)) ?? normalizedRaw["source"],
            countryCode: stringValue(readAdapterField(rawMatch, fields.countryCode)) ?? normalizedRaw["countryCode"]
        };

        const population = numberValue(readAdapterField(rawMatch, fields.population));
        if (population !== undefined) {
            adapted["population"] = population;
        } else if (normalizedRaw["population"] !== undefined) {
            adapted["population"] = normalizedRaw["population"];
        }

        return adapted;
    }

    private adapterLonLat(rawMatch: unknown, adapter: LocationSearchAdapterConfig): LocationPoint | undefined {
        const fields = adapter.fields ?? {};
        const lonLatValues = arrayNumbers(readAdapterField(rawMatch, fields.lonLat));
        if (lonLatValues && lonLatValues.length >= 2) {
            return adapter.lonLatOrder === "latLon"
                ? [lonLatValues[1], lonLatValues[0]]
                : [lonLatValues[0], lonLatValues[1]];
        }

        const lon = numberValue(readAdapterField(rawMatch, fields.longitude));
        const lat = numberValue(readAdapterField(rawMatch, fields.latitude));
        return lon !== undefined && lat !== undefined ? [lon, lat] : undefined;
    }

    private adapterAabb(rawMatch: unknown, adapter: LocationSearchAdapterConfig): LocationAabb | undefined {
        const selectedAabb = readAdapterField(rawMatch, adapter.fields?.aabb);
        const normalizedSelectedAabb = normalizeAabb(selectedAabb);
        if (normalizedSelectedAabb) {
            return normalizedSelectedAabb;
        }
        if (!adapter.bbox) {
            return undefined;
        }

        const rawBbox = readAdapterPath(rawMatch, adapter.bbox.path);
        if (adapter.bbox.format === "aabb") {
            return normalizeAabb(rawBbox) ?? undefined;
        }

        const bboxValues = arrayNumbers(rawBbox);
        if (!bboxValues || bboxValues.length < 4) {
            return undefined;
        }

        const [west, south, east, north] = adapter.bbox.format === "southNorthWestEast"
            ? [bboxValues[2], bboxValues[0], bboxValues[3], bboxValues[1]]
            : [bboxValues[0], bboxValues[1], bboxValues[2], bboxValues[3]];
        return [[west, south], [east - west, north - south]];
    }

    private labelForMatch(match: LocationSearchMatch): string {
        const details = [
            match.providerName,
            match.countryCode,
            typeof match.population === "number" && Number.isFinite(match.population)
                ? `population ${Math.trunc(match.population)}`
                : ""
        ].filter(Boolean);
        const credit = match.attribution;
        if (credit) details.push(credit.name);
        return details.map(detail => escapeHtml(String(detail))).join(" | ")
            + (credit?.url ? ` | <a href="${escapeHtml(credit.url)}" target="_blank" rel="noopener noreferrer">Source</a>` : "")
            + (credit?.licenseUrl ? ` | <a href="${escapeHtml(credit.licenseUrl)}" target="_blank" rel="noopener noreferrer">License</a>` : "");
    }
}
