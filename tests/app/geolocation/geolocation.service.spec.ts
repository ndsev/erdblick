import {Subject} from "rxjs";
import {LOCATION_BOUNDARY_TERMS_REVISION} from "../../../app/geolocation/location-policy.model";
import { GeolocationState } from "../../../app/geolocation/geolocation.state";
import {testPersistence, stateOwners} from '../../support/state-owners';
import "@angular/compiler";
import {
    firstValueFrom,
    NEVER,
    of,
    throwError
} from "rxjs";
import {
    describe,
    expect,
    it,
    vi
} from "vitest";

import type { LocationSearchProviderConfig } from "../../../app/geolocation/geolocation.model";
import {
    isSupportedLocationSearchQuery,
    GeolocationService,
    normalizeLocationSearchPayload
} from "../../../app/geolocation/geolocation.service";

class HttpClientStub {
    get = vi.fn();
}

const createService = (providers: LocationSearchProviderConfig[] = [
    {
        id: "mapget-offline",
        name: "Place",
        url: "/location",
        headers: {},
        enabled: true
    }
]) => {
    const httpClient = new HttpClientStub();
    const persistence = testPersistence();
    const state = new GeolocationState(persistence);
    state.locationBoundaryConsentState.next({decision: "accepted", revision: LOCATION_BOUNDARY_TERMS_REVISION});
    const configService = {
        snapshot: {
            locationSearch: {
                providers,
                minCharacters: 2,
                debounceMs: 0
            }
        }
    };
    return {
        service: new GeolocationService(httpClient as any, configService as any, persistence, state),
        httpClient, state
    };
};

const polygon = {type: "Polygon", coordinates: [[[10, 47], [14, 47], [14, 49], [10, 49], [10, 47]]]};
const areaMatch = {id: "wof:1", name: "Place", lonLat: [11.5, 48], aabb: [[10, 47], [4, 2]], geometryAvailable: true};

/** Saved search metadata intentionally contains no polygon. */
function savedArea(overrides: Record<string, unknown> = {}) {
    return {...areaMatch, providerId: "mapget-offline", providerName: "Place", ...overrides};
}

