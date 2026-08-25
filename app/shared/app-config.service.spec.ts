import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {HttpResponse} from "@angular/common/http";
import {of, throwError} from "rxjs";

import {
    AppConfigService,
    DEFAULT_BACKGROUND_LAYER_ID,
    DEFAULT_BACKGROUND_OPACITY,
    DEFAULT_XYZ_BACKGROUND_MAX_ZOOM,
    ServerConfigResponse
} from "./app-config.service";

class HttpClientStub {
    get = vi.fn();
}

const createService = () => {
    const httpClient = new HttpClientStub();
    const service = new AppConfigService(httpClient as any);
    return {service, httpClient};
};

const mapPresetCapability = (overrides: Record<string, unknown> = {}) => ({
    configured: false,
    valid: true,
    write: false,
    endpoint: "/config",
    method: "PATCH",
    path: "/erdblick/mapPresets",
    revision: "revision-1",
    ephemeral: false,
    issues: [],
    ...overrides
});

describe("AppConfigService", () => {
    it("falls back to static config.json when /config request fails", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({styles: [{url: "static.yaml"}]});
            }
            return throwError(() => new Error("network"));
        });

        const config = await service.load();

        expect(config.styles).toEqual([{url: "static.yaml", additional: false}]);
        expect(config.serverConfig.available).toBe(false);
        expect(config.serverConfig.datasourceConfigUnavailable).toBe(false);
        expect(config.serverConfig.datasourceConfigUnavailableReason).toBeNull();
        expect(config.serverConfig.cacheReset).toBe(false);
    });

    it("applies public erdblick config when datasource model is unavailable", async () => {
        const {service, httpClient} = createService();
        const serverBody: ServerConfigResponse = {
            datasourceConfigUnavailable: true,
            datasourceConfigUnavailableReason: "getConfigDisabled",
            erdblick: {
                styles: [{url: "server.yaml"}]
            }
        };
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({styles: [{url: "static.yaml"}]});
            }
            return of(new HttpResponse({status: 200, body: serverBody}));
        });

        const config = await service.load();

        expect(config.styles).toEqual([{url: "server.yaml", additional: false}]);
        expect(config.serverConfig.available).toBe(true);
        expect(config.serverConfig.datasourceConfigUnavailable).toBe(true);
        expect(config.serverConfig.datasourceConfigUnavailableReason).toBe("getConfigDisabled");
        expect(config.serverConfig.cacheReset).toBe(false);
    });

    it.each([
        [{cacheReset: true}, true],
        [{cacheReset: false}, false],
        [{cacheReset: "true"}, false],
        ["invalid", false],
        [undefined, false]
    ])("normalizes the caller-specific cache-reset capability from %j", async (capabilities, expected) => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "config.json") {
                return of({});
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    datasourceConfigUnavailable: false,
                    capabilities
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();

        expect(config.serverConfig.cacheReset).toBe(expected);
    });

    it("exposes source-style editing metadata from the runtime config section", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({styles: [{url: "static.yaml"}]});
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    datasourceConfigUnavailable: false,
                    erdblickRuntime: {
                        mode: "source",
                        styleEditing: {
                            enabled: true,
                            directory: "/workspace/mapviewer/config/styles"
                        }
                    }
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();

        expect(config.serverConfig.styleEditingEnabled).toBe(true);
        expect(config.serverConfig.styleEditingDirectory).toBe("/workspace/mapviewer/config/styles");
    });

    it("overrides static styles only when server styles are non-empty", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({styles: [{url: "static.yaml"}]});
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    datasourceConfigUnavailable: false,
                    erdblick: {styles: [{url: "server.yaml"}]}
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();
        expect(config.styles).toEqual([{url: "server.yaml", additional: false}]);
    });

    it("does not override static styles when server styles are empty", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({styles: [{url: "static.yaml"}]});
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    datasourceConfigUnavailable: false,
                    erdblick: {styles: []}
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();
        expect(config.styles).toEqual([{url: "static.yaml", additional: false}]);
    });

    it("appends static additional styles after static styles", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({
                    styles: ["static.yaml"],
                    additionalStyles: [
                        "customer.yaml",
                        {id: "customer-pois", url: "pois.yaml"}
                    ]
                });
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    datasourceConfigUnavailable: false,
                    erdblick: {}
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();

        expect(config.styles).toEqual([
            {url: "static.yaml", additional: false},
            {url: "customer.yaml", additional: true},
            {id: "customer-pois", url: "pois.yaml", additional: true}
        ]);
    });

    it("appends server additional styles to static base and static additional styles", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({
                    styles: ["static.yaml"],
                    additionalStyles: ["static-extra.yaml"]
                });
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    datasourceConfigUnavailable: false,
                    erdblick: {
                        additionalStyles: ["server-extra.yaml"]
                    }
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();

        expect(config.styles).toEqual([
            {url: "static.yaml", additional: false},
            {url: "static-extra.yaml", additional: true},
            {url: "server-extra.yaml", additional: true}
        ]);
    });

    it("uses non-empty server styles as the base replacement before appending server additional styles", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({styles: ["static.yaml"]});
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    datasourceConfigUnavailable: false,
                    erdblick: {
                        styles: ["server.yaml"],
                        additionalStyles: ["server-extra.yaml"]
                    }
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();

        expect(config.styles).toEqual([
            {url: "server.yaml", additional: false},
            {url: "server-extra.yaml", additional: true}
        ]);
    });

    it("ignores empty additional style lists", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({
                    styles: ["static.yaml"],
                    additionalStyles: []
                });
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    datasourceConfigUnavailable: false,
                    erdblick: {additionalStyles: []}
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();

        expect(config.styles).toEqual([{url: "static.yaml", additional: false}]);
    });

    it("keeps inline static map presets when the server omits the key", async () => {
        const {service, httpClient} = createService();
        const mapPresets = [{
            id: "static",
            name: "Static",
            layerPresets: [{layerId: "Lane", styleId: "Lanes", presetId: "topology"}]
        }];
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({mapPresets});
            }
            return of(new HttpResponse({status: 200, body: {erdblick: {}}}));
        });

        const config = await service.load();

        expect(config.mapPresets).toEqual([{...mapPresets[0], enabled: true}]);
        expect(config.mapPresetConfig).toMatchObject({configured: true, valid: true, write: false});
        expect(config.state).not.toHaveProperty("mapPresets");
    });

    it("leaves map presets unconfigured when both sources omit them without a write target", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({});
            }
            return of(new HttpResponse({status: 200, body: {erdblick: {}}}));
        });

        const config = await service.load();

        expect(config.mapPresets).toEqual([]);
        expect(config.mapPresetConfig).toMatchObject({
            configured: false,
            valid: true,
            write: false
        });
    });

    it("allows an omitted server catalog to be materialized when write capability is available", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({});
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    capabilities: {
                        mapPresets: mapPresetCapability({write: true})
                    },
                    erdblick: {}
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();

        expect(config.mapPresets).toEqual([]);
        expect(config.mapPresetConfig).toMatchObject({
            configured: true,
            valid: true,
            write: true,
            endpoint: "/config",
            method: "PATCH",
            path: "/erdblick/mapPresets",
            revision: "revision-1"
        });
        expect(config.serverConfig.mapPresets.configured).toBe(false);
    });

    it("keeps a valid static catalog when the writable server key is omitted", async () => {
        const {service, httpClient} = createService();
        const staticPreset = {
            id: "static",
            name: "Static",
            layerPresets: [{layerId: "Lane", styleId: "Lanes", presetId: "topology"}]
        };
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({mapPresets: [staticPreset]});
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    capabilities: {
                        mapPresets: mapPresetCapability({write: true})
                    },
                    erdblick: {}
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();

        expect(config.mapPresets).toEqual([{...staticPreset, enabled: true}]);
        expect(config.mapPresetConfig).toMatchObject({configured: true, valid: true, write: true});
        expect(config.serverConfig.mapPresets.configured).toBe(false);
    });

    it("does not expose a malformed static catalog through an omitted writable server key", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({mapPresets: [{id: "broken"}]});
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    capabilities: {
                        mapPresets: mapPresetCapability({write: true})
                    },
                    erdblick: {}
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();

        expect(config.mapPresets).toEqual([]);
        expect(config.mapPresetConfig).toMatchObject({configured: true, valid: true, write: true});
        expect(config.serverConfig.mapPresets.configured).toBe(false);
    });

    it("normalizes the server map-preset capability and revision", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({});
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    capabilities: {
                        mapPresets: mapPresetCapability({configured: true, write: true})
                    },
                    erdblick: {mapPresets: []}
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();

        expect(config.mapPresetConfig).toEqual({
            configured: true,
            valid: true,
            write: true,
            endpoint: "/config",
            method: "PATCH",
            path: "/erdblick/mapPresets",
            revision: "revision-1",
            ephemeral: false,
            issues: []
        });
    });

    it("does not treat the removed map-preset endpoint shape as writable", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({});
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    capabilities: {
                        mapPresets: {
                            configured: true,
                            valid: true,
                            write: true,
                            endpoint: ["/config", "erdblick", "map-presets"].join("/"),
                            revision: "revision-1"
                        }
                    },
                    erdblick: {mapPresets: []}
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();

        expect(config.mapPresetConfig).toMatchObject({configured: true, valid: true, write: false});
    });

    it("replaces static map presets when the server key is present", async () => {
        const replacementHarness = createService();
        replacementHarness.httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({mapPresets: [{id: "static"}]});
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    erdblick: {mapPresets: [{
                        id: "server",
                        name: "Server",
                        layerPresets: [{layerId: "Road", styleId: "Roads", presetId: "geometry"}]
                    }]}
                } satisfies ServerConfigResponse
            }));
        });

        expect((await replacementHarness.service.load()).mapPresets)
            .toEqual([{
                id: "server",
                name: "Server",
                enabled: true,
                layerPresets: [{layerId: "Road", styleId: "Roads", presetId: "geometry"}]
            }]);
    });

    it("preserves an explicit empty server map-preset list", async () => {
        const {service, httpClient} = createService();
        const staticPreset = {
            id: "static",
            name: "Static",
            layerPresets: [{layerId: "Lane", styleId: "Lanes", presetId: "topology"}]
        };
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({mapPresets: [staticPreset]});
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    capabilities: {
                        mapPresets: mapPresetCapability({configured: true, write: true})
                    },
                    erdblick: {mapPresets: []}
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();
        expect(config.mapPresets).toEqual([]);
        expect(config.mapPresetConfig).toMatchObject({configured: true, valid: true, write: true});
    });

    it("lets malformed authoritative server presets block valid static fallback", async () => {
        const {service, httpClient} = createService();
        const staticPreset = {
            id: "static",
            name: "Static",
            layerPresets: [{layerId: "Lane", styleId: "Lanes", presetId: "topology"}]
        };
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({mapPresets: [staticPreset]});
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    capabilities: {
                        mapPresets: {
                            configured: true,
                            valid: false,
                            write: false,
                            issues: ["mapPresets must be a sequence."]
                        }
                    },
                    erdblick: {mapPresets: 42}
                } as unknown as ServerConfigResponse
            }));
        });

        const config = await service.load();

        expect(config.mapPresets).toEqual([]);
        expect(config.mapPresetConfig.valid).toBe(false);
        expect(config.mapPresetConfig.write).toBe(false);
        expect(config.mapPresetConfig.issues).toContainEqual({
            message: "mapPresets must be a sequence."
        });
    });

    it("lets an invalid server erdblick section block static fallback", async () => {
        const {service, httpClient} = createService();
        const staticPreset = {
            id: "static",
            name: "Static",
            layerPresets: [{layerId: "Lane", styleId: "Lanes", presetId: "topology"}]
        };
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({mapPresets: [staticPreset]});
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    capabilities: {
                        mapPresets: mapPresetCapability({
                            configured: false,
                            valid: false,
                            issues: ["The erdblick config section must be an object."]
                        })
                    },
                    erdblick: {}
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();

        expect(config.mapPresets).toEqual([]);
        expect(config.mapPresetConfig).toMatchObject({configured: true, valid: false, write: false});
        expect(config.mapPresetConfig.issues).toContainEqual({
            message: "The erdblick config section must be an object."
        });
    });

    it("keeps valid server siblings while reporting a partially invalid catalog", async () => {
        const {service, httpClient} = createService();
        const validPreset = {
            id: "network",
            name: "Network",
            layerPresets: [{layerId: "Lane", styleId: "Lanes", presetId: "topology"}]
        };
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({});
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    capabilities: {
                        mapPresets: {
                            configured: true,
                            valid: false,
                            write: false,
                            issues: ["mapPresets[1] is invalid."]
                        }
                    },
                    erdblick: {mapPresets: [validPreset]}
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();

        expect(config.mapPresets).toEqual([{...validPreset, enabled: true}]);
        expect(config.mapPresetConfig.valid).toBe(false);
        expect(config.mapPresetConfig.write).toBe(false);
    });

    it("excludes retired state.mapPresets from normalized state and its hash", async () => {
        const loadWithState = async (state: Record<string, unknown>) => {
            const {service, httpClient} = createService();
            httpClient.get.mockImplementation((url: string) => {
                if (url === "/static-config/config.json") {
                    return of({state});
                }
                return of(new HttpResponse({status: 200, body: {erdblick: {}}}));
            });
            return service.load();
        };

        const withoutLegacy = await loadWithState({foo: true});
        const withLegacy = await loadWithState({foo: true, mapPresets: [{id: "legacy"}]});

        expect(withLegacy.state).toEqual(withoutLegacy.state);
        expect(withLegacy.configStateHash).toBe(withoutLegacy.configStateHash);
    });

    it("ignores an invalid map-presets type without discarding the rest of the config", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({
                    styles: ["static.yaml"],
                    mapPresets: 42
                });
            }
            return throwError(() => new Error("network"));
        });

        const config = await service.load();

        expect(config.styles).toEqual([{url: "static.yaml", additional: false}]);
        expect(config.mapPresets).toEqual([]);
        expect(config.mapPresetConfig.valid).toBe(false);
        expect(config.state).not.toHaveProperty("mapPresets");
    });

    it("does not override static extension modules with empty server values", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({
                    extensionModules: {
                        jumpTargets: "static_jump_targets",
                        distribVersions: "static_distrib_versions"
                    }
                });
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    datasourceConfigUnavailable: false,
                    erdblick: {
                        extensionModules: {
                            jumpTargets: "",
                            distribVersions: "server_distrib_versions"
                        }
                    }
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();
        expect(config.extensionModules.jumpTargets).toBe("static_jump_targets");
        expect(config.extensionModules.distribVersions).toBe("server_distrib_versions");
    });

    it("drops surveys with invalid linkHtml and keeps valid entries", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({});
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    datasourceConfigUnavailable: false,
                    erdblick: {
                        surveys: [
                            {
                                id: "tooling-days-2026",
                                link: "https://nds.to/tooling-days2026",
                                linkHtml: "Let's meet @ <b>NDS Tooling Days&nbsp;2026</b><br><small>Learn|Connect|Build</small>"
                            },
                            {
                                id: "bad",
                                link: "https://example.com",
                                linkHtml: "<a href='https://example.com'>bad</a>"
                            }
                        ]
                    }
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();
        expect(config.surveys.length).toBe(1);
        expect(config.surveys[0].id).toBe("tooling-days-2026");
    });

    it("replaces configured external viewers in server order and accepts an explicit empty list", async () => {
        const staticViewers = [
            {
                id: "static",
                name: "Static Viewer",
                urlTemplate: "https://static.test/?lat={lat}&lon={lon}"
            }
        ];
        const serverViewers = [
            {
                id: "second",
                name: "Second Viewer",
                urlTemplate: "https://second.test/{lon}/{lat}"
            },
            {
                id: "first",
                name: "First Viewer",
                urlTemplate: "https://first.test/{lat}/{lon}"
            }
        ];
        const replacementHarness = createService();
        replacementHarness.httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({externalViewers: staticViewers});
            }
            return of(new HttpResponse({
                status: 200,
                body: {erdblick: {externalViewers: serverViewers}} satisfies ServerConfigResponse
            }));
        });

        const replacement = await replacementHarness.service.load();

        expect(replacement.externalViewers.map(viewer => viewer.id)).toEqual(["second", "first"]);

        const emptyHarness = createService();
        emptyHarness.httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({externalViewers: staticViewers});
            }
            return of(new HttpResponse({
                status: 200,
                body: {erdblick: {externalViewers: []}} satisfies ServerConfigResponse
            }));
        });

        expect((await emptyHarness.service.load()).externalViewers).toEqual([]);
    });

    it("drops duplicate, malformed, and non-HTTP external viewers without rejecting valid entries", async () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({
                    externalViewers: [
                        {
                            id: "valid",
                            name: "Valid",
                            urlTemplate: "https://viewer.test/{lat}/{lon}"
                        },
                        {
                            id: "valid",
                            name: "Duplicate",
                            urlTemplate: "https://duplicate.test/{lat}/{lon}"
                        },
                        {
                            id: "unsafe",
                            name: "Unsafe",
                            urlTemplate: "javascript:open({lat},{lon})"
                        },
                        {
                            id: "missing-lon",
                            name: "Missing longitude",
                            urlTemplate: "https://viewer.test/{lat}"
                        }
                    ]
                });
            }
            return throwError(() => new Error("network"));
        });

        try {
            const config = await service.load();

            expect(config.externalViewers).toEqual([
                {
                    id: "valid",
                    name: "Valid",
                    urlTemplate: "https://viewer.test/{lat}/{lon}"
                }
            ]);
            expect(warning).toHaveBeenCalledTimes(4);
        } finally {
            warning.mockRestore();
        }
    });

    it("uses the built-in offline location provider by default", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({});
            }
            return throwError(() => new Error("network"));
        });

        const config = await service.load();

        expect(config.locationSearch.providers).toEqual([
            {
                id: "mapget-offline",
                name: "Place",
                url: "/location",
                headers: {},
                enabled: true
            }
        ]);
        expect(config.locationSearch.minCharacters).toBe(2);
        expect(config.locationSearch.debounceMs).toBe(150);
    });

    it("uses OSM as the built-in fallback background without requiring Blue Marble", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({});
            }
            return throwError(() => new Error("network"));
        });

        const config = await service.load();

        expect(config.defaultBackgroundLayerId).toBe(DEFAULT_BACKGROUND_LAYER_ID);
        expect(config.backgroundLayers).toEqual([
            expect.objectContaining({
                id: "osm",
                defaultOpacity: DEFAULT_BACKGROUND_OPACITY,
                maxZoom: 19
            })
        ]);
        expect(config.backgroundLayers.some(layer => layer.id === "world-overview")).toBe(false);
    });

    it("falls back to the first configured background when Blue Marble is removed", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({
                    backgroundLayers: [
                        {
                            id: "osm",
                            name: "OpenStreetMap",
                            type: "xyz",
                            urlTemplate: "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
                            defaultOpacity: 6,
                            maxZoom: 19
                        }
                    ],
                    defaultBackgroundLayerId: "world-overview"
                });
            }
            return throwError(() => new Error("network"));
        });

        const config = await service.load();

        expect(config.defaultBackgroundLayerId).toBe("osm");
        expect(config.backgroundLayers.map(layer => layer.id)).toEqual(["osm"]);
    });

    it("allows custom XYZ satellite layers to omit maxZoom while still reaching high levels", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({
                    backgroundLayers: [
                        {
                            id: "satellite",
                            name: "Satellite",
                            type: "xyz",
                            urlTemplate: "https://tiles.example.com/{z}/{x}/{y}.jpg"
                        }
                    ],
                    defaultBackgroundLayerId: "satellite"
                });
            }
            return throwError(() => new Error("network"));
        });

        const config = await service.load();

        expect(config.backgroundLayers[0]).toEqual(expect.objectContaining({
            id: "satellite",
            maxZoom: DEFAULT_XYZ_BACKGROUND_MAX_ZOOM
        }));
    });

    it("accepts location provider adapters from static config.json", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({
                    locationSearch: {
                        providers: [
                            {
                                id: "static-external",
                                name: "Static external",
                                url: "https://geocoder.example/search",
                                params: {
                                    format: "jsonv2",
                                    addressdetails: 1
                                },
                                queryParam: "q",
                                limitParam: "limit",
                                adapter: {
                                    itemsPath: "features",
                                    fields: {
                                        id: "id",
                                        name: {template: "{properties.name}, {properties.country}"},
                                        lonLat: "geometry.coordinates",
                                        population: "properties.population",
                                        source: {value: "static-geocoder"}
                                    },
                                    bbox: {
                                        path: "bbox",
                                        format: "westSouthEastNorth"
                                    }
                                }
                            }
                        ]
                    }
                });
            }
            return throwError(() => new Error("network"));
        });

        const config = await service.load();

        expect(config.locationSearch.providers[0]).toEqual({
            id: "static-external",
            name: "Static external",
            url: "https://geocoder.example/search",
            headers: {},
            params: {
                format: "jsonv2",
                addressdetails: 1
            },
            queryParam: "q",
            limitParam: "limit",
            adapter: {
                itemsPath: "features",
                fields: {
                    id: "id",
                    name: {template: "{properties.name}, {properties.country}"},
                    lonLat: "geometry.coordinates",
                    population: "properties.population",
                    source: {value: "static-geocoder"}
                },
                bbox: {
                    path: "bbox",
                    format: "westSouthEastNorth"
                }
            },
            enabled: true
        });
    });

    it("replaces location providers from non-empty server config", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({
                    locationSearch: {
                        providers: [
                            {id: "static", name: "Static", url: "/static-location"}
                        ],
                        minCharacters: 3,
                        debounceMs: 400
                    }
                });
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    datasourceConfigUnavailable: false,
                    erdblick: {
                        locationSearch: {
                            providers: [
                                {
                                    id: "customer",
                                    name: "Customer",
                                    url: "https://geocoder.example/location",
                                    headers: {"X-Project": "mapviewer"},
                                    params: {
                                        format: "jsonv2"
                                    },
                                    queryParam: "q",
                                    adapter: {
                                        itemsPath: "results",
                                        fields: {
                                            id: "place.id",
                                            name: "place.label",
                                            longitude: "position.lon",
                                            latitude: "position.lat"
                                        },
                                        lonLatOrder: "lonLat"
                                    },
                                    enabled: false
                                }
                            ],
                            minCharacters: 2,
                            debounceMs: 200
                        }
                    }
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();

        expect(config.locationSearch.providers).toEqual([
            {
                id: "customer",
                name: "Customer",
                url: "https://geocoder.example/location",
                headers: {"X-Project": "mapviewer"},
                params: {
                    format: "jsonv2"
                },
                queryParam: "q",
                adapter: {
                    itemsPath: "results",
                    fields: {
                        id: "place.id",
                        name: "place.label",
                        longitude: "position.lon",
                        latitude: "position.lat"
                    },
                    lonLatOrder: "lonLat"
                },
                enabled: false
            }
        ]);
        expect(config.locationSearch.minCharacters).toBe(2);
        expect(config.locationSearch.debounceMs).toBe(200);
    });

    it("uses coordinates-enabled as a config-seeded local default", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({"coordinates-enabled": true});
            }
            return of(new HttpResponse({
                status: 200,
                body: {
                    datasourceConfigUnavailable: false,
                    erdblick: {"coordinates-enabled": false}
                } satisfies ServerConfigResponse
            }));
        });

        const config = await service.load();

        expect(config.coordinates.enabledByDefault).toBe(false);
        expect(config.state).toEqual(expect.objectContaining({coordinatesEnabled: false}));
    });

    it.each([
        ["JSON", '{"legal-terms":"JSON legal text"}', "JSON legal text"],
        ["YAML", "legal-terms: |\n  YAML legal text\n", "YAML legal text\n"]
    ])("loads and validates %s coordinate legal terms", async (_format, source, expectedText) => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({
                    "coordinates-enabled": true,
                    "coordinates-legal-terms": "/coordinates-legal-terms/terms.yaml"
                });
            }
            if (url === "/coordinates-legal-terms/terms.yaml") {
                return of(source);
            }
            return throwError(() => new Error("no server config"));
        });

        const config = await service.load();

        expect(config.coordinates).toEqual({
            enabledByDefault: false,
            legalTermsUrl: "/coordinates-legal-terms/terms.yaml",
            legalTerms: expectedText,
            legalTermsError: null
        });
        expect(config.state).toEqual(expect.objectContaining({coordinatesEnabled: false}));
    });

    it("fails the coordinate legal gate closed when the document is invalid", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "/static-config/config.json") {
                return of({"coordinates-legal-terms": "/coordinates-legal-terms/invalid.yaml"});
            }
            if (url === "/coordinates-legal-terms/invalid.yaml") {
                return of("legal-terms: '   '");
            }
            return throwError(() => new Error("no server config"));
        });

        const config = await service.load();

        expect(config.coordinates.enabledByDefault).toBe(false);
        expect(config.coordinates.legalTerms).toBeNull();
        expect(config.coordinates.legalTermsError).toContain("invalid.yaml");
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });
});
