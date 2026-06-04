import {firstValueFrom, of, throwError} from "rxjs";
import {describe, expect, it, vi} from "vitest";

import {LocationSearchProviderConfig} from "../shared/app-config.service";
import {LocationSearchService, normalizeLocationSearchPayload} from "./location.search.service";

class HttpClientStub {
    get = vi.fn();
}

const createService = (providers: LocationSearchProviderConfig[] = [
    {
        id: "mapget-offline",
        name: "Offline locations",
        url: "/location",
        headers: {},
        enabled: true
    }
]) => {
    const httpClient = new HttpClientStub();
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
        service: new LocationSearchService(httpClient as any, configService as any),
        httpClient
    };
};

describe("LocationSearchService", () => {
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
            providerName: "Offline locations"
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
