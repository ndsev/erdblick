import { testPersistence, stateOwners } from "../../support/state-owners";
import "@angular/compiler";
import { HttpClient, HttpHeaders, HttpResponse } from "@angular/common/http";
import { BehaviorSubject, of, Subject } from "rxjs";
import {
    describe,
    expect,
    it,
    vi
} from "vitest";
import { MapDataService } from "../../../app/mapdata/mapdata.service";
import type { MapInfoItem } from "../../../app/mapdata/source-catalog.model";
import type { AppStateService } from "../../../app/appstate/appstate.service";
import type { MapStyleService } from "../../../app/mapstyle/mapstyle.service";
import type { MapPresetService } from "../../../app/mapstyle/map-preset.service";
import type { InfoMessageService } from "../../../app/diagnostics/info.service";

/** Minimal valid catalog entry; each refresh below crosses a real JSON boundary. */
function source(mapId: string, configIndex: number, status = "ready"): MapInfoItem {
    return {
        mapId, sourceId: mapId, stringPoolId: mapId, configIndex, status,
        extraJsonAttachment: {}, maxParallelJobs: 1, addOn: false,
        layers: status === "ready" ? {
            Road: {
                layerId: "Road", type: "Features", canRead: true, canWrite: false,
                coverage: [], featureTypes: [], zoomLevels: [13],
                version: { major: 1, minor: 0, patch: 0 }
            }
        } : {}
    };
}

/** Exercises the real tree and native parser with only persistence/UI dependencies stubbed. */
function fixture() {
    const get = vi.fn();
    const state = testPersistence();
    const owners = stateOwners(state);
    state.ready.next(true);
    const service = new MapDataService(
        { get } as unknown as HttpClient, state, owners.styleService,
        { presets: [], presets$: new BehaviorSubject([]), presetsForLayer: () => [] } as unknown as MapPresetService,
        { clearBackendConnectionError: vi.fn(), showBackendConnectionError: vi.fn() } as unknown as InfoMessageService,
        owners.layerState, owners.viewSettings, owners.inspectionState
    );
    const resets = vi.fn();
    service.dataSourceInfoChanged.subscribe(resets);
    let revision = 0;
    return {
        service, resets, state, owners, get,
        async reload(entries: MapInfoItem[]) {
            get.mockReturnValueOnce(of(new HttpResponse({
                body: JSON.parse(JSON.stringify(entries)),
                headers: new HttpHeaders({ "X-Mapget-Sources-Revision": String(++revision) })
            })));
            expect(await service.reloadDataSources()).toBe(true);
        },
        dispose() {
            service.maps.destroy();
            service.tileLayerParser.delete();
        }
    };
}

