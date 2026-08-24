import "@angular/compiler";
import {HttpErrorResponse, HttpHeaders, HttpResponse} from "@angular/common/http";
import {of, Subject, throwError} from "rxjs";
import {beforeEach, describe, expect, it, vi} from "vitest";
import type {MapPresetDefinition} from "./map-preset.model";
import {MapPresetService} from "./map-preset.service";

const configured: MapPresetDefinition[] = [{
    id: "network",
    name: "Network",
    enabled: true,
    layerPresets: [{layerId: "Lane", styleId: "Lanes", presetId: "topology"}]
}];

function createService(
    write = true,
    catalogConfigured = true,
    serverContract = true,
    definitions: MapPresetDefinition[] = configured
) {
    const endpoint = serverContract ? "/config" : null;
    const method = serverContract ? "PATCH" : null;
    const path = serverContract ? "/erdblick/mapPresets" : null;
    const config: any = {
        snapshot: {
            mapPresets: structuredClone(definitions),
            mapPresetConfig: {
                configured: catalogConfigured,
                valid: true,
                write,
                endpoint,
                method,
                path,
                revision: "rev-1",
                ephemeral: false,
                issues: []
            },
            serverConfig: {
                mapPresets: {
                    configured: catalogConfigured,
                    valid: true,
                    write,
                    endpoint,
                    method,
                    path,
                    revision: "rev-1",
                    ephemeral: false,
                    issues: []
                }
            }
        },
        applyCanonicalMapPresets: vi.fn((definitions: MapPresetDefinition[], revision: string) => {
            config.snapshot.mapPresets = structuredClone(definitions);
            config.snapshot.mapPresetConfig.revision = revision;
            return true;
        }),
        refreshMapPresetConfig: vi.fn(async () => config.snapshot)
    };
    const http = {patch: vi.fn()};
    const styles = new Map<string, any>([["Lanes", {
        id: "Lanes",
        visible: true,
        featureLayerStyle: {hasLayerAffinity: (layerId: string) => layerId === "Lane"},
        presets: [{
            id: "topology",
            name: "Topology",
            values: [{optionId: "show", value: true}]
        }]
    }]]);
    const service = new MapPresetService(config, http as any, {styles} as any);
    service.initialize();
    return {service, config, http};
}

