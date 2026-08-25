import "@angular/compiler";
import {describe, expect, it, vi} from 'vitest';
import {BehaviorSubject} from "rxjs";
import {
    bestMatchingLayerPreset,
    dataSourceCatalogStatus,
    dataSourceProgressPercent,
    filterMapTreeNodes,
    GroupTreeNode,
    isDataSourceCatalogEntryReady,
    layerPresetInferenceKey,
    layerPresetNode,
    layerStyleOptions,
    LayerInfoItem,
    MapLayerTree,
    MapInfoItem,
    MapTreeNode,
    MapTreeViewNode,
    StyleOptionNode,
    sortDataSourceCatalogEntries
} from './map.tree.model';
import type {AppStateService} from "../shared/appstate.service";
import type {
    ErdblickStyle,
    FeatureStyleOptionWithStringType,
    StyleService
} from "../styledata/style.service";
import type {MapPresetService} from "../styledata/map-preset.service";
import type {ResolvedLayerPreset} from "../styledata/map-preset.service";

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

/** Creates one feature-layer metadata entry for map-tree filtering tests. */
function featureLayer(layerId: string): LayerInfoItem {
    return {
        layerId,
        type: "Features",
        canRead: true,
        canWrite: false,
        coverage: [],
        featureTypes: [],
        version: {major: 1, minor: 0, patch: 0},
        zoomLevels: [13]
    };
}

/** Creates one boolean style option with distinct machine and display names. */
function styleOption(id: string, label: string): FeatureStyleOptionWithStringType {
    return {
        id,
        label,
        description: label,
        type: "Bool",
        defaultValue: false,
        internal: false
    };
}

/** Creates the empty preset catalog used by map-tree tests unrelated to presets. */
function emptyPresetService(): MapPresetService {
    return {
        presets: [],
        presets$: new BehaviorSubject([]),
        isAvailable: () => true,
        presetsForLayer: () => [],
        matchesPresetValues: () => false
    } as unknown as MapPresetService;
}

/** Builds a collapsed group/map/layer hierarchy with two layers and two road options. */
function filterTreeFixture() {
    const mapInfo = source("Vendor/PrimaryMap");
    mapInfo.layers = {
        Roads: featureLayer("Roads"),
        Buildings: featureLayer("Buildings")
    };
    const mapNode = new MapTreeNode(mapInfo);
    const roads = mapNode.layers.get("Roads")!;
    roads.children = [
        new StyleOptionNode(
            mapInfo.mapId,
            roads.id,
            styleOption("road-labels", "Show Road Names"),
            "customer/roads",
            "roads",
            true
        ),
        new StyleOptionNode(
            mapInfo.mapId,
            roads.id,
            styleOption("road-shields", "Show Route Shields"),
            "customer/roads",
            "roads",
            false
        )
    ];

    const group = new GroupTreeNode("Vendor");
    group.children = [mapNode];
    group.expanded = false;
    group.visible = [true, false];
    mapNode.expanded = false;
    mapNode.visible = [true, false];
    roads.expanded = false;
    roads.viewConfig = [
        {autoLevel: true, level: 13, visible: true},
        {autoLevel: false, level: 12, visible: false}
    ];
    return {nodes: [group], group, mapNode, roads};
}

