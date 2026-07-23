import {describe, expect, it, vi} from 'vitest';
import {BehaviorSubject} from "rxjs";
import {
    dataSourceCatalogStatus,
    dataSourceProgressPercent,
    isDataSourceCatalogEntryReady,
    MapLayerTree,
    MapInfoItem,
    sortDataSourceCatalogEntries
} from './map.tree.model';
import type {AppStateService} from "../shared/appstate.service";
import type {ErdblickStyle, StyleService} from "../styledata/style.service";

function source(mapId: string, configIndex?: number, status?: string): MapInfoItem {
    return {
        extraJsonAttachment: {},
        layers: {},
        mapId,
        maxParallelJobs: 0,
        sourceId: mapId,
        stringPoolId: mapId,
        protocolVersion: {major: 1, minor: 0, patch: 0},
        addOn: false,
        ...(configIndex === undefined ? {} : {configIndex}),
        ...(status === undefined ? {} : {status})
    };
}

describe('datasource catalog tree helpers', () => {
    it('treats legacy entries without a status as ready', () => {
        const legacy = source('Legacy');

        expect(dataSourceCatalogStatus(legacy)).toBe('ready');
        expect(isDataSourceCatalogEntryReady(legacy)).toBe(true);
    });

    it('recognizes initializing and failed catalog entries as not ready', () => {
        expect(isDataSourceCatalogEntryReady(source('Init', 0, 'initializing'))).toBe(false);
        expect(isDataSourceCatalogEntryReady(source('Failed', 1, 'failed'))).toBe(false);
    });

    it('preserves backend config order when catalog entries are sorted', () => {
        const sorted = sortDataSourceCatalogEntries([
            source('third', 2),
            source('legacy'),
            source('first', 0),
            source('second', 1)
        ]);

        expect(sorted.map(entry => entry.mapId)).toEqual(['first', 'second', 'third', 'legacy']);
    });

    it('normalizes datasource progress values for display', () => {
        expect(dataSourceProgressPercent({...source('fraction'), progress: 0.42})).toBe(42);
        expect(dataSourceProgressPercent({...source('percent'), progress: 73})).toBe(73);
        expect(dataSourceProgressPercent({...source('missing'), progress: null})).toBeNull();
    });
});

describe("style option groups", () => {
    it("marks the first visible option of each full stylesheet group", () => {
        const ready = new BehaviorSubject(true);
        const numViewsState = new BehaviorSubject(1);
        const stateService = {
            ready,
            numViewsState,
            mapLayerConfig: vi.fn(() => [{autoLevel: true, level: 13, visible: true}]),
            styleOptionValues: vi.fn((_mapId, _layerId, _styleId, _optionId, _type, defaultValue) => [defaultValue]),
            prune: vi.fn()
        };
        const styleGroups = new BehaviorSubject([]);
        const option = (id: string, internal = false) => ({
            id,
            label: id,
            description: id,
            type: "Bool",
            defaultValue: false,
            internal
        });
        const style = (id: string, shortId: string, options: ReturnType<typeof option>[]) => ({
            id,
            shortId,
            options,
            visible: true,
            featureLayerStyle: {hasLayerAffinity: () => true}
        }) as unknown as ErdblickStyle;
        const styles = new Map<string, ErdblickStyle>([
            ["customer/roads", style("customer/roads", "roads", [option("hidden", true), option("a"), option("b")])],
            ["customer/signs", style("customer/signs", "signs", [option("c")])]
        ]);
        const styleService = {styles, styleGroups};
        const map = source("Map");
        map.layers = {
            Roads: {
                layerId: "Roads",
                type: "Feature",
                canRead: true,
                canWrite: false,
                coverage: [],
                featureTypes: [],
                version: {major: 1, minor: 0, patch: 0},
                zoomLevels: [13]
            }
        };

        const tree = new MapLayerTree(
            [map],
            stateService as unknown as AppStateService,
            styleService as unknown as StyleService,
            false
        );
        const children = tree.maps.get("Map")?.layers.get("Roads")?.children ?? [];

        expect(children.map(child => child.id)).toEqual(["a", "b", "c"]);
        expect(children.map(child => child.styleOptionGroupId)).toEqual([
            "customer/roads",
            "customer/roads",
            "customer/signs"
        ]);
        expect(children.map(child => child.firstInStyleGroup)).toEqual([true, false, true]);
    });
});
