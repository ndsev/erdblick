import {MapTreeNode} from "../../../app/mapdata/map-tree.controller";
import {SearchPresentation} from "../../../app/search/search-visualization.presentation";
import "@angular/compiler";
import {afterEach, describe, expect, it, vi} from "vitest";
import {StateOwners, testPersistence} from "../../support/state-owners";
import {coreLib, uint8ArrayToWasmOrThrow} from "../../../app/integrations/wasm.adapter";
import {VIEW_SYNC_LAYERS} from "../../../app/mapview/mapview.model";
import {spatialExtentEnvelope, unionSpatialTileRectangles} from "../../../app/mapview/spatial-extent-bounds.util";
import {DeckSpatialExtentOverlay, type SpatialExtentFrame} from "../../../app/mapview/deck/deck-spatial-extent.presentation";
import {SearchService} from "../../../app/search/search.service";
import {createFeatureSearchStateEntry} from "../../../app/search/search-definition.model";

const viewport = {west: -30, south: -30, width: 60, height: 60, camPosLon: 0, camPosLat: 0, orientation: 0};
afterEach(() => vi.unstubAllGlobals());

describe("spatial extent ownership and native boundary", () => {
    it("defaults, clones, synchronizes and retains settings by logical view", () => {
        const registry = testPersistence(), owners = new StateOwners(registry);
        owners.data.maps.maps.set("Map", new MapTreeNode({mapId: "Map", layers: {}} as never));
        expect(owners.data.spatialExtentSettings(0, "Map")).toEqual({limitToSpatialExtent: true, showSpatialExtent: false});
        owners.data.setSpatialExtentSettings(0, "Map", {limitToSpatialExtent: false, showSpatialExtent: true});
        owners.viewSettings.addView("0");
        expect(owners.data.spatialExtentSettings(1, "Map")).toEqual(owners.data.spatialExtentSettings(0, "Map"));
        owners.data.setSpatialExtentSettings(1, "Map", {limitToSpatialExtent: true});
        expect(owners.data.spatialExtentSettings(0, "Map").limitToSpatialExtent).toBe(false);
        owners.viewSettings.viewSync = [VIEW_SYNC_LAYERS];
        owners.data.setSpatialExtentSettings(1, "Map", {showSpatialExtent: false});
        expect(owners.data.spatialExtentSettings(0, "Map")).toEqual({limitToSpatialExtent: true, showSpatialExtent: false});
        owners.viewSettings.viewSync = [];
        owners.data.setSpatialExtentSettings(1, "Map", {showSpatialExtent: true});
        owners.viewSettings.retainViews([1, 0], new Map());
        expect(owners.data.spatialExtentSettings(0, "Map").showSpatialExtent).toBe(true);
        expect(owners.data.spatialExtentSettings(1, "Map").showSpatialExtent).toBe(false);
        registry.ngOnDestroy();
    });

    it("round-trips map preferences through the shared URL codec", () => {
        const registry = testPersistence(), owners = new StateOwners(registry);
        owners.viewSettings.addView("0");
        owners.data.setSpatialExtentSettings(1, "Map/With spaces", {limitToSpatialExtent: false, showSpatialExtent: true});
        const params = owners.layerState.spatialExtentSettingsState.appState.serialize(true)!;
        expect(params["extent"]).toBeDefined();
        owners.layerState.spatialExtentSettingsState.next(1, {});
        registry.transaction(() => owners.url.hydrate({v2: "1", n: "2", vid: "0,1", ...params}));
        expect(owners.data.spatialExtentSettings(1, "Map/With spaces")).toEqual({limitToSpatialExtent: false, showSpatialExtent: true});
        expect(owners.data.spatialExtentSettings(0, "Map/With spaces")).toEqual({limitToSpatialExtent: true, showSpatialExtent: false});
        registry.ngOnDestroy();
    });

    it("keeps inspection ownership through focus changes and view removal", () => {
        const registry = testPersistence(), owners = new StateOwners(registry);
        owners.viewSettings.addView("0");
        const id = owners.inspectionState.setSelection([{mapTileKey: "Features:Map:Layer:42", featureId: "Road.1"}])!;
        const owner = owners.inspectionState.state.selection[0].requestViewId;
        owners.viewSettings.focusedView = 1;
        expect(owners.inspectionState.state.selection[0].requestViewId).toBe(owner);
        owners.viewSettings.retainViews([1], new Map());
        expect(owners.inspectionState.state.selection.find(panel => panel.id === id)?.requestViewId).toBe("1");
        registry.ngOnDestroy();
    });

    it("retains one-NDS-unit polygons in real WASM admission and visualization", () => {
        const parser = new coreLib.TileLayerParser(), step = 360 / 2 ** 32;
        try {
            for (const [x,y] of [[11,48],[-11,-48],[179.9,70]]) {
                const extent = {bounds:[x,y,x+step,y+step],exterior:[[x,y],[x+step,y],[x+step,y+step],[x,y+step]]};
                uint8ArrayToWasmOrThrow(data=>parser.setDataSourceInfo(data),new TextEncoder().encode(JSON.stringify([{mapId:'Tiny',stringPoolId:'Tiny',layers:{Road:{type:'Features',featureTypes:[],spatialExtent:[extent],coverageComplete:true}}}])));
                const inside=Number(coreLib.getTileIdFromPosition(x+step/2,y+step/2,15)), outside=Number(coreLib.getTileIdFromPosition(x-1,y-1,15));
                expect(parser.permitsCoverageTile('Tiny','Road',inside)).toBe(true);
                expect(parser.permitsCoverageTile('Tiny','Road',outside)).toBe(false);
                expect(parser.coverageInfo('Tiny','Road').regions).toHaveLength(1);
                const selected=parser.selectCoverageTileIds('Tiny','Road',{west:x-2,south:y-2,width:4,height:4,camPosLon:x-1,camPosLat:y-1,orientation:0},15,1,true);
                expect(selected).toEqual([inside]);
            }
        } finally { parser.delete(); }
    });

    it("fails open on malformed packed IDs and overlong extent coordinates in WASM", () => {
        const parser = new coreLib.TileLayerParser();
        try {
            for (const optional of [{coverage:[4295032832]}, {coverage:[{min:65536.5,max:65536}]}, {spatialExtent:[{bounds:[0,0,1,1,999]}]}]) {
                uint8ArrayToWasmOrThrow(data=>parser.setDataSourceInfo(data),new TextEncoder().encode(JSON.stringify([{mapId:'Malformed',stringPoolId:'Malformed',layers:{Road:{type:'Features',featureTypes:[],coverageComplete:true,...optional}}}])));
                const remote=Number(coreLib.getTileIdFromPosition(100,-40,13));
                expect(parser.permitsCoverageTile('Malformed','Road',remote)).toBe(true);
            }
        } finally { parser.delete(); }
    });

    it("uses all geographic extents before capacity and invalidates metadata replacements", () => {
        const parser = new coreLib.TileLayerParser();
        const install = (complete: boolean, extents: unknown[]) => uint8ArrayToWasmOrThrow(
            data => parser.setDataSourceInfo(data), new TextEncoder().encode(JSON.stringify([{
                mapId: "Map", stringPoolId: "Map", layers: {Road: {type: "Features", featureTypes: [],
                    spatialExtent: extents, coverageComplete: complete}}
            }])));
        try {
            install(true, [{bounds: [20, 20, 21, 21]}, {bounds: [-21, -21, -20, -20]}]);
            const tiles = parser.selectCoverageTileIds("Map", "Road", viewport, 13, 8, true) as number[];
            expect(tiles).toHaveLength(8);
            expect(tiles.every(tile => parser.permitsCoverageTile("Map", "Road", tile))).toBe(true);
            expect(parser.coverageInfo("Map", "Road").regions).toHaveLength(2);
            const center = Number(coreLib.getTileIdFromPosition(0, 0, 13));
            expect(parser.permitsCoverageTile("Map", "Road", center)).toBe(false);
            install(true, []);
            expect(parser.selectCoverageTileIds("Map", "Road", viewport, 13, 8, true)).toEqual([]);
            install(false, []);
            expect(parser.selectCoverageTileIds("Map", "Road", viewport, 13, 8, true)).toHaveLength(8);
        } finally {parser.delete();}
    });

    it("pauses object discovery and ignores results already in flight", async () => {
        let resolve!: (value: {associations: []; expiresAtMs: null}) => void;
        const discover = vi.fn(() => new Promise<{associations: []; expiresAtMs: null}>(done => {resolve = done;}));
        const changed = vi.fn();
        const filterRef = {suspended: false};
        const presentation = Object.assign(Object.create(SearchPresentation.prototype), {
            destroyed: false, objectDiscoveryVersion: 0, objectDiscoverySignature: "", objectDiscoveryTimer: null,
            objectCoverage: null, coverage: null, spatialTileByPartition: new Map(),
            mapgetLayer: {mapId: "Map", layerId: "Objects"}, requestContext: {},
            tileStream: {discoverObjectPartitions: discover}, coverageChanged: changed,
            styledLayer: {filterRef, setSuspended: (value: boolean) => {filterRef.suspended = value;},
                setPartitionCoverage: vi.fn()}
        }) as SearchPresentation;
        presentation.setSuspended(true);
        presentation.setCoverage({kind: "object", discoveryTileIds: [42]});
        expect(discover).not.toHaveBeenCalled();
        presentation.setSuspended(false);
        presentation.setCoverage({kind: "object", discoveryTileIds: [42]});
        expect(discover).toHaveBeenCalledOnce();
        presentation.setSuspended(true);
        resolve({associations: [], expiresAtMs: null});
        await Promise.resolve();
        expect(changed).not.toHaveBeenCalled();
    });

    it("preserves frozen search area when the policy owner is replaced", () => {
        const select = vi.fn<(...args: unknown[]) => number[]>(() => [1]);
        const view = {viewport: {...viewport}};
        const service = Object.assign(Object.create(SearchService.prototype), {
            spatialSearchScopes: new Map(), viewSettings: {viewIds: ["0"]},
            viewState: {viewVisualizationState: [view]}, mapInfo: {tileLayerParser: {selectCoverageTileIds: select}}
        }) as SearchService;
        const definition = {...createFeatureSearchStateEntry({id: "s", query: "true", autoUpdate: false}),
            concreteScope: "feature", backendQuery: "true", resultFields: [], selectedTileLevels: [13]} as const;
        const presentation = {viewIds: ["0"], mapgetLayer: {mapId: "Map", layerId: "Road", partitionKind: "tile"},
            requestContext: {policy: {defaultLimit: true, maps: {}}}};
        service["searchCoverageRequest"](definition as never, presentation as never);
        view.viewport = {...viewport, west: 50};
        presentation.requestContext.policy.defaultLimit = false;
        service["searchCoverageRequest"](definition as never, presentation as never);
        expect(select.mock.calls[1][2]).toEqual(viewport);
        expect(select.mock.calls[1][5]).toBe(false);
    });
});