/** Flattens stable presentation keys in rendered tree order. */
function flattenedMapTreeKeys(nodes: MapTreeViewNode[]): string[] {
    return nodes.flatMap(node => [
        node.key,
        ...flattenedMapTreeKeys(node.children ?? [])
    ]);
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

describe("map tree presentation filtering", () => {
    it("treats a removed split-view index as not visible", () => {
        const fixture = filterTreeFixture();
        const tree = Object.create(MapLayerTree.prototype) as any;
        tree.mapsForMapIds = new Map([[fixture.mapNode.id, fixture.mapNode]]);

        expect(tree.getMapLayerVisibility(
            2,
            fixture.mapNode.id,
            fixture.roads.id
        )).toBe(false);
    });

    it("returns the canonical tree for an empty query", () => {
        const fixture = filterTreeFixture();
        const result = filterMapTreeNodes(fixture.nodes, "   ");

        expect(flattenedMapTreeKeys(result)).toEqual(flattenedMapTreeKeys(fixture.nodes));
        expect(result).not.toBe(fixture.nodes);
    });

    it("matches map ids case-insensitively and retains the complete map subtree", () => {
        const fixture = filterTreeFixture();
        const result = filterMapTreeNodes(fixture.nodes, "PRIMARYmap");
        const filteredMap = result[0].children?.[0];
        const filteredRoads = filteredMap?.children?.[0];

        expect(result.map(node => node.id)).toEqual(["Vendor"]);
        expect(filteredMap?.id).toBe("Vendor/PrimaryMap");
        expect(filteredMap?.children?.map(node => node.id)).toEqual(["Roads", "Buildings"]);
        expect(result[0].visible).toBe(fixture.group.visible);
        expect(filteredMap?.visible).toBe(fixture.mapNode.visible);
        expect(filteredRoads?.viewConfig).toBe(fixture.roads.viewConfig);
    });

    it("keeps only the expanded ancestor path to a matching layer", () => {
        const fixture = filterTreeFixture();
        const result = filterMapTreeNodes(fixture.nodes, "build");
        const filteredMap = result[0].children?.[0];

        expect(result[0].expanded).toBe(true);
        expect(filteredMap?.expanded).toBe(true);
        expect(filteredMap?.children?.map(node => node.id)).toEqual(["Buildings"]);
        expect(fixture.group.expanded).toBe(false);
        expect(fixture.mapNode.expanded).toBe(false);
    });

    it("matches style-option labels and ids while leaving source expansion unchanged", () => {
        const fixture = filterTreeFixture();
        const labelResult = filterMapTreeNodes(fixture.nodes, "road names");
        const filteredRoads = labelResult[0].children?.[0].children?.[0];
        const idResult = filterMapTreeNodes(fixture.nodes, "road-shields");

        expect(filteredRoads?.id).toBe("Roads");
        expect(filteredRoads?.expanded).toBe(true);
        expect(filteredRoads?.children?.map(node => node.id)).toEqual(["road-labels"]);
        expect(idResult[0].children?.[0].children?.[0].children?.map(node => node.id))
            .toEqual(["road-shields"]);
        expect(fixture.roads.expanded).toBe(false);
    });

    it("returns no roots when no displayed identifier or option label matches", () => {
        const fixture = filterTreeFixture();

        expect(filterMapTreeNodes(fixture.nodes, "not-present")).toEqual([]);
    });

    it("preserves unique logical keys across equivalent filtered projections", () => {
        const fixture = filterTreeFixture();
        const firstKeys = flattenedMapTreeKeys(filterMapTreeNodes(fixture.nodes, "primary"));
        const secondKeys = flattenedMapTreeKeys(filterMapTreeNodes(fixture.nodes, "primarymap"));

        expect(secondKeys).toEqual(firstKeys);
        expect(new Set(firstKeys).size).toBe(firstKeys.length);
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
            getLayerPresetSelection: vi.fn(() => null),
            setLayerPresetSelection: vi.fn(),
            getMapPresetSelection: vi.fn(() => null),
            setMapPresetSelection: vi.fn(),
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
            presets: [],
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
            emptyPresetService(),
            false
        );
        const layer = tree.maps.get("Map")?.layers.get("Roads");
        const children = layer ? layerStyleOptions(layer) : [];

        expect(layer?.children[0].type).toBe("Preset");
        expect(children.map(child => child.id)).toEqual(["a", "b", "c"]);
        expect(children.map(child => child.styleOptionGroupId)).toEqual([
            "customer/roads",
            "customer/roads",
            "customer/signs"
        ]);
        expect(children.map(child => child.firstInStyleGroup)).toEqual([true, false, true]);

        tree.setNodeExpanded(layer!.key, false);
        expect(layer?.expanded).toBe(false);

        const styleOptionReadsBeforeDestroy = stateService.styleOptionValues.mock.calls.length;
        tree.destroy();
        styleGroups.next([]);
        numViewsState.next(2);
        expect(stateService.styleOptionValues).toHaveBeenCalledTimes(styleOptionReadsBeforeDestroy);
    });
});

