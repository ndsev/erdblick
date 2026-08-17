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

function createService(write = true) {
    const config: any = {
        snapshot: {
            mapPresets: structuredClone(configured),
            mapPresetsEnabled: true,
            mapPresetConfig: {
                configured: true,
                valid: true,
                write,
                endpoint: "/config/erdblick/map-presets",
                revision: "rev-1",
                ephemeral: false,
                issues: []
            }
        },
        applyCanonicalMapPresets: vi.fn((definitions: MapPresetDefinition[], revision: string) => {
            config.snapshot.mapPresets = structuredClone(definitions);
            config.snapshot.mapPresetConfig.revision = revision;
            return true;
        }),
        refreshMapPresetConfig: vi.fn(async () => config.snapshot)
    };
    const http = {put: vi.fn()};
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
        http.put.mockReturnValue(of(new HttpResponse({
            status: 200,
            body: {mapPresets: canonical, revision: "rev-2"}
        })));

        expect(await service.setAvailable("network", false)).toBe(true);
        expect(service.presets).toEqual(canonical);
        expect(config.applyCanonicalMapPresets).toHaveBeenCalledWith(canonical, "rev-2");
        const options = http.put.mock.calls[0][2] as {headers: HttpHeaders};
        expect(options.headers.get("If-Match")).toBe('"rev-1"');
    });

    it("allows only one complete-catalog write in flight", async () => {
        const {service, http} = createService();
        const pending = new Subject<HttpResponse<unknown>>();
        http.put.mockReturnValue(pending);

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
            body: {mapPresets: [{...configured[0], enabled: false}], revision: "rev-2"}
        }));
        pending.complete();
        expect(await first).toBe(true);
    });

    it("refetches the authoritative catalog after a stale revision", async () => {
        const {service, config, http} = createService();
        http.put.mockReturnValue(throwError(() => new HttpErrorResponse({status: 412})));
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
        expect(http.put).not.toHaveBeenCalled();
    });
});
