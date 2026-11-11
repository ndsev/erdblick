import { testPersistence, stateOwners } from "../../support/state-owners";
import "@angular/compiler";
import { HttpClient, HttpErrorResponse, HttpHeaders, HttpResponse } from "@angular/common/http";
import { NgZone } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BehaviorSubject, of, Subject, throwError } from "rxjs";
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
import { InfoMessageService } from "../../../app/diagnostics/info.service";
import { MapTileStreamService } from "../../../app/mapdata/map-tile-stream.service";
import { MapTileStreamClientInteractive } from "../../../app/mapdata/map-tile-stream.client";

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
function fixture(messages: InfoMessageService = {showError: vi.fn()} as unknown as InfoMessageService) {
    const get = vi.fn();
    const state = testPersistence();
    const owners = stateOwners(state);
    state.ready.next(true);
    const service = new MapDataService(
        { get } as unknown as HttpClient, state, owners.styleService,
        { presets: [], presets$: new BehaviorSubject([]), presetsForLayer: () => [] } as unknown as MapPresetService,
        messages,
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
    it("retains configuration health separately from source readiness and clears it on recovery", async () => {
        const {service, get, reload, dispose} = fixture();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            get.mockReturnValueOnce(of(new HttpResponse({body: [], headers: new HttpHeaders({
                'X-Mapget-Sources-Config-Status': 'error',
                'X-Mapget-Sources-Config-Message': 'Configuration rejected'
            })})));
            expect(await service.reloadDataSources()).toBe(true);
            expect(service.getSourceRecoveryState()).toMatchObject({
                failedSourceCount: 0, catalogError: 'Configuration rejected'
            });
            await reload([]);
            expect(service.getSourceRecoveryState().catalogError).toBe('');
        } finally {warning.mockRestore(); dispose();}
    });

    it("classifies transient catalog HTTP failures without retrying invalid response bodies", async () => {
        const {service, get, reload, dispose} = fixture();
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            for (const [status, retryable] of [[0, true], [503, true], [401, false], [200, false]] as const) {
                get.mockReturnValueOnce(throwError(() => new HttpErrorResponse({status})));
                expect(await service.reloadDataSources()).toBe(false);
                expect(service.catalogRefreshFailure?.retryable).toBe(retryable);
            }
            get.mockReturnValueOnce(of(new HttpResponse({body: {unexpected: true}})));
            expect(await service.reloadDataSources()).toBe(false);
            expect(service.catalogRefreshFailure?.retryable).toBe(false);
            await reload([]);
            expect(service.catalogRefreshFailure).toBeUndefined();
        } finally {error.mockRestore(); dispose();}
    });

    it("cancels catalog HTTP reads without publishing an error or a late response", async () => {
        const notice = vi.fn();
        const {service, get, dispose} = fixture({showError: notice} as unknown as InfoMessageService);
        const response = new Subject<HttpResponse<MapInfoItem[]>>();
        const controller = new AbortController();
        get.mockReturnValueOnce(response);
        try {
            const pending = service.reloadDataSources(controller.signal);
            controller.abort();
            expect(await pending).toBe(false);
            expect(response.observed).toBe(false);
            response.next(new HttpResponse({body: [source('Late', 0)]}));
            expect(service.maps.maps.size).toBe(0);
            expect(notice).not.toHaveBeenCalled();
            expect(service.catalogRefreshFailure).toBeUndefined();
        } finally {dispose();}
    });

    it("keeps HTTP, stream and protocol notices independently owned across recovery and user dismissal", async () => {
        vi.useFakeTimers();
        TestBed.configureTestingModule({});
        const messages = TestBed.inject(InfoMessageService);
        const reported = vi.spyOn(messages, 'showError');
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(MapTileStreamClientInteractive.prototype, 'updateRequest').mockResolvedValue('sent');
        const {service, state, owners, get, reload, dispose} = fixture(messages);
        const stream = new MapTileStreamService(state, service, messages, TestBed.inject(NgZone), owners.layerState);
        try {
            await stream.initialize();
            const client = stream['tileStream']!;
            get.mockReturnValueOnce(throwError(() => new Error('HTTP unavailable')));
            expect(await service.reloadDataSources()).toBe(false);
            const http = reported.mock.results.at(-1)!.value;
            client.onClose?.(new CloseEvent('close', {code: 1006, reason: 'Lost connection'}));
            const disconnected = reported.mock.results.at(-1)!.value;
            client.onError?.(new Event('error'));
            expect(reported.mock.results.at(-1)!.value.id).toBe(disconnected.id);
            expect(messages.entry(disconnected.id)?.state().count).toBe(2);
            expect(messages.entry(disconnected.id)?.state().detail).toBe('Could not connect to the map backend.');
            await reload([]);
            expect(http.active).toBe(false);
            expect(disconnected.active).toBe(true);

            get.mockReturnValueOnce(throwError(() => new Error('HTTP unavailable again')));
            await service.reloadDataSources();
            const nextHttp = reported.mock.results.at(-1)!.value;
            client.onProtocolMismatch?.({actual: {major: 0, minor: 0, patch: 0}, expected: {major: 1, minor: 0}});
            const protocol = reported.mock.results.at(-1)!.value;
            expect(protocol.active).toBe(true);
            client.onOpen?.();
            expect(disconnected.active).toBe(false);
            expect(protocol.active).toBe(false);
            expect(nextHttp.active).toBe(true);
            nextHttp.dismiss();
            get.mockReturnValueOnce(throwError(() => new Error('New failure event')));
            await service.reloadDataSources();
            const fresh = reported.mock.results.at(-1)!.value;
            expect(fresh.id).not.toBe(nextHttp.id);
            expect(messages.entry(fresh.id)?.state().count).toBe(1);
            await reload([]);
            expect(fresh.active).toBe(false);
        } finally {
            stream.ngOnDestroy();
            dispose();
            TestBed.resetTestingModule();
            vi.restoreAllMocks();
            vi.useRealTimers();
        }
    });

    it("publishes independent schema readiness and keeps a failed source from pruning saved state", async () => {
        const {service, get, reload, dispose} = fixture();
        const slow = new Subject<ArrayBuffer>();
        const fast = new Subject<ArrayBuffer>();
        get.mockImplementation((_url, options) => options.params.sourceId === "Slow" ? slow : fast);
        vi.spyOn(service.tileLayerParser, "installMapSchema").mockImplementation(() => {});
        vi.spyOn(service.tileLayerParser, "applyDataSourceChanges").mockImplementation(() => {});
        try {
            await reload([{...source("Slow", 0), schemaId: "slow"}, {...source("Fast", 1), schemaId: "fast"}]);
            expect(service.isMapReady("Fast")).toBe(false);
            expect(service.canPruneStateForCurrentCatalog()).toBe(false);
            const ready = vi.fn();
            const inspectionReady = service.waitForMapLayersReady([{mapId: "Fast", layerId: "Road"}]).then(ready);
            expect(ready).not.toHaveBeenCalled();
            fast.next(new Uint8Array([1]).buffer);
            await inspectionReady;
            expect(ready).toHaveBeenCalledOnce();
            await vi.waitFor(() => expect(service.isMapReady("Fast")).toBe(true));
            const signature = service.schemaScopeSignature(["Fast"]);
            slow.error(new Error("Schema download failed"));
            await vi.waitFor(() => expect(service.isMapFailed("Slow")).toBe(true));
            expect(service.schemaScopeSignature(["Fast"])).toBe(signature);
            expect(service.canPruneStateForCurrentCatalog()).toBe(false);
            expect(service.maps.maps.get("Slow")?.info.status).toBe("ready");
            expect(service.maps.maps.get("Slow")?.info.schemaStatus).toBe("failed");
            expect(service.getSourceRecoveryState()).toMatchObject({
                failed: true, sourceCount: 2, failedSourceCount: 1, retrying: false
            });
            expect(service.getSourceRecoveryState().message).toContain("Schema download failed");
        } finally {vi.restoreAllMocks(); dispose();}
    });

    it("cancels readiness waits and reports failed or missing inspection targets", async () => {
        const {service, reload, dispose} = fixture();
        try {
            await reload([source("Loading", 0, "initializing")]);
            const controller = new AbortController();
            const pending = service.waitForMapLayersReady([{mapId: "Loading", layerId: "Road"}], controller.signal);
            const cancelled = expect(pending).rejects.toMatchObject({name: "AbortError"});
            controller.abort();
            await cancelled;

            await reload([source("Loading", 0, "initializing"), source("Broken", 1, "failed")]);
            await expect(service.waitForMapLayersReady([
                {mapId: "Loading", layerId: "Road"}, {mapId: "Broken", layerId: "Road"}
            ])).rejects.toThrow("failed");
            await expect(service.waitForMapLayersReady([{mapId: "Missing", layerId: "Road"}]))
                .rejects.toThrow("unavailable");
            await reload([source("Ready", 0)]);
            await expect(service.waitForMapLayersReady([{mapId: "Ready", layerId: "Missing"}]))
                .rejects.toThrow("unavailable");
        } finally {dispose();}
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
        vi.spyOn(service.tileLayerParser, "applyDataSourceChanges").mockImplementation(() => {});
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
        vi.spyOn(service.tileLayerParser, "applyDataSourceChanges").mockImplementation(() => {});
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
    it('cancels the awaited superseded read and never starts an unowned follow-up', async () => {
        const {service, get, reload, dispose} = fixture();
        const first = new Subject<HttpResponse<MapInfoItem[]>>();
        const second = new Subject<HttpResponse<MapInfoItem[]>>();
        const controller = new AbortController();
        try {
            await reload([source('Map', 0, 'initializing')]);
            get.mockReturnValueOnce(first).mockReturnValueOnce(second);
            const refresh = service.reloadDataSources(controller.signal);
            service.applySourceCatalogChange({configIndex: 0, status: 'initializing', progress: 0.5}, 3);
            first.next(new HttpResponse({body: [], headers: new HttpHeaders({'X-Mapget-Sources-Revision': '2'})}));
            await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3));
            controller.abort();
            expect(await refresh).toBe(false);
            expect(second.observed).toBe(false);
            expect(service.sourceCatalogRevision).toBe(3);
            expect(get).toHaveBeenCalledTimes(3);
        } finally {dispose();}
    });

    it('does not revive recovery when an older owned request fails after a manual read succeeds', async () => {
        const {service, state, owners, get, dispose} = fixture();
        const older = new Subject<HttpResponse<MapInfoItem[]>>();
        const stream = new MapTileStreamService(state, service, {} as InfoMessageService,
            {run: (fn: () => void) => fn(), runOutsideAngular: (fn: () => void) => fn()} as NgZone, owners.layerState);
        const internal = stream as any;
        internal.scheduleUpdate = vi.fn();
        try {
            get.mockReturnValueOnce(older);
            internal.requestSourceCatalogRefresh(8);
            get.mockReturnValueOnce(of(new HttpResponse({body: [], headers: new HttpHeaders({'X-Mapget-Sources-Revision': '8'})})));
            expect(await service.reloadDataSources()).toBe(true);
            older.error(new HttpErrorResponse({status: 503}));
            await internal.sourceCatalogReloadPromise;
            expect(internal.catalogRetry).toBeUndefined();
            expect(service.catalogRefreshFailure).toBeUndefined();
            expect(get).toHaveBeenCalledTimes(2);
        } finally {stream.ngOnDestroy(); dispose();}
    });

    it('reports a bounded stale snapshot independently of an earlier terminal failure', async () => {
        const {service, get, reload, dispose} = fixture();
        const first = new Subject<HttpResponse<MapInfoItem[]>>();
        const second = new Subject<HttpResponse<MapInfoItem[]>>();
        try {
            await reload([source('Map', 0, 'initializing')]);
            service.catalogRefreshFailure = {message: 'Old malformed response', retryable: false};
            get.mockReturnValueOnce(first).mockReturnValueOnce(second);
            const refresh = service.refreshSourceCatalog();
            service.applySourceCatalogChange({configIndex: 0, status: 'initializing', progress: 0.5}, 3);
            first.next(new HttpResponse({body: [], headers: new HttpHeaders({'X-Mapget-Sources-Revision': '2'})}));
            await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3));
            service.applySourceCatalogChange({configIndex: 0, status: 'initializing', progress: 0.6}, 4);
            second.next(new HttpResponse({body: [], headers: new HttpHeaders({'X-Mapget-Sources-Revision': '3'})}));
            expect(await refresh).toEqual({status: 'stale'});
            expect(get).toHaveBeenCalledTimes(3);
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

    it.each(["replace", "remove"])("retires only the affected map for a metadata %s", async change => {
        const { service, resets, reload, dispose } = fixture();
        const first = source("First", 0);
        const second = source("Second", 1);
        try {
            await reload([first, second]);
            const original = service.mapgetLayer("First", "Road");
            const retained = service.mapgetLayer("Second", "Road");
            const retainedBlob = service.getRenderDataSourceInfoBlob("Second");
            const retainedGeneration = service.mapMetadataGeneration("Second");
            const replace = vi.spyOn(service.tileLayerParser, "setDataSourceInfo");
            resets.mockClear();
            if (change === "replace") {
                first.layers["Road"].version.minor = 1;
                await reload([first, second]);
            } else {
                await reload([second]);
            }
            expect(replace).not.toHaveBeenCalled();
            expect(resets).toHaveBeenCalledWith(["First"]);
            expect(service.mapgetLayer("Second", "Road")).toBe(retained);
            expect(service.getRenderDataSourceInfoBlob("Second")).toBe(retainedBlob);
            expect(service.mapMetadataGeneration("Second")).toBe(retainedGeneration);
            expect(resets).toHaveBeenCalledOnce();
            expect(service.mapgetLayer("First", "Road")).not.toBe(original);
        } finally {
            vi.restoreAllMocks();
            dispose();
        }
    });

    it("retires the old generation before a replacement schema finishes downloading", async () => {
        const {service, resets, get, reload, dispose} = fixture();
        const download = new Subject<ArrayBuffer>();
        try {
            await reload([source("Map", 0), source("Sibling", 1)]);
            const oldGeneration = service.mapMetadataGeneration("Map");
            const siblingGeneration = service.mapMetadataGeneration("Sibling");
            get.mockReturnValue(download);
            const install = vi.spyOn(service.tileLayerParser, "installMapSchema").mockImplementation(() => {});
            // Only the replacement uses a synthetic artifact. Removal still
            // exercises the native parser with the original ready metadata.
            const apply = vi.spyOn(service.tileLayerParser, "applyDataSourceChanges");
            await reload([{...source("Map", 0), schemaId: "replacement"}, source("Sibling", 1)]);
            expect(service.isMapReady("Map")).toBe(false);
            expect(service.mapMetadataGeneration("Map")).toBeGreaterThan(oldGeneration);
            expect(service.mapMetadataGeneration("Sibling")).toBe(siblingGeneration);
            expect(resets).toHaveBeenCalledExactlyOnceWith(["Map"]);
            expect(install).not.toHaveBeenCalled();
            expect(apply).toHaveBeenCalledOnce();

            // Remove it again before the late artifact arrives; completion
            // cannot revive the retired map or change its sibling's generation.
            await reload([source("Sibling", 1)]);
            download.next(new Uint8Array([1]).buffer);
            await Promise.resolve();
            expect(service.isMapReady("Map")).toBe(false);
            expect(install).not.toHaveBeenCalled();
            expect(service.mapMetadataGeneration("Sibling")).toBe(siblingGeneration);
        } finally {vi.restoreAllMocks(); dispose();}
    });
});
