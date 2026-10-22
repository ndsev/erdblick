import {runInInjectionContext} from "@angular/core";
import {ownerTestInjector} from "../../test/owner-test-injector";
import {AppStore} from "../shared/app.store";
import {AppStateService} from "../shared/appstate.service";
import type {HttpClient} from "@angular/common/http";
import "@angular/compiler";
import {BehaviorSubject} from "rxjs";
import {describe, expect, it, vi} from "vitest";
import type {InfoMessageService} from "../shared/info.service";
import type {MapPresetService} from "../styledata/map-preset.service";
import type {ErdblickStyle, StyleService} from "../styledata/style.service";
import {MapInfoService} from "./map-info.service";
import {layerStyleOptions, type MapInfoItem} from "./map.tree.model";

describe("MapInfoService external-state reconciliation", () => {
    it("reapplies layer and style state without relying on a view-count change", () => {
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
        const injector = ownerTestInjector();
        const persistence = injector.get(AppStateService);
        const store = injector.get(AppStore);
        store.setMapLayerConfig("Map", "Layer", [{autoLevel: false, level: 13, visible: true}]);
        store.setStyleOptionValues("Map", "Layer", "Style", "details", [false]);
        persistence.ready.next(true);
        const service = runInInjectionContext(injector, () => new MapInfoService(
            {} as HttpClient,
            persistence,
            styleService,
            mapPresetService,
            {} as InfoMessageService
        ));
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
        Reflect.get(service, "publishSourceCatalogTree").call(service, [mapInfo]);
        const tree = service.maps;
        const layer = tree.maps.get("Map")!.layers.get("Layer")!;
        const option = layerStyleOptions(layer)[0]!;
        expect(layer.viewConfig[0]).toEqual({autoLevel: false, level: 13, visible: true});
        expect(option.value).toEqual([false]);

        const reasons: string[] = [];
        service.layerStateChanged.subscribe(reason => reasons.push(reason));
        store.setMapLayerConfig("Map", "Layer", [{autoLevel: false, level: 9, visible: false}]);
        store.setStyleOptionValues("Map", "Layer", "Style", "details", [true]);
        persistence.stateApplied.next();

        expect(store.numViews()).toBe(1);
        expect(layer.viewConfig[0]).toEqual({autoLevel: false, level: 9, visible: false});
        expect(option.value).toEqual([true]);
        expect(reasons).toEqual(["external-state"]);
        tree.destroy();
    });
});
