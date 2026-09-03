import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import {BehaviorSubject, Subject} from "rxjs";
import type {HttpClient} from "@angular/common/http";
import {MapInfoService} from "./map-info.service";
import {layerStyleOptions, MapLayerTree, type MapInfoItem} from "./map.tree.model";
import type {AppStateService} from "../shared/appstate.service";
import type {ErdblickStyle, StyleService} from "../styledata/style.service";
import type {MapPresetService} from "../styledata/map-preset.service";
import type {InfoMessageService} from "../shared/info.service";

describe("MapInfoService URL-state reconciliation", () => {
    it("reapplies layer and style state without relying on a view-count change", () => {
        const urlStateApplied = new Subject<void>();
        let visible = true;
        let level = 13;
        let optionValue = false;
        const stateService = {
            ready: new BehaviorSubject(true),
            numViewsState: new BehaviorSubject(1),
            urlStateApplied,
            mapLayerConfig: vi.fn(() => [{autoLevel: false, level, visible}]),
            styleOptionValues: vi.fn(() => [optionValue]),
            getLayerPresetSelection: vi.fn(() => null),
            setLayerPresetSelection: vi.fn(),
            getMapPresetSelection: vi.fn(() => null),
            setMapPresetSelection: vi.fn(),
            prune: vi.fn()
        } as unknown as AppStateService;
        const style = {
            id: "Style",
            shortId: "Style",
            visible: true,
            presets: [],
            options: [{
                id: "details",
                label: "Details",
                description: "Show details",
                type: "Bool",
                defaultValue: false,
                internal: false
            }],
            featureLayerStyle: {hasLayerAffinity: () => true}
        } as unknown as ErdblickStyle;
        const styleService = {
            styles: new Map([[style.id, style]]),
            styleGroups: new BehaviorSubject([])
        } as unknown as StyleService;
        const mapPresetService = {
            presets: [],
            presets$: new BehaviorSubject([]),
            isAvailable: () => true,
            presetsForLayer: () => [],
            matchesPresetValues: () => false
        } as unknown as MapPresetService;
        const service = new MapInfoService(
            {} as HttpClient,
            stateService,
            styleService,
            mapPresetService,
            {} as InfoMessageService
        );
        const mapInfo: MapInfoItem = {
            extraJsonAttachment: {},
            layers: {
                Layer: {
                    layerId: "Layer",
                    type: "Features",
                    canRead: true,
                    canWrite: false,
                    coverage: [],
                    featureTypes: [],
                    version: {major: 1, minor: 0, patch: 0},
                    zoomLevels: [13]
                }
            },
            mapId: "Map",
            maxParallelJobs: 0,
            sourceId: "Map",
            stringPoolId: "Map",
            protocolVersion: {major: 1, minor: 0, patch: 0},
            addOn: false
        };
        const tree = new MapLayerTree(
            [mapInfo],
            stateService,
            styleService,
            mapPresetService,
            false
        );
        service.maps$.getValue().destroy();
        service.maps$.next(tree);
        const layer = tree.maps.get("Map")!.layers.get("Layer")!;
        const option = layerStyleOptions(layer)[0]!;
        expect(layer.viewConfig[0]).toEqual({autoLevel: false, level: 13, visible: true});
        expect(option.value).toEqual([false]);

        const reasons: string[] = [];
        service.layerStateChanged.subscribe(reason => reasons.push(reason));
        visible = false;
        level = 9;
        optionValue = true;
        urlStateApplied.next();

        expect(stateService.numViewsState.getValue()).toBe(1);
        expect(layer.viewConfig[0]).toEqual({autoLevel: false, level: 9, visible: false});
        expect(option.value).toEqual([true]);
        expect(reasons).toEqual(["url-state"]);
        tree.destroy();
    });
});
