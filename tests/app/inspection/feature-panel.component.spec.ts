import {
    describe,
    expect,
    it,
    vi
} from "vitest";
import {FeaturePanelComponent} from "../../../app/inspection/feature-panel.component";
import {InspectionTreeComponent} from "../../../app/inspection/inspection-tree.component";

describe("property validity hover", () => {
    it("dispatches exactly the referenced attribute slots, independent of names, coordinates and visible rows", async () => {
        const panel = Object.create(FeaturePanelComponent.prototype) as any;
        const mapTileKey = "F:map:layer:42";
        panel.selectedFeatures = [{featureId: "Way.1", mapTileKey, featureTile: {mapName: "map"}}];
        const coordinates = [11.566950012345, 48.16831, 0];
        const station = (index: number) => ({key: "observation", children: [
            {key: "raw", value: 23},
            {key: "binding", type: 129, referenceHoverId: "Way.1:attribute#4:validity#" + index, value: coordinates}
        ]});
        const [section] = panel.getFeatureTreeDataFromModel([[{key: "Attribute Layers", children: [
            {key: "survey", hoverId: "Way.1:attribute#4", children: [
                {key: "readings", type: 128, children: [station(0),
                    {key: "unbound", children: [{key: "$mapgetValidity", value: 0}]},
                    station(2), station(0)]}
            ]}
        ]}]]);
        const attribute = section.children[0];
        const readings = attribute.children[0];
        const [first, unbound, second] = readings.children;
        expect(first.children[1].data.value).toBe("11.56695001, 48.16831, 0");
        expect(coordinates).toEqual([11.566950012345, 48.16831, 0]);
        const tree = Object.create(InspectionTreeComponent.prototype) as any;
        tree.mapService = {setHoveredFeatures: vi.fn()};
        tree.cdr = {markForCheck: vi.fn()};
        tree.mapHoverEpoch = 0;
        const target = (slot: number) => ({mapTileKey, featureId: "Way.1:attribute#4:validity#" + slot});
        tree.onRowHover(readings.data);
        expect(tree.mapService.setHoveredFeatures).toHaveBeenLastCalledWith([target(0), target(2)], true);
        tree.onRowHover(first.children[0].data);
        expect(tree.mapService.setHoveredFeatures).toHaveBeenLastCalledWith([target(0)], true);
        tree.onRowHover(second.data);
        expect(tree.mapService.setHoveredFeatures).toHaveBeenLastCalledWith([target(2)], true);
        tree.onRowHover(unbound.children[0].data);
        expect(tree.mapService.setHoveredFeatures).toHaveBeenLastCalledWith([]);
        tree.onRowHover(attribute.data);
        expect(tree.mapService.setHoveredFeatures).toHaveBeenLastCalledWith([{mapTileKey, featureId: attribute.data.hoverId}], true);
        tree.onRowHover(readings.data);
        tree.onRowHoverExit(readings.data);
        await Promise.resolve();
        expect(tree.mapService.setHoveredFeatures).toHaveBeenLastCalledWith([]);
    });
});