describe("layer presets in the map tree", () => {
    it("chooses only a deterministic most-specific matching preset", () => {
        const optionA = new StyleOptionNode(
            "Map", "Example", styleOption("a", "A"), "Style", "Style", true);
        const optionB = new StyleOptionNode(
            "Map", "Example", styleOption("b", "B"), "Style", "Style", false);
        optionA.value = [true];
        optionB.value = [false];
        const preset = (
            id: string,
            values: Array<{optionId: string; value: boolean}>
        ): ResolvedLayerPreset => ({
            id,
            name: id,
            styleId: "Style",
            ref: {styleId: "Style", presetId: id},
            key: id,
            values
        });
        const broad = preset("broad", [{optionId: "a", value: true}]);
        const exact = preset("exact", [
            {optionId: "a", value: true},
            {optionId: "b", value: false}
        ]);
        const duplicate = preset("duplicate", [...exact.values]);

        expect(bestMatchingLayerPreset([broad, exact], [optionA, optionB], 0, ""))
            .toBe(exact);
        expect(bestMatchingLayerPreset([exact, duplicate], [optionA, optionB], 0, ""))
            .toBeUndefined();
        expect(bestMatchingLayerPreset([exact, duplicate], [optionA, optionB], 0, exact.key))
            .toBe(exact);
    });

    /** Builds a two-view layer with one owned and one unowned Boolean option. */
    function presetTreeFixture(ownedValues = [false, false]) {
        const ready = new BehaviorSubject(true);
        const numViewsState = new BehaviorSubject(2);
        const selections: Array<Record<string, Record<string, {styleId: string; presetId: string}>>> = [{}, {}];
        const stateService = {
            ready,
            numViewsState,
            mapLayerConfig: vi.fn(() => [
                {autoLevel: true, level: 13, visible: true},
                {autoLevel: true, level: 13, visible: true}
            ]),
            styleOptionValues: vi.fn((_mapId, _layerId, _styleId, optionId) =>
                optionId === "owned" ? ownedValues : [false, false]),
            getLayerPresetSelection: vi.fn((viewIndex: number, mapId: string, layerId: string) =>
                selections[viewIndex][mapId]?.[layerId] ?? null),
            setLayerPresetSelection: vi.fn((
                viewIndex: number,
                mapId: string,
                layerId: string,
                ref: {styleId: string; presetId: string} | null
            ) => {
                const mapSelections = {...(selections[viewIndex][mapId] ?? {})};
                if (ref) {
                    mapSelections[layerId] = ref;
                    selections[viewIndex] = {...selections[viewIndex], [mapId]: mapSelections};
                } else {
                    delete mapSelections[layerId];
                    selections[viewIndex] = Object.keys(mapSelections).length
                        ? {...selections[viewIndex], [mapId]: mapSelections}
                        : {};
                }
            }),
            getMapPresetSelection: vi.fn(() => null),
            setMapPresetSelection: vi.fn(),
            prune: vi.fn()
        };
        const styleGroups = new BehaviorSubject([]);
        const style = {
            id: "Example/Style",
            shortId: "style",
            options: [
                styleOption("owned", "Controlled value"),
                styleOption("unowned", "Free value")
            ],
            presets: [{
                id: "focused",
                name: "Focused view",
                values: [{optionId: "owned", value: true}]
            }],
            visible: true,
            featureLayerStyle: {hasLayerAffinity: (layerId: string) => layerId === "Example"}
        } as unknown as ErdblickStyle;
        const styleService = {
            styles: new Map([["Example/Style", style]]),
            styleGroups
        };
        const preset = {
            id: "focused",
            name: "Focused view",
            styleId: "Example/Style",
            ref: {styleId: "Example/Style", presetId: "focused"},
            key: JSON.stringify(["Example/Style", "focused"]),
            values: [{optionId: "owned", value: true}]
        };
        const presetService = {
            presets: [],
            presets$: new BehaviorSubject([]),
            isAvailable: () => true,
            presetsForLayer: vi.fn((layerId: string) => layerId === "Example" ? [preset] : []),
            matchesPresetValues: vi.fn((
                candidate: typeof preset,
                options: StyleOptionNode[],
                viewIndex: number
            ) =>
                candidate.values.every(value => options.find(option =>
                    option.styleId === candidate.styleId && option.id === value.optionId
                )?.value[viewIndex] === value.value))
        };
        const map = source("Map");
        map.layers = {Example: featureLayer("Example")};
        const tree = new MapLayerTree(
            [map],
            stateService as unknown as AppStateService,
            styleService as unknown as StyleService,
            presetService as unknown as MapPresetService,
            false);
        return {tree, stateService};
    }

    it("places the preset row first and projects owned options independently per view", () => {
        const {tree} = presetTreeFixture();
        const layer = tree.getFeatureLayer("Map", "Example")!;
        const presetNode = layerPresetNode(layer)!;

        expect(layer.children.map(child => child.id)).toEqual([
            "layer-preset",
            "owned",
            "unowned"
        ]);
        expect(presetNode.selectOptions.map(option => option.label)).toEqual([
            "Custom options",
            "Example/Style — Focused view"
        ]);

        tree.setLayerPresetSelection(0, "Map", "Example", presetNode.presets[0].ref);
        const viewZeroLayer = filterMapTreeNodes(tree.nodes, "", 0)[0].children?.[0];
        const viewOneLayer = filterMapTreeNodes(tree.nodes, "", 1)[0].children?.[0];

        expect(viewZeroLayer?.children?.map(child => child.id)).toEqual([
            "layer-preset",
            "unowned"
        ]);
        expect(viewOneLayer?.children?.map(child => child.id)).toEqual([
            "layer-preset",
            "owned",
            "unowned"
        ]);

        tree.setLayerPresetExpanded(0, "Map", "Example", true);
        expect(filterMapTreeNodes(tree.nodes, "", 0)[0].children?.[0].children
            ?.map(child => child.id)).toEqual([
            "layer-preset",
            "owned",
            "unowned"
        ]);
    });

    it("infers a unique preset from clean hydrated option defaults", () => {
        const {tree, stateService} = presetTreeFixture([true, false]);
        const presetNode = layerPresetNode(tree.getFeatureLayer("Map", "Example")!)!;

        expect(presetNode.selectedPresetKeys).toEqual([presetNode.presets[0].key, ""]);
        expect(stateService.setLayerPresetSelection).toHaveBeenCalledWith(
            0, "Map", "Example", presetNode.presets[0].ref);
    });

    it("keeps an empty preset node for reconciliation but omits it from presentation", () => {
        const {tree} = presetTreeFixture();
        const layer = tree.getFeatureLayer("Map", "Example")!;
        const presetNode = layerPresetNode(layer)!;
        presetNode.presets.splice(0);
        presetNode.selectOptions.splice(
            0,
            presetNode.selectOptions.length,
            {label: "Custom options", value: ""}
        );

        const projected = filterMapTreeNodes(tree.nodes, "", 0)[0].children?.[0];

        expect(layerPresetNode(layer)).toBe(presetNode);
        expect(projected?.children?.map(child => child.id)).toEqual(["owned", "unowned"]);
    });

    it("finds preset names and temporarily projects a matching collapsed owned option", () => {
        const {tree} = presetTreeFixture();
        const presetNode = layerPresetNode(tree.getFeatureLayer("Map", "Example")!)!;
        tree.setLayerPresetSelection(0, "Map", "Example", presetNode.presets[0].ref);

        const presetResult = filterMapTreeNodes(tree.nodes, "focused view", 0);
        const ownedResult = filterMapTreeNodes(tree.nodes, "controlled value", 0);

        expect(presetResult[0].children?.[0].children?.map(child => child.id))
            .toEqual(["layer-preset"]);
        expect(ownedResult[0].children?.[0].children?.map(child => child.id))
            .toEqual(["owned"]);
    });

    it("infers only affected layer/view identities and preserves custom values", () => {
        const {tree, stateService} = presetTreeFixture();
        const layer = tree.getFeatureLayer("Map", "Example")!;
        const presetNode = layerPresetNode(layer)!;
        const owned = layerStyleOptions(layer).find(option => option.id === "owned")!;

        owned.value[0] = true;
        tree.reconcilePresetSelections(new Set([
            layerPresetInferenceKey(0, "Map", "Example")
        ]));
        expect(presetNode.selectedPresetKeys[0]).toBe(presetNode.presets[0].key);
        expect(presetNode.expandedPresetOptions[0]).toBe(true);

        owned.value[0] = false;
        tree.reconcilePresetSelections(new Set([
            layerPresetInferenceKey(0, "Map", "Example")
        ]));
        expect(presetNode.selectedPresetKeys[0]).toBe("");
        expect(owned.value[0]).toBe(false);
        expect(stateService.setLayerPresetSelection).toHaveBeenLastCalledWith(
            0, "Map", "Example", null);

        owned.value[1] = true;
        tree.reconcilePresetSelections();
        expect(presetNode.selectedPresetKeys[1]).toBe("");
    });
});