describe("spatial extent presentation", () => {
    it("unions repeated footprints without expanding cells and preserves dateline bounds", () => {
        expect(unionSpatialTileRectangles([[0,0,10,10],[0,0,10,10],[5,5,15,15]])).toEqual([
            [0,0,10,5], [0,5,15,10], [5,10,15,15]
        ]);
        expect(spatialExtentEnvelope([[170,-5,180,5],[-180,-5,-170,5]])).toEqual({west:170,south:-5,east:190,north:5});
        expect(spatialExtentEnvelope([[-170,-5,170,5]])).toEqual({west:-170,south:-5,east:170,north:5});
    });

    it("renders one map-level shader union, fits the clicked extent and clears hidden maps", () => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
        vi.stubGlobal("cancelAnimationFrame", vi.fn());
        const registry = {upsert: vi.fn(), remove: vi.fn()};
        let frame: SpatialExtentFrame = {viewport, layers: ["A", "B"].map(layerId => ({mapId:"Map",layerId,level:13,revision:1}))};
        const overlay = new DeckSpatialExtentOverlay(registry as never, () => frame,
            () => [[0,0,10,10]], (_layer, lon) => lon > 5 ? [[7,7,8,8]] : [[1,1,2,2]]);
        overlay.scheduleUpdate(); overlay.scheduleUpdate();
        expect(frames).toHaveLength(1); frames.shift()!(0);
        expect(registry.upsert).toHaveBeenCalledOnce();
        expect(registry.upsert.mock.calls[0][1].props.data).toHaveLength(1);
        expect(overlay.hit(6,6)).toEqual({west:7,east:8,south:7,north:8});
        frame = {...frame, layers: []}; overlay.scheduleUpdate(); frames.shift()!(0);
        expect(registry.remove).toHaveBeenCalledOnce(); expect(overlay.hit(6,6)).toBeNull();
        overlay.destroy();
    });
});
