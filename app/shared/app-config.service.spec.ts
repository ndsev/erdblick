import {describe, expect, it, vi} from "vitest";
import {HttpResponse} from "@angular/common/http";
import {of, throwError} from "rxjs";

import {AppConfigService, ServerConfigResponse} from "./app-config.service";

class HttpClientStub {
    get = vi.fn();
}

const createService = () => {
    const httpClient = new HttpClientStub();
    const service = new AppConfigService(httpClient as any);
    return {service, httpClient};
};

describe("AppConfigService", () => {
    it("falls back to static config.json when /config request fails", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "config.json") {
                return of({styles: [{url: "static.yaml"}]});
            }
            return throwError(() => new Error("network"));
        });

        const config = await service.load();

        expect(config.styles).toEqual([{url: "static.yaml", additional: false}]);
        expect(config.serverConfig.available).toBe(false);
        expect(config.serverConfig.datasourceConfigUnavailable).toBe(false);
        expect(config.serverConfig.datasourceConfigUnavailableReason).toBeNull();
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
            if (url === "config.json") {
                return of({styles: [{url: "static.yaml"}]});
            }
            return of(new HttpResponse({status: 200, body: serverBody}));
        });

        const config = await service.load();

        expect(config.styles).toEqual([{url: "server.yaml", additional: false}]);
        expect(config.serverConfig.available).toBe(true);
        expect(config.serverConfig.datasourceConfigUnavailable).toBe(true);
        expect(config.serverConfig.datasourceConfigUnavailableReason).toBe("getConfigDisabled");
    });

    it("overrides static styles only when server styles are non-empty", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "config.json") {
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
            if (url === "config.json") {
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
            if (url === "config.json") {
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
            if (url === "config.json") {
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
            if (url === "config.json") {
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
            if (url === "config.json") {
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

    it("does not override static extension modules with empty server values", async () => {
        const {service, httpClient} = createService();
        httpClient.get.mockImplementation((url: string) => {
            if (url === "config.json") {
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
            if (url === "config.json") {
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
});