describe("map presets in the map tree", () => {
    it("offers present components without hiding unrelated map layers", () => {
        const ref = {styleId: "Example/Style", presetId: "focused"};
        const resolvedPreset = {
            id: "focused",
            name: "Focused",
            styleId: ref.styleId,
            ref,
            key: JSON.stringify([ref.styleId, ref.presetId]),
            values: [{optionId: "owned", value: true}]
        };
        const mapPreset = {
            id: "overview",
            name: "Overview",
            enabled: true,
            layerPresets: [
                {layerId: "Example", styleId: ref.styleId, presetId: ref.presetId},
                {layerId: "Missing", styleId: ref.styleId, presetId: ref.presetId}
            ]
        };
        const duplicatePreset = {
            ...mapPreset,
            id: "duplicate",
            name: "Duplicate",
            layerPresets: [mapPreset.layerPresets[0]]
        };
        const brokenPreset = {
            ...mapPreset,
            id: "broken",
            name: "Broken",
            layerPresets: [{layerId: "Unrelated", styleId: ref.styleId, presetId: ref.presetId}]
        };
        const stateService = {
            ready: new BehaviorSubject(true),
            numViewsState: new BehaviorSubject(1),
            mapLayerConfig: vi.fn(() => [{autoLevel: true, level: 13, visible: true}]),
            styleOptionValues: vi.fn(() => [true]),
            getLayerPresetSelection: vi.fn(() => null),
            setLayerPresetSelection: vi.fn(),
            getMapPresetSelection: vi.fn(() => null),
            setMapPresetSelection: vi.fn(),
            prune: vi.fn()
        };
        const style = {
            id: ref.styleId,
            shortId: "style",
            options: [styleOption("owned", "Owned")],
            presets: [{id: "focused", name: "Focused", values: resolvedPreset.values}],
            visible: true,
            featureLayerStyle: {hasLayerAffinity: (layerId: string) => layerId === "Example"}
        } as unknown as ErdblickStyle;
        const styleService = {
            styles: new Map([[style.id, style]]),
            styleGroups: new BehaviorSubject([])
        };
        const presetService = {
            presets: [mapPreset, duplicatePreset, brokenPreset],
            presets$: new BehaviorSubject([mapPreset, duplicatePreset, brokenPreset]),
            isAvailable: () => true,
            presetsForLayer: () => [resolvedPreset],
            resolveLayerPreset: (layerId: string, candidate: typeof ref) =>
                layerId === "Example"
                    && candidate.styleId === ref.styleId
                    && candidate.presetId === ref.presetId
                    ? resolvedPreset
                    : undefined,
            matchesPresetValues: (_preset: typeof resolvedPreset, options: StyleOptionNode[], viewIndex: number) =>
                options.find(option => option.id === "owned")?.value[viewIndex] === true
        };
        const map = source("Map");
        map.layers = {
            Example: featureLayer("Example"),
            Unrelated: featureLayer("Unrelated")
        };

        const tree = new MapLayerTree(
            [map],
            stateService as unknown as AppStateService,
            styleService as unknown as StyleService,
            presetService as unknown as MapPresetService,
            false);
        const mapNode = tree.maps.get("Map")!;
        const renderedMap = filterMapTreeNodes(tree.nodes, "", 0)[0];

        expect(mapNode.mapPresetOptions).toEqual([
            {label: "Custom options", value: ""},
            {label: "Overview", value: "overview"}
        ]);
        expect(mapNode.selectedMapPresetIds).toEqual(["overview"]);
        expect(stateService.setLayerPresetSelection).toHaveBeenCalledWith(
            0, "Map", "Example", ref);
        expect(stateService.setMapPresetSelection).toHaveBeenCalledWith(
            0, "Map", "overview");
        expect(renderedMap.children?.map(child => child.id)).toEqual(["Example", "Unrelated"]);
        expect(renderedMap.children?.[0].children?.map(child => child.id)).toEqual(["layer-preset"]);
    });
});