describe("MapDataService incremental catalog startup", () => {
    it("publishes independent schema readiness and keeps a failed source from pruning saved state", async () => {
        const {service, get, reload, dispose} = fixture();
        const slow = new Subject<ArrayBuffer>();
        const fast = new Subject<ArrayBuffer>();
        get.mockImplementation((_url, options) => options.params.sourceId === "Slow" ? slow : fast);
        vi.spyOn(service.tileLayerParser, "installMapSchema").mockImplementation(() => {});
        vi.spyOn(service.tileLayerParser, "addDataSourceInfo").mockImplementation(() => {});
        try {
            await reload([{...source("Slow", 0), schemaId: "slow"}, {...source("Fast", 1), schemaId: "fast"}]);
            expect(service.isMapReady("Fast")).toBe(false);
            expect(service.canPruneStateForCurrentCatalog()).toBe(false);
            fast.next(new Uint8Array([1]).buffer);
            await vi.waitFor(() => expect(service.isMapReady("Fast")).toBe(true));
            const signature = service.schemaScopeSignature(["Fast"]);
            slow.error(new Error("Schema download failed"));
            await vi.waitFor(() => expect(service.isMapFailed("Slow")).toBe(true));
            expect(service.schemaScopeSignature(["Fast"])).toBe(signature);
            expect(service.canPruneStateForCurrentCatalog()).toBe(false);
            expect(service.maps.maps.get("Slow")?.info.status).toBe("ready");
            expect(service.maps.maps.get("Slow")?.info.schemaStatus).toBe("failed");
        } finally {vi.restoreAllMocks(); dispose();}
    });

    it("retries a coalesced artifact through another source after the first provider fails", async () => {
        const {service, get, reload, dispose} = fixture();
        const first = new Subject<ArrayBuffer>();
        const second = new Subject<ArrayBuffer>();
        const requested: string[] = [];
        get.mockImplementation((_url, options) => {
            requested.push(options.params.sourceId);
            return options.params.sourceId === "First" ? first : second;
        });
        vi.spyOn(service.tileLayerParser, "installMapSchema").mockImplementation(() => {});
        vi.spyOn(service.tileLayerParser, "addDataSourceInfo").mockImplementation(() => {});
        try {
            await reload([{...source("First", 0), schemaId: "shared"}, {...source("Second", 1), schemaId: "shared"}]);
            expect(requested).toEqual(["First"]);
            first.error(new Error("Provider unavailable"));
            await vi.waitFor(() => expect(requested).toEqual(["First", "Second"]));
            second.next(new Uint8Array([1]).buffer);
            await vi.waitFor(() => expect(service.isMapReady("Second")).toBe(true));
            expect(service.isMapReady("First")).toBe(true);
            expect(service.getSchemaArtifacts()).toHaveLength(1);
        } finally {vi.restoreAllMocks(); dispose();}
    });

    it("discards a retired download instead of installing it into the replacement catalog", async () => {
        const {service, get, reload, dispose} = fixture();
        const old = new Subject<ArrayBuffer>();
        const replacement = new Subject<ArrayBuffer>();
        get.mockImplementation((_url, options) => options.params.schemaId === "old" ? old : replacement);
        const install = vi.spyOn(service.tileLayerParser, "installMapSchema").mockImplementation(() => {});
        vi.spyOn(service.tileLayerParser, "addDataSourceInfo").mockImplementation(() => {});
        try {
            await reload([{...source("Map", 0), schemaId: "old"}]);
            await reload([{...source("Map", 0), schemaId: "new"}]);
            old.next(new Uint8Array([1]).buffer);
            replacement.next(new Uint8Array([2]).buffer);
            await vi.waitFor(() => expect(service.isMapReady("Map")).toBe(true));
            expect(install.mock.calls.every(call => call[1] === "new")).toBe(true);
            expect(service.getSchemaArtifacts().map(artifact => artifact.schemaId)).toEqual(["new"]);
        } finally {vi.restoreAllMocks(); dispose();}
    });

    it("does not let an older HTTP response overwrite a newer stream update", async () => {
        const {service, get, reload, dispose} = fixture();
        const delayed = new Subject<HttpResponse<MapInfoItem[]>>();
        try {
            await reload([source("First", 0), source("Second", 1, "initializing")]);
            get.mockReturnValueOnce(delayed);
            const refresh = service.reloadDataSources();
            service.applySourceCatalogChange({configIndex: 1, status: "initializing", progress: 0.9}, 3);
            get.mockReturnValueOnce(of(new HttpResponse({body: [source("First", 0), source("Second", 1)],
                headers: new HttpHeaders({"X-Mapget-Sources-Revision": "3"})})));
            const states: unknown[] = [];
            const subscription = service.maps$.subscribe(tree => states.push(tree.maps.get("Second")?.info.status));
            delayed.next(new HttpResponse({body: [source("First", 0), source("Second", 1, "failed")],
                headers: new HttpHeaders({"X-Mapget-Sources-Revision": "2"})}));
            await refresh;
            await vi.waitFor(() => expect(service.isMapReady("Second")).toBe(true));
            expect(states).not.toContain("failed");
            subscription.unsubscribe();
        } finally {dispose();}
    });
    it('prunes layers, style visibility and inspection together only after a complete catalog', async () => {
        const { service, state, owners, reload, dispose } = fixture();
        try {
            await reload([source('First', 0), source('Second', 1, 'initializing')]);
            owners.layerState.layerNames = ['First/Road', 'First/Retired'];
            owners.layerState.layerVisibilityState.next(0, [true, false]);
            owners.styleService.state.styleVisibility = { retired: false };
            owners.inspectionState.setSelection([{ mapTileKey: 'Features:First:Retired:1', featureId: 'Road.1' }]);
            const selectedPanel = owners.inspectionState.state.selection[0];
            service.pruneCatalogState();
            expect(owners.layerState.layerNames).toContain('First/Retired');
            expect(owners.inspectionState.state.selection[0]).toBe(selectedPanel);
            expect(owners.styleService.state.styleVisibility).toEqual({ retired: false });

            // Finish catalog discovery, then add stale state as a later imported preference.
            await reload([source('First', 0), source('Second', 1)]);
            owners.layerState.layerNames = ['First/Road', 'First/Retired'];
            owners.layerState.layerVisibilityState.next(0, [true, false]);
            owners.styleService.state.styleVisibility = { retired: false };
            owners.inspectionState.setSelection([{ mapTileKey: 'Features:First:Retired:1', featureId: 'Road.1' }]);
            const observed: unknown[] = [];
            const subscription = state.observe(() => ({
                layers: owners.layerState.layerNames,
                visibility: owners.layerState.layerVisibilityState.getValue(0),
                styles: owners.styleService.state.styleVisibility,
                selection: owners.inspectionState.state.selection
            })).subscribe(value => observed.push(value));
            const systemEdit = vi.spyOn(state, 'withSystemStateMutation');
            service.pruneCatalogState();
            expect(observed).toHaveLength(2);
            expect(observed[1]).toEqual({ layers: ['First/Road'], visibility: [true], styles: {}, selection: [] });
            expect(systemEdit).toHaveBeenCalledOnce();
            subscription.unsubscribe();
        } finally {
            dispose();
            state.ngOnDestroy();
        }
    });

    it("retains existing layer identity and parser state when other maps become ready", async () => {
        const { service, resets, reload, dispose } = fixture();
        const first = source("First", 0);
        try {
            await reload([first, source("Second", 1, "initializing")]);
            const layer = service.mapgetLayer("First", "Road");
            const renderMetadata = service.getRenderDataSourceInfoBlob("First");
            const replace = vi.spyOn(service.tileLayerParser, "setDataSourceInfo");
            resets.mockClear();

            // The status notification precedes the full ready metadata response.
            service.applySourceCatalogChange({ configIndex: 1, status: "ready" });
            await reload([first, source("Second", 1)]);

            expect(service.mapgetLayer("First", "Road")).toBe(layer);
            expect(service.mapgetLayer("Second", "Road")).toBeDefined();
            expect(service.getRenderDataSourceInfoBlob("First")).toBe(renderMetadata);
            expect(replace).not.toHaveBeenCalled();
            expect(resets).not.toHaveBeenCalled();

            // Progress/status decoration and a repeat HTTP response are not model changes.
            await reload([{ ...first, progress: 1, statusMessage: "Ready", configIndex: 2 }, source("Second", 1)]);
            expect(service.mapgetLayer("First", "Road")).toBe(layer);
            expect(replace).not.toHaveBeenCalled();
            expect(resets).not.toHaveBeenCalled();
        } finally {
            vi.restoreAllMocks();
            dispose();
        }
    });

    it.each(["replace", "remove"])("keeps the full invalidation path for a real metadata %s", async change => {
        const { service, resets, reload, dispose } = fixture();
        const first = source("First", 0);
        const second = source("Second", 1);
        try {
            await reload([first, second]);
            const original = service.mapgetLayer("First", "Road");
            const replace = vi.spyOn(service.tileLayerParser, "setDataSourceInfo");
            resets.mockClear();
            if (change === "replace") {
                first.layers["Road"].version.minor = 1;
                await reload([first, second]);
            } else {
                await reload([second]);
            }
            expect(replace).toHaveBeenCalledOnce();
            expect(resets).toHaveBeenCalledOnce();
            expect(service.mapgetLayer("First", "Road")).not.toBe(original);
        } finally {
            vi.restoreAllMocks();
            dispose();
        }
    });
});