describe("point cloud selection and export", () => {
    it("opens the current host at the picked geometry and vertex ordinals", () => {
        const model = vi.fn(() => []);
        const component = Object.create(FeaturePanelComponent.prototype) as any;
        component.treeData = [];
        component.incoming = new Map();
        component.panel = () => ({id: 1, features: [{featureId: "Lane.2:shapepoint#1.0@feed",
            mapTileKey: "Features:Map:Lane:42", featureTile: {sourceId: "feed"},
            peek: (cb: any) => cb({inspectionModelAtShapePoint: model})}]});
        component.getFeatureTreeDataFromModel = () => [];
        component.rebuildInspectionTree();
        expect(model).toHaveBeenCalledWith(1, 0, "feed", "r1");
    });
    it("rebuilds inspection without exporting geometry and exports all coordinates on demand", () => {
        const coordinates = Array.from({length: 1000}, (_, i) => [8.7, 47.4, i]);
        const native = {
            inspectionModel: vi.fn(() => []),
            geojson: vi.fn(() => JSON.stringify({type: "Feature", geometry: {type: "MultiPoint", coordinates}}))
        };
        const component = Object.create(FeaturePanelComponent.prototype) as any;
        component.treeData = [];
        component.incoming = new Map();
        component.panel = () => ({id: "points", features: [{featureId: "PointCloudObject.1", featureTile: {hasIncomingRelations: () => false}, peek: (cb: any) => cb(native)}]});
        component.getFeatureTreeDataFromModel = () => [];
        component.rebuildInspectionTree();
        expect(native.inspectionModel).toHaveBeenCalledTimes(1);
        expect(native.geojson).not.toHaveBeenCalled();
        const exported = JSON.parse(component.exportGeoJson());
        expect(exported.features[0].geometry.coordinates).toEqual(coordinates);
        expect(native.geojson).toHaveBeenCalledTimes(1);
    });

    it("does not put empty comma-separated entries into exports when a wrapper is unavailable", () => {
        const component = Object.create(FeaturePanelComponent.prototype) as any;
        component.selectedFeatures = [
            {featureId: "Road.1", peek: () => null},
            {featureId: "Road.2", peek: () => '{"type":"Feature"}'}
        ];
        expect(JSON.parse(component.exportGeoJson()).features).toEqual([{type: "Feature"}]);
    });

    it("exports a vertex host only when its datasource and original indices still match", () => {
        const component = Object.create(FeaturePanelComponent.prototype) as any;
        const tile = {sourceId: "feed"};
        const native = {shapePointPosition: vi.fn().mockReturnValueOnce({x: 0, y: 0, z: 0}).mockReturnValue(null),
            geojson: vi.fn(() => '{"type":"Feature","id":"Lane.2"}')};
        const peek = vi.fn(callback => callback(native));
        component.selectedFeatures = [{featureId: "Lane.2:shapepoint#1.0@feed", featureTile: tile, peek}];
        expect(JSON.parse(component.exportGeoJson()).features).toEqual([{type: "Feature", id: "Lane.2"}]);
        tile.sourceId = "other";
        expect(JSON.parse(component.exportGeoJson()).features).toEqual([]);
        tile.sourceId = "feed";
        expect(JSON.parse(component.exportGeoJson()).features).toEqual([]);
        expect(peek).toHaveBeenCalledTimes(2);
        expect(native.shapePointPosition).toHaveBeenCalledWith(1, 0, "feed");
        expect(native.geojson).toHaveBeenCalledTimes(1);
    });
});