describe("MapPresetService", () => {
    beforeEach(() => localStorage.clear());

    it("loads config definitions and resolves embedded presets for an affine layer", () => {
        const {service} = createService();

        expect(service.presets.map(preset => preset.id)).toEqual(["network"]);
        const resolved = service.presetsForLayer("Lane", [{styleId: "Lanes", id: "show"}]);
        expect(resolved).toHaveLength(1);
        expect(resolved[0].ref).toEqual({styleId: "Lanes", presetId: "topology"});
        expect(service.presetsForLayer("Road", [{styleId: "Lanes", id: "show"}])).toEqual([]);
    });

    it("publishes only the canonical response from a revision-guarded write", async () => {
        const {service, config, http} = createService();
        const canonical = [{...configured[0], enabled: false}];
        http.patch.mockReturnValue(of(new HttpResponse({
            status: 200,
            body: {path: "/erdblick/mapPresets", value: canonical, revision: "rev-2"}
        })));

        expect(await service.setAvailable("network", false)).toBe(true);
        expect(service.presets).toEqual(canonical);
        expect(config.applyCanonicalMapPresets).toHaveBeenCalledWith(canonical, "rev-2");
        expect(http.patch.mock.calls[0][1]).toEqual({
            path: "/erdblick/mapPresets",
            value: canonical
        });
        const options = http.patch.mock.calls[0][2] as {headers: HttpHeaders};
        expect(options.headers.get("If-Match")).toBe('"rev-1"');
    });

    it("materializes the complete inherited catalog on its first server write", async () => {
        const {service, config, http} = createService();
        config.snapshot.serverConfig.mapPresets.configured = false;
        const added: MapPresetDefinition = {
            id: "geometry",
            name: "Geometry",
            enabled: true,
            layerPresets: [{layerId: "Road", styleId: "Roads", presetId: "geometry"}]
        };
        const canonical = [...configured, added];
        http.patch.mockReturnValue(of(new HttpResponse({
            status: 200,
            body: {path: "/erdblick/mapPresets", value: canonical, revision: "rev-2"}
        })));

        expect(await service.addPreset(added)).toBe(true);
        expect(http.patch.mock.calls[0][1]).toEqual({
            path: "/erdblick/mapPresets",
            value: canonical
        });
        expect(service.presets).toEqual(canonical);
    });

    it("allows only one complete-catalog write in flight", async () => {
        const {service, http} = createService();
        const pending = new Subject<HttpResponse<unknown>>();
        http.patch.mockReturnValue(pending);

        const first = service.setAvailable("network", false);
        expect(service.writePending).toBe(true);
        expect(await service.addPreset({
            id: "geometry",
            name: "Geometry",
            enabled: true,
            layerPresets: [{layerId: "Road", styleId: "Roads", presetId: "geometry"}]
        })).toBe(false);
        pending.next(new HttpResponse({
            status: 200,
            body: {
                path: "/erdblick/mapPresets",
                value: [{...configured[0], enabled: false}],
                revision: "rev-2"
            }
        }));
        pending.complete();
        expect(await first).toBe(true);
    });

    it("refetches the authoritative catalog after a stale revision", async () => {
        const {service, config, http} = createService();
        http.patch.mockReturnValue(throwError(() => new HttpErrorResponse({status: 412})));
        config.refreshMapPresetConfig.mockImplementation(async () => {
            config.snapshot.mapPresets = [{...configured[0], name: "Server version"}];
            config.snapshot.mapPresetConfig.revision = "rev-2";
            return config.snapshot;
        });

        expect(await service.setAvailable("network", false)).toBe(false);
        expect(config.refreshMapPresetConfig).toHaveBeenCalledOnce();
        expect(service.presets[0].name).toBe("Server version");
    });

    it("keeps read-only and invalid edits out of the effective catalog", async () => {
        const {service, http} = createService(false);
        expect(await service.applyOverrideSource("- id: invalid")).toBe(false);
        expect(await service.setAvailable("network", false)).toBe(false);
        expect(service.presets).toEqual(configured);
        expect(http.patch).not.toHaveBeenCalled();
    });

    it("explains whether an effective read-only catalog comes from static or server config", () => {
        const staticCatalog = createService(false);
        staticCatalog.config.snapshot.serverConfig.mapPresets.configured = false;
        expect(staticCatalog.service.readOnlyReason).toBe(
            "These map presets come from the static Erdblick configuration and are read-only."
        );

        const serverCatalog = createService(false);
        expect(serverCatalog.service.readOnlyReason).toBe(
            "Map presets are read-only because configuration writes are disabled."
        );
    });

    it("keeps a totally omitted catalog unavailable without a writable server target", async () => {
        const {service, http} = createService(true, false);

        expect(service.configured).toBe(false);
        expect(service.presets).toEqual([]);
        expect(service.canWrite).toBe(false);
        expect(await service.addPreset(configured[0])).toBe(false);
        expect(http.patch).not.toHaveBeenCalled();
    });

    it("distinguishes writable, locked MapViewer, and static-only empty catalogs", () => {
        expect(createService(true, true, true, []).service.emptyCatalogMessage).toBe(
            "No map presets configured."
        );
        const lockedMapViewer = createService(false, false, true, []).service;
        expect(lockedMapViewer.emptyCatalogMessage).toBe(
            "Configuring map presets is not allowed. Modify the server configuration to allow access"
        );
        expect(lockedMapViewer.readOnlyReason).toBe(lockedMapViewer.emptyCatalogMessage);

        const staticOnly = createService(false, false, false, []).service;
        expect(staticOnly.emptyCatalogMessage).toBe(
            "No map presets configured. Please, add map presets in the configuration"
        );
        expect(staticOnly.readOnlyReason).toBe(staticOnly.emptyCatalogMessage);
    });

    it("explains populated read-only catalogs according to their deployment", () => {
        expect(createService(false, true, true).service.readOnlyCatalogMessage).toBe(
            "Configuring map presets is not allowed. Modify the server configuration to allow access"
        );
        expect(createService(false, true, false).service.readOnlyCatalogMessage).toBe(
            "Using static configuration. Modify the configuration to update map presets"
        );
        expect(createService(true, true, true).service.readOnlyCatalogMessage).toBeNull();
        expect(createService(false, false, true, []).service.readOnlyCatalogMessage).toBeNull();
        expect(createService(false, false, false, []).service.readOnlyCatalogMessage).toBeNull();
    });

    it("validates the complete catalog immediately before PATCH", async () => {
        const {service, http} = createService();
        const invalid = structuredClone(configured);
        invalid[0].layerPresets.push({...invalid[0].layerPresets[0]});

        expect(await service.applyDefinitions(invalid)).toBe(false);
        expect(http.patch).not.toHaveBeenCalled();
    });
});
