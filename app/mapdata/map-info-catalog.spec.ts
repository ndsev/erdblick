import "@angular/compiler";
import {HttpClient, HttpHeaders, HttpResponse} from "@angular/common/http";
import {BehaviorSubject, of, Subject} from "rxjs";
import {describe, expect, it, vi} from "vitest";
import {MapInfoService} from "./map-info.service";
import type {MapInfoItem} from "./map.tree.model";
import type {AppStateService} from "../shared/appstate.service";
import type {StyleService} from "../styledata/style.service";
import type {MapPresetService} from "../styledata/map-preset.service";
import type {InfoMessageService} from "../shared/info.service";

/** Minimal valid catalog entry; each refresh below crosses a real JSON boundary. */
function source(mapId: string, configIndex: number, status = "ready"): MapInfoItem {
    return {
        mapId, sourceId: mapId, stringPoolId: mapId, configIndex, status,
        extraJsonAttachment: {}, maxParallelJobs: 1, addOn: false,
        layers: status === "ready" ? {Road: {
            layerId: "Road", type: "Features", canRead: true, canWrite: false,
            coverage: [], featureTypes: [], zoomLevels: [13],
            version: {major: 1, minor: 0, patch: 0}
        }} : {}
    };
}

/** Exercises the real tree and native parser with only persistence/UI dependencies stubbed. */
function fixture() {
    const get = vi.fn();
    const service = new MapInfoService(
        {get} as unknown as HttpClient,
        {
            ready: new BehaviorSubject(true), numViews: 1, numViewsState: new BehaviorSubject(1),
            stateApplied: new Subject<void>(),
            mapLayerConfig: () => [{visible: true, level: 13, autoLevel: false}],
            getMapPresetSelection: () => null, getLayerSyncOption: () => false,
            prune: vi.fn()
        } as unknown as AppStateService,
        {styles: new Map(), styleGroups: new BehaviorSubject([])} as unknown as StyleService,
        {presets: [], presets$: new BehaviorSubject([]), presetsForLayer: () => []} as unknown as MapPresetService,
        {clearBackendConnectionError: vi.fn(), showBackendConnectionError: vi.fn()} as unknown as InfoMessageService
    );
    const resets = vi.fn();
    service.dataSourceInfoChanged.subscribe(resets);
    let revision = 0;
    return {
        service, resets,
        async reload(entries: MapInfoItem[]) {
            get.mockReturnValueOnce(of(new HttpResponse({
                body: JSON.parse(JSON.stringify(entries)),
                headers: new HttpHeaders({"X-Mapget-Sources-Revision": String(++revision)})
            })));
            expect(await service.reloadDataSources()).toBe(true);
        },
        dispose() {
            service.maps.destroy();
            service.tileLayerParser.delete();
        }
    };
}

describe("MapInfoService incremental catalog startup", () => {
    it("retains existing layer identity and parser state when other maps become ready", async () => {
        const {service, resets, reload, dispose} = fixture();
        const first = source("First", 0);
        try {
            await reload([first, source("Second", 1, "initializing")]);
            const layer = service.mapgetLayer("First", "Road");
            const renderMetadata = service.getRenderDataSourceInfoBlob("First");
            const replace = vi.spyOn(service.tileLayerParser, "setDataSourceInfo");
            resets.mockClear();

            // The status notification precedes the full ready metadata response.
            service.applySourceCatalogChange({configIndex: 1, status: "ready"});
            await reload([first, source("Second", 1)]);

            expect(service.mapgetLayer("First", "Road")).toBe(layer);
            expect(service.mapgetLayer("Second", "Road")).toBeDefined();
            expect(service.getRenderDataSourceInfoBlob("First")).toBe(renderMetadata);
            expect(replace).not.toHaveBeenCalled();
            expect(resets).not.toHaveBeenCalled();

            // Progress/status decoration and a repeat HTTP response are not model changes.
            await reload([{...first, progress: 1, statusMessage: "Ready", configIndex: 2}, source("Second", 1)]);
            expect(service.mapgetLayer("First", "Road")).toBe(layer);
            expect(replace).not.toHaveBeenCalled();
            expect(resets).not.toHaveBeenCalled();
        } finally {
            vi.restoreAllMocks();
            dispose();
        }
    });

    it.each(["replace", "remove"])("keeps the full invalidation path for a real metadata %s", async change => {
        const {service, resets, reload, dispose} = fixture();
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