describe("deferred incoming inspection", () => {
    function harness(tile: any) {
        const component = Object.create(FeaturePanelComponent.prototype) as any;
        component.incoming = new Map();
        component.scheduleInspectionTreeRebuild = vi.fn();
        component.destroyed = false;
        const feature = {featureId: "Surface.1", featureTile: tile};
        return {component, feature};
    }

    it("does not schedule conventional-only selections", () => {
        const tile = {hasIncomingRelations: () => false, loadIncoming: vi.fn()};
        const {component, feature} = harness(tile);
        expect(component.incomingSection(feature)).toBeUndefined();
        expect(tile.loadIncoming).not.toHaveBeenCalled();
    });

    it("keeps malformed eligibility metadata from interrupting ordinary inspection", () => {
        const tile = {hasIncomingRelations: () => { throw new Error('Invalid declaration'); }, loadIncoming: vi.fn()};
        const {component, feature} = harness(tile);
        const section = component.incomingSection(feature);
        expect(section.incomingLoading).toBe(false);
        expect(section.value).toContain('Invalid declaration');
        expect(tile.loadIncoming).not.toHaveBeenCalled();
    });

    it("publishes loading immediately and preserves source rows after completion", async () => {
        let resolve!: (result: any) => void;
        const tile = {hasIncomingRelations: () => true, loadIncoming: vi.fn(() => new Promise(r => resolve = r))};
        const {component, feature} = harness(tile);
        component.selectedFeatures = [feature];
        const loadingTree = component.getFeatureTreeDataFromModel([[component.incomingSection(feature)]]);
        expect(loadingTree[0].data.incomingLoading).toBe(true);
        expect(loadingTree[0].data.retryIncoming).toBeUndefined();
        resolve({model: [{key: "Incoming Relations", children: [{mapTileKey: "source", key: "Lane.7"}]}],
            complete: true, status: "complete", scope: ["Features:Map:Road:1"], issues: []});
        await Promise.resolve();
        const section = component.incomingSection(feature);
        expect(section.incomingLoading).toBe(false);
        expect(section.children[0].mapTileKey).toBe("source");
        const loadedTree = component.getFeatureTreeDataFromModel([[section]]);
        expect(loadedTree[0].data.incomingLoading).toBe(false);
        expect(loadedTree[0].data.retryIncoming).toEqual(expect.any(Function));
        expect(loadedTree[0].children[0].data.mapTileKey).toBe("source");
        expect(tile.loadIncoming).toHaveBeenCalledTimes(1);
    });

    it("uses the validated fresh target for inspection and export without starting another query", async () => {
        const refreshed = {isNull: () => false, delete: vi.fn(), geojson: () => '{"type":"Feature","id":"Surface.1","properties":{"revision":2}}'};
        const target = {peek: (callback: any) => callback({find: () => refreshed})};
        const tile = {hasIncomingRelations: () => true, loadIncoming: vi.fn().mockResolvedValue({
            model: [], target, complete: true, status: "complete", scope: ["Features:Map:Road:1"], issues: []
        })};
        const {component, feature} = harness(tile);
        component.selectedFeatures = [feature];
        component.incomingSection(feature);
        await Promise.resolve();
        expect(component.inspectionFeature(feature).featureTile).toBe(target);
        expect(JSON.parse(component.exportGeoJson()).features[0].properties.revision).toBe(2);
        component.incomingSection(feature);
        expect(tile.loadIncoming).toHaveBeenCalledTimes(1);
    });

    it("reports failure locally and suppresses a cancelled stale completion", async () => {
        const tile = {hasIncomingRelations: () => true, loadIncoming: vi.fn().mockRejectedValue(new Error("Unavailable"))};
        const {component, feature} = harness(tile);
        component.incomingSection(feature);
        await Promise.resolve();
        expect(component.incomingSection(feature).value).toBe("Unavailable");
        let finish!: (result: any) => void;
        tile.loadIncoming.mockImplementation(() => new Promise(r => finish = r));
        component.retryIncoming(feature);
        component.ngOnDestroy();
        finish({model: [], complete: true, status: "complete", scope: ["Features:Map:Road:1"], issues: []});
        await Promise.resolve();
        expect(component.incoming.size).toBe(0);
    });

    it("renews finite dependencies while keeping the existing rows available for expansion restoration", async () => {
        vi.useFakeTimers();
        const result = {model: [{key: 'Incoming Relations', children: [{key: 'Lane.7', nodeId: 'owner'}]}],
            complete: true, status: "complete", scope: ["Features:Map:Road:1"], issues: [], expiresAtMs: Date.now() + 1000};
        const tile = {hasIncomingRelations: () => true, loadIncoming: vi.fn().mockResolvedValueOnce(result)
            .mockImplementation(() => new Promise(() => {}))};
        const {component, feature} = harness(tile);
        try {
            component.incomingSection(feature);
            await Promise.resolve();
            vi.advanceTimersByTime(1000);
            expect(tile.loadIncoming).toHaveBeenCalledTimes(2);
            const section = component.incomingSection(feature);
            expect(section.incomingLoading).toBe(true);
            expect(section.children[0].nodeId).toBe('owner');
        } finally {
            component.ngOnDestroy();
            vi.useRealTimers();
        }
    });
});