describe("GeolocationService", () => {
    it("does not query providers when location search is disabled", async () => {
        const {service, httpClient, state} = createService();
        state.locationSearchEnabledState.next(false);
        expect(await firstValueFrom(service.search("Place", 10))).toEqual([]);
        expect(httpClient.get).not.toHaveBeenCalled();
    });

    it("cancels an outstanding provider search when disabled", () => {
        const {service, httpClient, state} = createService();
        const response = new Subject<unknown>();
        const next = vi.fn();
        httpClient.get.mockReturnValue(response);
        service.search("Place", 10).subscribe(next);
        expect(response.observed).toBe(true);
        state.locationSearchEnabledState.next(false);
        expect(response.observed).toBe(false);
        response.next([areaMatch]);
        expect(next).not.toHaveBeenCalled();
    });

    it("uses the supplied centrepoint without geometry requests when boundaries are disabled", async () => {
        const {service, httpClient, state} = createService();
        state.locationBoundaryConsentState.next({decision: "disabled", revision: LOCATION_BOUNDARY_TERMS_REVISION});
        expect(await firstValueFrom(service.resolveNavigation("loc:mapget-offline:wof:1", savedArea())))
            .toEqual({point: [11.5, 48], label: "Place"});
        expect(httpClient.get).not.toHaveBeenCalled();
    });

    it("does not substitute a bounding box for a missing centrepoint while boundaries are disabled", async () => {
        const {service, httpClient, state} = createService();
        state.locationBoundaryConsentState.next({decision: "disabled", revision: LOCATION_BOUNDARY_TERMS_REVISION});
        const result = await firstValueFrom(service.resolveNavigation("loc:mapget-offline:wof:1", savedArea({lonLat: undefined})));
        expect(result.error).toContain("centrepoint");
        expect(result.area).toBeUndefined();
        expect(httpClient.get).not.toHaveBeenCalled();
    });

    it("cancels a boundary lookup when consent is withdrawn", () => {
        const {service, httpClient, state} = createService();
        const response = new Subject<unknown>();
        const next = vi.fn();
        httpClient.get.mockReturnValue(response);
        service.resolveNavigation("loc:mapget-offline:wof:1", savedArea()).subscribe(next);
        state.locationBoundaryConsentState.next({decision: "disabled", revision: LOCATION_BOUNDARY_TERMS_REVISION});
        expect(response.observed).toBe(false);
        response.next([{...areaMatch, geometry: polygon}]);
        expect(next).not.toHaveBeenCalled();
    });

    it("normalizes provider responses and creates executable targets", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockReturnValue(of([
            {
                id: "geonames:5690557",
                name: "Munich, US",
                lonLat: [-98.83926, 46.80667],
                aabb: [[-98.83926, 46.80667], [0, 0]],
                source: "geonames-cities5000",
                countryCode: "US",
                population: 190
            },
            {
                id: "geonames:2867714",
                name: "Munich, DE",
                lonLat: [11.57549, 48.13743],
                aabb: [[11.57549, 48.13743], [0, 0]],
                source: "geonames-cities5000",
                countryCode: "DE",
                population: 1260391
            },
            {
                id: "bad",
                name: "Bad",
                lonLat: [999, 48]
            }
        ]));

        const matches = await firstValueFrom(service.search("munich", 10));

        expect(matches).toHaveLength(2);
        expect(matches[0]).toEqual({
            id: "geonames:2867714",
            name: "Munich, DE",
            lonLat: [11.57549, 48.13743],
            aabb: [[11.57549, 48.13743], [0, 0]],
            source: "geonames-cities5000",
            countryCode: "DE",
            population: 1260391,
            providerId: "mapget-offline",
            providerName: "Place"
        });
        expect(matches[1].id).toBe("geonames:5690557");

        const target = service.createSearchTarget(matches[0]);
        expect(target.id).toBe("loc:mapget-offline:geonames:2867714");
        expect(target.iconType).toBe("material");
        expect(target.icon).toBe("location_city");
        expect(target.jump?.("munich", target.payload)).toEqual([48.13743, 11.57549, 0]);
    });

    it("adds a zero-extent aabb when an otherwise valid provider match omits one", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockReturnValue(of([
            {
                id: "geonames:2867714",
                name: "Munich, DE",
                lonLat: [11.57549, 48.13743]
            }
        ]));

        const matches = await firstValueFrom(service.search("munich", 10));

        expect(matches[0].aabb).toEqual([[11.57549, 48.13743], [0, 0]]);
    });

    it("maps external provider responses through a configured adapter", async () => {
        const {service, httpClient} = createService([
            {
                id: "external",
                name: "External geocoder",
                url: "https://geocoder.example/search",
                headers: {},
                params: {
                    format: "jsonv2",
                    addressdetails: 1
                },
                queryParam: "q",
                limitParam: "limit",
                enabled: true,
                adapter: {
                    itemsPath: "features",
                    fields: {
                        id: "id",
                        name: {template: "{properties.name}, {properties.countryCode}"},
                        lonLat: "geometry.coordinates",
                        countryCode: "properties.countryCode",
                        population: "properties.population",
                        source: {value: "external-api"}
                    },
                    bbox: {
                        path: "bbox",
                        format: "westSouthEastNorth"
                    }
                }
            }
        ]);
        httpClient.get.mockReturnValue(of({
            features: [
                {
                    id: "place.1",
                    properties: {
                        name: "Munich",
                        countryCode: "DE",
                        population: "1260391"
                    },
                    geometry: {
                        coordinates: [11.57549, 48.13743]
                    },
                    bbox: [11, 48, 12, 49]
                }
            ]
        }));

        const matches = await firstValueFrom(service.search("munich", 10));
        const requestOptions = httpClient.get.mock.calls[0][1];

        expect(requestOptions.params.get("q")).toBe("munich");
        expect(requestOptions.params.get("name")).toBeNull();
        expect(requestOptions.params.get("format")).toBe("jsonv2");
        expect(requestOptions.params.get("addressdetails")).toBe("1");
        expect(requestOptions.params.get("limit")).toBe("10");
        expect(matches).toEqual([
            {
                id: "place.1",
                name: "Munich, DE",
                lonLat: [11.57549, 48.13743],
                aabb: [[11, 48], [1, 1]],
                source: "external-api",
                countryCode: "DE",
                population: 1260391,
                providerId: "external",
                providerName: "External geocoder"
            }
        ]);
    });

    it("skips short queries, disabled providers, and provider errors", async () => {
        const disabled = createService([
            {id: "disabled", name: "Disabled", url: "/disabled", headers: {}, enabled: false}
        ]);
        expect(await firstValueFrom(disabled.service.search("m", 10))).toEqual([]);
        expect(await firstValueFrom(disabled.service.search("munich", 10))).toEqual([]);
        expect(disabled.httpClient.get).not.toHaveBeenCalled();

        const failing = createService();
        failing.httpClient.get.mockReturnValue(throwError(() => new Error("offline")));
        expect(await firstValueFrom(failing.service.search("munich", 10))).toEqual([]);
    });

    it("resolves a saved WOF identity directly, without a name query or intermediate point", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockReturnValue(of([{...areaMatch, geometry: polygon}]));
        const result = await firstValueFrom(service.resolveNavigation("loc:mapget-offline:wof:1"));
        const options = httpClient.get.mock.calls[0][1];
        expect(options.params.get("id")).toBe("wof:1");
        expect(options.params.has("name")).toBe(false);
        expect(options.params.has("geometry")).toBe(false);
        expect(result.area?.polygons).toEqual([polygon.coordinates]);
        expect(result.point).toBeUndefined();
    });

    it("retains capability and credit but never puts boundary arrays in history payloads", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockReturnValue(of([{...areaMatch, geometry: polygon,
            attribution: {name: "WOF", url: "https://example.test", licenseUrl: "javascript:bad"}}]));
        const [match] = await firstValueFrom(service.search("Place", 10));
        const target = service.createSearchTarget(match);
        expect(match.geometryAvailable).toBe(true);
        expect(target.payload).not.toHaveProperty("geometry");
        expect(target.label).toContain("WOF");
        expect(match.attribution).toEqual({name: "WOF", url: "https://example.test"});
        expect(httpClient.get).toHaveBeenCalledOnce();
    });

    it("uses extent-only records without fetching geometry, even when geometryAvailable is false", async () => {
        const {service, httpClient} = createService();
        const result = await firstValueFrom(service.resolveNavigation("loc:mapget-offline:wof:1",
            savedArea({geometryAvailable: false})));
        expect(result.area?.rectangle).toEqual({west: 10, south: 47, east: 14, north: 49});
        expect(result.area?.polygons).toBeUndefined();
        expect(result.notice).toBeUndefined();
        expect(httpClient.get).not.toHaveBeenCalled();
    });

    it.each([413, 503, 500])("falls back to saved extent on HTTP %s", async status => {
        const {service, httpClient} = createService();
        httpClient.get.mockReturnValue(throwError(() => ({status})));
        const result = await firstValueFrom(service.resolveNavigation("loc:mapget-offline:wof:1", savedArea()));
        expect(result.area?.rectangle.east).toBe(14);
        expect(result.notice).toContain("bounding extent");
    });

    it.each([[], [{...areaMatch, id: "wof:2", geometry: polygon}], [{...areaMatch, geometry: {type: "Polygon", coordinates: [[]]}}]].map(response => ({response})))(
        "does not accept missing, mismatched or malformed detail geometry", async ({response}) => {
            const {service, httpClient} = createService();
            httpClient.get.mockReturnValue(of(response));
            const result = await firstValueFrom(service.resolveNavigation("loc:mapget-offline:wof:1", savedArea()));
            expect(result.area?.polygons).toBeUndefined();
            expect(result.area?.rectangle.west).toBe(10);
            expect(result.notice).toBeTruthy();
        });

    it("still checks the extent when fresh details no longer advertise a boundary", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockReturnValue(of([{...areaMatch, geometryAvailable: false}]));
        expect((await firstValueFrom(service.resolveNavigation("loc:mapget-offline:wof:1", savedArea()))).area).toBeTruthy();
    });

    it("uses point behavior only after both area representations are unusable", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockReturnValue(throwError(() => new Error("offline")));
        const result = await firstValueFrom(service.resolveNavigation("loc:mapget-offline:wof:1",
            savedArea({aabb: [[10, 47], [0, 2]]})));
        expect(result.point).toEqual([11.5, 48]);
        expect(result.area).toBeUndefined();
    });

    it("navigates valid geometry/extent even without a representative point", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockReturnValue(of([{...areaMatch, lonLat: [999, 999], aabb: null, geometry: polygon}]));
        const result = await firstValueFrom(service.resolveNavigation("loc:mapget-offline:wof:1"));
        expect(result.area?.polygons).toEqual([polygon.coordinates]);
        expect(result.area?.representativePoint).toBeUndefined();
        expect((await firstValueFrom(service.resolveNavigation("loc:mapget-offline:wof:1",
            savedArea({lonLat: undefined, geometryAvailable: false})))).area).toBeTruthy();
    });

    it("keeps external providers and legacy saved points on their synchronous point contract", async () => {
        const {service, httpClient} = createService();
        const external = savedArea({providerId: "external", id: "wof:1"});
        expect((await firstValueFrom(service.resolveNavigation("loc:external:wof:1", external))).point).toEqual([11.5, 48]);
        const legacy = savedArea({id: "geonames:1"});
        expect((await firstValueFrom(service.resolveNavigation("loc:mapget-offline:geonames:1", legacy))).point).toEqual([11.5, 48]);
        expect((await firstValueFrom(service.resolveNavigation("loc:mapget-offline:geonames:1"))).error).toBeTruthy();
        expect(httpClient.get).not.toHaveBeenCalled();
    });

    it("honors provider headers and filters conflicting selectors from detail requests", async () => {
        const {service, httpClient} = createService([{id: "mapget-offline", name: "Place", enabled: true,
            url: "/location", headers: {"X-Example": "value"}, params: {name: "wrong", geometry: true, limit: 50, language: "en"}}]);
        httpClient.get.mockReturnValue(of([{...areaMatch, geometry: polygon}]));
        await firstValueFrom(service.resolveNavigation("loc:mapget-offline:wof:1", savedArea()));
        const options = httpClient.get.mock.calls[0][1];
        expect(options.params.keys().sort()).toEqual(["id", "language"]);
        expect(options.headers.get("X-Example")).toBe("value");
    });

    it("bounds the detail wait and falls back once", async () => {
        vi.useFakeTimers();
        try {
            const {service, httpClient} = createService();
            httpClient.get.mockReturnValue(NEVER);
            const result = firstValueFrom(service.resolveNavigation("loc:mapget-offline:wof:1", savedArea()));
            await vi.advanceTimersByTimeAsync(8001);
            expect((await result).area).toBeTruthy();
        } finally { vi.useRealTimers(); }
    });

    it("reports unavailable identities and respects disabled providers", async () => {
        const {service, httpClient} = createService([{id: "mapget-offline", name: "Place", enabled: false, url: "/location", headers: {}}]);
        expect((await firstValueFrom(service.resolveNavigation("loc:mapget-offline:wof:1"))).error).toContain("disabled");
        expect((await firstValueFrom(service.resolveNavigation("loc:external:1"))).error).toBeTruthy();
        expect(httpClient.get).not.toHaveBeenCalled();
    });

    it("only accepts place-name queries for location search", async () => {
        expect(isSupportedLocationSearchQuery("Munich")).toBe(true);
        expect(isSupportedLocationSearchQuery("Sao Paulo")).toBe(true);
        expect(isSupportedLocationSearchQuery("Lodz")).toBe(true);
        expect(isSupportedLocationSearchQuery("Tokyo")).toBe(true);
        expect(isSupportedLocationSearchQuery("東京")).toBe(true);
        expect(isSupportedLocationSearchQuery("St. John's")).toBe(true);

        const {service, httpClient} = createService();
        expect(await firstValueFrom(service.search("12345", 10))).toEqual([]);
        expect(await firstValueFrom(service.search("Berlin 10115", 10))).toEqual([]);
        expect(await firstValueFrom(service.search("48.137 11.575", 10))).toEqual([]);
        expect(await firstValueFrom(service.search("Munich2", 10))).toEqual([]);
        expect(httpClient.get).not.toHaveBeenCalled();
    });

    it("rejects invalid location payloads", () => {
        expect(normalizeLocationSearchPayload({
            id: "geonames:1",
            name: "Nowhere",
            lonLat: [181, 0],
            providerId: "provider",
            providerName: "Provider"
        })).toBeNull();
    });
});
