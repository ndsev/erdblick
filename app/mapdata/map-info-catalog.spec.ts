import { testPersistence, stateOwners } from "../../test/state-owners";
import "@angular/compiler";
import { HttpClient, HttpHeaders, HttpResponse } from "@angular/common/http";
import { BehaviorSubject, of, Subject } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { MapInfoService } from "./map-info.service";
import type { MapInfoItem } from "./map.tree.model";
import type { AppStateService } from "../shared/appstate.service";
import type { StyleService } from "../styledata/style.service";
import type { MapPresetService } from "../styledata/map-preset.service";
import type { InfoMessageService } from "../shared/info.service";

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
    const service = new MapInfoService(
        { get } as unknown as HttpClient, state, owners.styleService,
        { presets: [], presets$: new BehaviorSubject([]), presetsForLayer: () => [] } as unknown as MapPresetService,
        { clearBackendConnectionError: vi.fn(), showBackendConnectionError: vi.fn() } as unknown as InfoMessageService,
        owners.layerState, owners.viewSettings, owners.inspectionState
    );
    const resets = vi.fn();
    service.dataSourceInfoChanged.subscribe(resets);
    let revision = 0;
    return {
        service, resets, state, owners,
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

describe("MapInfoService incremental catalog startup", () => {
    it('prunes layers, style visibility and inspection together only after a complete catalog', async () => {
        const { service, state, owners, reload, dispose } = fixture();
        try {
            await reload([source('First', 0), source('Second', 1, 'initializing')]);
            owners.layerState.layerNames = ['First/Road', 'First/Retired'];
            owners.layerState.layerVisibilityState.next(0, [true, false]);
            owners.styleService.styleVisibility = { retired: false };
            owners.inspectionState.setSelection([{ mapTileKey: 'Features:First:Retired:1', featureId: 'Road.1' }]);
            const selectedPanel = owners.inspectionState.selection[0];
            service.pruneCatalogState();
            expect(owners.layerState.layerNames).toContain('First/Retired');
            expect(owners.inspectionState.selection[0]).toBe(selectedPanel);
            expect(owners.styleService.styleVisibility).toEqual({ retired: false });

            // Finish catalog discovery, then add stale state as a later imported preference.
            await reload([source('First', 0), source('Second', 1)]);
            owners.layerState.layerNames = ['First/Road', 'First/Retired'];
            owners.layerState.layerVisibilityState.next(0, [true, false]);
            owners.styleService.styleVisibility = { retired: false };
            owners.inspectionState.setSelection([{ mapTileKey: 'Features:First:Retired:1', featureId: 'Road.1' }]);
            const observed: unknown[] = [];
            const subscription = state.observe(() => ({
                layers: owners.layerState.layerNames,
                visibility: owners.layerState.layerVisibilityState.getValue(0),
                styles: owners.styleService.styleVisibility,
                selection: owners.inspectionState.selection
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
